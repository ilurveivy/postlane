import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A recipient clicking "unsubscribe" cannot be asked for the operator's password, so the
// endpoint has to sit in front of the Basic-auth gate. That ordering is the whole point of
// this test; it is easy to break by moving a route a few lines down.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-unsub-route-'));
const port = Number(process.env.TEST_UNSUB_PORT || 4196);
const origin = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const password = 'p'.repeat(32);
let server,
  output = '';

async function launch() {
  server = spawn(process.execPath, ['server/index.js', '--production'], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      POSTLANE_ACCESS_PASSWORD: password,
      DISABLE_MAIL_SYNC: 'true',
      DISABLE_BATCH_REPORTS: 'true',
      DISABLE_DELIVERY_RECOVERY: 'true',
      DISABLE_SLEEP_GUARD: 'true',
      DISABLE_BACKUP: 'true',
      PREFLIGHT_DNS: 'disabled',
      DATA_DIR: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => (output += b.toString()));
  server.stderr.on('data', (b) => (output += b.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${origin}/ready`);
      if (r.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error('Server did not start: ' + output);
}

test('退订链接不需要登录，其余接口仍然需要', async (t) => {
  await launch();
  try {
    const unauthorized = await fetch(`${origin}/api/state`);
    assert.equal(unauthorized.status, 401, '默认所有页面与接口都要密码');

    // 坏令牌返回 404 页面，而不是 401：说明请求到了退订处理里，没有被鉴权挡下。
    const page = await fetch(`${origin}/u/not-a-real-token`);
    assert.equal(page.status, 404);
    assert.match(await page.text(), /链接无效/);

    const post = await fetch(`${origin}/u/not-a-real-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    assert.equal(post.status, 404);
    assert.match(post.headers.get('cache-control') || '', /no-store/);

    // 带密码时运营入口照常可用，证明 401 只是因为没带凭据。
    const authorized = await fetch(`${origin}/api/state`, {
      headers: { authorization: 'Basic ' + Buffer.from(`postlane:${password}`).toString('base64') },
    });
    assert.equal(authorized.status, 200);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
  }
});
