#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// USB Rsync — 后台守护
//   - mount_monitor:       轮询 USB 挂载变化（检测逻辑统一在 ui/usb.js）
//   - trigger_auto_sync:   UUID 绑定 + auto_sync_on_insert 任务触发
//   - trigger_pending_resync: 设备回来后补做被中断的同步（每轮都检查）
//   - drain_deferred:      被「已有同步在跑」挡下的触发，等空闲后补跑
//   - trigger_scheduled_sync: 每分钟检查计划任务 (daily/weekly)
//
// 健壮性要点（都是踩过的坑）：
//   1. requestSync 从不抛异常，只返回 {status:'running'|'busy'|'error'} ——
//      只看 try/catch 会把"被繁忙挡下"也记成"已触发"，任务就这么静默丢了。
//   2. 每个任务有冷却窗口：U 盘抖动/重新枚举时不会反复触发同一个任务。
//   3. 触发前校验源/目标目录真实存在：只做字符串前缀匹配会在子目录被改名后硬跑。
//   4. 待补同步每轮检查（原来只在插入事件里查）：重启后设备一直挂着也能补做。
//   5. tick 有超时看门狗：卡住时不会永久占住 running 标志让监控停摆。
// ═══════════════════════════════════════════════════════════════
import { collectUsbMounts, mountSignature, diffMounts, pathReady } from './usb.js';

const POLL_MS = Number(process.env.USBR_SYNC_POLL_MS || 5000);
// 挂载出现后先等设备稳定再触发（文件系统刚挂上时可能还在恢复，blkid 也未必就绪）
const SETTLE_MS = Number(process.env.USBR_SYNC_SETTLE_MS || 2000);
// 同一任务的触发冷却：防止挂载抖动 / USB 重新枚举导致连续重复同步
const COOLDOWN_MS = Number(process.env.USBR_SYNC_COOLDOWN_MS || 120000);
// 待补同步的重试间隔（同一个 task 两次补做之间至少隔这么久）
const PENDING_RETRY_MS = Number(process.env.USBR_SYNC_PENDING_RETRY_MS || 30000);
// 被繁忙挡下的触发最多等这么久，超过就放弃并记日志
const DEFER_MAX_MS = Number(process.env.USBR_SYNC_DEFER_MAX_MS || 1800000);
// 单轮检测的最长允许时间
const TICK_TIMEOUT_MS = Number(process.env.USBR_SYNC_TICK_TIMEOUT_MS || 60000);

const normUuid = (s) => String(s || '').trim().toUpperCase();
const underMount = (p, mp) => !!mp && (p === mp || String(p).startsWith(mp + '/'));

export function createDaemon({
  loadTasks, isAllowedPath, requestSync, log, loadPending, removePending,
  scanUsb = collectUsbMounts, pollMs = POLL_MS, settleMs = SETTLE_MS,
  now = () => Date.now(), cooldownMs = COOLDOWN_MS,
  pendingRetryMs = PENDING_RETRY_MS, deferMaxMs = DEFER_MAX_MS,
  tickTimeoutMs = TICK_TIMEOUT_MS,
}) {
  let lastMounts = '';
  let lastScheduleStamp = '';
  let stopped = false;
  let running = false;
  let timer = null;
  let mounts = [];                          // 最近一次扫描结果

  const lastFired = new Map();              // taskKey -> 最近成功触发时间
  const deferred = new Map();               // taskKey -> { payload, name, reason, addedAt }
  const lastPendingTry = new Map();         // task_id -> 最近一次补做时间

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const taskKey = (t) => t.id || t.name || String(t.source);

  function readTasks() {
    try { return loadTasks(); } catch { return { sync_tasks: [] }; }
  }

  // ── 统一触发入口：正确解读 requestSync 的返回值 ───────────────
  // 返回 'running' | 'busy' | 'error'
  async function fire(payload, key, name, reason) {
    let r;
    try {
      r = await requestSync(payload);
    } catch (e) {
      log(`${reason} failed: ${name} (${e.message})`);
      return 'error';
    }
    const st = r && r.status;
    if (st === 'running') {
      lastFired.set(key, now());
      deferred.delete(key);
      log(`${reason} started: ${name} (${payload.source} → ${payload.target})`);
      return 'running';
    }
    if (st === 'busy') {
      // 已有同步在跑：排队，等空闲了在 drainDeferred 里补跑，不再静默丢弃
      const prev = deferred.get(key);
      if (!prev) {
        deferred.set(key, { payload, name, reason, addedAt: now() });
        log(`${reason} deferred (已有同步在运行): ${name} —— 空闲后自动补跑`);
      }
      return 'busy';
    }
    log(`${reason} skipped: ${name} (${(r && r.message) || '未知原因'})`);
    return 'error';
  }

  // ── 自动同步（插入触发）─────────────────────────────────────
  async function triggerAutoSync(mountList, mountPoint, firedTaskIds) {
    const tasks = readTasks();
    if (!tasks.sync_tasks?.length) return;
    const mounted = (mountList || []).find((m) => m.mount_point === mountPoint);
    const mountedUuid = mounted?.uuid || null;

    for (const task of tasks.sync_tasks) {
      if (task.enabled === false) continue;
      if (task.auto_sync_on_insert !== true) continue;
      if (!task.source || !task.target) continue;
      // UUID 绑定校验（大小写/空白不敏感：vfat UUID 大小写不统一会造成漏触发）
      if (task.device_uuid && normUuid(mountedUuid) !== normUuid(task.device_uuid)) continue;
      // 源目录必须在该挂载点内（边界匹配，防 /x/usbA 命中 /x/usbA2）
      if (!underMount(task.source, mountPoint)) continue;

      const key = taskKey(task);
      if (firedTaskIds.has(key)) continue;                 // 同一轮多分区只触发一次
      firedTaskIds.add(key);

      // 冷却窗口：挂载抖动 / U 盘重新枚举时不重复跑
      const last = lastFired.get(key) || 0;
      if (now() - last < cooldownMs) {
        const left = Math.ceil((cooldownMs - (now() - last)) / 1000);
        log(`auto sync skipped: ${task.name || key} 处于冷却期（还剩 ${left}s）`);
        continue;
      }
      // 路径校验：前缀对 ≠ 目录真的在（挂载成功但子目录被改名/删除怎么办）
      if (isAllowedPath && !isAllowedPath(task.source)) {
        log(`auto sync skipped: ${task.name || key} 源路径不在允许范围 (${task.source})`);
        continue;
      }
      if (!pathReady(task.source)) {
        log(`auto sync skipped: ${task.name || key} 源目录不存在 (${task.source})`);
        continue;
      }
      if (!pathReady(task.target)) {
        log(`auto sync skipped: ${task.name || key} 目标目录不存在 (${task.target})`);
        continue;
      }

      await fire({
        source: task.source, target: task.target, bidirectional: !!task.bidirectional,
        use_delete: !!task.use_delete, task_id: task.id, retry_count: task.retry_count || 0, name: task.name || '',
        retry_delay: task.retry_delay || 5, checksum: !!task.checksum, notify: true,
        keep_history: !!task.keep_history, auto: true,
      }, key, task.name || key, 'auto sync');
    }
  }

  // ── 被繁忙挡下的触发：空闲后补跑 ────────────────────────────
  async function drainDeferred() {
    if (!deferred.size) return;
    for (const [key, item] of [...deferred]) {
      if (now() - item.addedAt > deferMaxMs) {
        deferred.delete(key);
        log(`deferred ${item.reason} dropped: ${item.name}（等待超时）`);
        continue;
      }
      if (!pathReady(item.payload.source)) {
        deferred.delete(key);
        log(`deferred ${item.reason} dropped: ${item.name}（源目录已不存在）`);
        continue;
      }
      const st = await fire(item.payload, key, item.name, `${item.reason} (deferred)`);
      if (st === 'running' || st === 'error') deferred.delete(key);
      // st === 'busy' → 继续等下一轮
    }
  }

  // ── 待补同步（中断后设备回来时补做）─────────────────────────
  // 就绪判断用「路径是否真实存在」：USB 拔掉后挂载点与内容都会消失。
  // 每轮都检查（不只在插入时），这样重启后设备一直挂着也能补上。
  async function triggerPendingResync() {
    const list = (loadPending && loadPending()) || [];
    if (!list.length) return;
    let started = 0;
    for (const item of list) {
      if (item.attempts >= 3) { removePending && removePending(item.task_id); continue; }
      const last = lastPendingTry.get(item.task_id) || 0;
      if (now() - last < pendingRetryMs) continue;
      const need = [item.source, item.target].filter(Boolean);
      if (!need.length) continue;
      const ready = need.every((p) => (isAllowedPath ? isAllowedPath(p) : true) && pathReady(p));
      if (!ready) continue;

      lastPendingTry.set(item.task_id, now());
      const st = await fire({
        source: item.source, target: item.target, bidirectional: !!item.bidirectional,
        use_delete: !!item.use_delete, task_id: item.task_id, retry_count: 0, name: item.name || '',
        retry_delay: 5, checksum: !!item.checksum, keep_history: !!item.keep_history,
        notify: true, auto: true, pending_retry: true,
      }, `pending:${item.task_id}`, `补做 ${item.task_id}`, 'pending resync');
      if (st === 'running') {
        // 已启动即出队；若这次同步又失败，requestSync 的失败分支会重新记入待补
        removePending && removePending(item.task_id);
        started++;
      }
      // busy / error 都保留待补记录，等下一个重试窗口
    }
    if (started) log(`pending resync: ${started} 个任务已重新开始`);
  }

  // ── 计划任务（每分钟检查一次）───────────────────────────────
  async function triggerScheduledSync() {
    const d = new Date(now());
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const stamp = `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}${hm.replace(':', '')}`;
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
      const bashDay = d.getDay() === 0 ? 7 : d.getDay();       // getDay(): 0=周日
      if (schedule === 'weekly' && taskWeekday && Number(taskWeekday) !== bashDay) continue;
      if (!task.source || !task.target) continue;

      const key = taskKey(task);
      if (!pathReady(task.source)) {
        log(`scheduled sync skipped: ${task.name || key} 源目录不存在 (${task.source})`);
        continue;
      }
      if (!pathReady(task.target)) {
        log(`scheduled sync skipped: ${task.name || key} 目标目录不存在 (${task.target})`);
        continue;
      }
      await fire({
        source: task.source, target: task.target, bidirectional: !!task.bidirectional,
        use_delete: !!task.use_delete, task_id: task.id, retry_count: task.retry_count || 0, name: task.name || '',
        retry_delay: task.retry_delay || 5, checksum: !!task.checksum, notify: true,
        keep_history: !!task.keep_history, auto: true,
      }, key, task.name || key, `scheduled sync ${hm}`);
    }
  }

  // ── 一轮检测 ─────────────────────────────────────────────────
  async function tick() {
    let list;
    try {
      list = await scanUsb();
    } catch (e) {
      log(`usb scan failed: ${e.message}`);   // 检测层故障必须可见
      return;
    }
    mounts = list;
    const cur = mountSignature(list);

    if (cur !== lastMounts) {
      const prev = lastMounts;
      const diff = diffMounts(prev, cur, list);
      lastMounts = cur;                       // 空签名也要写回，否则重插同一设备不触发
      for (const r of diff.removed) log(`USB removed: ${r.mount_point}`);
      for (const a of diff.added) log(`new USB mount: ${a.mount_point}`);

      if (diff.added.length) {
        // 稳定期后再确认一次：避免挂载瞬间文件系统还没就绪就开跑
        if (settleMs > 0) await sleep(settleMs);
        let settled = list;
        try { settled = await scanUsb(); } catch { /* 沿用上一轮结果 */ }
        mounts = settled;
        const settledSig = mountSignature(settled);
        const addedNow = diffMounts(prev, settledSig, settled).added;
        if (settledSig !== lastMounts) lastMounts = settledSig;

        const fired = new Set();
        for (const a of addedNow) {
          if (a.mount_point) await triggerAutoSync(settled, a.mount_point, fired);
        }
      }
    }

    // 下面三步每轮都跑，不依赖"刚好发生插入"
    await triggerScheduledSync();
    await triggerPendingResync();
    await drainDeferred();
  }

  async function loop() {
    if (stopped) return;
    if (running) return;                     // 上一轮还没结束（含稳定期等待）
    running = true;
    let watchdog = null;
    try {
      await Promise.race([
        tick().catch((e) => { try { log(`daemon tick error: ${e.message}`); } catch {} }),
        new Promise((res) => {
          watchdog = setTimeout(() => {
            try { log(`daemon tick 超时 (>${tickTimeoutMs}ms)，放弃本轮等待，下一轮继续`); } catch {}
            res();
          }, tickTimeoutMs);
        }),
      ]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
      running = false;
    }
    if (!stopped) timer = setTimeout(loop, pollMs);
  }

  return {
    async start() {
      try {
        mounts = await scanUsb();
        lastMounts = mountSignature(mounts);
      } catch { lastMounts = ''; }
      if (mounts.length) {
        // 启动前就插着的设备不触发插入自动同步，但要说明白，否则用户以为功能坏了
        log(`启动时已有 ${mounts.length} 个 USB 分区挂载（${mounts.map((m) => m.mount_point).join(', ')}）—— 不视为"插入"，不触发自动同步`);
      }
      log(`mount monitor started (poll ${pollMs}ms, settle ${settleMs}ms, cooldown ${Math.round(cooldownMs / 1000)}s)`);
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
    _state: () => ({
      lastMounts,
      lastFired: Object.fromEntries(lastFired),
      deferred: [...deferred.keys()],
    }),
  };
}
