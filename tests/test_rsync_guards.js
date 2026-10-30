// rsync 护栏纯函数单元测试
//   node --test tests/test_rsync_guards.js
// 覆盖：删除护栏 / 预检统计解析 / 掉盘判定（不再把单文件 ENOENT 当掉盘）/
//       /proc/mounts 转义解码 / 排除规则清洗
import test from 'node:test';
import assert from 'node:assert';

import {
  parseStats, deleteGuard, isDeviceLost, decodeMountEscapes,
  detectFsFromMounts, sanitizeExclusions, MAX_EXCLUSIONS, MAX_EXCLUSION_LEN,
  buildRsyncCmd, bindHook,
} from '../ui/rsync.js';

// ── P0-1 删除护栏 ────────────────────────────────────────────────
test('删除护栏：没有要删的就放行', () => {
  assert.equal(deleteGuard({ sourceFiles: 0, deletes: 0 }).ok, true);
  assert.equal(deleteGuard({ sourceFiles: 100, deletes: 0 }).ok, true);
});

test('删除护栏：源目录 0 条目却要删东西 → 阻止（设备没就绪/路径选错）', () => {
  const r = deleteGuard({ sourceFiles: 0, deletes: 12 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /源目录里没有任何条目/);
});

test('删除护栏：删除量远超源条目数 → 阻止', () => {
  const r = deleteGuard({ sourceFiles: 20, deletes: 101, ratio: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /超过源目录条目数/);
});

test('删除护栏：正常清理放行', () => {
  assert.equal(deleteGuard({ sourceFiles: 100, deletes: 99 }).ok, true);
  assert.equal(deleteGuard({ sourceFiles: 1000, deletes: 300 }).ok, true);
});

// ── 预检统计解析 ────────────────────────────────────────────────
const STATS_SAMPLE = `
Number of files: 1,284 (reg: 1,200, dir: 84)
Number of created files: 3 (reg: 3)
Number of deleted files: 12 (reg: 12)
Total file size: 3,865,470,566 bytes
Total transferred file size: 104,857,600 bytes
`;

test('parseStats 解析 rsync --stats 的千分位数字', () => {
  const s = parseStats(STATS_SAMPLE);
  assert.equal(s.files, 1284);
  assert.equal(s.filesReg, 1200);
  assert.equal(s.deleted, 12);
  assert.equal(s.deletedReg, 12);
  assert.equal(s.transferredBytes, 104857600);
  assert.equal(s.totalFileSize, 3865470566);
});

test('parseStats：空源目录时 "1 (dir: 1)" 的正则文件数必须是 0', () => {
  // rsync 实测输出：源目录为空时只有 dir，没有 reg 字段
  const s = parseStats('Number of files: 1 (dir: 1)\nNumber of deleted files: 2 (reg: 2)\n');
  assert.equal(s.files, 1);
  assert.equal(s.filesReg, 0, '空目录必须解析成 0 个文件，否则删除护栏失效');
  assert.equal(s.deletedReg, 2);
});

test('parseStats 对空/异常输入返回 0 而不是抛错', () => {
  for (const v of ['', null, undefined, 'garbage']) {
    const s = parseStats(v);
    assert.equal(s.files, 0);
    assert.equal(s.deleted, 0);
    assert.equal(s.transferredBytes, 0);
  }
});

// ── P1-5 掉盘判定 ───────────────────────────────────────────────
const existsAll = () => true;
const existsNone = () => false;

test('掉盘判定：change_dir failed 视为掉盘', () => {
  assert.equal(isDeviceLost({ out: 'rsync: [sender] change_dir "/mnt/usbA" failed: No such file or directory (2)',
                              source: '/mnt/usbA/x', target: '/vol1/y', exists: existsAll }), true);
});

test('掉盘判定：只有单文件 ENOENT（目录还在）不算掉盘', () => {
  const out = 'rsync: [sender] send_files failed to open "/mnt/usbA/x/a.jpg": No such file or directory (2)';
  assert.equal(isDeviceLost({ out, source: '/mnt/usbA/x', target: '/vol1/y', exists: existsAll }), false);
});

test('掉盘判定：源或目标根目录不存在 → 掉盘', () => {
  assert.equal(isDeviceLost({ out: '', source: '/mnt/usbA/x', target: '/vol1/y', exists: existsNone }), true);
});

test('掉盘判定：空间不足不算掉盘', () => {
  const out = 'rsync: write failed: No space left on device (28)';
  assert.equal(isDeviceLost({ out, source: '/mnt/usbA/x', target: '/vol1/y', exists: existsAll }), false);
});

// ── P2-4 /proc/mounts 转义 ──────────────────────────────────────
test('挂载点八进制转义解码', () => {
  assert.equal(decodeMountEscapes('/mnt/my\\040disk'), '/mnt/my disk');
  assert.equal(decodeMountEscapes('/mnt/a\\011b'), '/mnt/a\tb');
  assert.equal(decodeMountEscapes('/plain'), '/plain');
});

test('detectFsFromMounts 能匹配带空格的挂载点，并取最深匹配', () => {
  const mounts = [
    '/dev/root / ext4 rw 0 0',
    '/dev/sdz1 /mnt/my\\040disk vfat rw 0 0',
    '/dev/sdz2 /mnt/my\\040disk/sub exfat rw 0 0',
  ].join('\n');
  assert.equal(detectFsFromMounts(mounts, '/mnt/my disk/photos'), 'vfat');
  assert.equal(detectFsFromMounts(mounts, '/mnt/my disk/sub/x'), 'exfat');
  assert.equal(detectFsFromMounts(mounts, '/'), 'ext4');
});

// ── P2-5 排除规则清洗 ───────────────────────────────────────────
test('sanitizeExclusions：非数组、空串、非字符串都丢掉', () => {
  assert.deepEqual(sanitizeExclusions(null), []);
  assert.deepEqual(sanitizeExclusions('x'), []);
  assert.deepEqual(sanitizeExclusions(['', '  ', 42, null, '*.tmp']), ['*.tmp']);
});

test('sanitizeExclusions：去重且保留顺序', () => {
  assert.deepEqual(sanitizeExclusions(['*.tmp', 'a', '*.tmp', 'b']), ['*.tmp', 'a', 'b']);
});

test('sanitizeExclusions：超长项丢弃、总量封顶', () => {
  const long = 'x'.repeat(MAX_EXCLUSION_LEN + 1);
  assert.deepEqual(sanitizeExclusions([long, 'ok']), ['ok']);
  const many = Array.from({ length: MAX_EXCLUSIONS + 50 }, (_, i) => `p${i}`);
  assert.equal(sanitizeExclusions(many).length, MAX_EXCLUSIONS);
});

// ── 命令构建（护栏相关部分）────────────────────────────────────
test('buildRsyncCmd：del 才带 --delete，dry 带 --dry-run，末尾保留单斜杠', () => {
  bindHook({});
  const plain = buildRsyncCmd({ source: '/a/b/', target: '/c/d/', del: false });
  assert.ok(plain.includes('--stats'));
  assert.ok(!plain.includes('--delete'));
  assert.equal(plain[plain.length - 2], '/a/b/');   // 末尾统一保留单斜杠（rsync 语义）
  assert.equal(plain[plain.length - 1], '/c/d/');

  const del = buildRsyncCmd({ source: '/a', target: '/c', del: true });
  assert.ok(del.includes('--delete'));

  const dry = buildRsyncCmd({ source: '/a', target: '/c', dry: true });
  assert.ok(dry.includes('--dry-run'));
});

test('buildRsyncCmd：排除规则经过清洗（注入巨大列表不得撑爆 argv）', () => {
  bindHook({ excluder: () => Array.from({ length: 1000 }, (_, i) => `e${i}`) });
  const cmd = buildRsyncCmd({ source: '/a', target: '/c' });
  const excludeCount = cmd.filter((x) => x === '--exclude').length;
  assert.equal(excludeCount, MAX_EXCLUSIONS);
  bindHook({});
});
