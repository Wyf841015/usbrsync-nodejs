// 插入自动同步的健壮性回归测试
//   node --test tests/test_auto_sync.js
// 覆盖：
//   1. 正常触发（requestSync 返回 running）
//   2. requestSync 返回 busy 时不丢任务，空闲后补跑（关键修复）
//   3. 冷却窗口：挂载抖动 / 重插不重复触发
//   4. UUID 大小写不敏感匹配
//   5. 源/目标目录不存在时不硬跑
//   6. 待补同步每轮都检查（不需要新的插入事件）
//   7. 待补超过 3 次自动出队
//   8. 计划任务路径不存在时跳过
//   9. tick 卡死有看门狗，监控不会永久停摆
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDaemon } from '../ui/daemon.js';

const USB_MOUNT = '/mnt/usbA';
const UUID = '5EF3-DE54';

function mountOf(mountPoint = USB_MOUNT, uuid = UUID) {
  return [{ device: '/dev/sdz1', mount_point: mountPoint, fs_type: 'vfat', name: 'U盘', label: 'U盘',
            uuid, size: 1000, removable: true, tran: 'usb', ro: false, source: 'test' }];
}

/** 造一套可控的依赖 */
function harness(opts = {}) {
  const logs = [];
  const calls = [];
  let state = opts.initialState ?? [];
  let clock = opts.clock ?? 1_000_000;
  let syncResult = opts.syncResult ?? (() => ({ status: 'running' }));
  let pending = opts.pending ?? [];
  const removed = [];

  const daemon = createDaemon({
    loadTasks: () => ({ sync_tasks: opts.tasks ?? [] }),
    isAllowedPath: () => opts.allowed !== false,
    requestSync: async (p) => {
      calls.push(p);
      return syncResult(p, calls.length);
    },
    log: (m) => logs.push(m),
    loadPending: () => pending,
    removePending: (id) => { removed.push(id); pending = pending.filter((x) => x.task_id !== id); },
    scanUsb: async () => state,
    pollMs: opts.pollMs ?? 10,
    settleMs: 0,
    now: () => clock,
    cooldownMs: opts.cooldownMs ?? 120000,
    pendingRetryMs: opts.pendingRetryMs ?? 30000,
    deferMaxMs: opts.deferMaxMs ?? 1800000,
    tickTimeoutMs: opts.tickTimeoutMs ?? 60000,
  });
  return {
    daemon, logs, calls, removed,
    setState: (v) => { state = v; },
    setMount: (mountPoint, uuid = UUID) => { state = mountOf(mountPoint, uuid); },
    advance: (ms) => { clock += ms; },
    setSyncResult: (fn) => { syncResult = fn; },
    getPending: () => pending,
    logHas: (re) => logs.some((l) => re.test(l)),
  };
}

function tmpDirs() {
  const base = mkdtempSync(join(tmpdir(), 'usbr-auto-'));
  const src = join(base, 'src');
  const tgt = join(base, 'tgt');
  mkdirSync(src);
  mkdirSync(tgt);
  return { base, src, tgt, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const taskWith = (src, tgt, extra = {}) => ({
  id: 't1', name: '照片备份', enabled: true, auto_sync_on_insert: true,
  source: src, target: tgt, device_uuid: UUID, retry_count: 0, ...extra,
});

test('插入触发：requestSync 返回 running → 记录并开始', async () => {
  const d = tmpDirs();
  try {
    const h = harness({ tasks: [taskWith(d.src, d.tgt)] });
    await h.daemon._tick();                 // 启动时无设备
    h.setMount(d.base);
    await h.daemon._tick();                 // 插入
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].source, d.src);
    assert.ok(h.logHas(/auto sync started/), '应记录 started');
    assert.deepEqual(h.daemon._state().deferred, []);
  } finally { d.cleanup(); }
});

test('busy 不丢任务：先 deferred，空闲后自动补跑（关键修复）', async () => {
  const d = tmpDirs();
  try {
    const h = harness({
      tasks: [taskWith(d.src, d.tgt)],
      syncResult: () => ({ status: 'busy' }),      // 一直有同步在跑
    });
    await h.daemon._tick();
    h.setMount(d.base);
    await h.daemon._tick();                 // 插入 → 被繁忙挡下
    assert.ok(h.logHas(/deferred/), '应记录 deferred');
    assert.deepEqual(h.daemon._state().deferred, ['t1'], '应进入延迟队列');

    await h.daemon._tick();                 // 还是繁忙 → 继续等，不丢
    assert.deepEqual(h.daemon._state().deferred, ['t1'], '仍在队列里');

    h.setSyncResult(() => ({ status: 'running' }));   // 同步结束，空闲了
    const before = h.calls.length;
    await h.daemon._tick();                 // 下一轮 → 补跑
    assert.equal(h.calls.length, before + 1, '空闲后应补跑一次');
    assert.deepEqual(h.daemon._state().deferred, [], '补跑成功后出队');
    assert.ok(h.logHas(/deferred\) started/), '应记录补跑开始');
  } finally { d.cleanup(); }
});

test('冷却窗口：挂载抖动 / 重插同一设备不重复触发', async () => {
  const d = tmpDirs();
  try {
    const h = harness({ tasks: [taskWith(d.src, d.tgt)] });
    await h.daemon._tick();
    h.setMount(d.base); await h.daemon._tick();     // 第一次插入 → 触发
    assert.equal(h.calls.length, 1);

    h.setState([]); await h.daemon._tick();            // 拔出
    h.advance(3000);                                   // 只过了 3 秒
    h.setMount(d.base); await h.daemon._tick();     // 重插（抖动）
    assert.equal(h.calls.length, 1, '冷却期内不应重复触发');
    assert.ok(h.logHas(/冷却/), '应记录冷却跳过');

    h.setState([]); await h.daemon._tick();
    h.advance(200000);                                 // 超过 120s 冷却
    h.setMount(d.base); await h.daemon._tick();
    assert.equal(h.calls.length, 2, '冷却结束后再插入应触发');
  } finally { d.cleanup(); }
});

test('同一块盘两个分区同时出现：同一任务只触发一次', async () => {
  const d = tmpDirs();
  try {
    const h = harness({ tasks: [taskWith(d.src, d.tgt)] });
    await h.daemon._tick();
    // 一台设备两个分区（第二块挂在 base 的子目录上）
    h.setState([
      ...mountOf(d.base),
      { device: '/dev/sdz2', mount_point: join(d.base, 'p2'), fs_type: 'vfat', name: 'p2',
        label: 'p2', uuid: 'AAAA-1111', size: 1, removable: true, tran: 'usb', ro: false, source: 'test' },
    ]);
    await h.daemon._tick();
    assert.equal(h.calls.length, 1, '同一任务不应因多分区跑两遍');
  } finally { d.cleanup(); }
});

test('UUID 大小写不敏感（vfat 卷标大小写不统一）', async () => {
  const d = tmpDirs();
  try {
    const h = harness({
      tasks: [taskWith(d.src, d.tgt, { device_uuid: '5ef3-de54' })],
      initialState: [],
    });
    await h.daemon._tick();
    h.setMount(d.base, '5EF3-DE54');       // 挂载侧大写
    await h.daemon._tick();
    assert.equal(h.calls.length, 1, '大小写不同也应匹配');
  } finally { d.cleanup(); }
});

test('UUID 真的不匹配时不触发', async () => {
  const d = tmpDirs();
  try {
    const h = harness({ tasks: [taskWith(d.src, d.tgt, { device_uuid: 'AAAA-BBBB' })] });
    await h.daemon._tick();
    h.setMount(d.base);
    await h.daemon._tick();
    assert.equal(h.calls.length, 0);
  } finally { d.cleanup(); }
});

test('源目录不存在：不触发也不记 busy/deferred', async () => {
  const d = tmpDirs();
  try {
    const gone = join(d.base, 'renamed-away');
    const h = harness({ tasks: [taskWith(gone, d.tgt)] });
    await h.daemon._tick();
    h.setMount(d.base);
    await h.daemon._tick();
    assert.equal(h.calls.length, 0, '不应发起同步');
    assert.ok(h.logHas(/源目录不存在/), '应说明原因');
    assert.deepEqual(h.daemon._state().deferred, []);
  } finally { d.cleanup(); }
});

test('目标目录不存在：不触发', async () => {
  const d = tmpDirs();
  try {
    const h = harness({ tasks: [taskWith(d.src, join(d.base, 'no-target'))] });
    await h.daemon._tick();
    h.setMount(d.base);
    await h.daemon._tick();
    assert.equal(h.calls.length, 0);
    assert.ok(h.logHas(/目标目录不存在/));
  } finally { d.cleanup(); }
});

test('待补同步每轮都检查：启动时设备已挂着也能补做（原来只在插入时查）', async () => {
  const d = tmpDirs();
  try {
    const pending = [{ task_id: 'p1', source: d.src, target: d.tgt, attempts: 1 }];
    const h = harness({ tasks: [], pending, initialState: mountOf(d.base) });
    // 没有任何插入事件，直接跑一轮
    await h.daemon._tick();
    assert.equal(h.calls.length, 1, '应补做');
    assert.equal(h.calls[0].pending_retry, true);
    assert.deepEqual(h.removed, ['p1'], '启动后应出队');
  } finally { d.cleanup(); }
});

test('待补同步：attempts >= 3 自动出队且不触发', async () => {
  const d = tmpDirs();
  try {
    const pending = [{ task_id: 'p2', source: d.src, target: d.tgt, attempts: 3 }];
    const h = harness({ tasks: [], pending });
    await h.daemon._tick();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.removed, ['p2']);
  } finally { d.cleanup(); }
});

test('待补同步：路径未就绪时不触发、不消耗重试窗口', async () => {
  const d = tmpDirs();
  try {
    const pending = [{ task_id: 'p3', source: join(d.base, 'not-mounted'), target: d.tgt, attempts: 0 }];
    const h = harness({ tasks: [], pending, initialState: [] });
    await h.daemon._tick();
    await h.daemon._tick();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.removed, []);
    assert.equal(h.getPending().length, 1, '记录应保留');
  } finally { d.cleanup(); }
});

test('计划任务：源目录不存在时跳过', async () => {
  const d = tmpDirs();
  try {
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const task = taskWith(join(d.base, 'gone'), d.tgt, { auto_sync_on_insert: false, schedule: 'daily', schedule_time: hm });
    const h = harness({ tasks: [task], clock: Date.now() });
    await h.daemon._tick();
    assert.equal(h.calls.length, 0);
    assert.ok(h.logHas(/scheduled sync skipped/), '应说明跳过原因');
  } finally { d.cleanup(); }
});

test('tick 卡死有看门狗：监控继续跑下一轮', async () => {
  let scanCalls = 0;
  const logs = [];
  const daemon = createDaemon({
    loadTasks: () => ({ sync_tasks: [] }),
    isAllowedPath: () => true,
    requestSync: async () => ({ status: 'running' }),
    log: (m) => logs.push(m),
    loadPending: () => [],
    removePending: () => {},
    // 第一次（start 里）正常返回，之后永久挂起，模拟 lsblk 卡死
    scanUsb: () => {
      scanCalls++;
      if (scanCalls === 1) return Promise.resolve([]);
      return new Promise(() => {});
    },
    pollMs: 20,
    settleMs: 0,
    tickTimeoutMs: 60,
  });
  await daemon.start();
  await new Promise((r) => setTimeout(r, 320));
  daemon.stop();
  assert.ok(scanCalls >= 3, `看门狗应让 loop 继续（实际 scanUsb 调用 ${scanCalls} 次）`);
  assert.ok(logs.some((l) => /超时/.test(l)), '应记录超时告警');
});

// ══ 挂载点改名（/vol00/RemovableDisk_1 → /vol00/ProductCode_1）════
// 现场问题：任务存的是绝对路径，U 盘重插后 fnOS 换了挂载目录名，
// 原来的 underMount 前缀匹配永远失败 → 表现为「插入后自动同步无效」。
function renamedDirs() {
  const base = mkdtempSync(join(tmpdir(), 'usbr-ren-'));
  const oldRoot = join(base, 'RemovableDisk_1');
  const newRoot = join(base, 'ProductCode_1');
  const tgt = join(base, 'tgt');
  mkdirSync(oldRoot);                    // 旧挂载留下的空目录（拔盘后仍在）
  mkdirSync(join(newRoot, 'DCIM'), { recursive: true });   // 新挂载里的真实内容
  mkdirSync(tgt);
  return { base, oldRoot, newRoot, tgt, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('挂载点改名：老任务（只存绝对路径）也能触发，并把源路径换算到新挂载点', async () => {
  const d = renamedDirs();
  try {
    const task = { id: 't-rename', name: '手机备份', enabled: true, auto_sync_on_insert: true,
                   source: d.oldRoot, target: d.tgt, device_uuid: UUID, retry_count: 0 };
    const h = harness({ tasks: [task] });
    await h.daemon._tick();                       // 启动时无设备
    h.setMount(d.newRoot);                        // 插入后挂在新的目录名上
    await h.daemon._tick();
    assert.equal(h.calls.length, 1, '应触发一次同步');
    assert.equal(h.calls[0].source, d.newRoot, '源路径应换算到新挂载点');
    assert.ok(h.logHas(/源路径换算/), '应记录换算日志');
  } finally { d.cleanup(); }
});

test('挂载点改名：存了 source_rel 的任务按相对路径还原（子目录场景）', async () => {
  const d = renamedDirs();
  try {
    const task = { id: 't-rel', name: 'DCIM 备份', enabled: true, auto_sync_on_insert: true,
                   source: d.oldRoot + '/DCIM', target: d.tgt, device_uuid: UUID,
                   source_rel: '/DCIM', retry_count: 0 };
    const h = harness({ tasks: [task] });
    await h.daemon._tick();
    h.setMount(d.newRoot);
    await h.daemon._tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].source, join(d.newRoot, 'DCIM'));
  } finally { d.cleanup(); }
});

test('挂载点改名：换算后目录不存在就不硬跑，并说明原因', async () => {
  const d = renamedDirs();
  try {
    const task = { id: 't-miss', name: '不存在的子目录', enabled: true, auto_sync_on_insert: true,
                   source: d.oldRoot + '/NoSuchDir', target: d.tgt, device_uuid: UUID, retry_count: 0 };
    const h = harness({ tasks: [task] });
    await h.daemon._tick();
    h.setMount(d.newRoot);
    await h.daemon._tick();
    assert.equal(h.calls.length, 0, '不应触发');
    assert.ok(h.logHas(/换算后的源目录不存在|源目录不存在/), '应说明原因');
  } finally { d.cleanup(); }
});

test('绑定设备不匹配时记日志（不再静默跳过）', async () => {
  const d = tmpDirs();
  try {
    const other = 'AAA-BBBB';
    const h = harness({ tasks: [taskWith(d.src, d.tgt)] });   // 任务绑定 UUID
    await h.daemon._tick();
    h.setMount(d.base, other);                                // 插入的是别的盘
    await h.daemon._tick();
    assert.equal(h.calls.length, 0);
    assert.ok(h.logHas(/不是绑定设备/), '应记录设备不匹配的原因');
  } finally { d.cleanup(); }
});
