#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// USB Rsync — 后台守护
//   - mount_monitor: 轮询 USB 挂载变化（检测逻辑统一在 ui/usb.js）
//   - trigger_auto_sync: UUID 绑定 + auto_sync_on_insert 任务触发
//   - trigger_pending_resync: 设备回来后补做被中断的同步
//   - trigger_scheduled_sync: 每分钟检查计划任务 (daily/weekly)
// ═══════════════════════════════════════════════════════════════
import { collectUsbMounts, mountSignature, diffMounts, pathReady } from './usb.js';

const POLL_MS = Number(process.env.USBR_SYNC_POLL_MS || 5000);
// 挂载出现后先等设备稳定再触发（文件系统刚挂上时可能还在恢复，blkid 也未必就绪）
const SETTLE_MS = Number(process.env.USBR_SYNC_SETTLE_MS || 2000);

export function createDaemon({ loadTasks, isAllowedPath, requestSync, log, loadPending, removePending,
                              scanUsb = collectUsbMounts, pollMs = POLL_MS, settleMs = SETTLE_MS }) {
  let lastMounts = '';
  let lastScheduleStamp = '';
  let stopped = false;
  let running = false;
  let timer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 读取任务列表 ─────────────────────────────────────────────
  function readTasks() {
    try { return loadTasks(); } catch { return { sync_tasks: [] }; }
  }

  // ── 触发自动同步 (USB 插入) ─────────────────────────────────
  async function triggerAutoSync(mounts, mountPoint, firedTaskIds) {
    const tasks = readTasks();
    if (!tasks.sync_tasks?.length) return;
    const mounted = (mounts || []).find((m) => m.mount_point === mountPoint);
    const mountedUuid = mounted?.uuid || null;

    for (const task of tasks.sync_tasks) {
      if (task.enabled === false) continue;
      if (task.auto_sync_on_insert !== true) continue;
      if (!task.source || !task.target) continue;
      // UUID 绑定校验：绑定过的设备必须 UUID 对上
      if (task.device_uuid && (!mountedUuid || mountedUuid !== task.device_uuid)) continue;
      // 源目录必须在挂载点内（边界匹配，防 /vol1/usbA 命中 /vol1/usbA2）
      if (!(task.source === mountPoint || task.source.startsWith(mountPoint + '/'))) continue;
      // 同一次插入事件里一个任务只跑一次（一个盘多分区时不重复触发）
      const key = task.id || task.name || String(task.source);
      if (firedTaskIds.has(key)) continue;
      firedTaskIds.add(key);

      log(`auto sync triggered: ${task.name || task.id} (${task.source} → ${task.target})`);
      try {
        await requestSync({
          source: task.source, target: task.target, bidirectional: !!task.bidirectional,
          use_delete: !!task.use_delete, task_id: task.id, retry_count: task.retry_count || 0,
          retry_delay: task.retry_delay || 5, checksum: !!task.checksum, notify: true,
          keep_history: !!task.keep_history, auto: true,
        });
      } catch (e) { log(`auto sync error: ${e.message}`); }
    }
  }

  // ── 待补同步重试（中断后设备回来时自动补）────────────────────
  // 就绪判断用「路径是否真实存在」：USB 拔掉后挂载点与其内容都会消失。
  // 不再用「排除 /volN」这种猜测——那会让挂在 /volN 下的 U 盘恒判为已就绪。
  async function triggerPendingResync() {
    const list = (loadPending && loadPending()) || [];
    if (!list.length) return;
    let triggered = 0;
    for (const item of list) {
      const need = [item.source, item.target].filter(Boolean);
      if (!need.length) continue;
      const ready = need.every((p) => (isAllowedPath ? isAllowedPath(p) : true) && pathReady(p));
      if (!ready) continue;
      if (item.attempts >= 3) { removePending && removePending(item.task_id); continue; }
      log(`pending resync triggered: ${item.task_id} (路径已就绪, 尝试 ${item.attempts})`);
      try {
        await requestSync({
          source: item.source, target: item.target, bidirectional: !!item.bidirectional,
          use_delete: !!item.use_delete, task_id: item.task_id, retry_count: 0,
          retry_delay: 5, checksum: !!item.checksum, keep_history: !!item.keep_history,
          notify: true, auto: true, pending_retry: true,
        });
        triggered++;
      } catch (e) { log(`pending resync error: ${e.message}`); }
    }
    if (triggered) log(`pending resync: ${triggered} task(s) re-triggered`);
  }

  // ── 计划任务触发 (每分钟检查) ────────────────────────────────
  function triggerScheduledSync() {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const stamp = `${now.getFullYear()}${now.getMonth() + 1}${now.getDate()}${hm.replace(':', '')}`;
    if (lastScheduleStamp === stamp) return;
    lastScheduleStamp = stamp;

    const tasks = readTasks();
    if (!tasks.sync_tasks?.length) return;
    for (const task of tasks.sync_tasks) {
      if (task.enabled === false) continue;
      const schedule = task.schedule;
      if (schedule !== 'daily' && schedule !== 'weekly') continue;
      if (task.schedule_time !== hm) continue;
      const taskWeekday = task.schedule_weekday;               // 1-7 (周一=1)
      const bashDay = now.getDay() === 0 ? 7 : now.getDay();   // getDay(): 0=周日
      if (schedule === 'weekly' && taskWeekday && Number(taskWeekday) !== bashDay) continue;
      if (!task.source || !task.target) continue;
      log(`scheduled sync triggered: ${task.name || task.id} at ${hm}`);
      requestSync({
        source: task.source, target: task.target, bidirectional: !!task.bidirectional,
        use_delete: !!task.use_delete, task_id: task.id, retry_count: task.retry_count || 0,
        retry_delay: task.retry_delay || 5, checksum: !!task.checksum, notify: true,
        keep_history: !!task.keep_history, auto: true,
      }).catch((e) => log(`scheduled sync error: ${e.message}`));
    }
  }

  // ── 一轮检测 ─────────────────────────────────────────────────
  async function tick() {
    let mounts;
    try {
      mounts = await scanUsb();
    } catch (e) {
      // 不再静默吞掉：检测层出问题必须能在日志里看到
      log(`usb scan failed: ${e.message}`);
      return;
    }
    const cur = mountSignature(mounts);

    if (cur !== lastMounts) {
      const prev = lastMounts;                 // ← 保留旧签名做基线
      const diff = diffMounts(prev, cur, mounts);
      lastMounts = cur;                        // ← 空签名也要写回，否则重插同一设备永远不触发
      for (const r of diff.removed) log(`USB removed: ${r.mount_point}`);
      for (const a of diff.added) log(`new USB mount: ${a.mount_point}`);

      if (diff.added.length) {
        // 稳定期后再确认一次：避免挂载瞬间文件系统还没就绪就开跑
        if (settleMs > 0) await sleep(settleMs);
        let settled = mounts;
        try { settled = await scanUsb(); } catch { /* 沿用上一轮结果 */ }
        const settledSig = mountSignature(settled);
        // 与「插入前的基线」比较，而不是与刚写回的 cur 比较
        const addedNow = diffMounts(prev, settledSig, settled).added;
        if (settledSig !== lastMounts) lastMounts = settledSig;

        const fired = new Set();
        for (const a of addedNow) {
          if (a.mount_point) await triggerAutoSync(settled, a.mount_point, fired);
        }
        if (addedNow.length) await triggerPendingResync();
      }
    }

    triggerScheduledSync();
  }

  async function loop() {
    if (stopped) return;
    if (running) return;             // 上一轮（含稳定期等待）还没跑完就跳过本轮
    running = true;
    try { await tick(); }
    catch (e) { try { log(`daemon loop error: ${e.message}`); } catch {} }
    finally { running = false; }
    if (!stopped) timer = setTimeout(loop, pollMs);
  }

  return {
    async start() {
      try { lastMounts = mountSignature(await scanUsb()); }
      catch { lastMounts = ''; }
      log(`mount monitor started (poll ${pollMs}ms, settle ${settleMs}ms)`);
      loop();
    },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      log('mount monitor stopped');
    },
    // 供测试/诊断使用
    _signature: () => lastMounts,
    _tick: tick,
  };
}
