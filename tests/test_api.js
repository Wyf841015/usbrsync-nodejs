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
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
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

  await t.test('history clear + stats', async () => {
    await api('/api/history?action=clear', 'POST', {});
    const r = await api('/api/history');
    assert.deepStrictEqual(r.body.history, []);
    const s = await api('/api/stats');
    assert.strictEqual(s.status, 200);
  });
});