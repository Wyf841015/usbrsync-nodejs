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
import { collectUsbMounts } from './usb.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(__dirname);   // *usbrsync 根 (target)
const VERSION = '0.4.5';

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
function log(msg) {
  const line = `${new Date().toISOString().replace('T',' ').slice(0,19)} - ${msg}\n`;
  try { writeFileSync(APP_LOG, line, {flag:'a'}); } catch {}
}
// 状态写盘节流: 进度刷新高频(每秒多次), 300ms 合并写, 原子替换防撕裂
let _statusTimer = null;
function setSyncStatus(s, p=0, f='', m='', sp='', n=0) {
  syncState = { status:s, progress:p, current_file:f, message:m, speed:sp, xfr_num:n };
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
function isAllowedPath(p) {
  if (!p || !p.startsWith('/')) return false;
  // 拒绝含 .. 分量 (路径穿越) 和原始含危险字符的路径
  if (p.split('/').includes('..')) return false;
  const allowed = new Set(ALLOWED_PATH_PREFIXES);
  // /vol 是前缀; 其余是精确前缀匹配 (/vol → /vol2, /vol3...)
  const okPrefix = (prefix) =>
    p === prefix || p.startsWith(prefix + '/') ||
    (prefix === '/vol' ? /^\/vol\d+(\/|$)/.test(p) : false);
  if (!ALLOWED_PATH_PREFIXES.some(okPrefix)) return false;
  // realpath 归一化后再校验一次 (防 symlink)
  try {
    const real = realpathSync(p);
    if (!ALLOWED_PATH_PREFIXES.some((prefix) => {
      if (prefix === '/vol') return /^\/vol\d+(\/|$)/.test(real);
      return real === prefix || real.startsWith(prefix + '/');
    })) return false;
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
function saveTasks(o) {
  // 唯一临时名防并发覆盖 (history clear 与 appendHistory 可能并发)
  const t = `${TASKS_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(t, JSON.stringify(o,null,2)); renameSync(t,TASKS_FILE);
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
  const rec = { task_id:item.task_id, source:item.source, target:item.target,
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
function requestSync(p) {
  return new Promise((res, rej) => {
    if (running) { res({ status:'busy', message:'已有同步正在运行' }); return; }
    if (!p.source || !p.target || !isAllowedPath(p.source) || !isAllowedPath(p.target)) {
      res({ status:'error', message:'路径不允许或缺失' }); return;
    }
    // 旋转日志
    rotateLog();
    // 后台启动
    const ctl = rsync.startSync({
      source:p.source, target:p.target, bidirectional:p.bidirectional,
      del:p.use_delete, taskId:p.task_id, retry:p.retry_count,
      delay:p.retry_delay, checksum:p.checksum, keep:p.keep_history, notify:p.notify,
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
    res({ status:'running', message:'同步已开始' });
  });
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
          try { const o=JSON.parse(body||'{}'); if (!o.sync_tasks) throw new Error('missing sync_tasks');
            saveTasks(o); send(res,200,{success:true}); }
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
        if (p.check_space !== false) {
          const cs = await rsync.checkSpace(p.source, p.target);
          if (!cs.ok) return send(res,200,{success:false,error:cs.reason||'目标空间不足'});
        }
        // 互斥最终防线 (checkSpace await 期间可能已有其他同步进入)
        if (syncRunning()) return send(res,200,{ success:false, error:'已有同步正在运行，请先停止或等待完成' });
        const r = await requestSync(p);
        return send(res,200,{ success:true, result:r });
      }
      case '/preview': {
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
        send(res,200,{ success:true, history:loadHistory() }); return;
      }
      case '/stats': {
        const h = loadHistory();
        let total=0,ok=0,bytes=0,duration=0;
        for (const e of h) { total++; if(e.success)ok++; bytes+=e.bytes||0; duration+=e.duration||0; }
        send(res,200,{ success:true,total,ok,fail:total-ok,bytes,duration }); return;
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
        let entries=[];
        try {
          for (const d of readdirSync(dir)) {
            const p=join(dir,d);
            entries.push({ name:d, type:statSync(p).isDirectory()?'dir':'file' });
          }
        } catch { return send(res,200,{success:false,error:'not a directory'}); }
        entries.sort((a,b)=>a.name.localeCompare(b.name));
        send(res,200,{ success:true, path:dir, entries, ...meta }); return;
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
          const content = kind==='log'
            ? String(o.content||'')
            : JSON.stringify(loadTasks(), null, 2);
          writeFileSync(target, content, 'utf8');
          send(res,200,{success:true, path:target, size:Buffer.byteLength(content,'utf8')});
        } catch(e) { send(res,200,{success:false,error:'保存失败: '+e.message}); }
        return;
      }
      case '/config_import': {
        try { const o=JSON.parse(body||'{}'); if (!o.sync_tasks) throw new Error('invalid');
          saveTasks(o); send(res,200,{success:true}); }
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
  // 启动 daemon
  const daemon = createDaemon({ loadTasks, isAllowedPath, requestSync, log, loadPending, removePending });
  daemon.start();

  // 启动信号清理
  process.on('SIGTERM', () => { daemon.stop(); try{unlinkSync(SOCK_PATH);}catch{} process.exit(0); });
  process.on('SIGINT',  () => { daemon.stop(); try{unlinkSync(SOCK_PATH);}catch{} process.exit(0); });

  return new Promise((res, rej) => {
    if (PORT_MODE) {
      server.listen(PORT_MODE, () => {
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
});

// 启动 (cmd/main 调用)
start().catch((e)=>{ console.error(`[usbrsync] startup failed: ${e.message}`); process.exit(1); });