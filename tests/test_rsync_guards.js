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
  parseProgressLine, exitMeaning, extractErrors,
} from '../ui/rsync.js';

// ── 进度行解析（进度条与统计的数据源）──────────────────────────
test('parseProgressLine：progress2 行拆出字节/百分比/速度/ETA/文件计数', () => {
  const p = parseProgressLine('     1,234,567  45%    1.23MB/s    0:00:03 (xfr#12, to-chk=345/1234)');
  assert.equal(p.bytes, 1234567);
  assert.equal(p.pct, 45);
  assert.equal(p.speed, '1.23MB/s');
  assert.equal(p.eta, '0:00:03');
  assert.equal(p.xfr, 12);
  assert.equal(p.toChk, 345);
  assert.equal(p.total, 1234);
});

test('parseProgressLine：没有 xfr/to-chk 的进度行也能解析', () => {
  const p = parseProgressLine('    32,768  10%   31.25kB/s    0:01:23');
  assert.equal(p.bytes, 32768);
  assert.equal(p.pct, 10);
  assert.equal(p.eta, '0:01:23');
  assert.equal(p.xfr, null);
});

test('parseProgressLine：itemize 行识别为文件、删除行标记 deleted', () => {
  const f = parseProgressLine('>f+++++++++ photos/2026/a.jpg');
  assert.equal(f.itemized, true);
  assert.equal(f.file, 'photos/2026/a.jpg');
  assert.equal(f.pct, null);

  const d = parseProgressLine('*deleting   old/b.txt');
  assert.equal(d.deleted, true);
  assert.equal(d.file, 'old/b.txt');
});

test('parseProgressLine：错误行不会被当成进度', () => {
  const e = parseProgressLine('rsync: [sender] change_dir "/mnt/x" failed: No such file or directory (2)');
  assert.equal(e.pct, null);
  assert.equal(e.itemized, false);
  assert.equal(e.deleted, false);
  assert.match(e.file, /change_dir/);
  assert.equal(parseProgressLine('').pct, null);
});

// ── 退出码含义 / 错误提取（历史记录展示用）──────────────────────
test('exitMeaning：常见退出码给人话', () => {
  assert.equal(exitMeaning(0), '成功');
  assert.equal(exitMeaning(23), '部分文件传输失败');
  assert.equal(exitMeaning(24), '传输中源文件消失（已跳过）');
  assert.equal(exitMeaning(-1), '进程被中止（超时或强制结束）');
  assert.equal(exitMeaning(-999), '用户手动停止');
  assert.match(exitMeaning(99), /未知退出码 99/);
});

test('extractErrors：挑出错误行，跳过进度行并去重', () => {
  const out = [
    '     1,234,567  45%    1.23MB/s    0:00:03',
    'rsync: [sender] send_files failed to open "/mnt/u/a.jpg": Permission denied (13)',
    'rsync: [sender] send_files failed to open "/mnt/u/a.jpg": Permission denied (13)',
    'sent 1,234 bytes  received 56 bytes',
    '*deleting   old/b.txt',
  ].join('\n');
  const errs = extractErrors(out, 5);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /Permission denied/);
});

test('extractErrors：错误行被 \\r 拼在进度行后面也要抓出来', () => {
  // rsync 用 \r 刷新进度，错误行常紧贴进度行尾部（实测输出）
  const out = '\r              0 100%    0.00kB/s    0:00:00 (xfr#0, to-chk=0/0)' +
              'rsync: [sender] change_dir "/tmp/no-such" failed: No such file or directory (2)\n' +
              'rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338)\n';
  const errs = extractErrors(out, 5);
  assert.equal(errs.length, 2, JSON.stringify(errs));
  assert.match(errs[0], /change_dir/);
  assert.match(errs[1], /code 23/);
});

test('extractErrors：空输入返回空数组，limit 生效', () => {
  assert.deepEqual(extractErrors(''), []);
  const many = Array.from({ length: 10 }, (_, i) => `rsync: error: failed item ${i}`).join('\n');
  assert.equal(extractErrors(many, 3).length, 3);
});

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
