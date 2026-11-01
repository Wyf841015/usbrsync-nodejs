#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// USB Rsync — Node.js 重写版 (v0.4.2) — 入口
// 单进程: HTTP server(静态+API) + USB监控守护 + 计划调度
// 零 npm 依赖
// ═══════════════════════════════════════════════════════════════
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync, unlinkSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rsync from './rsync.js';
import { createDaemon } from './daemon.js';
import { collectUsbMounts, relWithin, rebasePath, legacyRelFor } from './usb.js';
import { parseMounts, mountForPath, ownerUidOf, listAsUid } from './mountperm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(__dirname);   // *usbrsync 根 (target)
const VERSION = '0.5.0';

// ── 数据目录 ───────────────────────────────────────────────────
const DATA_BASE = process.env.TRM_PKGVAR || '/tmp/usbrsync-nodejs';
const CONFIG_DIR = join(DATA_BASE,'config');
const LOG_DIR    = join(DATA_BASE,'logs');
const TASKS_FILE = join(CONFIG_DIR,'tasks.json');
const HISTORY_FILE = join(DATA_BASE,'history.json');
const STATUS_FILE  = join(DATA_BASE,'sync_status.json');
const PENDING_FILE = join(DATA_BASE,'pending_resync.json');
const SYNCLOG  = join(LOG_DIR,'sync.log');
const APP_LOG  = join(LOG_DIR,'usbrsync.log');
const WWW_DIR  = join(__dirname,'www');
mkdirSync(CONFIG_DIR,{recursive:true});
mkdirSync(LOG_DIR,{recursive:true});

// ── Socket ─────────────────────────────────────────────────────
const SOCK_NAME = 'usbrsync.sock';
const SOCK_PATH = join(APP_ROOT, SOCK_NAME);
const PORT_MODE = process.env.PORT || 0;

// ── 状态 ───────────────────────────────────────────────────────
let syncState = { status:'idle', progress:0, current_file:'', message:'空闲', speed:'', xfr_num:0 };
let running = null;  // { stop() } 当前运行的同步控制器
let syncHistory = [];

const DEFAULT_EXCLUSIONS = ['*.tmp','*.temp','~*','.DS_Store','Thumbs.db','System Volume Information','$RECYCLE.BIN/'];
const ALLOWED_PATH_PREFIXES = ['/vol','/mnt','/media','/tmp'];

// ── 工具 ───────────────────────────────────────────────────────
// 应用日志轮转：每 200 条检查一次体积，超过 5MB 滚到 .1.bak。
// 原来只有 sync.log 有轮转，usbrsync.log 会无限增长（/vol3 被日志占满是真实事故）。
let _logWrites = 0;
function rotateAppLog() {
  try {
    if (statSync(APP_LOG).size > 5 * 1024 * 1024) {
      const b = APP_LOG + '.1.bak';
      if (existsSync(b)) unlinkSync(b);
      renameSync(APP_LOG, b);
    }
  } catch {}
}
function log(msg) {
  const line = `${new Date().toISOString().replace('T',' ').slice(0,19)} - ${msg}\n`;
  try {
    writeFileSync(APP_LOG, line, {flag:'a'});
    if (++_logWrites % 200 === 0) rotateAppLog();
  } catch {}
}
// 状态写盘节流: 进度刷新高频(每秒多次), 300ms 合并写, 原子替换防撕裂
let _statusTimer = null;
function setSyncStatus(s, p=0, f='', m='', sp='', n=0, extra=null) {
  // extra 里是进度详情（已传字节/总量、ETA、文件计数、删除数…）
  // 整体重建而不是合并：切回 idle 时旧进度字段必须消失，否则界面会显示上一次的数字
  syncState = { status:s, progress:p, current_file:f, message:m, speed:sp, xfr_num:n, ...(extra || {}) };
  if (_statusTimer) return; // 已有待写, 合并
  _statusTimer = setTimeout(() => {
    _statusTimer = null;
    try {
      const t = STATUS_FILE + '.tmp';
      writeFileSync(t, JSON.stringify(syncState));
      renameSync(t, STATUS_FILE);
    } catch {}
  }, 300);
}
// /proc/mounts 缓存：isAllowedPath 会被每个请求调用，别每次都读盘
let _mountsCache = { at: 0, list: [] };
function currentMounts() {
  const now = Date.now();
  if (now - _mountsCache.at > 3000) {
    let list = [];
    try { list = parseMounts(readFileSync('/proc/mounts', 'utf8')); } catch { /* ignore */ }
    _mountsCache = { at: now, list };
  }
  return _mountsCache.list;
}

// 外接设备可能被 fnOS 挂到 /vol00 以外（/run/media、/mnt/xxx…），
// 只要路径落在「当前真的挂载着的可移动/外接文件系统」里就放行，
// 免得浏览时莫名「root not allowed」。静态前缀仍然照旧生效。
// 系统自带的 vfat 挂载（/boot/efi 之类）不该因为「可移动文件系统」被放行
const SYSTEM_MOUNT_DENY = ['/boot', '/sys', '/proc', '/dev', '/run', '/usr', '/etc', '/var/lib/docker'];

function isUnderRemovableMount(p) {
  const m = mountForPath(p, currentMounts());
  if (!m || !m.removable_fs) return false;
  const mp = m.mount_point === '/' ? '' : m.mount_point;
  if (!mp) return false;                         // 挂到根上的不算外接设备
  if (SYSTEM_MOUNT_DENY.some((d) => mp === d || mp.startsWith(d + '/'))) return false;
  return true;
}

function isAllowedPath(p) {
  if (!p || !p.startsWith('/')) return false;
  // 拒绝含 .. 分量 (路径穿越) 和原始含危险字符的路径
  if (p.split('/').includes('..')) return false;
  const allowed = new Set(ALLOWED_PATH_PREFIXES);
  // /vol 是前缀; 其余是精确前缀匹配 (/vol → /vol2, /vol3...)
  const okPrefix = (prefix) =>
    p === prefix || p.startsWith(prefix + '/') ||
    (prefix === '/vol' ? /^\/vol\d+(\/|$)/.test(p) : false);
  if (!ALLOWED_PATH_PREFIXES.some(okPrefix) && !isUnderRemovableMount(p)) return false;
  // realpath 归一化后再校验一次 (防 symlink)
  try {
    const real = realpathSync(p);
    if (!ALLOWED_PATH_PREFIXES.some((prefix) => {
      if (prefix === '/vol') return /^\/vol\d+(\/|$)/.test(real);
      return real === prefix || real.startsWith(prefix + '/');
    }) && !isUnderRemovableMount(real)) return false;
  } catch {
    // 路径不存在: realpath 失败, 允许继续 (由调用方处理不存在)
    return true;
  }
  return true;
}

// ── 任务 ───────────────────────────────────────────────────────
function loadTasks() {
  try { return JSON.parse(readFileSync(TASKS_FILE,'utf8')); }
  catch { return { sync_tasks:[], exclusions:[...DEFAULT_EXCLUSIONS] }; }
}
// 历史记录里的任务名：v0.4.9 之前的记录没有 task_name 字段，
// 读接口时按 task_id 回查当前任务表补上，老记录也能显示名字。
function taskNameOf(taskId) {
  if (!taskId) return '';
  const id = String(taskId);
  if (id.includes('(restore)')) {
    const base = id.replace(/\(restore\)/g, '').trim();
    return `恢复：${taskNameOf(base) || base || '未知任务'}`;
  }
  try {
    const list = loadTasks().sync_tasks || [];
    const t = list.find((x) => x && x.id === id);
    return (t && t.name) || '';
  } catch { return ''; }
}
function withTaskNames(list) {
  return (list || []).map((e) => (e && !e.task_name) ? { ...e, task_name: taskNameOf(e.task_id) } : e);
}

// 保存任务时把「设备内相对路径」一起存下来。
// 原因：同一 U 盘重插后 fnOS 可能换挂载目录名（/vol00/RemovableDisk_1 →
// /vol00/ProductCode_1），只存绝对路径会导致插入自动同步永远匹配不上。
async function attachSourceRel(tasksObj) {
  let mounts = [];
  try { mounts = await collectUsbMounts(); } catch { mounts = []; }
  for (const t of (tasksObj.sync_tasks || [])) {
    if (!t || !t.source) continue;
    const uuid = String(t.device_uuid || '').trim().toUpperCase();
    // 优先用绑定的设备，其次任意包含该路径的挂载点
    const hit = mounts.find((m) => uuid && String(m.uuid || '').trim().toUpperCase() === uuid
                                && relWithin(t.source, m.mount_point) !== null)
             || mounts.find((m) => relWithin(t.source, m.mount_point) !== null);
    if (!hit) continue;
    const rel = relWithin(t.source, hit.mount_point);
    if (rel !== null) {
      t.source_rel = rel;                 // '' 表示就是挂载根
      t.source_mount = hit.mount_point;
    }
  }
  return tasksObj;
}

function saveTasks(o) {
  // 唯一临时名防并发覆盖 (history clear 与 appendHistory 可能并发)
  const t = `${TASKS_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(t, JSON.stringify(o,null,2)); renameSync(t,TASKS_FILE);
}

// ── 任务配置校验（/tasks 与 /config_import 共用）────────────────
// 原来把 POST 的 JSON 直接落盘：任意结构、任意长度都能写进去，
// 之后 daemon/rsync 拿着脏字段去找路径。这里做一次结构与长度收敛。
const MAX_TASKS = 200;
const MAX_TASK_STR = 4096;
const MAX_EXCLUSIONS = rsync.MAX_EXCLUSIONS;
function validateTasksPayload(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok:false, error:'配置必须是对象' };
  const tasks = o.sync_tasks;
  if (!Array.isArray(tasks)) return { ok:false, error:'sync_tasks 必须是数组' };
  if (tasks.length > MAX_TASKS) return { ok:false, error:`任务数量超过上限 ${MAX_TASKS}` };
  const cleanStr = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') return null;
    if (v.length > MAX_TASK_STR) return null;
    if (v.includes('\u0000')) return null;
    return v;
  };
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { ok:false, error:`第 ${i+1} 个任务不是对象` };
    const name = cleanStr(t.name), source = cleanStr(t.source), target = cleanStr(t.target), id = cleanStr(t.id);
    if (name === null || source === null || target === null || id === null)
      return { ok:false, error:`第 ${i+1} 个任务的字段类型或长度不合法` };
    const excl = Array.isArray(t.task_exclusions) ? t.task_exclusions : [];
    if (excl.length > MAX_EXCLUSIONS) return { ok:false, error:`第 ${i+1} 个任务的排除规则超过 ${MAX_EXCLUSIONS} 条` };
    out.push({
      ...t,
      id: id || `task_${Date.now()}_${i}`,
      name: name.slice(0, 200),
      source, target,
      task_exclusions: excl.filter((x) => typeof x === 'string' && x.length <= 512 && x.length > 0),
    });
  }
  const globalExcl = Array.isArray(o.exclusions) ? o.exclusions : [];
  return { ok:true, value: { ...o, sync_tasks: out, exclusions: globalExcl.filter((x) => typeof x === 'string' && x.length <= 512 && x.length > 0) } };
}
function excluder(taskId) {
  const { sync_tasks=[], exclusions=[] } = loadTasks();
  const set = new Set(exclusions);
  if (taskId) { const t = sync_tasks.find(x=>x.id===taskId); (t?.task_exclusions||[]).forEach(x=>set.add(x)); }
  return [...set];
}

// ── 历史/统计 ─────────────────────────────────────────────────
function loadHistory() { try { return JSON.parse(readFileSync(HISTORY_FILE,'utf8')); } catch { return []; } }
function saveHistory(h) {
  const t = `${HISTORY_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(t, JSON.stringify(h)); renameSync(t,HISTORY_FILE);
}
function appendHistory(entry) {
  const h = loadHistory(); h.push(entry);
  if (h.length > 100) h.splice(0, h.length-100);
  try { saveHistory(h); return true; } catch { return false; }
}

// ── 待补同步 (中断后挂载恢复自动重试) ─────────────────────────
function loadPending() { try { return JSON.parse(readFileSync(PENDING_FILE,'utf8')); } catch { return []; } }
function savePending(a) {
  try { const t=`${PENDING_FILE}.${process.pid}.${Date.now()}.tmp`; writeFileSync(t, JSON.stringify(a)); renameSync(t,PENDING_FILE); } catch {}
}
function addPending(item) {
  const list = loadPending();
  const idx = list.findIndex(x=>x.task_id===item.task_id);
  const rec = { task_id:item.task_id, name:item.name||'', source:item.source, target:item.target,
                bidirectional:item.bidirectional, use_delete:item.use_delete,
                checksum:item.checksum, keep_history:item.keep_history, attempts:(idx>=0?list[idx].attempts:0)+1 };
  if (idx>=0) list[idx]=rec; else list.push(rec);
  savePending(list); log(`pending resync added: ${item.task_id} (attempt ${rec.attempts})`);
}
function removePending(taskId) {
  const list = loadPending();
  const next = list.filter(x => x.task_id !== taskId);
  if (next.length !== list.length) { savePending(next); log(`pending resync cleared: ${taskId}`); }
}

// ── USB 设备扫描 ──────────────────────────────────────────────
// 检测逻辑统一在 ui/usb.js（daemon 与 API 共用一份，避免两处实现各自漂移）。
// 这里只加一层短 TTL 缓存：/api/status 与 /api/devices 常被同一次刷新连续调用，
// 缓存可以避免同一秒内反复 fork lsblk。
let _usbCache = { at: 0, list: [] };
const USB_CACHE_MS = Number(process.env.USBR_SYNC_USB_CACHE_MS || 1500);

async function scanUsbDevices() {
  const now = Date.now();
  if (now - _usbCache.at < USB_CACHE_MS) return _usbCache.list;
  try {
    const list = await collectUsbMounts();
    _usbCache = { at: now, list };
    return list;
  } catch (e) {
    log(`usb scan failed: ${e.message}`);
    return _usbCache.list || [];
  }
}

// ── rsync 核心绑定 ─────────────────────────────────────────────
rsync.bindHook({
  setStatus: setSyncStatus,
  log,
  excluder,
  appendHistory,
  notify: (title, content, level) => notifyDone(title, content, level),
});

// ── fnOS 通知 (psql) ───────────────────────────────────────────
function notifyDone(title, content, level) {
  try {
    const t = String(title).replace(/'/g,"''").replace(/[\r\n]/g,'');
    const c = String(content).replace(/'/g,"''").replace(/[\r\n]/g,'');
    execFile('psql', ['-U','postgres','-d','trim','-v','ON_ERROR_STOP=0','-c',
      `WITH n AS (INSERT INTO notify(cat,level,title,source,content,dateandtime) VALUES(0,${level},'${t}','USBRsync','${c}',extract(epoch from now())::bigint) RETURNING id) INSERT INTO notify_user(uid,notify_id,read) SELECT uid,id,0 FROM users,n;`],
      { timeout: 10000 }, () => {});
  } catch {}
}

// ── 同步触发 (daemon 与 API 共用) ──────────────────────────────
// 所有入口(手动/插入自动/计划/待补)都必须经过这里，预检也放在这里，
// 保证「带 --delete 的危险同步」在哪条路径上都被拦一次。
async function requestSync(p) {
  if (running) return { status:'busy', message:'已有同步正在运行' };
  if (!p.source || !p.target || !isAllowedPath(p.source) || !isAllowedPath(p.target)) {
    return { status:'error', message:'路径不允许或缺失' };
  }
  // 源/目标不存在时不要强行跑：rsync 会以 23 失败，历史里只剩一条难懂的退出码
  if (!existsSync(p.source)) return { status:'error', message:`源目录不存在：${p.source}` };
  if (!existsSync(p.target)) return { status:'error', message:`目标目录不存在：${p.target}` };

  // 源盘若是「别的 uid 挂的 fuse 挂载」（exFAT/NTFS 常见），root 也读不到：
  // 预检和 rsync 主进程都要降权到该挂载的 owner，否则整单 EACCES。
  let runAs = null;
  try {
    const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    let rootCanRead = true;
    try { readdirSync(p.source); }
    catch (e) { rootCanRead = !(e && (e.code === 'EACCES' || e.code === 'EPERM')); }
    if (!rootCanRead) {
      const owner = ownerUidOf(mountForPath(p.source, currentMounts()));
      if (owner && owner.uid !== selfUid) {
        runAs = { uid: owner.uid, gid: owner.gid };
        log(`源目录 root 无权限，改以 uid=${owner.uid} 运行（${owner.source}）：${p.source}`);
      } else {
        setSyncStatus('idle', 0, '', '源目录无读取权限', '', 0);
        return { status:'error', message:`源目录无读取权限（EACCES），且找不到可降权的挂载 owner：${p.source}` };
      }
    }
  } catch { /* 检测本身失败就当可读，交给 rsync 报 */ }

  // ── 预检（一次 dry-run，同时拿到「要写多少字节」与「会删多少项」）──
  // 取代原先每次同步都跑的全盘 `du -sb`；也是 --delete 的护栏。
  setSyncStatus('syncing', 0, '', '正在预检源目录…', '', 0);
  const pre = await rsync.preflight({
    source: p.source, target: p.target,
    del: !!p.use_delete, checksum: !!p.checksum, taskId: p.task_id, runAs,
  });
  if (pre.ok) {
    const st = pre.stats || {};
    // 用 reg（正则文件）计数判空：`Number of files` 含目录自身，空目录也是 1
    const guard = rsync.deleteGuard({ sourceFiles: st.filesReg, deletes: st.deletedReg || st.deleted });
    if (!guard.ok) {
      // 把拦截原因直接显示在状态栏（用户看到"什么都没发生"时最需要的就是原因）
      setSyncStatus('idle', 0, '', `预检阻止：${guard.reason.slice(0, 80)}`, '', 0);
      log(`preflight blocked delete: ${guard.reason} (${p.source} → ${p.target})`);
      return { status:'error', message: guard.reason };
    }
    if (p.check_space !== false) {
      const free = await rsync.freeBytes(p.target);
      const need = st.transferredBytes || 0;
      if (free !== null && need > free) {
        setSyncStatus('idle', 0, '', '目标空间不足', '', 0);
        return { status:'error', message:`目标空间不足：需要 ${need} B，可用 ${free} B` };
      }
    }
  } else if (p.use_delete) {
    // 带删除时预检失败必须 fail-closed：开不了口子，宁可不跑
    setSyncStatus('idle', 0, '', '预检失败，已阻止同步', '', 0);
    log(`preflight failed, delete blocked: ${pre.reason} (${p.source} → ${p.target})`);
    return { status:'error', message:`预检失败，已阻止带删除的同步：${pre.reason}` };
  } else {
    log(`preflight skipped: ${pre.reason}（继续执行，空间/删除由 rsync 自己报错）`);
  }

  // 预检期间可能已有别的同步进来
  if (running) return { status:'busy', message:'已有同步正在运行' };
  rotateLog();

  const ctl = rsync.startSync({
    source:p.source, target:p.target, bidirectional:p.bidirectional,
    del:p.use_delete, taskId:p.task_id, retry:p.retry_count,
    delay:p.retry_delay, checksum:p.checksum, keep:p.keep_history, notify:p.notify,
    // 预检拿到的「本次需要传输的字节数」：进度条用它算 x/y，历史用它记录总量
    totalBytes: (pre && pre.ok && pre.stats && pre.stats.transferredBytes) || 0,
    taskName: p.name || '',
    runAs,
  }, { setStatus:setSyncStatus, synclog:SYNCLOG, appendHistory, notify:notifyDone });
  running = ctl;
  // 完成后清 running (startSync 返回 donePromise, 在完成时 resolve)
  ctl.donePromise.then((res) => {
    if (running === ctl) running = null;
    if (!res) return;
    if (res.success) {
      removePending(p.task_id);
    } else if (res.exit_code !== -999 && p.task_id && p.task_id.indexOf('(restore)') === -1) {
      // 失败且非用户停止(-999) → 记入待补 (挂载恢复后 daemon 自动补, 最多3次)
      const pm = loadPending().find(x=>x.task_id===p.task_id);
      if (!pm || pm.attempts < 3) addPending(p);
    }
  })
     .catch(() => { if (running === ctl) running = null; });
  return { status:'running', message:'同步已开始' };
}
function rotateLog() {
  try {
    if (statSync(SYNCLOG).size > 5*1024*1024) {
      const b = join(LOG_DIR,'sync.log.1.bak');
      if (existsSync(b)) unlinkSync(b);
      renameSync(SYNCLOG, b);
    }
  } catch {}
}
function stopSync() {
  if (running) {
    const ctl = running;
    if (ctl.stop) ctl.stop();
    // 等待旧子进程真正退出后再清 running, 防新同步与旧进程并发写目标
    Promise.race([
      ctl.donePromise || Promise.resolve(),
      new Promise((r) => setTimeout(r, 5000)),
    ]).finally(() => {
      if (running === ctl) running = null;
    });
    setSyncStatus('idle',0,'','已停止','',0);
  } else {
    setSyncStatus('idle',0,'','已停止','',0);
  }
}
function syncRunning() { return !!running; }

// ── 日志读取 ───────────────────────────────────────────────────
function readSyncLog(lines=200) {
  try {
    const all = readFileSync(SYNCLOG,'utf8').split('\n').filter(Boolean);
    return all.slice(-Math.min(lines,5000));
  } catch { return []; }
}
function readDriveList() {
  const drives = [];
  // 收集真实卷根目录: /vol1..N (无 /vol 父目录, 从根目录 glob)
  const roots = [];
  try {
    for (const d of readdirSync('/')) {
      if (/^vol\d+$/.test(d)) roots.push(join('/',d));
    }
  } catch {}
  roots.push('/mnt','/media');
  for (const p of roots) {
    try {
      if (!statSync(p).isDirectory()) continue;
      let size=0, free=0, mounted=false;
      try {
        const out = execFileSync('df',['-PB1',p]).toString().trim().split('\n');
        const m = out[out.length-1].split(/\s+/);
        const mp = m[5]||'';
        if (mp === p) mounted = true;
        if (mounted) size = parseInt(m[1]||'0',10), free = parseInt(m[3]||'0',10);
      } catch {}
      // 跳过非真实挂载点 (如 /media/cdrom0 空目录继承根分区)
      if (!mounted) continue;
      drives.push({ path:p, name:basename(p), size, free });
    } catch {}
  }
  return drives;
}

// ── API 路由 ───────────────────────────────────────────────────
async function handleApi(pathname, req, res) {
  const method = req.method;
  let body;
  try {
    body = ['POST','PUT'].includes(method) ? await readBody(req) : '';
  } catch(e) {
    return send(res,413,{success:false,error:'请求体过大'});
  }

  try {
    switch(pathname) {
      case '/status': {
        const devCount = (await scanUsbDevices()).length;
        send(res,200,{ success:true, version:VERSION, tasks_count:loadTasks().sync_tasks?.length||0,
                        device_count:devCount, sync:syncState });
        return;
      }
      case '/devices':
        send(res,200,{ success:true, devices:await scanUsbDevices() }); return;
      case '/drives':
        send(res,200,{ success:true, drives:readDriveList() }); return;
      case '/tasks': {
        if (method === 'POST') {
          try {
            const o = JSON.parse(body||'{}');
            if (!o.sync_tasks) throw new Error('missing sync_tasks');
            const v = validateTasksPayload(o);
            if (!v.ok) return send(res,400,{ success:false, error:v.error });
            await attachSourceRel(v.value);
            saveTasks(v.value);
            send(res,200,{success:true});
          }
          catch(e){ send(res,400,{success:false,error:'empty body or invalid'}); }
        } else {
          send(res,200,{ success:true, tasks:loadTasks() });
        }
        return;
      }
      case '/sync': {
        if (method !== 'POST') return send(res,405,{success:false,error:'POST required'});
        let p; try { p = JSON.parse(body||'{}'); } catch { p={}; }
        if (syncRunning()) return send(res,200,{ success:false, error:'已有同步正在运行，请先停止或等待完成' });
        if (!p.source || !p.target) return send(res,200,{success:false,error:'source/target required'});
        if (!isAllowedPath(p.source) || !isAllowedPath(p.target)) return send(res,200,{success:false,error:'path not allowed'});
        // 空间/删除护栏已统一放到 requestSync 的预检里（自动/计划/待补同一条路径）
        const r = await requestSync(p);
        if (r && r.status === 'running') return send(res,200,{ success:true, result:r });
        return send(res,200,{ success:false, error:(r && r.message) || '同步未能开始', result:r });
      }
      case '/preview': {
        if (method !== 'POST') return send(res,405,{success:false,error:'POST required'});
        let p; try { p=JSON.parse(body||'{}'); } catch { p={}; }
        if (!p.source || !p.target) return send(res,200,{success:false,error:'source/target required'});
        if (!isAllowedPath(p.source) || !isAllowedPath(p.target)) return send(res,200,{success:false,error:'path not allowed'});
        const cmd = rsync.buildRsyncCmd({ source:p.source, target:p.target, del:!!p.use_delete,
          taskId:p.task_id, checksum:!!p.checksum, dry:true, keep:false });
        execFile(cmd[0], cmd.slice(1), { timeout:30000, maxBuffer:10*1024*1024 }, (e, so) => {
          if (e) {
            const reason = e.code === 'ETIMEDOUT' ? '预览超时' : (e.code==='ENOBUFS' ? '输出过大' : e.message);
            return send(res,200, { success:false, exit_code:e.code||-1, error:`预览失败 (${reason})` });
          }
          const out = (so||'').split('\n');
          const adds = out.filter(l => /^>f\+|^cd\+/.test(l)).length;
          const dels = out.filter(l => /^\*deleting/.test(l)).length;
          const chgs = out.filter(l => /^>f|^<f/.test(l)).length;
          send(res, 200, { success:true, exit_code:0, add:adds, delete:dels, change:chgs,
                            lines: out.slice(0,200) });
        });
        return;
      }
      case '/sync_stop':
        // 状态变更必须 POST：GET 会被 <img src> 之类的跨站请求触发（CSRF）
        if (method !== 'POST') return send(res,405,{success:false,error:'POST required'});
        stopSync(); send(res,200,{success:true}); return;
      case '/sync_status':
        send(res,200,{ success:true, sync:syncState }); return;
      case '/restore': {
        if (method !== 'POST') return send(res,405,{success:false,error:'POST required'});
        let p; try { p=JSON.parse(body||'{}'); } catch { p={}; }
        const source = p.target, target = p.source; // 反向
        if (syncRunning()) return send(res,200,{success:false,error:'已有同步正在运行，请先停止或等待完成'});
        if (!source || !target) return send(res,200,{success:false,error:'source/target required'});
        if (!isAllowedPath(source) || !isAllowedPath(target)) return send(res,200,{success:false,error:'path not allowed'});
        // 恢复: 从 target 恢复到 source
        const r = await requestSync({ source, target, bidirectional:false, use_delete:false,
          task_id: p.task_id+' (restore)', retry_count:p.retry_count||0, retry_delay:p.retry_delay||5,
          checksum:false, keep:false, notify:p.notify!==false });
        return send(res,200,{ success:true, result:r });
      }
      case '/diff': {
        const source = readQuery(req).source, target = readQuery(req).target;
        if (!isAllowedPath(source) || !isAllowedPath(target)) return send(res,200,{success:false,error:'path not allowed'});
        const d = await rsync.diffDirs(source, target);
        return send(res,200,{ success:true, ...d });
      }
      case '/history': {
        const q = readQuery(req);
        if (/^(DELETE|POST)$/.test(method) && q.action === 'clear') saveHistory([]);
        const all = withTaskNames(loadHistory());
        let h = all;
        // 支持按结果/任务筛选 + 限制条数（前端「全部/成功/失败」切换和详情用）
        if (q.result === 'ok') h = h.filter(x => x.success);
        else if (q.result === 'fail') h = h.filter(x => !x.success);
        if (q.task_id) h = h.filter(x => x.task_id === q.task_id);
        const lim = parseInt(q.limit, 10);
        if (Number.isFinite(lim) && lim > 0) h = h.slice(-lim);
        send(res,200,{ success:true, history:h, total:all.length }); return;
      }
      case '/auto_sync_check': {
        // 逐条列出「自动同步」任务的判定链，插入没触发时用来自查
        let mounts = [];
        try { mounts = await collectUsbMounts(); } catch (e) { mounts = []; }
        const tasks = loadTasks().sync_tasks || [];
        const rows = tasks.map((t) => {
          const r = {
            id: t.id, name: t.name || '', source: t.source, target: t.target,
            enabled: t.enabled !== false, auto_sync_on_insert: t.auto_sync_on_insert === true,
            device_uuid: t.device_uuid || '', source_rel: (typeof t.source_rel === 'string' ? t.source_rel : null),
            mount: null, effective_source: t.source, ok: false, reasons: [],
          };
          if (!r.enabled) r.reasons.push('任务已禁用');
          if (!r.auto_sync_on_insert) r.reasons.push('未开启「插入后自动同步」');
          const uuid = String(t.device_uuid || '').trim().toUpperCase();
          const m = mounts.find((x) => uuid && String(x.uuid || '').trim().toUpperCase() === uuid)
                 || mounts.find((x) => relWithin(t.source || '', x.mount_point) !== null);
          if (!m) {
            r.reasons.push(uuid ? `设备 ${uuid} 未挂载` : '没有挂载中的 USB 设备包含该源目录');
          } else {
            r.mount = { mount_point: m.mount_point, uuid: m.uuid || '', label: m.label || '', fs_type: m.fs_type };
            // 与 daemon 同样的换算规则
            const within = relWithin(t.source || '', m.mount_point);
            const stored = (typeof t.source_rel === 'string') ? t.source_rel : null;
            const rel = within !== null ? within : (stored !== null ? stored : legacyRelFor(t.source || '', m.mount_point));
            if (rel === null || rel === undefined) {
              r.reasons.push(`源目录不在挂载点内且无法换算（${t.source} vs ${m.mount_point}）`);
            } else {
              r.effective_source = rebasePath(m.mount_point, rel);
              r.mount_renamed = r.effective_source !== t.source;
            }
          }
          if (!existsSync(t.target || '')) r.reasons.push(`目标目录不存在：${t.target}`);
          else if (r.effective_source && !existsSync(r.effective_source)) r.reasons.push(`源目录不存在：${r.effective_source}`);
          r.ok = r.enabled && r.auto_sync_on_insert && !!r.mount && r.reasons.length === 0;
          return r;
        });
        send(res,200,{ success:true, mounts: mounts.map((m)=>({ mount_point:m.mount_point, uuid:m.uuid||'', label:m.label||'', fs_type:m.fs_type })), tasks:rows });
        return;
      }
      case '/stats': {
        const h = withTaskNames(loadHistory());
        const now = Math.floor(Date.now()/1000);
        let total=0, ok=0, partial=0, bytes=0, duration=0, files=0, deleted=0;
        let speedSum = 0, speedN = 0;
        const byTask = new Map(), errCount = new Map(), daily = new Map();
        let lastOk = 0, lastFail = 0;
        for (const e of h) {
          total++; if (e.success) ok++;
          if (e.partial) partial++;
          const b = e.bytes || 0, d = e.duration || 0;
          bytes += b; duration += d; files += (e.files||0); deleted += (e.deleted||0);
          // 亚秒级同步 duration 会取整成 0，所以另外统计有 speed_bps 的记录做平均
          if (e.speed_bps > 0) { speedSum += e.speed_bps; speedN++; }
          if (e.success && (e.finished_at||0) > lastOk) lastOk = e.finished_at || 0;
          if (!e.success && (e.finished_at||0) > lastFail) lastFail = e.finished_at || 0;
          const tk = e.task_id || '(未命名任务)';
          const t = byTask.get(tk) || { task_id: tk, task_name: e.task_name || '', total:0, ok:0, fail:0, bytes:0, duration:0 };
          t.total++; e.success ? t.ok++ : t.fail++;
          t.bytes += b; t.duration += d;
          if (!t.task_name && e.task_name) t.task_name = e.task_name;
          byTask.set(tk, t);
          if (!e.success) {
            const reason = (e.exit_meaning || e.message || '未知原因').slice(0, 60);
            errCount.set(reason, (errCount.get(reason) || 0) + 1);
          }
          const day = new Date(((e.finished_at||0) || 0) * 1000);
          if (!isNaN(day.getTime())) {
            const key = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
            const dd = daily.get(key) || { date: key, total:0, ok:0, fail:0, bytes:0 };
            dd.total++; e.success ? dd.ok++ : dd.fail++; dd.bytes += b;
            daily.set(key, dd);
          }
        }
        // 补齐最近 7 天（含 0 的日期，图表才有完整时间轴）
        const dailyArr = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date((now - i*86400) * 1000);
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          dailyArr.push(daily.get(key) || { date: key, total:0, ok:0, fail:0, bytes:0 });
        }
        const last24 = h.filter(e => (e.finished_at||0) >= now - 86400);
        send(res,200,{
          success:true, total, ok, fail:total-ok, partial, bytes, duration,
          success_rate: total ? Math.round(ok/total*1000)/10 : 0,
          avg_duration: total ? Math.round(duration/total) : 0,
          avg_speed: duration ? Math.round(bytes/duration) : (speedN ? Math.round(speedSum/speedN) : 0),
          avg_bytes: total ? Math.round(bytes/total) : 0,
          files, deleted, last_ok_at: lastOk, last_fail_at: lastFail,
          last24h: { total: last24.length, ok: last24.filter(e=>e.success).length,
                     fail: last24.filter(e=>!e.success).length,
                     bytes: last24.reduce((a,e)=>a+(e.bytes||0),0) },
          daily: dailyArr,
          by_task: [...byTask.values()].sort((a,b)=>b.total-a.total).slice(0,20),
          top_errors: [...errCount.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([reason,count])=>({ reason, count })),
        }); return;
      }
      case '/log': {
        const n = parseInt(readQuery(req).lines,10)||200;
        send(res,200,{ success:true, lines:readSyncLog(n).length, log:readSyncLog(n) }); return;
      }
      case '/browse': {
        const q = readQuery(req);
        const dir = q.path || '/';
        // root 参数把浏览范围锁在某个目录内（源目录限 USB 设备用）：
        // 越界一律拒绝，前端即使被改也出不了设备范围。
        const root = q.root ? (String(q.root).replace(/\/+$/, '') || '/') : '';
        if (root && root !== '/' && !isAllowedPath(root))
          return send(res,200,{success:false,error:'root not allowed'});
        if (root && dir !== root && !dir.startsWith(root + '/'))
          return send(res,200,{success:false,error:'路径超出所选 USB 设备范围'});
        // 浏览入口放行根目录 (/), 便于跨卷切换; 同步(/sync)仍用严格 isAllowedPath
        if (dir !== '/' && !isAllowedPath(dir))
          return send(res,200,{success:false,error:'path not allowed'});
        const meta = { root: root || null, at_root: !!(root && dir === root) };
        if (dir === '/') {
          // 动态列出根下真实卷目录 (volN / mnt / media)
          const rootEntries = [];
          try {
            for (const d of readdirSync('/')) {
              if (/^vol\d+$/.test(d)) rootEntries.push({ name:d, type:'dir' });
            }
          } catch {}
          rootEntries.push({ name:'mnt', type:'dir' }, { name:'media', type:'dir' });
          return send(res,200,{success:true, path:'/', entries:rootEntries, ...meta});
        }
        if (dir !== root && !dir.startsWith(root + '/'))
          return send(res,200,{success:false,error:'路径超出所选 USB 设备范围'});
        // 外接设备的挂载点占位目录（/vol00/<名字>）在设备没插或掉线时是 mode 000 的空目录：
        // root 读得进去，界面就显示成「空文件夹」，用户会以为盘里没内容 —— 直接说清楚。
        //
        // ⚠ 只对 /vol00 的直接子目录做这个判断。fnOS 的用户卷目录大量是
        //   `d---------+`（mode 000 + POSIX ACL，如 /vol1/1000、/vol1/1000/Photos），
        //   按「mode 000 就算占位」一刀切会把正常卷目录全部误判成「设备未连接」。
        try {
          const parent = dirname(dir);
          const isExtMountRoot = /^\/vol0+$/.test(parent);       // /vol00（外接设备挂载根）
          const mounted = currentMounts().some((m) => m.mount_point === dir);
          if (isExtMountRoot && !mounted && (statSync(dir).mode & 0o777) === 0) {
            return send(res,200,{success:false, code:'ENODEV', path:dir,
              error:'设备未连接（这是挂载点占位目录，插上或重新挂载后才可读）'});
          }
        } catch { /* 不存在等交给下面的 readdir 报 */ }
        let entries = [];
        let via = null;
        let failCode = null;
        try {
          for (const d of readdirSync(dir)) {
            const p = join(dir, d);
            // 单个子项 stat 失败（断掉的符号链接 / 子项自身无权限）不该让整层目录都打不开
            let isDir = false;
            try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
            entries.push({ name: d, type: isDir ? 'dir' : 'file' });
          }
        } catch (e0) {
          failCode = (e0 && e0.code) || 'EUNKNOWN';
          // exFAT / NTFS 走 fuse 挂载时默认「只允许挂载它的那个 uid 访问」，
          // 连 root 都会被拒（挂载时没带 allow_other 的话）。
          // 服务本身是 root，可以直接降权到该挂载的 owner 再读一次。
          if (failCode === 'EACCES' || failCode === 'EPERM') {
            const owner = ownerUidOf(mountForPath(dir, currentMounts()));
            const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
            if (owner && owner.uid !== selfUid) {
              try {
                entries = listAsUid(dir, owner);
                via = `uid:${owner.uid}(${owner.source})`;
                try { log(`browse ${dir}：root 无权限，改用 uid=${owner.uid} 读取成功（${owner.source}）`); } catch {}
              } catch (e1) {
                try { log(`browse ${dir}：降权到 uid=${owner.uid} 仍失败 ${e1.code || e1.message}`); } catch {}
              }
            }
          }
          if (!via) {
            // 以前一律回 'not a directory'：设备拔掉、目录 mode 000、fuse 只给特定 uid
            // 这几种完全不同的原因在界面上长得一模一样，用户只看到「无法读取」四个字。
            const m = mountForPath(dir, currentMounts());
            let msg;
            if (failCode === 'EACCES' || failCode === 'EPERM') {
              const owner = ownerUidOf(m);
              msg = owner && owner.uid !== 0
                ? `没有读取权限（${failCode}）：该盘由 uid=${owner.uid} 挂载，只有它能访问`
                : `没有读取权限（${failCode}）`;
            } else if (failCode === 'ENOENT') {
              msg = '目录不存在（设备可能已拔出）';
            } else if (failCode === 'ENOTDIR') {
              msg = '这不是一个目录';
            } else {
              msg = `无法读取目录（${failCode}）`;
            }
            try {
              log(`browse 失败 ${dir}: ${failCode}${m ? ` [挂载 ${m.mount_point} ${m.fstype}]` : ''}`);
            } catch {}
            return send(res,200,{success:false,code:failCode,error:msg,path:dir});
          }
        }
        entries.sort((a,b)=>a.name.localeCompare(b.name));
        send(res,200,{ success:true, path:dir, entries, ...meta, ...(via ? { via } : {}) }); return;
      }
      case '/diag_usb': {
        // USB 排查：大容量盘「浏览显示无权限」时看不出是哪一层挂了 ——
        // lsblk 认没认到、/proc/mounts 实际挂载参数、挂载点 mode/uid、readdir 的真实 errno，一次摊开。
        const out = { success:true, uid: typeof process.getuid === 'function' ? process.getuid() : null,
                      node: process.version, now: new Date().toISOString() };
        try {
          out.lsblk = JSON.parse(execFileSync('lsblk',
            ['-J','-b','-o','NAME,TYPE,RM,TRAN,FSTYPE,MOUNTPOINT,LABEL,UUID,SIZE,RO,PKNAME'],
            { encoding:'utf8', timeout:5000, maxBuffer: 4*1024*1024 }));
        } catch (e) { out.lsblkError = `${e.code||''} ${e.message}`.trim(); }
        let procMounts = '';
        try { procMounts = readFileSync('/proc/mounts','utf8'); } catch (e) { out.procMountsError = e.code; }
        try { out.devices = await collectUsbMounts(); } catch (e) { out.devicesError = e.message; }
        out.mounts = [];
        for (const d of (out.devices || [])) {
          const it = { device:d.device, mount_point:d.mount_point, fs_type:d.fs_type,
                       size:d.size, label:d.label, tran:d.tran, ro:d.ro };
          it.proc_mount = procMounts.split('\n').find((l) => l.split(' ')[1] === d.mount_point) || null;
          try {
            const st = statSync(d.mount_point);
            it.stat = { mode:'0' + (st.mode & 0o777).toString(8), uid:st.uid, gid:st.gid, isDir:st.isDirectory() };
          } catch (e) { it.statError = `${e.code||''} ${e.message}`.trim(); }
          try { it.realpath = realpathSync(d.mount_point); } catch (e) { it.realpathError = e.code; }
          try {
            const t0 = Date.now();
            const names = readdirSync(d.mount_point);
            it.readdir = { ok:true, count:names.length, ms:Date.now()-t0, sample:names.slice(0,5) };
          } catch (e) { it.readdir = { ok:false, code:e.code||null, message:e.message }; }
          it.allowed_by_app = isAllowedPath(d.mount_point);
          // 挂载 owner：fuse 挂载「只允许挂载它的那个 uid 读」，正是「大容量盘无权限」的头号嫌疑
          try {
            const owner = ownerUidOf(mountForPath(d.mount_point, currentMounts()));
            it.owner = owner;
            if (!it.readdir.ok && owner) {
              try {
                const list = listAsUid(d.mount_point, owner);
                it.as_owner = { ok:true, uid:owner.uid, count:list.length, sample:list.slice(0,5) };
              } catch (e2) { it.as_owner = { ok:false, uid:owner.uid, code:e2.code||null, message:e2.message }; }
            }
          } catch (e2) { it.ownerError = String((e2 && e2.message) || e2); }
          out.mounts.push(it);
        }
        // /vol00 下的挂载点占位目录：没挂载时是 000，正是「看着有目录、点进去无权限」的样子
        out.vol00 = [];
        try {
          for (const n of readdirSync('/vol00')) {
            const path = '/vol00/' + n;
            const rec = { name:n };
            try { const st = statSync(path); rec.mode = '0' + (st.mode & 0o777).toString(8); }
            catch (e) { rec.statError = e.code; }
            rec.mounted = procMounts.split('\n').some((l) => l.split(' ')[1] === path);
            out.vol00.push(rec);
          }
        } catch (e) { out.vol00Error = e.code || e.message; }
        send(res,200,out); return;
      }
      case '/config_export':
        send(res,200, loadTasks(), { download:'usbrsync-config.json' }); return;
      case '/save_file': {
        if (method !== 'POST') return send(res,405,{success:false,error:'POST required'});
        try {
          const o=JSON.parse(body||'{}');
          const dir=String(o.dir||''), kind=(o.kind==='log'?'log':'config');
          if (!isAllowedPath(dir)) return send(res,200,{success:false,error:'目标目录不在允许范围内'});
          // 文件名固定, 不接受外部传入, 防目录穿越
          const fname = kind==='log' ? 'usbrsync.log' : 'usbrsync-config.json';
          const target = join(dir, fname);
          // 内容一律由服务端自己取：原来 kind='log' 写的是客户端传来的 o.content，
          // 等于把「导出日志」变成「向任意允许目录写任意文本」的写原语。
          const content = kind==='log'
            ? readSyncLog(5000).join('\n')
            : JSON.stringify(loadTasks(), null, 2);
          writeFileSync(target, content, 'utf8');
          send(res,200,{success:true, path:target, size:Buffer.byteLength(content,'utf8')});
        } catch(e) { send(res,200,{success:false,error:'保存失败: '+e.message}); }
        return;
      }
      case '/config_import': {
        if (method !== 'POST') return send(res,405,{success:false,error:'POST required'});
        try {
          const o=JSON.parse(body||'{}');
          if (!o.sync_tasks) throw new Error('invalid');
          const v = validateTasksPayload(o);
          if (!v.ok) return send(res,200,{ success:false, error:`配置校验失败：${v.error}` });
          saveTasks(v.value); send(res,200,{success:true});
        }
        catch(e){ send(res,200,{success:false,error:'invalid config'}); }
        return;
      }
      default:
        send(res,404,{ success:false, error:`Not found: ${pathname}` });
    }
  } catch(e) {
    try { log(`api error ${pathname}: ${e.message}`); } catch {}
    res.headersSent || send(res,500,{ success:false, error:`服务器错误: ${e.message}` });
  }
}

function readQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function send(res, code, obj, extra={}) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type':'application/json',
    'Cache-Control':'no-cache',
    ...(extra.download?{'Content-Disposition':`attachment; filename="${extra.download}"`}:{}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise)=>{
    const bufs=[]; let total=0;
    req.on('data',c=>{total+=c.length; if(total>1048576){req.destroy(); rejectPromise(new Error('body too large'));return;} bufs.push(c);});
    req.on('end',()=>resolvePromise(Buffer.concat(bufs).toString('utf8')));
    req.on('error',()=>resolvePromise(''));
  });
}

// ── 静态文件 ───────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.txt':'text/plain; charset=utf-8','.log':'text/plain; charset=utf-8',
};
function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath).replace(/^\/+/,''); }
  catch { return send(res,400,{success:false,error:'bad request'}); }
  if (rel === '' ) rel = 'index.html';
  // 防止路径穿越 (join 后 realpath 校验真实物理路径, 防 symlink 跳出 www)
  const target = join(WWW_DIR, rel);
  let realTarget;
  try { realTarget = realpathSync(target); }
  catch { return send(res,404,{success:false,error:'not found'}); }
  if (!realTarget.startsWith(WWW_DIR + '/') && realTarget !== WWW_DIR) {
    return send(res,403,{success:false,error:'forbidden'});
  }
  if (!existsSync(realTarget) || !statSync(realTarget).isFile()) {
    return send(res,404,{success:false,error:'not found'});
  }
  const ext = realTarget.slice(realTarget.lastIndexOf('.')) || '';
  const body = readFileSync(realTarget);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ── HTTP server ────────────────────────────────────────────────
// PORT 模式(非网关 socket)下校验同源, 防本地 CSRF; socket 模式由 fnOS 网关鉴权
function originAllowed(req) {
  if (!PORT_MODE) return true;   // socket 模式: 网关注入鉴权
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;      // 同源/无来源(curl)放行
  try {
    return new URL(origin).host === req.headers.host;
  } catch { return false; }
}
const server = createServer(async (req, res) => {
  // PORT 模式跨域来源拒绝
  if (req.method !== 'GET' && !originAllowed(req)) {
    return send(res,403,{success:false,error:'cross-origin not allowed'});
  }
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // 网关前缀剥离: /app/usbrsync/... → 去掉前缀
  let p = pathname;

  // 兼容两种路径: /api/xxx 或直接的 /xxx (网关前缀已剥)
  if (p.startsWith('/app/usbrsync')) p = p.replace('/app/usbrsync','') || '/';

  let apiPath = p;
  let isApi = apiPath.startsWith('/api/');
  try {
    if (isApi) {
      await handleApi(apiPath.slice(4), req, res);  // /api/status → /status
    } else {
      serveStatic(req, res, p);
    }
  } catch(e) {
    try { log(`handler error: ${e.message}`); } catch {}
    if (!res.headersSent) send(res,500,{success:false,error:'server error'});
  }
});

// ── 启动 ───────────────────────────────────────────────────────
function start() {
  // 上次异常退出可能把 sync_status.json 留在 syncing，界面会一直显示「同步中」
  try {
    const st = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    if (st && st.status === 'syncing') {
      log('启动复位：上次退出时同步状态为 syncing，已重置为空闲');
      setSyncStatus('idle', 0, '', '上次同步被中断（进程重启）', '', 0);
    }
  } catch {}

  // 启动 daemon
  const daemon = createDaemon({ loadTasks, isAllowedPath, requestSync, log, loadPending, removePending });
  daemon.start();

  // 启动信号清理
  process.on('SIGTERM', () => { daemon.stop(); try{unlinkSync(SOCK_PATH);}catch{} process.exit(0); });
  process.on('SIGINT',  () => { daemon.stop(); try{unlinkSync(SOCK_PATH);}catch{} process.exit(0); });

  return new Promise((res, rej) => {
    if (PORT_MODE) {
      // 只绑回环：PORT 模式没有网关鉴权，绑 0.0.0.0 等于把全部 API 暴露到局域网
      server.listen(PORT_MODE, '127.0.0.1', () => {
        log(`usbrsync listening on http://127.0.0.1:${PORT_MODE}`);
        debug(`listening on :${PORT_MODE}`);
        res(server.address());
      });
      server.on('error', rej);
    } else {
      try { if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH); } catch {}
      server.listen(SOCK_PATH, () => {
        log(`usbrsync listening on ${SOCK_PATH}`);
        debug(`listening on ${SOCK_PATH}`);
        res({ socket: SOCK_PATH });
      });
      server.on('error', rej);
    }
  });
}

function debug(m){ console.log(`[usbrsync] ${m}`); }

// 进程级异常处理: 避免未捕获 promise 拒绝导致整个 server+daemon 崩溃
process.on('unhandledRejection', (reason) => {
  try { log(`unhandledRejection: ${reason?.stack||reason}`); } catch {}
});
process.on('uncaughtException', (err) => {
  try { log(`uncaughtException: ${err?.stack||err}`); } catch {}
  // 不要让异常把 running 卡住：否则之后所有同步都返回「已有同步正在运行」
  try {
    if (running) running = null;
    setSyncStatus('error', 0, '', '进程异常，已重置同步状态', '', 0);
  } catch {}
});

// 启动 (cmd/main 调用)
start().catch((e)=>{ console.error(`[usbrsync] startup failed: ${e.message}`); process.exit(1); });