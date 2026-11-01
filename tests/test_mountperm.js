// tests/test_mountperm.js —— 挂载点权限工具（fuse 挂载「只有 owner 能读」这一层）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseMounts, mountForPath, ownerUidOf, fuseDaemonOwner, listAsUid,
  unescapeMount, REMOVABLE_FS,
} from '../ui/mountperm.js';

test('unescapeMount：空格/制表符等八进制转义还原', () => {
  assert.equal(unescapeMount('/vol00/My\\040Disk'), '/vol00/My Disk');
  assert.equal(unescapeMount('/a\\011b'), '/a\tb');
  assert.equal(unescapeMount('/plain'), '/plain');
});

test('parseMounts：解析 fstype/挂载参数并向内暴露 uid=', () => {
  const raw = [
    'proc /proc proc rw,relatime 0 0',
    '/dev/sdg1 /vol00/My\\040Disk exfat rw,nosuid,nodev,uid=1000,gid=1000,fmask=0022 0 0',
    '/dev/sda1 /vol1 btrfs rw,noatime 0 0',
  ].join('\n');
  const list = parseMounts(raw);
  assert.equal(list.length, 3);
  const ex = list[1];
  assert.equal(ex.mount_point, '/vol00/My Disk');
  assert.equal(ex.fstype, 'exfat');
  assert.equal(ex.opts.get('uid'), '1000');
  assert.equal(ex.removable_fs, true);
  assert.equal(list[2].removable_fs, false);       // btrfs 不算外接
  assert.equal(list[0].removable_fs, false);       // proc 不算
});

test('REMOVABLE_FS：认 fuse/exfat/ntfs，不认 btrfs/ext4', () => {
  for (const fs of ['exfat', 'vfat', 'ntfs', 'ntfs3', 'fuseblk', 'fuse.exfat', 'fuse.ntfs-3g']) {
    assert.ok(REMOVABLE_FS.test(fs), fs);
  }
  for (const fs of ['btrfs', 'ext4', 'xfs', 'tmpfs', 'proc']) {
    assert.ok(!REMOVABLE_FS.test(fs), fs);
  }
});

test('mountForPath：最长前缀匹配（嵌套挂载）', () => {
  const mounts = parseMounts([
    '/dev/root / ext4 rw 0 0',
    '/dev/sdg1 /vol00/ProductCode exfat rw 0 0',
    '/dev/sdg2 /vol00/ProductCode/sub exfat rw 0 0',
  ].join('\n'));
  assert.equal(mountForPath('/vol00/ProductCode/DCIM', mounts).mount_point, '/vol00/ProductCode');
  assert.equal(mountForPath('/vol00/ProductCode/sub/x', mounts).mount_point, '/vol00/ProductCode/sub');
  assert.equal(mountForPath('/vol3/hermes', mounts).mount_point, '/');
  // 近似前缀不算进去
  assert.equal(mountForPath('/vol00/ProductCodeX', mounts).mount_point, '/');
  assert.equal(mountForPath('/vol00/ProductCode', mounts).mount_point, '/vol00/ProductCode');
});

test('ownerUidOf：优先取挂载参数里的 uid=/gid=', () => {
  const mounts = parseMounts('/dev/sdg1 /vol00/A vfat rw,uid=1000,gid=1001 0 0');
  const owner = ownerUidOf(mounts[0]);
  assert.deepEqual(owner, { uid: 1000, gid: 1001, source: 'mountopt' });
});

test('ownerUidOf：非 fuse 且参数没有 uid= 时返回 null（不需要降权）', () => {
  const mounts = parseMounts('/dev/sda1 /vol1 btrfs rw,noatime 0 0');
  assert.equal(ownerUidOf(mounts[0]), null);
});

test('fuseDaemonOwner：从持有该挂载的 fuse 进程读出 uid/gid', () => {
  const root = mkdtempSync(join(tmpdir(), 'mountperm-'));
  try {
    // 造一个假的 /proc：pid 4242 持有 /vol00/ProductCode
    const pid = join(root, '4242');
    mkdirSync(pid);
    writeFileSync(join(pid, 'mountinfo'),
      '36 1 8:97 / /vol00/ProductCode rw,nosuid,nodev shared:5 - fuse.exfat /dev/sdg1 rw,user_id=1000\n');
    writeFileSync(join(pid, 'status'), 'Name:\tmount.exfat\nUid:\t1000\t1000\t1000\t1000\nGid:\t1001\t1001\t1001\t1001\n');
    // 另一个不相关进程（挂载点不同），不应被选中
    const other = join(root, '99');
    mkdirSync(other);
    writeFileSync(join(other, 'mountinfo'), '36 1 8:1 / / ext4 rw - /dev/root rw\n');
    writeFileSync(join(other, 'status'), 'Name:\tinit\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n');

    const owner = fuseDaemonOwner('/vol00/ProductCode', root);
    assert.deepEqual(owner, { uid: 1000, gid: 1001, source: 'fuse-pid:4242' });
    assert.equal(fuseDaemonOwner('/vol00/Nowhere', root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ownerUidOf：fuse 挂载没有 uid= 参数时走进程探测', () => {
  const root = mkdtempSync(join(tmpdir(), 'mountperm2-'));
  try {
    const pid = join(root, '777');
    mkdirSync(pid);
    writeFileSync(join(pid, 'mountinfo'), '1 1 8:97 / /vol00/X rw - fuseblk /dev/sdg1 rw,allow_other\n');
    writeFileSync(join(pid, 'status'), 'Name:\tntfs-3g\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n');
    const mounts = parseMounts('/dev/sdg1 /vol00/X fuseblk rw,allow_other 0 0');
    assert.deepEqual(ownerUidOf(mounts[0], root), { uid: 0, gid: 0, source: 'fuse-pid:777' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listAsUid：以指定 uid 列目录，末尾 / 标记目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mountperm3-'));
  try {
    mkdirSync(join(dir, 'DCIM'));
    writeFileSync(join(dir, 'a.txt'), 'x');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    const list = listAsUid(dir, { uid, gid });
    const byName = new Map(list.map((e) => [e.name, e.type]));
    assert.equal(byName.get('DCIM'), 'dir');
    assert.equal(byName.get('a.txt'), 'file');
    assert.equal(byName.has('.'), false);
    assert.equal(byName.has('..'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
