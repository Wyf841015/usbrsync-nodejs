// ═══════════════════════════════════════════════════════════
// 挂载点权限工具
//
// 为什么需要这一层：大容量 U 盘常见 exFAT / NTFS，fnOS 用 fuse
// （exfat-fuse / ntfs-3g → lsblk 里显示 fuseblk / fuse.*）挂载。
// fuse 的默认策略是「只允许挂载它的那个 uid 访问」，**连 root 也会被拒**
// （除非挂载时带 allow_other / allow_root）。于是服务进程（root）读
// /vol00/xxx 会拿到 EACCES，界面表现就是「源目录浏览显示无权限」。
// 小 U 盘多是 FAT32，走内核 vfat 驱动、带 uid=/fmask 参数，反而一切正常。
//
// 这里的做法：读不出来就按「这个挂载归谁」降权再读一次（root 起子进程
// 时可以指定 uid/gid），不改 fnOS 的挂载参数也能浏览。
// ═══════════════════════════════════════════════════════════
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// 可能是外接设备的文件系统（内核 vfat/exfat 与 fuse 系）
export const REMOVABLE_FS = /^(vfat|msdos|fat|exfat|ntfs|ntfs3|fuseblk|fuse(\..+)?|udf|iso9660|hfsplus|apfs)$/i;

// /proc/mounts 把空格等写成八进制转义（\040=空格），与 usb.js 里同一套规则
export function unescapeMount(s) {
  return String(s).replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// ── /proc/mounts → 结构化（纯函数，便于测试）─────────────────
export function parseMounts(raw) {
  const out = [];
  for (const line of String(raw || '').split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length < 4) continue;
    const options = parts[3];
    const opts = new Map();
    for (const kv of options.split(',')) {
      const i = kv.indexOf('=');
      if (i < 0) opts.set(kv, '');
      else opts.set(kv.slice(0, i), kv.slice(i + 1));
    }
    out.push({
      device: parts[0],
      mount_point: unescapeMount(parts[1]),
      fstype: parts[2],
      options,
      opts,
      removable_fs: REMOVABLE_FS.test(parts[2]),
    });
  }
  return out;
}

// 路径归哪个挂载点管（最长前缀匹配）
export function mountForPath(path, mounts) {
  const p = String(path || '');
  let best = null;
  for (const m of mounts || []) {
    const mp = m.mount_point.replace(/\/+$/, '') || '/';
    const hit = mp === '/' ? p.startsWith('/') : (p === mp || p.startsWith(mp + '/'));
    if (!hit) continue;
    if (!best || mp.length > (best.mount_point.replace(/\/+$/, '').length)) best = m;
  }
  return best;
}

// 持有某个挂载点的 fuse 守护进程的 uid/gid（fuse 默认只有它能读）
export function fuseDaemonOwner(mountPoint, procRoot = '/proc') {
  let pids = [];
  try { pids = readdirSync(procRoot); } catch { return null; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let mountinfo = '';
    try { mountinfo = readFileSync(`${procRoot}/${pid}/mountinfo`, 'latin1'); } catch { continue; }
    if (!mountinfo) continue;
    const owns = mountinfo.split('\n').some((l) => {
      const f = l.split(' ');
      return f.length > 4 && unescapeMount(f[4]) === mountPoint;
    });
    if (!owns) continue;
    try {
      const st = readFileSync(`${procRoot}/${pid}/status`, 'utf8');
      const uid = Number((st.match(/^Uid:\s+(\d+)/m) || [])[1]);
      const gid = Number((st.match(/^Gid:\s+(\d+)/m) || [])[1]);
      if (Number.isFinite(uid)) {
        return { uid, gid: Number.isFinite(gid) ? gid : 0, source: `fuse-pid:${pid}` };
      }
    } catch { /* 进程刚退出 */ }
  }
  return null;
}

// 这个挂载归谁：① 挂载参数 uid=/gid= ② fuse 守护进程的 uid
export function ownerUidOf(mount, procRoot = '/proc') {
  if (!mount) return null;
  const u = mount.opts && mount.opts.get('uid');
  const g = mount.opts && mount.opts.get('gid');
  if (u !== undefined && /^\d+$/.test(u)) {
    return { uid: Number(u), gid: (g !== undefined && /^\d+$/.test(g)) ? Number(g) : 0, source: 'mountopt' };
  }
  if (!/^(fuse|fuseblk)/i.test(mount.fstype || '')) return null;
  return fuseDaemonOwner(mount.mount_point, procRoot);
}

// ── 以指定 uid 列目录 ─────────────────────────────────────────
// 用 ls 而不是自己 stat：同一个 EACCES 下 stat 一样会失败，
// 而 ls -p 用末尾 '/' 标目录，不需要逐个 stat。
export function listAsUid(dir, { uid, gid = 0 }, opts = {}) {
  const out = execFileSync('ls', ['-1ap', '--quoting-style=literal', '--', dir], {
    uid, gid,
    encoding: 'utf8',
    timeout: opts.timeout || 15000,
    maxBuffer: opts.maxBuffer || 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((n) => n !== './' && n !== '../')
    .map((n) => (n.endsWith('/') ? { name: n.slice(0, -1), type: 'dir' } : { name: n, type: 'file' }));
}

export const _internal = { fuseDaemonOwner };
