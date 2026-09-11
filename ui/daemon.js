#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// USB Rsync — 后台守护 (Node.js v0.4.1)
// 替代原 bash cmd/main:
//   - mount_monitor: 轮询 /proc/mounts 检测 USB 设备插拔
//   - trigger_auto_sync: UUID 绑定 + auto_sync_on_insert 任务触发
//   - trigger_scheduled_sync: 每分钟计划任务 (daily/weekly)
// ═══════════════════════════════════════════════════════════════
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function createDaemon({ loadTasks, isAllowedPath, requestSync, log }) {
  let lastMounts = '';
  let lastScheduleStamp = '';
  let stopped = false;

  // ── 读取 /proc/mounts 中的 USB 设备 ──────────────────────────
  function readUsbMounts() {
    try {
      const mounts = readFileSync('/proc/mounts','utf8').split('\n');
      const result = [];
      for (const line of mounts) {
        const parts = line.split(' ');
        if (parts.length < 3) continue;
        const dev = parts[0], mp = parts[1], fs = parts[2];
        // 匹配 USB 块设备文件系统
        if (!/^\/dev\/sd/.test(dev)) continue;
        if (!/(vfat|ntfs|exfat|fuseblk|ext)/.test(fs)) continue;
        result.push({ device: dev, mount_point: mp, fs_type: fs });
      }
      return result.sort((a,b)=>a.device.localeCompare(b.device));
    } catch { return []; }
  }
  function mountsSignature() {
    return readUsbMounts().map(m => `${m.device}|${m.mount_point}`).join('\n');
  }

  // ── 读取任务列表 (含 auto_sync_on_insert 触发所需字段) ───────
  function readTasks() {
    try { return loadTasks(); } catch { return { sync_tasks: [] }; }
  }

  // ── 触发自动同步 (USB 插入) ─────────────────────────────────
  async function triggerAutoSync(mountPoint) {
    const tasks = readTasks();
    if (!tasks.sync_tasks?.length) return;
    // 找出挂了该挂载点的设备 UUID
    let mountedUuid = null;
    const mounts = readUsbMounts().find(m => m.mount_point === mountPoint);
    if (mounts && mounts.device) {
      mountedUuid = await getUuid(mounts.device);
    }
    for (const task of tasks.sync_tasks) {
      if (task.enabled === false) continue;
      if (task.auto_sync_on_insert !== true) continue;
      if (!task.source || !task.target) continue;
      // UUID 绑定校验
      if (task.device_uuid && (!mountedUuid || mountedUuid !== task.device_uuid)) continue;
      // 源目录必须包含挂载点 (用前缀匹配, 防 substring 误判: /vol1/usbX vs /vol1/usbX2)
      if (!(task.source === mountPoint || task.source.startsWith(mountPoint + '/'))) continue;
      log(`auto sync triggered: ${task.name||task.id} (${task.source} → ${task.target})`);
      // 触发同步 (采用行于 do_sync_api 的默认参数)
      try {
        await requestSync({
          source: task.source, target: task.target, bidirectional: !!task.bidirectional,
          use_delete: !!task.use_delete, task_id: task.id, retry_count: task.retry_count||0,
          retry_delay: task.retry_delay||5, checksum: !!task.checksum, notify: true,
          keep_history: !!task.keep_history, auto: true,
        });
      } catch (e) { log(`auto sync error: ${e.message}`); }
    }
  }

  // ── 获取设备 UUID (blkid) ────────────────────────────────────
  function getUuid(device) {
    return new Promise((res) => {
      const timer = setTimeout(() => res(null), 3000);
      execFile('blkid', ['-s','UUID','-o','value', device], (e, out) => {
        clearTimeout(timer);
        res(e ? null : (out.trim() || null));
      });
    });
  }

  // ── 计划任务触发 (每分钟检查) ────────────────────────────────
  function triggerScheduledSync() {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const day = now.getDay(); // 0=Sun..6=Sat  (原 bash 用 %u → 1=Mon..7=Sun)
    const stamp = `${now.getFullYear()}${now.getMonth()+1}${now.getDate()}${hm.replace(':','')}`;
    if (lastScheduleStamp === stamp) return;
    lastScheduleStamp = stamp;

    const tasks = readTasks();
    if (!tasks.sync_tasks?.length) return;
    for (const task of tasks.sync_tasks) {
      if (task.enabled === false) continue;
      const schedule = task.schedule;
      if (schedule !== 'daily' && schedule !== 'weekly') continue;
      if (task.schedule_time !== hm) continue;
      // weekly: 原 bash 用 %u(1-7), dayJS 用 getDay()(0-6); 换算
      const taskWeekday = task.schedule_weekday; // 1-7 (周一=1)
      const bashDay = day === 0 ? 7 : day;       // 转成 1-7
      if (schedule === 'weekly' && taskWeekday && Number(taskWeekday) !== bashDay) continue;
      if (!task.source || !task.target) continue;
      log(`scheduled sync triggered: ${task.name||task.id} at ${hm}`);
      requestSync({
        source: task.source, target: task.target, bidirectional: !!task.bidirectional,
        use_delete: !!task.use_delete, task_id: task.id, retry_count: task.retry_count||0,
        retry_delay: task.retry_delay||5, checksum: !!task.checksum, notify: true,
        keep_history: !!task.keep_history, auto: true,
      }).catch((e) => log(`scheduled sync error: ${e.message}`));
    }
  }

  // ── 主循环 ───────────────────────────────────────────────────
  function loop() {
    if (stopped) return;
    try {
      const cur = mountsSignature();
      if (cur !== lastMounts && cur) {
        if (lastMounts) {
          // 检测新增挂载
          const lastSet = new Set((lastMounts||'').split('\n').filter(Boolean));
          const newMounts = cur.split('\n').filter(m => m && !lastSet.has(m));
          for (const m of newMounts) {
            const mp = m.split('|')[1];
            if (mp) { log(`new USB mount: ${mp}`); triggerAutoSync(mp); }
          }
        }
        lastMounts = cur;
      }
      triggerScheduledSync();
    } catch (e) { try { log(`daemon loop error: ${e.message}`); } catch {} }
    setTimeout(loop, 5000); // 5s 轮询 (与原 bash 一致)
  }

  return {
    start() { lastMounts = mountsSignature(); log(`mount monitor started`); loop(); },
    stop() { stopped = true; log(`mount monitor stopped`); },
  };
}