// USB 设备检测回归测试
//   node --test tests/test_usb_detect.js
// 覆盖：
//   1. lsblk 树解析与 USB 判定（SATA/RAID/LVM 不得误报；USB 分区/U盘桥接/读卡器要认）
//   2. 挂载签名与差分（空签名参与比较 → 首次插入、重插同一设备都要触发）
//   3. 待补同步就绪判断（路径真实可见才算就绪）
//   4. daemon 主循环端到端（注入假扫描器驱动插→拔→再插）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  flattenLsblk, isUsbNode, mountSignature, diffMounts,
  unescapeMountPoint, isRemovableBySysfs, collectUsbMounts, pathReady,
} from '../ui/usb.js';
import { createDaemon } from '../ui/daemon.js';

// ── 夹具：本机真实结构（SATA + RAID + LVM + btrfs /volN）────────
const FIXTURE_SATA = {
  blockdevices: [{
    name: 'sda', type: 'disk', rm: false, tran: 'sata', fstype: null, mountpoint: null, size: 4000787030016, ro: false,
    children: [{
      name: 'sda1', type: 'part', rm: false, tran: null, fstype: 'linux_raid_member', mountpoint: null, size: 4000785104896, ro: false,
      children: [{
        name: 'md1', type: 'raid1', rm: false, tran: null, fstype: 'LVM2_member', mountpoint: null, size: 4000649838592, ro: false,
        children: [{
          name: 'trim_8478a9c0-0', type: 'lvm', rm: false, tran: null, fstype: 'btrfs',
          mountpoint: '/vol2', label: null, uuid: 'aaaa-bbbb', size: 4000648790016, ro: false, children: [],
        }],
      }],
    }],
  }],
};

// U 盘：整盘 tran=usb，分区自身 tran=null（需继承）
const FIXTURE_USB = {
  blockdevices: [{
    name: 'sdd', type: 'disk', rm: true, tran: 'usb', fstype: null, mountpoint: null, size: 32010928128, ro: false,
    children: [{
      name: 'sdd1', type: 'part', rm: true, tran: null, fstype: 'vfat', mountpoint: '/mnt/usbA',
      label: 'KINGSTON', uuid: '1A2B-3C4D', size: 32006782976, ro: false, children: [],
    }],
  }],
};

// USB-SATA 桥接硬盘盒：rm=false，但 tran=usb
const FIXTURE_USB_BRIDGE = {
  blockdevices: [{
    name: 'sde', type: 'disk', rm: false, tran: 'usb', fstype: null, mountpoint: null, size: 2000398934016, ro: false,
    children: [{
      name: 'sde1', type: 'part', rm: false, tran: null, fstype: 'ext4', mountpoint: '/vol1/usbHdd',
      label: 'BACKUP', uuid: '9f8e7d6c-5b4a', size: 2000393596928, ro: false, children: [],
    }],
  }],
};

// SD 读卡器：mmc，rm=true
const FIXTURE_MMC = {
  blockdevices: [{
    name: 'mmcblk0', type: 'disk', rm: true, tran: 'mmc', fstype: null, mountpoint: null, size: 63864569856, ro: false,
    children: [{
      name: 'mmcblk0p1', type: 'part', rm: true, tran: null, fstype: 'exfat', mountpoint: '/media/sd',
      label: null, uuid: 'ABCD-1234', size: 63860501504, ro: false, children: [],
    }],
  }],
};

// USB 上的 btrfs（旧白名单会漏掉）
const FIXTURE_USB_BTRFS = {
  blockdevices: [{
    name: 'sdf', type: 'disk', rm: true, tran: 'usb', fstype: null, mountpoint: null, size: 1000000000, ro: false,
    children: [{
      name: 'sdf1', type: 'part', rm: true, tran: null, fstype: 'btrfs', mountpoint: '/mnt/btrfsUsb',
      label: 'BTR', uuid: 'cafe-babe', size: 990000000, ro: false, children: [],
    }],
  }],
};

const mountOf = (fixture) => {
  const nodes = flattenLsblk(fixture).filter((n) => n.mountpoint && isUsbNode(n));
  return nodes.map((n) => ({
    device: '/dev/' + n.name, mount_point: n.mountpoint, fs_type: n.fstype,
    name: n.label || n.mountpoint, label: n.label, uuid: n.uuid, size: Number(n.size),
    removable: n.eff_rm, tran: n.eff_tran,
  }));
};

test('SATA + RAID + LVM + btrfs /volN 不得被识别为 USB', () => {
  assert.deepEqual(mountOf(FIXTURE_SATA), []);
});

test('U 盘分区（tran 需从父盘继承）被识别', () => {
  const m = mountOf(FIXTURE_USB);
  assert.equal(m.length, 1);
  assert.equal(m[0].device, '/dev/sdd1');
  assert.equal(m[0].mount_point, '/mnt/usbA');
  assert.equal(m[0].tran, 'usb', '分区自身 tran 为 null，必须继承父盘 usb');
  assert.equal(m[0].uuid, '1A2B-3C4D');
  assert.equal(m[0].label, 'KINGSTON');
  assert.equal(m[0].size, 32006782976);
});

test('USB-SATA 桥接硬盘盒（rm=false, tran=usb）被识别', () => {
  const m = mountOf(FIXTURE_USB_BRIDGE);
  assert.equal(m.length, 1);
  assert.equal(m[0].mount_point, '/vol1/usbHdd', '挂在 /volN 下的真 U 盘也要认（旧版被一刀切排除）');
  assert.equal(m[0].tran, 'usb');
});

test('SD 读卡器（mmc, rm=true）被识别', () => {
  const m = mountOf(FIXTURE_MMC);
  assert.equal(m.length, 1);
  assert.equal(m[0].device, '/dev/mmcblk0p1', '旧版 ^/dev/sd 过滤会漏掉 mmcblk');
});

test('USB 上的 btrfs 被识别（旧版 fs 白名单会漏）', () => {
  const m = mountOf(FIXTURE_USB_BTRFS);
  assert.equal(m.length, 1);
  assert.equal(m[0].fs_type, 'btrfs');
});

test('loop / dm / md 一律不是 USB', () => {
  for (const name of ['loop0', 'dm-0', 'md0', 'zram0', 'sr0']) {
    assert.equal(isUsbNode({ name, type: 'loop', eff_tran: 'usb', eff_rm: true }), false, name);
  }
});

test('挂载点八进制转义正确解码', () => {
  assert.equal(unescapeMountPoint('/mnt/my\\040disk'), '/mnt/my disk');
  assert.equal(unescapeMountPoint('/mnt/a\\011b'), '/mnt/a\tb');
  assert.equal(unescapeMountPoint('/mnt/plain'), '/mnt/plain');
});

test('挂载签名排序稳定', () => {
  const a = [{ device: '/dev/sdd1', mount_point: '/mnt/b' }, { device: '/dev/sdc1', mount_point: '/mnt/a' }];
  const b = [{ device: '/dev/sdc1', mount_point: '/mnt/a' }, { device: '/dev/sdd1', mount_point: '/mnt/b' }];
  assert.equal(mountSignature(a), mountSignature(b));
});

test('差分：空签名 → 首次插入算新增（P1-4）', () => {
  const list = mountOf(FIXTURE_USB);
  const d = diffMounts('', mountSignature(list), list);
  assert.equal(d.changed, true);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].mount_point, '/mnt/usbA');
});

test('差分：拔出 → 再次插入算新增（P1-3）', () => {
  const list = mountOf(FIXTURE_USB);
  const sig = mountSignature(list);
  const unplug = diffMounts(sig, '', []);
  assert.equal(unplug.removed.length, 1);
  assert.equal(unplug.added.length, 0);
  const replug = diffMounts('', sig, list);
  assert.equal(replug.added.length, 1, '空签名必须参与比较，重插同一设备要能触发');
});

test('差分：签名不变则不触发', () => {
  const list = mountOf(FIXTURE_USB);
  const sig = mountSignature(list);
  assert.equal(diffMounts(sig, sig, list).changed, false);
});

test('isRemovableBySysfs：本机 SATA 分区不是 removable', () => {
  assert.equal(isRemovableBySysfs('/dev/sdc2'), false);
  assert.equal(isRemovableBySysfs('/dev/sda1'), false);
  assert.equal(isRemovableBySysfs('/dev/loop0'), false);
  assert.equal(isRemovableBySysfs('/dev/md0'), false);
});

test('collectUsbMounts 在真实机器上不抛错，且不把 /volN 内部卷当 USB', async () => {
  const list = await collectUsbMounts();
  assert.ok(Array.isArray(list));
  for (const m of list) {
    assert.ok(!['/vol1', '/vol2', '/vol3'].includes(m.mount_point), `内部卷被误判为 USB: ${m.mount_point}`);
  }
});

test('pathReady：不存在路径不算就绪', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usbr-ready-'));
  try {
    assert.equal(pathReady(dir), true);
    assert.equal(pathReady(join(dir, 'missing-subdir')), false);
    assert.equal(pathReady(''), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── daemon 主循环端到端 ─────────────────────────────────────────
// 用「当前状态」变量驱动，测试里显式改状态；
// 这样 settle 复检（tick 内会再扫一次）拿到的是同一状态，符合真实行为。
function makeDaemon(initialState, tasks, pending = []) {
  const calls = [];
  const logs = [];
  let state = initialState;
  const daemon = createDaemon({
    loadTasks: () => ({ sync_tasks: tasks }),
    isAllowedPath: () => true,
    requestSync: async (p) => { calls.push(p); },
    log: (m) => logs.push(m),
    loadPending: () => pending,
    removePending: () => {},
    scanUsb: async () => state,
    pollMs: 10,
    settleMs: 0,
  });
  return { daemon, calls, logs, setState: (v) => { state = v; } };
}

const TASK = {
  id: 't1', name: '备份U盘', enabled: true, auto_sync_on_insert: true,
  source: '/mnt/usbA/photos', target: '/vol1/backup', device_uuid: '1A2B-3C4D',
};

test('主循环：启动无设备 → 插入 → 拔出 → 重插，两次插入各触发一次', async () => {
  const usb = mountOf(FIXTURE_USB);
  const h = makeDaemon([], [TASK]);

  await h.daemon._tick();        // 启动时没设备
  h.setState(usb);
  await h.daemon._tick();        // 第一次插入 → 触发
  h.setState([]);
  await h.daemon._tick();        // 拔出
  h.setState(usb);
  await h.daemon._tick();        // 同一个设备重插 → 必须再次触发（P1-3）
  await h.daemon._tick();        // 状态未变，不重复触发

  assert.equal(h.calls.length, 2, `期望插入两次各触发一次，实际 ${h.calls.length} 次`);
  assert.equal(h.calls[0].source, TASK.source);
  assert.equal(h.calls[0].auto, true);
});

test('主循环：UUID 不匹配不触发', async () => {
  const usb = mountOf(FIXTURE_USB);
  const h = makeDaemon([], [{ ...TASK, device_uuid: 'WRONG-UUID' }]);
  await h.daemon._tick();
  h.setState(usb);
  await h.daemon._tick();
  assert.equal(h.calls.length, 0);
});

test('主循环：未开 auto_sync_on_insert / 任务禁用 不触发', async () => {
  const usb = mountOf(FIXTURE_USB);
  const a = makeDaemon([], [{ ...TASK, auto_sync_on_insert: false }]);
  await a.daemon._tick(); a.setState(usb); await a.daemon._tick();
  assert.equal(a.calls.length, 0);

  const b = makeDaemon([], [{ ...TASK, enabled: false }]);
  await b.daemon._tick(); b.setState(usb); await b.daemon._tick();
  assert.equal(b.calls.length, 0);
});

test('主循环：源目录不在挂载点内不触发', async () => {
  const usb = mountOf(FIXTURE_USB);
  const h = makeDaemon([], [{ ...TASK, source: '/mnt/usbAB/photos' }]);
  await h.daemon._tick(); h.setState(usb); await h.daemon._tick();
  assert.equal(h.calls.length, 0, '/mnt/usbA 不应命中 /mnt/usbAB');
});

test('主循环：两块分区同时出现，同一任务只触发一次', async () => {
  const first = mountOf(FIXTURE_USB)[0];
  const second = { ...first, device: '/dev/sdd2', mount_point: '/mnt/usbA2' };
  const h = makeDaemon([], [TASK]);
  await h.daemon._tick();
  h.setState([first, second]);     // 同一块盘的两个分区同时出现
  await h.daemon._tick();
  assert.equal(h.calls.length, 1, '一个盘多分区不能让同一任务跑两遍');
});

test('待补同步：路径不可见时补同步不触发', async () => {
  const usb = mountOf(FIXTURE_USB);
  const pending = [{ task_id: 'p1', attempts: 0, source: '/mnt/not-mounted/x', target: '/vol1/backup' }];
  const h = makeDaemon([], [], pending);
  await h.daemon._tick();
  h.setState(usb);
  await h.daemon._tick();
  assert.equal(h.calls.length, 0, '源路径不存在时不得补同步');
});

test('待补同步：路径可见时触发补同步', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usbr-pending-'));
  try {
    const src = join(dir, 'src'); mkdirSync(src); writeFileSync(join(src, 'a.txt'), 'x');
    const usb = mountOf(FIXTURE_USB);
    const pending = [{ task_id: 'p1', attempts: 0, source: src, target: dir }];
    const h = makeDaemon([], [], pending);
    await h.daemon._tick();
    h.setState(usb);
    await h.daemon._tick();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].pending_retry, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
