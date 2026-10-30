#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// USB Rsync — rsync 执行核心 (Node.js v0.4.1)
// 构建 rsync 命令 + 后台执行 + 状态/进度追踪 + 重试/双向/停止 + 历史 + 通知
// ═══════════════════════════════════════════════════════════════
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 外部注入的依赖 (避免循环依赖)
let _hook = null;  // { setStatus, log, appendHistory, notify }
export function bindHook(hook) { _hook = hook; }

// ── rsync 可用性 ─────────────────────────────────────────────────
export function rsyncAvailable() {
  return new Promise((res) => execFile('rsync',['--version'],(e)=>res(!e)));
}

// ── 时间戳 (历史/backup-dir 用) ─────────────────────────────────
function ts() {
  const d = new Date();
  const p = (n,w=2) => String(n).padStart(w,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function epoch() { return Math.floor(Date.now()/1000); }

// ── /proc/mounts 的八进制转义（空格=\040 等）必须解码，否则带空格的
//    挂载点永远匹配不上 → 检测不到 exFAT → 漏 --modify-window
export function decodeMountEscapes(str) {
  return String(str).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

// ── 从 /proc/mounts 文本判定目标 fs（纯函数，便于测试）─────────
export function detectFsFromMounts(mountsText, target) {
  let bestDepth = -1, bestFs = '';
  for (const line of String(mountsText || '').split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const mp = decodeMountEscapes(parts[1]);
    const fs = parts[2];
    if (target === mp || String(target).startsWith(mp + '/')) {
      const depth = mp.split('/').length;
      if (depth > bestDepth) { bestDepth = depth; bestFs = String(fs).toLowerCase(); }
    }
  }
  return bestFs;
}

// ── 检测目标文件系统 (exFAT/NTFS → --modify-window) ─────────────
function detectTargetFs(target) {
  try { return detectFsFromMounts(readFileSync('/proc/mounts','utf8'), target); }
  catch { return ''; }
}

// ── 排除规则清洗：限条数/限长度/去重（配置来自用户，不能无限往 argv 里塞）──
export const MAX_EXCLUSIONS = 200;
export const MAX_EXCLUSION_LEN = 512;
export function sanitizeExclusions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || v.length > MAX_EXCLUSION_LEN) continue;
    if (out.includes(v)) continue;
    out.push(v);
    if (out.length >= MAX_EXCLUSIONS) break;
  }
  return out;
}

// ── rsync 命令构建 ───────────────────────────────────────────────
export function buildRsyncCmd({ source, target, del=false, taskId=null, checksum=false, dry=false, keep=false }) {
  const cmd = ['rsync','-av','--info=progress2','--stats'];
  const { excluder } = _hook || {};
  const exclusions = sanitizeExclusions(excluder ? excluder(taskId) : []);
  for (const e of exclusions) cmd.push('--exclude', e);
  if (del) cmd.push('--delete');
  if (checksum) cmd.push('--checksum');
  if (dry) cmd.push('--dry-run','--itemize-changes');
  if (keep && !dry) cmd.push('--backup', `--backup-dir=.rsync-history/${ts()}`);
  const fsType = detectTargetFs(target);
  if (['vfat','ntfs','exfat','fuseblk'].includes(fsType)) cmd.push('--modify-window=1');
  cmd.push(`${source.replace(/\/+$/,'')}/`, `${target.replace(/\/+$/,'')}/`);
  return cmd;
}

// ── 空间检查 ─────────────────────────────────────────────────────
// fail-closed: 无法确认空间足够时不放行 (返回 {ok:false, reason})
export function checkSpace(source, target) {
  return new Promise((res) => {
    execFile('du', ['-sb', source], {timeout:10000}, (e1, so1) => {
      if (e1) return res({ ok:false, reason:`无法获取源空间 (${e1.message})` });
      const need = parseInt((so1.toString().trim().split('\t')[0]) || '0', 10) || 0;
      execFile('df', ['-PB1', target], {timeout:10000}, (e2, so2) => {
        if (e2) return res({ ok:false, reason:`无法获取目标空间 (${e2.message})` });
        const last = so2.toString().trim().split('\n').pop() || '';
        const free = parseInt(last.split(/\s+/)[3] || '0', 10) || 0;
        res(Number.isFinite(need) ? { ok: free >= need, reason: free < need ? `目标可用 ${free} 字节 < 需要 ${need}` : '' } : { ok:true });
      });
    });
  });
}

// ── 源/目标 du 对比 ──────────────────────────────────────────────
export function diffDirs(source, target) {
  return new Promise((res) => {
    let sc=0, tc=0, sf=0, tf=0, pending=4;
    const fin = () => { if (--pending === 0) res({ source_bytes:sc, target_bytes:tc, source_files:sf, target_files:tf, same_size: sc===tc }); };
    // 每个调用都必须有超时：这些 await 在同步主体里，卡住会让 running 永不释放，
    // 之后所有同步都被判为「已有同步正在运行」。
    const OPT = { timeout: 120000, maxBuffer: 32 * 1024 * 1024 };
    execFile('du',['-sb',source],OPT,(e,o)=>{ if(!e) sc=parseInt(o.toString().split('\t')[0],10)||0; fin(); });
    execFile('du',['-sb',target],OPT,(e,o)=>{ if(!e) tc=parseInt(o.toString().split('\t')[0],10)||0; fin(); });
    execFile('find',[source,'-type','f'],OPT,(e,o)=>{ if(!e) sf=(o.toString().match(/\n/g)||[]).length; fin(); });
    execFile('find',[target,'-type','f'],OPT,(e,o)=>{ if(!e) tf=(o.toString().match(/\n/g)||[]).length; fin(); });
  });
}

// ── 解析 rsync --stats（纯函数，预检与结果统计共用）──────────────
// 注意 "Number of files: 1 (dir: 1)" 这种形态：空目录时没有 `reg:` 字段，
// 总数仍是 1（目录自身），所以删除护栏必须看 **reg 正则文件数**，不能看总数。
export function parseStats(text) {
  const src = String(text || '');
  const pick = (re) => { const m = src.match(re); return m ? parseInt(String(m[1]).replace(/,/g,''),10) || 0 : 0; };
  const regOf = (re) => {
    const line = src.match(re);
    if (!line) return 0;
    const inner = String(line[0]).match(/reg:\s*([\d,]+)/);
    return inner ? parseInt(inner[1].replace(/,/g,''),10) || 0 : 0;
  };
  return {
    files: pick(/Number of files:\s*([\d,]+)/),
    filesReg: regOf(/Number of files:[^\n]*/),
    deleted: pick(/Number of deleted files:\s*([\d,]+)/),
    deletedReg: regOf(/Number of deleted files:[^\n]*/),
    transferredBytes: pick(/Total transferred file size:\s*([\d,]+)/),
    totalFileSize: pick(/Total file size:\s*([\d,]+)/),
  };
}

// ── 删除护栏判据（纯函数）─────────────────────────────────────
// `--delete` 让目标成为源的镜像：源选错 / 设备没就绪 / 目录为空，目标会被整片删掉。
export function deleteGuard({ sourceFiles, deletes, ratio = 5 }) {
  if (!deletes || deletes <= 0) return { ok: true };
  if (!sourceFiles || sourceFiles <= 0) {
    return { ok: false, reason: `源目录里没有任何条目，却要删除目标中的 ${deletes} 项 —— 疑似设备未就绪或路径选错，已阻止` };
  }
  if (deletes > sourceFiles * ratio) {
    return { ok: false, reason: `预检将删除 ${deletes} 项，超过源目录条目数(${sourceFiles})的 ${ratio} 倍 —— 疑似源路径选错，已阻止` };
  }
  return { ok: true };
}

// ── 预检：一次 dry-run 同时拿到「要写入多少字节」和「会删掉多少项」──
// 取代原先每次同步都跑的 `du -sb` 全盘扫描（大卷上极慢，超时还会把同步误拦）。
export function preflight({ source, target, del = false, checksum = false, taskId = null, timeoutMs = 180000 }) {
  const cmd = buildRsyncCmd({ source, target, del, taskId, checksum, dry: true, keep: false });
  return new Promise((resolve) => {
    execFile(cmd[0], cmd.slice(1), { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (e, so) => {
      if (e) {
        const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
        return resolve({ ok: false, timedOut, reason: timedOut ? `预检超时（>${Math.round(timeoutMs/1000)}s）` : `预检失败 (${e.message})`, stats: null });
      }
      resolve({ ok: true, timedOut: false, stats: parseStats(so) });
    });
  });
}

// ── 目标可用空间（df）──────────────────────────────────────────
export function freeBytes(target, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile('df', ['-PB1', target], { timeout: timeoutMs }, (e, so) => {
      if (e) return resolve(null);
      const last = String(so || '').trim().split('\n').pop() || '';
      const free = parseInt(last.split(/\s+/)[3] || '0', 10);
      resolve(Number.isFinite(free) ? free : null);
    });
  });
}

// ── 设备是否已丢失（纯函数）：只有「整目录进不去」才算掉盘，
//    单个文件在同步中消失（rsync 23/24）是正常局部失败，不能整单判失败
export function isDeviceLost({ out, source, target, exists = existsSync }) {
  const text = String(out || '');
  if (/change_dir .* failed/.test(text)) return true;
  if (/No space left on device/.test(text)) return false;
  if (!exists(source) || !exists(target)) return true;
  return false;
}

// ── rsync 退出码含义（历史记录里直接给人看，不是数字）──────────
const RSYNC_EXIT_MEANING = {
  0: '成功', 1: '语法或用法错误', 2: '协议不兼容', 3: '路径/目录选择错误',
  4: '请求的功能不被支持', 5: '客户端与服务端协议版本不匹配', 6: '日志文件打开失败',
  10: '网络 socket IO 错误', 11: '文件 IO 错误', 12: '协议数据流错误',
  13: '权限不足或目录不存在', 14: '内存分配失败', 20: '收到 SIGUSR1/SIGINT',
  21: 'waitpid 出错', 22: 'malloc 缓冲区错误', 23: '部分文件传输失败',
  24: '传输中源文件消失（已跳过）', 25: '达到 --max-delete 上限', 30: '数据超时',
  35: '服务端连接超时',
};
export function exitMeaning(code) {
  if (code === -1) return '进程被中止（超时或强制结束）';
  if (code === -999) return '用户手动停止';
  return RSYNC_EXIT_MEANING[code] || `未知退出码 ${code}`;
}

// ── 从输出里挑出错误行（历史里展示失败原因，不用翻日志）────────
export function extractErrors(out, limit = 5) {
  const seen = new Set();
  const res = [];
  // 进度输出用 \r 刷新，错误行常被拼在进度行后面
  // 例: "\r    0 100%  0.00kB/s 0:00:00 (xfr#0, to-chk=0/0)rsync: [sender] change_dir ... failed"
  // 所以既要按 \r 也要按 \n 切，还要把关键字的起点截出来
  for (const raw of String(out || '').split(/[\r\n]+/)) {
    let line = raw.trim();
    if (!line) continue;
    const cut = line.search(/rsync(?: error)?:|cp:|mkstemp|send_files|recv_files|symlink|readlink|failed|denied|No space|Cannot|Invalid|error:/i);
    if (cut < 0) continue;
    if (cut > 0) line = line.slice(cut).trim();
    if (/^\d+\s+\d+%/.test(line)) continue;          // 进度行不算错误
    const key = line.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    res.push(line.slice(0, 300));
    if (res.length >= limit) break;
  }
  return res;
}

// ── 备份目录清理（keep_history 会一直堆 .rsync-history/<ts>）────
export function pruneBackupDirs(target, keep = 10) {
  const dir = join(target, '.rsync-history');
  try {
    const names = readdirSync(dir).filter((n) => /^\d{14}$/.test(n)).sort();
    const drop = names.slice(0, Math.max(0, names.length - keep));
    for (const n of drop) { try { rmSync(join(dir, n), { recursive: true, force: true }); } catch {} }
    if (drop.length && _hook?.log) _hook.log(`备份历史已清理 ${drop.length} 个旧版本（保留最近 ${keep} 个）`);
    return drop.length;
  } catch { return 0; }
}

// ── 解析 rsync 输出一行 → 进度 ──────────────────────────────────
// ── 解析一行 rsync 输出（纯函数，导出供测试）────────────────────
// progress2 形如:  "   1,234,567  45%   1.23MB/s    0:00:03 (xfr#12, to-chk=345/1234)"
//  - 第 1 列是「已处理的字节数」，第 2 列是百分比，第 3 列速度，第 4 列剩余时间
//  - xfr# = 本次已传输文件数, to-chk=剩余待检查/总数
export function parseProgressLine(line) {
  const out = { pct: null, speed: '', eta: '', bytes: null, xfr: null, toChk: null, total: null,
                file: '', itemized: false, deleted: false };
  const s = String(line || '');

  // 传输统计行
  const mb = s.match(/^\s*([\d,]+)\s+(\d+)%/);
  if (mb) {
    out.bytes = parseInt(mb[1].replace(/,/g, ''), 10);
    out.pct = parseInt(mb[2], 10);
    const ms = s.match(/([\d.]+\s*[kKMGT]?B\/s)/);
    if (ms) out.speed = ms[1].replace(/\s+/g, '');
    const me = s.match(/(\d+:\d{2}:\d{2}|\d+:\d{2})/);
    if (me) out.eta = me[1];
    const mx = s.match(/xfr#(\d+)/);
    if (mx) out.xfr = parseInt(mx[1], 10);
    const mc = s.match(/(?:to-chk|ir-chk)=(\d+)\/(\d+)/);
    if (mc) { out.toChk = parseInt(mc[1], 10); out.total = parseInt(mc[2], 10); }
    return out;
  }

  // 删除行: "*deleting   path"
  const md = s.match(/^\*deleting\s+(.+)$/);
  if (md) { out.deleted = true; out.file = md[1].trim(); return out; }

  // itemize 行: ">f+++++++++ path" / "cd+++++++++ path" / "*deleting"... 其余作当前文件
  const mi = s.match(/^[<>ch*.][fdLDS][^\s]*\s+(.+)$/);
  if (mi) { out.itemized = true; out.file = mi[1].trim(); return out; }

  // 其他行（错误/提示）保留尾部作为当前行
  out.file = s.trim().slice(-200);
  return out;
}

// ── 单次 rsync 执行 ──────────────────────────────────────────────
// 接收已 spawn 的 child, 返回 Promise: { code, out }
// 超时策略: 无活动超时 (5 分钟无 stdout/stderr 输出才 kill, 防 /dev 挂死)
const EXEC_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无输出才判卡死
const OUT_TAIL_BYTES = 256 * 1024;          // 内存里只保留输出尾部（失败判定/统计都在尾部）
const LOG_FLUSH_MS = 400;                   // 日志按批落盘，避免每个 chunk 都同步写盘
function execRsync(child, synclog, onProgress) {
  return new Promise((res) => {
    let out = '', done = false;
    let lastActivity = Date.now();
    let timer = null;
    let buf = '', flushTimer = null;
    const flush = () => {
      if (!synclog || !buf) { buf = ''; return; }
      const chunk = buf; buf = '';
      try { appendFileSync(synclog, chunk); }
      catch { if (_hook?.log) _hook.log('appendFileSync(sync.log) failed'); }
    };
    const pushLog = (str) => {
      if (!synclog) return;
      buf += str;
      if (buf.length >= 64 * 1024) { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flush(); return; }
      if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, LOG_FLUSH_MS);
    };
    const fin = (code) => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        flush();
        if (_hook?.log) _hook.log(`execRsync done code=${code} (stdout ${out.length}B, 传输 ${filesTransferred} 文件, 删除 ${deletedCount})`);
        // progress2 下只有 xfr# 能反映真实传输文件数，itemize 计数仅作兜底
        res({ code, out, filesTransferred: Math.max(filesTransferred, maxXfr), deletedCount });
      }
    };
    const touch = () => { lastActivity = Date.now(); };
    const resetIdleTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!done && Date.now() - lastActivity >= EXEC_IDLE_TIMEOUT_MS) {
          if (_hook?.log) _hook.log(`execRsync IDLE TIMEOUT ${EXEC_IDLE_TIMEOUT_MS/1000}s (no output)`);
          try { child.kill('SIGKILL'); } catch {}
          fin(-1);
        } else {
          // 有活动则重新计时
          resetIdleTimer();
        }
      }, EXEC_IDLE_TIMEOUT_MS);
    };
    if (_hook?.log) _hook.log(`execRsync spawned pid=${child.pid}`);
    let filesTransferred = 0, deletedCount = 0, maxXfr = 0;
    child.stdout.on('data', (d) => {
      touch();
      const str = d.toString();
      out = (out + str).slice(-OUT_TAIL_BYTES);
      pushLog(str);
      const lines = str.split(/\r?\n/);
      let lastP = null;
      for (const line of lines) {
        if (line.startsWith('>f')) filesTransferred++;
        const p = parseProgressLine(line);
        if (p.deleted) deletedCount++;
        if (p.xfr && p.xfr > maxXfr) maxXfr = p.xfr;
        if (p.pct !== null || p.itemized) lastP = p;
      }
      if (lastP && onProgress) {
        // progress2 会抑制逐文件 itemize 行，所以「已传输文件数」优先用 xfr#（rsync 自报），
        // itemize 计数只作为兜底（老版本 rsync 或非 progress2 场景）
        const transferred = Math.max(filesTransferred, lastP.xfr || 0);
        try { onProgress({ ...lastP, filesTransferred: transferred, deletedCount }); }
        catch (e) { if (_hook?.log) _hook.log(`onProgress err ${e.message}`); }
      }
    });
    child.stderr.on('data', (d) => {
      touch();
      const str = d.toString();
      out = (out + str).slice(-OUT_TAIL_BYTES);  // stderr 也收进尾部用于失败原因判断
      pushLog(str);
    });
    child.on('error', (e) => {
      try { if (_hook?.log) _hook.log(`rsync spawn error: ${e.message}`); } catch {}
      fin(-1);
    });
    child.on('close', (code) => fin(code ?? -1));
    // 启动无活动超时
    resetIdleTimer();
  });
}

// ── 后台执行一次完整同步 (含重试/双向/历史/通知) ────────────────
// opts: { source, target, bidirectional, del, taskId, retry, delay, checksum, keep, notify }
// 返回立即的 { status, message }; 完整结果通过 asyncOnDone 回调
export function startSync(opts, { setStatus, synclog, appendHistory, notify }) {
  // 前置: rsync 可用性 / 互斥已在 API 层检查, 这里只构建命令
  const cmd = buildRsyncCmd({ source:opts.source, target:opts.target, del:opts.del, taskId:opts.taskId,
                              checksum:opts.checksum, dry:false, keep:opts.keep });

  let stopRequested = false;
  let currentChild = null;
  let _resolveDone = null;
  const donePromise = new Promise((res) => { _resolveDone = res; });

  // 异步主体 (在后台运行, 不阻塞 HTTP 返回)
  const body = (async () => {
    const start = epoch();
    setStatus('syncing', 0, '', '正在准备同步...', '', 0, { started_at: start, bytes_total: opts.totalBytes || null });
    const startTs = new Date().toISOString();

    // 前向同步 (含重试)
    const maxRetry = (typeof opts.retry === 'number' && opts.retry >= 0) ? opts.retry : 0;
    const retryDelay = (typeof opts.delay === 'number' && opts.delay > 0) ? opts.delay : 5;
    let exitCode = -1;
    let attempt = 0;
    let out = '';
    let lastRun = { filesTransferred: 0, deletedCount: 0 };
    let deadEncountered = false;  // 源/目标根目录不可用 (USB拔出等)
    // keep_history: 先清理过旧的备份快照，否则 .rsync-history 会无限堆积占满目标盘
    if (opts.keep) { try { pruneBackupDirs(opts.target, 10); } catch {} }
    if (_hook?.log) _hook.log(`startSync cmd: ${cmd.join(' ')}`);
    for (attempt = 1; attempt <= maxRetry + 1; attempt++) {
      if (attempt > 1) setStatus('syncing', 0, '', `第 ${attempt} 次尝试`, '', 0);
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore','pipe','pipe'] });
      currentChild = child;
      const r = await execRsync(child, synclog, (p) => setStatus('syncing', p.pct ?? 0, p.file, p.file, p.speed || '', p.xfr || 0, {
        bytes_done: p.bytes, bytes_total: opts.totalBytes || null,
        eta: p.eta || '', files_total: p.total, files_left: p.toChk,
        files_done: p.filesTransferred || 0, deleted_done: p.deletedCount || 0,
        started_at: start,
      }));
      if (_hook?.log) _hook.log(`rsync attempt ${attempt} finished code=${r.code}`);
      lastRun = { filesTransferred: r.filesTransferred || 0, deletedCount: r.deletedCount || 0 };
      if (stopRequested) break;
      // 只有「整目录进不去」才算掉盘；单个文件在同步中消失（rsync 23/24）
      // 属于正常局部失败，不能整单判失败（否则会白占了 pending 的重试次数）
      const deadMark = isDeviceLost({ out: r.out, source: opts.source, target: opts.target });
      if (deadMark) {
        deadEncountered = true;
        // 保留真实退出码与输出：否则历史里 exit_code 只能是 -1、errors 为空，
        // 用户看不到 "No such file or directory" 这种关键信息
        exitCode = r.code === 0 ? -1 : r.code;
        out = r.out;
        break;   // 源/目标不可用, 立即重试无意义, 交待补机制处理
      }
      if ([0,24].includes(r.code) || r.code === 23) { exitCode = r.code; out = r.out; break; }
      if (attempt <= maxRetry) {
        setStatus('syncing', 0, '', `第 ${attempt} 次失败，${retryDelay} 秒后重试`, '', 0);
        await new Promise((r2) => setTimeout(r2, retryDelay * 1000));
      } else { exitCode = r.code; out = r.out; }
    }

    // 双向: 反向同步 (不用 --delete)
    if (opts.bidirectional && !stopRequested && [0,23,24].includes(exitCode)) {
      const revCmd = buildRsyncCmd({ source:opts.target, target:opts.source, del:false, taskId:opts.taskId,
                                     checksum:opts.checksum, dry:false, keep:opts.keep });
      const child2 = spawn(revCmd[0], revCmd.slice(1), { stdio:['ignore','pipe','pipe'] });
      currentChild = child2;
      if (opts.keep) { try { pruneBackupDirs(opts.source, 10); } catch {} }
      const r = await execRsync(child2, synclog, (p) => setStatus('syncing', p.pct ?? 0, p.file, '反向同步: ' + p.file, p.speed || '', p.xfr || 0, {
        bytes_done: p.bytes, bytes_total: null, eta: p.eta || '',
        files_done: p.filesTransferred || 0, deleted_done: p.deletedCount || 0, started_at: start,
      }));
      if (stopRequested) exitCode = -999; else exitCode = r.code;
      out = (out + r.out).slice(-OUT_TAIL_BYTES);
    }

    const end = epoch();
    const duration = end - start;

    // 结果判定
    let success = false, msg, level = 2;
    if (stopRequested) { success = false; msg = '已停止'; level = 2; }
    else if (exitCode === -1 && deadEncountered) { success = false; msg = '源/目标不可用 (设备可能已拔出)'; }
    else if (deadEncountered) { success = false; msg = '源/目标不可用 (设备可能已拔出)'; }
    else if (exitCode === 0) { success = true; msg = '同步完成'; level = 0; }
    else if (exitCode === 23) { success = true; msg = '同步完成（部分文件未能传输，见日志）'; level = 1; }
    else if (exitCode === 24) { success = true; msg = '同步完成（部分源文件在传输中消失，已跳过）'; level = 1; }
    else { msg = `同步失败 (rsync exit ${exitCode})`; }

    setStatus(success ? 'idle' : 'error', success ? 100 : 0, '', msg, '', 0);

    // 传输统计：直接从本次输出尾部解析（原来每次都要整份读 sync.log，5MB 级很贵）
    let bytes = 0, files = 0;
    try {
      const st = parseStats(out);
      bytes = st.transferredBytes || 0;
      const fm = String(out).match(/Number of regular files transferred:\s*([\d,]+)/);
      files = fm ? (parseInt(fm[1].replace(/,/g,''),10) || 0) : (st.files || 0);
    } catch {}

    // 差异对比 (源 vs 目标)
    let diffBytes = 0, synced = true;
    try {
      const { source_bytes, target_bytes } = await diffDirs(opts.source, opts.target);
      diffBytes = Math.max(0, source_bytes - target_bytes);
      synced = source_bytes === target_bytes;
    } catch {}

    // 写历史
    appendHistory({
      task_id: opts.taskId, task_name: opts.taskName || '', source:opts.source, target:opts.target, success,
      message:msg, started_at:start, finished_at:end, duration, bytes, files,
      exit_code:exitCode, attempts:attempt, diff_bytes:diffBytes, synced,
      // ── 新增：让人不用翻日志就能看懂这次同步 ──
      exit_meaning: deadEncountered ? '源/目标不可用（设备可能已拔出）' : exitMeaning(exitCode),
      partial: !deadEncountered && (exitCode === 23 || exitCode === 24),
      files_done: lastRun.filesTransferred,
      // progress2 会抑制 "*deleting" 输出行，所以删除数取 --stats 的
      // "Number of deleted files"，itemize 计数只作兜底
      deleted: (() => {
        const st = parseStats(out || '');
        return (st.deletedReg || st.deleted) || lastRun.deletedCount;
      })(),
      bytes_total: opts.totalBytes || 0,
      // 平均速度：优先用 rsync 自己报的 bytes/sec（亚秒级同步时 duration 会取整成 0，
      // 光算 bytes/duration 会得到 0），再用 bytes/duration 兜底
      speed_bps: (() => {
        const m = String(out || '').match(/([\d,.]+)\s+bytes\/sec/);
        if (m) { const v = parseInt(m[1].replace(/[,.](?=\d{3}\b)/g,''), 10); if (v > 0) return v; }
        return duration > 0 ? Math.round(bytes / duration) : 0;
      })(),
      bidirectional: !!opts.bidirectional,
      checksum: !!opts.checksum,
      use_delete: !!opts.del,
      errors: success ? [] : extractErrors(out || '', 5),
    });

    // 通知
          if (opts.notify && notify) {
            notify(success ? '同步完成' : '同步失败', `${opts.source} → ${opts.target}，${msg}`, level);
          }
          if (_resolveDone) _resolveDone({ success, message: msg, exit_code: exitCode });
        })().catch((e) => {
          try { if (_hook?.log) _hook.log(`sync body error: ${e.message}`); } catch {}
          setStatus('error', 0, '', `同步异常: ${e.message}`, '', 0);
          if (_resolveDone) _resolveDone({ success:false, message:`同步异常: ${e.message}`, exit_code:-999 });
        });

  // stop: 先 SIGTERM，10s 仍未退出则 SIGKILL。
  // 只发 SIGTERM 的话，卡在 IO 上的 rsync 会不响应，用户看到「停止中」但进程还在写目标。
  const stop = () => {
    stopRequested = true;
    const child = currentChild;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch {}
    const t = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { if (_hook?.log) _hook.log(`rsync 未响应 SIGTERM，10s 后强制 SIGKILL pid=${child.pid}`); } catch {}
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 10000);
    if (typeof t.unref === 'function') t.unref();
  };

  return { status: 'running', message: '同步已开始', stop, donePromise };
  }

// 供 server.js 判断是否有 rsync 运行中 (由 server.js 维护 syncActive)
export { detectTargetFs };