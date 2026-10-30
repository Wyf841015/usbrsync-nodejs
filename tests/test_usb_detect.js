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
  flattenLsblk, isUsbNode, mountSignature, diffMounts, fixEncoding,
  unescapeMountPoint, isRemovableBySysfs, collectUsbMounts, pathReady,
  relWithin, rebasePath, legacyRelFor,
} from '../ui/usb.js';

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

// ── 卷标编码：U 盘 FAT 卷标常由 Windows 按 GBK 写入，UTF-8 解码会变 � ──
const latin1 = (buf) => buf.toString('latin1');

test('GBK 卷标按字节解码（Windows 默认「新加卷」）', () => {
  const gbkBytes = Buffer.from('d0c2bcd3beed', 'hex');   // 「新加卷」的 GBK 编码
  assert.equal(fixEncoding(latin1(gbkBytes)), '新加卷');
});

test('UTF-8 卷标保持原样', () => {
  assert.equal(fixEncoding(latin1(Buffer.from('我的优盘', 'utf8'))), '我的优盘');
});

test('纯 ASCII 卷标不受影响', () => {
  assert.equal(fixEncoding('KINGSTON'), 'KINGSTON');
  assert.equal(fixEncoding(''), '');
});

test('无法识别的字节不留替换符（避免界面出现 �）', () => {
  const junk = latin1(Buffer.from('ff fe 81 82', 'hex'));
  const out = fixEncoding(junk);
  assert.ok(!out.includes('\uFFFD'), `仍含替换符: ${JSON.stringify(out)}`);
  assert.ok(out.length > 0, '不应返回空字符串');
});

test('flattenLsblk 会把 GBK 卷标解码后再交给上层', () => {
  const fixture = {
    blockdevices: [{
      name: 'sdz', type: 'disk', rm: true, tran: 'usb', mountpoint: null, size: 1000,
      children: [{
        name: 'sdz1', type: 'part', rm: true, tran: null, fstype: 'vfat',
        mountpoint: '/vol00/ProductCode_1',
        label: latin1(Buffer.from('d0c2bcd3beed', 'hex')), size: 900, children: [],
      }],
    }],
  };
  const n = flattenLsblk(fixture).find((x) => x.name === 'sdz1');
  assert.equal(n.label, '新加卷');
  assert.equal(n.mountpoint, '/vol00/ProductCode_1');
});

test('真实机器上任何卷标/挂载点都不含替换符', async () => {
  const list = await collectUsbMounts();
  for (const m of list) {
    assert.ok(!String(m.label).includes('\uFFFD'), `卷标乱码: ${m.label}`);
    assert.ok(!String(m.mount_point).includes('\uFFFD'), `挂载点乱码: ${m.mount_point}`);
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

// ── 挂载点改名换算（现场问题：U 盘重插后挂载目录名变了）──────────
test('relWithin：根 / 子目录 / 外部三种情况', () => {
  assert.equal(relWithin('/vol00/RemovableDisk_1', '/vol00/RemovableDisk_1'), '');
  assert.equal(relWithin('/vol00/RemovableDisk_1/DCIM', '/vol00/RemovableDisk_1'), '/DCIM');
  assert.equal(relWithin('/vol00/Other', '/vol00/RemovableDisk_1'), null);
  assert.equal(relWithin('/vol00/RemovableDisk_10', '/vol00/RemovableDisk_1'), null, '不能前缀误命中');
  assert.equal(relWithin('/vol00/X/', '/vol00/X'), '');
});

test('rebasePath：拼回绝对路径', () => {
  assert.equal(rebasePath('/vol00/ProductCode_1', ''), '/vol00/ProductCode_1');
  assert.equal(rebasePath('/vol00/ProductCode_1', '/'), '/vol00/ProductCode_1');
  assert.equal(rebasePath('/vol00/ProductCode_1', '/DCIM'), '/vol00/ProductCode_1/DCIM');
  assert.equal(rebasePath('/vol00/ProductCode_1/', 'DCIM'), '/vol00/ProductCode_1/DCIM');
});

test('legacyRelFor：按挂载目录改名推断设备内相对路径', () => {
  assert.equal(legacyRelFor('/vol00/RemovableDisk_1', '/vol00/ProductCode_1'), '');
  assert.equal(legacyRelFor('/vol00/RemovableDisk_1/DCIM/2026', '/vol00/ProductCode_1'), '/DCIM/2026');
  assert.equal(legacyRelFor('/mnt/usbA/x', '/vol00/ProductCode_1'), null, '不同顶层目录不猜');
  assert.equal(legacyRelFor('/vol00', '/vol00/ProductCode_1'), null, '比挂载点还浅不猜');
});
