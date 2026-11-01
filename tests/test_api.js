// usbrsync-nodejs 测试套件
// spawn 真实 Node server (端口模式) → 端到端 HTTP 验证
// 用法: node --test tests/
// 需要 Node 18+ (全局 fetch)

// 版本号以 manifest 为准, 升版无需改测试
const MANIFEST_VERSION = readFileSync(new URL('../manifest', import.meta.url), 'utf8')
  .match(/^version\s+=\s+(\S+)\s*$/m)[1];
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const SERVER = join(PROJECT_DIR, 'ui', 'server.js');
const TEST_PORT = 47988;
const TEST_DATA = '/tmp/usbrsync-nodejs_test';
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let server = null;
let logTail = '';

function startServer() {
  return new Promise((resolve, reject) => {
    rmSync(TEST_DATA, { recursive: true, force: true });
    mkdirSync(TEST_DATA, { recursive: true });
    server = spawn('node', [SERVER], {
      env: { ...process.env, TRM_PKGVAR: TEST_DATA, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', d => { logTail += d.toString(); });
    server.stderr.on('data', d => { logTail += d.toString(); });
    const tryReady = (n) => {
      if (n <= 0) return reject(new Error('server start timeout:\n' + logTail));
      healthCheck().then(resolve).catch(() => setTimeout(() => tryReady(n - 1), 300));
    };
    tryReady(20);
  });
}

function healthCheck() {
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const t = setTimeout(() => { ctl.abort(); reject(new Error('timeout')); }, 1500);
    fetch(`${BASE}/app/usbrsync/api/status`, { signal: ctl.signal })
      .catch(() => { clearTimeout(t); reject(new Error('conn')); })
      .then(() => { clearTimeout(t); resolve(); });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('close', () => resolve());
    server.kill('SIGTERM');
    setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 2000);
  });
}

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const resp = await fetch(`${BASE}/app/usbrsync${path}`, opts);
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, body: json };
}

test('usbrsync-nodejs server E2E', { timeout: 30000 }, async (t) => {
  await startServer();
  t.after(() => stopServer());

  await t.test('status endpoint', async () => {
    const r = await api('/api/status');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.version, MANIFEST_VERSION);
  });

  await t.test('static index.html', async () => {
    const resp = await fetch(`${BASE}/app/usbrsync/`);
    assert.strictEqual(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('USB RSYNC'));
  });

  await t.test('static css/js', async () => {
    const c = await fetch(`${BASE}/app/usbrsync/css/style.css`);
    assert.strictEqual(c.status, 200);
    const j = await fetch(`${BASE}/app/usbrsync/js/main.js`);
    assert.strictEqual(j.status, 200);
  });

  await t.test('save + load tasks', async () => {
    const r1 = await api('/api/tasks', 'POST', { sync_tasks: [{ id:'t1', name:'测试', source:'/tmp/a', target:'/tmp/b', keep_history:true }], exclusions: [] });
    assert.strictEqual(r1.body.success, true);
    const r2 = await api('/api/tasks');
    assert.strictEqual(r2.body.tasks.sync_tasks.length, 1);
    assert.strictEqual(r2.body.tasks.sync_tasks[0].keep_history, true);
  });

  await t.test('sync rejects bad path', async () => {
    const r = await api('/api/sync', 'POST', { source:'/etc/passwd', target:'/tmp/b' });
    assert.strictEqual(r.body.success, false);
  });

  await t.test('diff rejects bad path', async () => {
    const r = await api('/api/diff?source=/etc&target=/tmp');
    assert.strictEqual(r.body.success, false);
  });

  await t.test('browse /tmp', async () => {
    const r = await api('/api/browse?path=/tmp');
    assert.strictEqual(r.body.success, true);
  });

  // 回归：fnOS 用户卷目录大量是 `d---------+`（mode 000 + POSIX ACL，
  // 例如 /vol1/1000、/vol1/1000/Photos）。曾经把「mode 000 且不是挂载点」
  // 一律判成 /vol00 的设备占位目录，导致选 /vol1/1000 下任何目录都报「设备未连接」。
  await t.test('browse: mode 000 的普通目录仍可浏览（不得误判为设备占位）', async () => {
    const base = mkdtempSync(join(tmpdir(), 'usbrsync-mode000-'));
    const locked = join(base, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'a.txt'), 'x');
    chmodSync(locked, 0o000);
    t.after(() => { try { chmodSync(locked, 0o755); } catch {} rmSync(base, { recursive: true, force: true }); });
    const r = await api(`/api/browse?path=${encodeURIComponent(locked)}`);
    // 关键断言：不能返回 ENODEV（设备未连接）。
    // 测试进程不是 root，自己读不了 mode 000 的目录会返回 EACCES —— 那是正常的权限报错，
    // 与「挂载点占位目录」是两码事。
    assert.notStrictEqual(r.body.code, 'ENODEV', `被误判成设备占位：${r.body.error}`);
    if (r.body.success) assert.ok((r.body.entries || []).some((e) => e.name === 'a.txt'));
  });

  await t.test('404 unknown api', async () => {
    const r = await api('/api/nonexistent');
    assert.strictEqual(r.status, 404);
  });

  // ── P0-1 删除护栏（真实 rsync 预检）────────────────────────
  await t.test('sync: --delete 在源目录为空时被阻止', async () => {
    const fs = await import('node:fs');
    const base = '/tmp/usbrsync-guard';
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(`${base}/src`, { recursive: true });
    fs.mkdirSync(`${base}/tgt`, { recursive: true });
    fs.writeFileSync(`${base}/tgt/keep1.txt`, 'x');
    fs.writeFileSync(`${base}/tgt/keep2.txt`, 'y');
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    const r = await api('/api/sync', 'POST', {
      source: `${base}/src`, target: `${base}/tgt`, use_delete: true,
    });
    assert.equal(r.body.success, false, '应被拒绝');
    assert.match(r.body.error || '', /源目录里没有任何条目/);
    // 目标文件必须原样还在（护栏生效的硬证据）
    assert.ok(fs.existsSync(`${base}/tgt/keep1.txt`));
    assert.ok(fs.existsSync(`${base}/tgt/keep2.txt`));
  });

  await t.test('sync: --delete 正常清理放行并完成', async () => {
    const fs = await import('node:fs');
    const base = '/tmp/usbrsync-guard2';
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(`${base}/src`, { recursive: true });
    fs.mkdirSync(`${base}/tgt`, { recursive: true });
    fs.writeFileSync(`${base}/src/a.txt`, 'aaa');
    fs.writeFileSync(`${base}/tgt/stale.txt`, 'old');
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    const r = await api('/api/sync', 'POST', {
      source: `${base}/src`, target: `${base}/tgt`, use_delete: true, notify: false,
    });
    assert.equal(r.body.success, true, `应被放行: ${JSON.stringify(r.body)}`);

    // 等同步跑完（最多 15s）
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const st = await api('/api/status');
      if (st.body.sync?.status !== 'syncing') break;
      await new Promise((res) => setTimeout(res, 300));
    }
    assert.ok(fs.existsSync(`${base}/tgt/a.txt`), '新文件应已同步');
    assert.ok(!fs.existsSync(`${base}/tgt/stale.txt`), '多余文件应被删除');
  });


  await t.test('browse: root 参数锁定浏览范围', async () => {
    const fs = await import('node:fs');
    const rootA = '/tmp/usbrsync-browse-a';
    const rootB = '/tmp/usbrsync-browse-b';
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
    fs.mkdirSync(`${rootA}/sub`, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    t.after(() => { fs.rmSync(rootA, { recursive: true, force: true }); fs.rmSync(rootB, { recursive: true, force: true }); });

    const enc = encodeURIComponent;
    // 1) root 本身可浏览，并标记 at_root
    const atRoot = await api(`/api/browse?path=${enc(rootA)}&root=${enc(rootA)}`);
    assert.strictEqual(atRoot.body.success, true);
    assert.strictEqual(atRoot.body.at_root, true);
    assert.strictEqual(atRoot.body.root, rootA);
    assert.ok(atRoot.body.entries.some((e) => e.name === 'sub'));

    // 2) root 的子目录可浏览，at_root=false
    const sub = await api(`/api/browse?path=${enc(rootA + '/sub')}&root=${enc(rootA)}`);
    assert.strictEqual(sub.body.success, true);
    assert.strictEqual(sub.body.at_root, false);

    // 3) 越界到 root 外 → 拒绝
    const out = await api(`/api/browse?path=${enc(rootB)}&root=${enc(rootA)}`);
    assert.strictEqual(out.body.success, false);
    assert.match(out.body.error, /超出所选 USB 设备范围/);

    // 4) 越界到父目录 → 拒绝
    const up = await api(`/api/browse?path=${enc('/tmp')}&root=${enc(rootA)}`);
    assert.strictEqual(up.body.success, false);

    // 5) root 含 ../ → 由 isAllowedPath 拦下
    const evil = await api(`/api/browse?path=${enc(rootA + '/..')}&root=${enc(rootA)}`);
    assert.strictEqual(evil.body.success, false);

    // 6) 不带 root（目标目录浏览）仍可跨卷
    const free = await api('/api/browse?path=%2Fvol1');
    assert.strictEqual(free.body.success, true);
    assert.strictEqual(free.body.root, null);
  });

  // ── 接口面加固（P1-2/P1-3/P1-7/P2-1/P2-8）──────────────────
  await t.test('sync_stop / preview / config_import 必须是 POST', async () => {
    for (const p of ['/api/sync_stop', '/api/preview', '/api/config_import']) {
      const r = await api(p, 'GET');
      assert.equal(r.status, 405, `${p} GET 应返回 405，实际 ${r.status}`);
    }
  });

  await t.test('save_file: 忽略客户端传入内容，写服务端真实日志', async () => {
    const fs = await import('node:fs');
    const dir = '/tmp/usbrsync-savefile';
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const r = await api('/api/save_file', 'POST', { dir, kind: 'log', content: 'HACKED-CONTENT' });
    assert.equal(r.body.success, true, JSON.stringify(r.body));
    const written = fs.readFileSync(`${dir}/usbrsync.log`, 'utf8');
    assert.ok(!written.includes('HACKED-CONTENT'), '客户端内容不应写入文件');

    const c = await api('/api/save_file', 'POST', { dir, kind: 'config' });
    assert.equal(c.body.success, true);
    const cfg = JSON.parse(fs.readFileSync(`${dir}/usbrsync-config.json`, 'utf8'));
    assert.ok(Array.isArray(cfg.sync_tasks));
  });

  await t.test('tasks POST: 结构非法被拒绝（400）', async () => {
    const bad1 = await api('/api/tasks', 'POST', { sync_tasks: 'not-an-array' });
    assert.equal(bad1.status, 400);
    const bad2 = await api('/api/tasks', 'POST', { sync_tasks: [{ source: 123 }] });
    assert.equal(bad2.status, 400);
    const bad3 = await api('/api/tasks', 'POST', { sync_tasks: Array.from({ length: 201 }, () => ({})) });
    assert.equal(bad3.status, 400);
    const ok = await api('/api/tasks', 'POST', { sync_tasks: [{ id: 'x1', name: 'n', source: '/tmp/a', target: '/tmp/b' }] });
    assert.equal(ok.body.success, true, JSON.stringify(ok.body));
  });

  await t.test('log / drives 只读端点正常', async () => {
    const log = await api('/api/log?lines=10');
    assert.equal(log.status, 200);
    assert.equal(log.body.success, true);
    const drives = await api('/api/drives');
    assert.equal(drives.status, 200);
    assert.ok(Array.isArray(drives.body.drives));
  });

  await t.test('静态文件：路径穿越被拒', async () => {
    for (const path of ['/app/usbrsync/..%2f..%2fserver.js', '/app/usbrsync/%2e%2e/server.js']) {
      const r = await fetch(`${BASE}${path}`);
      assert.ok([403, 404].includes(r.status), `${path} 应被拒，实际 ${r.status}`);
      const body = await r.text();
      assert.ok(!body.includes('createServer'), '不得泄露后端源码');
    }
  });

  await t.test('PORT 模式：跨源 POST 被拒（CSRF 防护）', async () => {
    const r = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: JSON.stringify({ sync_tasks: [] }),
    });
    assert.equal(r.status, 403, '跨源写请求应 403');
    // 无 Origin（curl/服务端调用）仍放行
    const ok = await fetch(`${BASE}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sync_tasks: [] }),
    });
    assert.equal(ok.status, 200);
  });

  await t.test('preview POST 正常返回对比数据', async () => {
    const fs = await import('node:fs');
    const base = '/tmp/usbrsync-preview';
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(`${base}/src`, { recursive: true });
    fs.mkdirSync(`${base}/tgt`, { recursive: true });
    fs.writeFileSync(`${base}/src/a.txt`, 'aaa');
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    const r = await api('/api/preview', 'POST', { source: `${base}/src`, target: `${base}/tgt` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.success, true, JSON.stringify(r.body));
  });

  await t.test('sync_stop POST 在空闲时也返回成功', async () => {
    const r = await api('/api/sync_stop', 'POST', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
  });

  await t.test('stats: 聚合字段完整（成功率/7 天趋势/按任务/失败原因）', async () => {
    const r = await api('/api/stats');
    assert.equal(r.status, 200);
    const d = r.body;
    for (const k of ['total', 'ok', 'fail', 'partial', 'bytes', 'duration', 'success_rate',
                     'avg_duration', 'avg_speed', 'avg_bytes', 'files', 'deleted',
                     'last_ok_at', 'last_fail_at', 'daily', 'by_task', 'top_errors', 'last24h']) {
      assert.ok(Object.prototype.hasOwnProperty.call(d, k), `缺少字段 ${k}`);
    }
    assert.equal(Array.isArray(d.daily), true);
    assert.equal(d.daily.length, 7, '趋势应补齐 7 天');
    assert.ok(d.daily.every((x) => typeof x.date === 'string' && typeof x.total === 'number'));
    assert.equal(Array.isArray(d.by_task), true);
    assert.equal(Array.isArray(d.top_errors), true);
    assert.ok(typeof d.last24h.bytes === 'number' && typeof d.last24h.total === 'number');
  });

  await t.test('history: 支持 result / limit 筛选', async () => {
    const all = await api('/api/history');
    const ok = await api('/api/history?result=ok');
    const fail = await api('/api/history?result=fail');
    assert.equal(ok.body.history.every((x) => x.success), true);
    assert.equal(fail.body.history.every((x) => !x.success), true);
    assert.equal(ok.body.history.length + fail.body.history.length, all.body.history.length);
    const lim = await api('/api/history?limit=1');
    assert.ok(lim.body.history.length <= 1);
    assert.equal(lim.body.total, all.body.history.length, 'total 应是未裁剪的总数');
  });

  await t.test('history: 记录任务名称（含老记录按 task_id 回填）', async () => {
    const fs = await import('node:fs');
    const base = '/tmp/usbrsync-name';
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(`${base}/a`, { recursive: true });
    fs.mkdirSync(`${base}/b`, { recursive: true });
    fs.writeFileSync(`${base}/a/x.txt`, 'x');
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    // 建一个有名字的任务，保证回填能查到
    await api('/api/tasks', 'POST', { sync_tasks: [
      { id: 'named1', name: '我的备份任务', source: `${base}/a`, target: `${base}/b` },
    ] });

    const wait = async () => {
      for (let i = 0; i < 60; i++) {
        const st = await api('/api/sync_status');
        if (['idle', 'error'].includes(st.body.sync.status)) return;
        await new Promise((r) => setTimeout(r, 200));
      }
    };

    // ① 带 name 触发 → 历史里直接有任务名
    await api('/api/sync', 'POST', { name: '我的备份任务', task_id: 'named1',
      source: `${base}/a`, target: `${base}/b` });
    await wait();
    let h = await api('/api/history?limit=1');
    assert.equal(h.body.history.at(-1).task_name, '我的备份任务');

    // ② 不带 name（模拟旧版本/直接调接口）→ 读接口时按 task_id 回填
    await api('/api/sync', 'POST', { task_id: 'named1', source: `${base}/a`, target: `${base}/b` });
    await wait();
    h = await api('/api/history?limit=1');
    const last = h.body.history.at(-1);
    assert.equal(last.task_name, '我的备份任务', '老记录应能按 task_id 回填任务名');

    // ③ 统计的按任务汇总也用任务名
    const st = await api('/api/stats');
    const row = (st.body.by_task || []).find((x) => x.task_id === 'named1');
    assert.ok(row, JSON.stringify(st.body.by_task));
    assert.equal(row.task_name, '我的备份任务');
  });

  await t.test('auto_sync_check: 逐条给出自动同步的判定原因', async () => {
    const fs = await import('node:fs');
    const base = '/tmp/usbrsync-autocheck';
    fs.rmSync(base, { recursive: true, force: true });
    fs.mkdirSync(`${base}/src`, { recursive: true });
    fs.mkdirSync(`${base}/tgt`, { recursive: true });
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));

    await api('/api/tasks', 'POST', { sync_tasks: [
      { id: 'ac1', name: '未开自动', source: `${base}/src`, target: `${base}/tgt`, auto_sync_on_insert: false },
      { id: 'ac2', name: '开了自动但设备没挂', source: `${base}/src`, target: `${base}/tgt`,
        auto_sync_on_insert: true, device_uuid: 'AAAA-BBBB' },
      { id: 'ac3', name: '自动但目标不存在', source: `${base}/src`, target: `${base}/no-such`,
        auto_sync_on_insert: true, device_uuid: 'AAAA-BBBB' },
    ] });

    const r = await api('/api/auto_sync_check');
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.ok(Array.isArray(r.body.mounts), '应返回当前挂载列表');
    const byId = Object.fromEntries(r.body.tasks.map((x) => [x.id, x]));

    assert.equal(byId.ac1.auto_sync_on_insert, false);
    assert.ok(byId.ac1.reasons.some((x) => x.includes('插入后自动同步')), JSON.stringify(byId.ac1));
    assert.equal(byId.ac1.ok, false);

    assert.ok(byId.ac2.reasons.some((x) => /未挂载|没有挂载中的 USB/.test(x)), JSON.stringify(byId.ac2));
    assert.equal(byId.ac2.ok, false);

    assert.ok(byId.ac3.reasons.some((x) => x.includes('目标目录不存在')), JSON.stringify(byId.ac3));
    assert.equal(byId.ac3.ok, false);
    for (const row of r.body.tasks) assert.ok(Array.isArray(row.reasons));
  });

  await t.test('history clear + stats', async () => {
    await api('/api/history?action=clear', 'POST', {});
    const r = await api('/api/history');
    assert.deepStrictEqual(r.body.history, []);
    const s = await api('/api/stats');
    assert.strictEqual(s.status, 200);
  });
});