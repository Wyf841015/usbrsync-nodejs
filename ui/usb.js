// ═══════════════════════════════════════════════════════════════
// USB 设备检测（daemon.js 与 server.js 共用的唯一实现）
//
// 判定原则：以内核视图 lsblk 为准，看传输层与可移动位，
// 而不是自己拼 /sys 路径、也不靠挂载点前缀猜：
//   · tran=usb           → USB 总线上的盘（最权威，USB-SATA 桥接柜也认）
//   · rm=true            → 可移动介质（读卡器 / U 盘）
//   两者按父链继承：/dev/sdd1 自身 tran 为空，父盘 sdd 才是 usb。
//
// 旧实现的三个坑，这里一次性规避：
//   1. 曾用 /sys/block/<分区名>/removable —— 该路径不存在（分区在
//      /sys/block/sdd/sdd1），读取必抛 ENOENT，导致所有分区恒判 false。
//   2. 曾用挂载点 /^\/vol\d+/ 一刀切排除，会把挂在 /volN 下的真 U 盘也排掉；
//      现在由 tran/rm 判定，fnOS 自身的 btrfs/dm/md 卷天然不满足，无需特判。
//   3. 曾限定设备名 /^\/dev\/sd/，mmcblk、nvme、按 UUID 挂载都识别不到；
//      现在设备名完全来自 lsblk 树。
// ═══════════════════════════════════════════════════════════════
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const LSBLK_COLS = 'NAME,TYPE,RM,TRAN,FSTYPE,MOUNTPOINT,LABEL,UUID,SIZE,RO,PKNAME';

// 永不可能是 USB 的节点类型 / 名字（fnOS 自身存储栈）
const NON_USB_TYPE = new Set(['loop', 'lvm', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10', 'crypt', 'mpath']);
const NON_USB_NAME = /^(loop|ram|zram|dm-|md\d|sr\d)/;

function truthy(v) {
  return v === true || v === '1' || v === 1 || v === 'true';
}

// /proc/mounts 把空格等字符写成八进制转义（\040=\s、\011=\t、\134=\\）
export function unescapeMountPoint(s) {
  return String(s).replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// ── lsblk JSON → 扁平节点（纯函数，便于测试）───────────────────
export function flattenLsblk(json) {
  const out = [];
  const walk = (node, inherited) => {
    const tran = node.tran || inherited.tran || null;
    const rm = node.rm === undefined || node.rm === null ? inherited.rm : truthy(node.rm);
    const cur = { tran, rm };
    out.push({
      name: node.name,
      type: node.type || '',
      rm: truthy(node.rm),
      tran: node.tran || null,
      // 继承后的有效值：分区自身 tran 为空，靠父盘带下来
      eff_tran: tran,
      eff_rm: rm,
      fstype: node.fstype || '',
      mountpoint: node.mountpoint ? fixEncoding(node.mountpoint) : null,
      label: node.label ? fixEncoding(node.label) : '',
      uuid: node.uuid || '',
      size: node.size || 0,
      ro: truthy(node.ro),
      pkname: node.pkname || inherited.pkname || null,
    });
    for (const c of node.children || []) walk(c, { ...cur, pkname: node.name });
  };
  for (const b of json.blockdevices || []) walk(b, { tran: null, rm: false, pkname: null });
  return out;
}

// 单个节点是否属于「USB / 可移动介质」
export function isUsbNode(node) {
  if (!node) return false;
  if (NON_USB_TYPE.has(node.type)) return false;
  if (NON_USB_NAME.test(node.name)) return false;
  if (node.eff_tran === 'usb') return true;
  if (node.eff_rm === true) return true;
  return false;
}

// ── 卷标/挂载点乱码修复 ─────────────────────────────────────────
// U 盘分区标签是 FAT 卷标，Windows 默认按 GBK/CP936 写入（例如「新加卷」的字节是
// d0 c2 bc d3 be ed）。lsblk 原样吐出这些字节，Node 与浏览器一律按 UTF-8 解码，
// 非法序列就变成 U+FFFD（界面显示 "�¼Ӿ�"）。这里把字符串按 1:1 还原成原始
// 字节，再依次尝试：严格 UTF-8 → GBK → 宽松 UTF-8（去替换符）→ 十六进制兜底。
const utf8Strict = (() => { try { return new TextDecoder('utf-8', { fatal: true }); } catch { return null; } })();
const gbkDecoder = (() => { try { return new TextDecoder('gbk', { fatal: false }); } catch { return null; } })();
const utf8Loose = (() => { try { return new TextDecoder('utf-8'); } catch { return null; } })();

export function fixEncoding(input) {
  if (input === null || input === undefined) return '';
  const str = String(input);
  // latin1 解码后的字符串里 0x80 以上都是单字节映射，这里还原真实字节
  const bytes = Buffer.from(str, 'latin1');
  if (!bytes.some((b) => b >= 0x80)) return str.replace(/[\u0000-\u001f]/g, '');

  if (utf8Strict) {
    try { return utf8Strict.decode(bytes).replace(/[\u0000-\u001f]/g, ''); } catch { /* 不是 UTF-8 */ }
  }
  if (gbkDecoder) {
    try {
      const t = gbkDecoder.decode(bytes);
      if (t && !t.includes('\uFFFD')) return t.replace(/[\u0000-\u001f]/g, '').trim();
    } catch { /* 继续兜底 */ }
  }
  const loose = (utf8Loose ? utf8Loose.decode(bytes) : str).replace(/\uFFFD+/g, '').trim();
  return loose || bytes.toString('hex').toUpperCase();
}

// ── 系统调用封装（异步 + 超时，绝不阻塞事件循环）──────────────
// 取原始 Buffer 而不是 String：卷标可能是非 UTF-8，先按 latin1 保字节再自行解码
function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (e, out) => {
        clearTimeout(timer);
        finish(e ? null : out);
      });
    } catch { clearTimeout(timer); finish(null); }
  });
}

// 兜底：lsblk 缺失/异常时，用 /proc/mounts + 父设备 removable 判定
export function isRemovableBySysfs(device) {
  const name = String(device).replace(/^\/dev\//, '');
  if (!name || NON_USB_NAME.test(name) || /\//.test(name)) return false;
  let parent = name;
  if (!/^[a-z]+$/.test(name)) {            // 带数字 = 分区，取父盘
    try { parent = basename(dirname(realpathSync('/sys/class/block/' + name))); }
    catch { return false; }
  }
  if (!parent || parent === 'block') return false;
  try { return readFileSync('/sys/block/' + parent + '/removable', 'utf8').trim() === '1'; }
  catch { return false; }
}

function collectFromProcMounts() {
  const list = [];
  let raw = '';
  try { raw = readFileSync('/proc/mounts').toString('latin1'); } catch { return list; }
  for (const line of raw.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const device = parts[0];
    const mount_point = fixEncoding(unescapeMountPoint(parts[1]));
    const fs_type = parts[2];
    if (!device.startsWith('/dev/')) continue;
    if (!isRemovableBySysfs(device)) continue;
    list.push({
      device, mount_point, fs_type,
      name: basename(mount_point), label: '', uuid: '', size: 0,
      removable: true, tran: 'usb', ro: false, source: 'proc-mounts',
    });
  }
  return list;
}

// ── 对外主入口：当前挂载着且属于 USB/可移动介质的设备 ──────────
export async function collectUsbMounts() {
  const raw = await run('lsblk', ['-J', '-b', '-o', LSBLK_COLS]);
  if (raw) {
    try {
      // latin1 是字节 1:1 映射，JSON 结构本身是 ASCII，解析安全；字段内容随后再解码
      const nodes = flattenLsblk(JSON.parse(raw.toString('latin1')));
      const list = [];
      for (const n of nodes) {
        if (!n.mountpoint) continue;
        if (!isUsbNode(n)) continue;
        list.push({
          device: '/dev/' + n.name,
          mount_point: n.mountpoint,
          fs_type: n.fstype || '',
          name: n.label || basename(n.mountpoint),
          label: n.label || '',
          uuid: n.uuid || '',
          size: Number(n.size) || 0,
          removable: n.eff_rm === true,
          tran: n.eff_tran || '',
          ro: n.ro === true,
          source: 'lsblk',
        });
      }
      return list.sort((a, b) => a.mount_point.localeCompare(b.mount_point));
    } catch { /* 落到兜底 */ }
  }
  return collectFromProcMounts().sort((a, b) => a.mount_point.localeCompare(b.mount_point));
}

// ── 挂载签名与差分（纯函数，便于测试）─────────────────────────
export function mountSignature(list) {
  return (list || [])
    .map((m) => `${m.device}|${m.mount_point}`)
    .sort()
    .join('\n');
}

// 关键修复：空签名参与比较，且「新增」不再要求上一步非空
export function diffMounts(prevSig, curSig, curList) {
  const prevSet = new Set(String(prevSig || '').split('\n').filter(Boolean));
  const curSet = new Set(String(curSig || '').split('\n').filter(Boolean));
  const addedRaw = [...curSet].filter((x) => !prevSet.has(x));
  const removedRaw = [...prevSet].filter((x) => !curSet.has(x));
  const byKey = new Map((curList || []).map((m) => [`${m.device}|${m.mount_point}`, m]));
  return {
    added: addedRaw.map((k) => byKey.get(k) || { raw: k, mount_point: k.split('|')[1], device: k.split('|')[0] }),
    removed: removedRaw.map((k) => ({ device: k.split('|')[0], mount_point: k.split('|')[1] })),
    changed: addedRaw.length > 0 || removedRaw.length > 0,
  };
}

// 待补同步就绪判断：路径必须真实可见（USB 拔掉后其挂载点与内容会消失）
export function pathReady(p) {
  if (!p) return false;
  try { return existsSync(p); } catch { return false; }
}

export const _internal = { flattenLsblk, collectFromProcMounts, NON_USB_NAME };
