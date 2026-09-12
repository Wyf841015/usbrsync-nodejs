#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// USB Rsync — rsync 执行核心 (Node.js v0.4.1)
// 构建 rsync 命令 + 后台执行 + 状态/进度追踪 + 重试/双向/停止 + 历史 + 通知
// ═══════════════════════════════════════════════════════════════
import { spawn, execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

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

// ── 检测目标文件系统 (exFAT/NTFS → --modify-window) ─────────────
function detectTargetFs(target) {
  try {
    const mounts = readFileSync('/proc/mounts','utf8').split('\n');
    let bestDepth = -1, bestFs = '';
    for (const line of mounts) {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const mp = parts[1], fs = parts[2];
      if (target === mp || target.startsWith(mp + '/')) {
        const depth = mp.split('/').length;
        if (depth > bestDepth) { bestDepth = depth; bestFs = fs.toLowerCase(); }
      }
    }
    return bestFs;
  } catch { return ''; }
}

// ── rsync 命令构建 ───────────────────────────────────────────────
export function buildRsyncCmd({ source, target, del=false, taskId=null, checksum=false, dry=false, keep=false }) {
  const cmd = ['rsync','-av','--info=progress2','--stats'];
  const { excluder } = _hook || {};
  const exclusions = excluder ? excluder(taskId) : [];
  for (const e of exclusions) if (e && typeof e === 'string') cmd.push('--exclude', e);
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
    execFile('du',['-sb',source],(e,o)=>{ if(!e) sc=parseInt(o.toString().split('\t')[0],10)||0; fin(); });
    execFile('du',['-sb',target],(e,o)=>{ if(!e) tc=parseInt(o.toString().split('\t')[0],10)||0; fin(); });
    execFile('find',[source,'-type','f'],(e,o)=>{ if(!e) sf=(o.toString().match(/\n/g)||[]).length; fin(); });
    execFile('find',[target,'-type','f'],(e,o)=>{ if(!e) tf=(o.toString().match(/\n/g)||[]).length; fin(); });
  });
}

// ── 解析 rsync 输出一行 → 进度 ──────────────────────────────────
function parseLine(line) {
  const m1 = line.match(/(\d+)%/);
  const m2 = line.match(/[\d.]+[KMGT]?B\/s/);
  return {
    pct: m1 ? parseInt(m1[1],10) : null,
    speed: m2 ? m2[0] : '',
    file: line.trim().slice(-200),
  };
}

// ── 单次 rsync 执行 ──────────────────────────────────────────────
// 接收已 spawn 的 child, 返回 Promise: { code, out }
// 超时策略: 无活动超时 (5 分钟无 stdout/stderr 输出才 kill, 防 /dev 挂死)
const EXEC_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟无输出才判卡死
function execRsync(child, synclog, onProgress) {
  return new Promise((res) => {
    let out = '', done = false;
    let lastActivity = Date.now();
    let timer = null;
    const fin = (code) => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        if (_hook?.log) _hook.log(`execRsync done code=${code} (stdout ${out.length}B)`);
        res({ code, out });
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
    child.stdout.on('data', (d) => {
      touch();
      const str = d.toString();
      out += str;
      if (synclog) { try { appendFileSync(synclog, str); } catch { if (_hook?.log) _hook.log('appendFileSync(sync.log) failed'); } }
      const lines = str.split(/\r?\n/);
      for (const line of lines) {
        const p = parseLine(line);
        if (p.pct !== null && onProgress) { try { onProgress(p); } catch (e) { if (_hook?.log) _hook.log(`onProgress err ${e.message}`); } }
      }
    });
    child.stderr.on('data', (d) => {
      touch();
      out += d.toString();  // stderr 也收进 out 用于失败原因判断 (如 change_dir failed)
      if (synclog) { try { appendFileSync(synclog, d.toString()); } catch {} }
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
    setStatus('syncing', 0, '', '正在准备同步...', '', 0);
    const startTs = new Date().toISOString();

    // 前向同步 (含重试)
    const maxRetry = (typeof opts.retry === 'number' && opts.retry >= 0) ? opts.retry : 0;
    const retryDelay = (typeof opts.delay === 'number' && opts.delay > 0) ? opts.delay : 5;
    let exitCode = -1;
    let attempt = 0;
    let out = '';
    let deadEncountered = false;  // 源/目标不可用 (USB拔出等), 即使 code 为 23 也算失败
    if (_hook?.log) _hook.log(`startSync cmd: ${cmd.join(' ')}`);
    for (attempt = 1; attempt <= maxRetry + 1; attempt++) {
      if (attempt > 1) setStatus('syncing', 0, '', `第 ${attempt} 次尝试`, '', 0);
      const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore','pipe','pipe'] });
      currentChild = child;
      const r = await execRsync(child, synclog, (p) => setStatus('syncing', p.pct, p.file, p.file, p.speed, 0));
      if (_hook?.log) _hook.log(`rsync attempt ${attempt} finished code=${r.code}`);
      if (stopRequested) break;
      // 23 可能是部分传输失败 —— 若 stderr 显示源/目标不可用 (USB拔出等), 判为失败并停止重试
      const deadMark = /change_dir .* failed|No such file or directory/.test(r.out);
      if (deadMark) deadEncountered = true;
      if ([0,24].includes(r.code) || (r.code === 23 && !deadMark)) { exitCode = r.code; out = r.out; break; }
      if (deadMark) break;  // 源/目标不可用, 立即重试无意义, 交待补机制处理
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
      const r = await execRsync(child2, synclog, (p) => setStatus('syncing', p.pct, p.file, p.file, p.speed, 0));
      if (stopRequested) exitCode = -999; else exitCode = r.code;
    }

    const end = epoch();
    const duration = end - start;

    // 结果判定
    let success = false, msg, level = 2;
    if (stopRequested) { success = false; msg = '已停止'; level = 2; }
    else if (exitCode === -1 && deadEncountered) { success = false; msg = '源/目标不可用 (设备可能已拔出)'; }
    else if ([0,23,24].includes(exitCode)) { success = true; msg = '同步完成'; level = 0; }
    else { msg = `同步失败 (rsync exit ${exitCode})`; }

    setStatus(success ? 'idle' : 'error', success ? 100 : 0, '', msg, '', 0);

    // 从日志提取传输统计
    let bytes = 0, files = 0;
    try {
      const tailSrc = readFileSync(synclog,'utf8').split('\n').slice(-100).join('\n');
      const bm = tailSrc.match(/Total transferred file size:\s*([\d,]+)/);
      const fm = tailSrc.match(/Number of regular files transferred:\s*([\d,]+)/);
      if (bm) bytes = parseInt(bm[1].replace(/,/g,''),10) || 0;
      if (fm) files = parseInt(fm[1].replace(/,/g,''),10) || 0;
    } catch {}

    // 差异对比 (源 vs 目标)
    let diffBytes = 0, synced = true;
    try {
      const { source_bytes, target_bytes } = await diffDirs(opts.source, opts.target);
      diffBytes = Math.max(0, source_bytes - target_bytes);
      synced = source_bytes === target_bytes;
    } catch {}

    // 写历史
    appendHistory({ task_id:opts.taskId, source:opts.source, target:opts.target, success,
                    message:msg, started_at:start, finished_at:end, duration, bytes, files,
                    exit_code:exitCode, attempts:attempt, diff_bytes:diffBytes, synced });

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

  return { status: 'running', message: '同步已开始', stop: () => { stopRequested = true; if (currentChild) { try { currentChild.kill('SIGTERM'); } catch {} } },
             donePromise };
  }

// 供 server.js 判断是否有 rsync 运行中 (由 server.js 维护 syncActive)
export { detectTargetFs };