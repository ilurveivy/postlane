import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { SMTPServer } from 'smtp-server';
import Database from 'better-sqlite3';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-test-'));
const port = Number(process.env.TEST_PORT || 4197),
  smtpPort = Number(process.env.TEST_SMTP_PORT || 14658),
  origin = `http://127.0.0.1:${port}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.POSTLANE_REPORT_TO = 'xuyuan@example.com,mtong@example.com';
process.env.POSTLANE_EXECUTION_REPORT_TO = 'mtong@example.com';
let server,
  token = '',
  output = '',
  smtp,
  received = [];
async function launch() {
  server = spawn(process.execPath, ['server/index.js', '--production'], {
    env: {
      ...process.env,
      PORT: String(port),
      DISABLE_MAIL_SYNC: 'true',
      PREFLIGHT_DNS: 'disabled', // Deterministic integration fixture; DNS behavior tested with injected resolver.
      DISABLE_BATCH_REPORTS: 'true',
      DISABLE_SLEEP_GUARD: 'true',
      DISABLE_BACKUP: 'true',
      DISABLE_DELIVERY_RECOVERY: 'true',
      DATA_DIR: dir,
      NODE_EXTRA_CA_CERTS: path.join(dir, 'cert.pem'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => (output += b.toString()));
  server.stderr.on('data', (b) => (output += b.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(origin + '/api/state');
      if (r.ok) {
        token = (await r.json()).token;
        return;
      }
    } catch {}
    await wait(100);
  }
  throw new Error('Server did not start: ' + output);
}
async function stop() {
  // A child killed by a signal keeps exitCode === null and sets signalCode, so both must be
  // checked: otherwise a second stop() waits forever for an 'exit' that already happened.
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill();
    await once(server, 'exit');
  }
}
async function request(url, { method = 'GET', body, expected = 200, headers = {} } = {}) {
  if (url === '/campaigns' && body && body.randomInterval === undefined)
    body = { ...body, randomInterval: false };
  const h = { 'x-postlane-token': token, ...headers };
  if (body && !(body instanceof FormData)) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(origin + '/api' + url, { method, body, headers: h });
  const text = await res.text();
  assert.equal(res.status, expected, `${url}: ${text}`);
  return res.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}
async function poll(id, predicate) {
  for (let i = 0; i < 120; i++) {
    const c = await request('/campaigns/' + id);
    if (predicate(c)) return c;
    await wait(100);
  }
  throw new Error('Campaign timeout');
}
let list, campaign;
test('完整流程：导入、演练、持久化、SMTP 与队列控制', async (t) => {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      path.join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  smtp = new SMTPServer({
    secure: true,
    key: fs.readFileSync(path.join(dir, 'key.pem')),
    cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    logger: false,
    onAuth(auth, session, callback) {
      callback(
        auth.username === 'sender@example.com' && auth.password === 'test-secret-123'
          ? null
          : new Error('Invalid auth'),
        { user: 'test' },
      );
    },
    onRcptTo(address, session, callback) {
      callback(
        address.address === 'reject@example.com'
          ? Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 })
          : null,
      );
    },
    onData(stream, session, callback) {
      let text = '';
      stream.on('data', (b) => (text += b));
      stream.on('end', () => {
        received.push({ text, envelope: session.envelope });
        callback(null);
      });
    },
  });
  await new Promise((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(smtpPort, '127.0.0.1', resolve);
  });
  try {
    await launch();
    await t.test('生产页面与跨来源保护', async () => {
      const page = await fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Postlane/);
      await request('/lists', {
        method: 'POST',
        body: {},
        headers: { 'x-postlane-token': '' },
        expected: 403,
      });
      await request('/lists', {
        method: 'POST',
        body: {},
        headers: { origin: 'https://malicious.example' },
        expected: 403,
      });
    });
    await t.test('地址预检接口只读，未知域名状态不冒充可送达', async () => {
      const review = await request('/address-preflight', {
        method: 'POST',
        body: {
          name: 'preflight test',
          emailColumn: 'email',
          rows: [
            { email: 'bad' },
            { email: 'a@example.com' },
            { email: 'a@postlane.dev' },
            { email: 'a@postlane.dev' },
          ],
        },
      });
      // example.com is a reserved placeholder domain, so the send review blocks it outright;
      // an ordinary domain that DNS could not confirm stays a warning, never "clear".
      assert.deepEqual(review.counts, { invalid: 2, warning: 1, clear: 0 });
      assert.equal((await request('/state')).campaigns.length, 0);
    });
    await t.test('同一数据目录拒绝第二个发送队列进程', async () => {
      const duplicate = spawn(process.execPath, ['server/index.js', '--production'], {
        env: { ...process.env, PORT: '4198', DATA_DIR: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let message = '';
      duplicate.stderr.on('data', (b) => (message += b.toString()));
      const [code] = await once(duplicate, 'exit');
      assert.notEqual(code, 0);
      assert.match(message, /已有运行中的邮序实例/);
      assert.equal((await request('/state')).campaigns.length, 0);
    });
    await t.test('CSV 导入识别、去重与异常报告', async () => {
      const fd = new FormData();
      fd.append(
        'file',
        new Blob([
          '\ufeff邮箱,姓名,公司\na@example.com,小满,山野\nA@example.com,重复,山野\ninvalid,无效,测试\nb@example.com,一舟,青禾',
        ]),
        'contacts.csv',
      );
      const imported = await request('/import', { method: 'POST', body: fd });
      assert.equal(imported.sheets[0].rows.length, 4);
      list = await request('/lists', {
        method: 'POST',
        body: { name: '测试名单', rows: imported.sheets[0].rows, emailColumn: '邮箱' },
      });
      assert.equal(list.contacts.length, 2);
      assert.equal(list.issues.length, 2);
      assert.match(await request('/lists/' + list.id + '/issues'), /重复邮箱/);
    });
    await t.test('导入任务创建、改名、幂等与原名单保持一致', async () => {
      const before = await request('/lists/' + list.id);
      assert.ok(before.importTaskId);
      const directory = await request('/import-tasks');
      assert.ok(directory.items.some((t) => t.id === before.importTaskId && t.counts.total === 2));
      await request('/import-tasks/' + before.importTaskId, {
        method: 'PATCH',
        body: { name: '合作邀约用途', description: '测试说明' },
      });
      const detail = await request('/import-tasks/' + before.importTaskId);
      assert.equal(detail.task.name, '合作邀约用途');
      assert.deepEqual(await request('/lists/' + list.id), before);
      const input = {
        name: '导入幂等',
        requestId: 'fixture-idempotent',
        rows: [{ email: 'idempotent@example.com' }],
        emailColumn: 'email',
      };
      const first = await request('/lists', { method: 'POST', body: input });
      const again = await request('/lists', { method: 'POST', body: input });
      assert.equal(first.id, again.id);
      assert.equal(first.importTaskId, again.importTaskId);
      await request('/lists/' + first.id, { method: 'DELETE' });
      const retained = await request('/import-tasks/' + first.importTaskId);
      assert.equal(retained.task.counts.total, 1);
      assert.equal(retained.records[0].email, 'idempotent@example.com');
    });
    await t.test('批量处理只修改当前筛选快照内的待处理状态，重复请求幂等', async () => {
      const store = new Database(path.join(dir, 'postlane.sqlite'));
      const seed = (id, extra = {}) => ({
        id,
        type: 'reply',
        accountId: 'workflow-test',
        from: ['creator@example.com'],
        subject: 'workflow sample',
        text: 'Original text',
        date: '2026-10-28T01:00:00Z',
        links: [],
        handled: false,
        ...extra,
      });
      const initial = [
        seed('workflow-one'),
        seed('workflow-two'),
        seed('workflow-done', { handled: true }),
        seed('workflow-other', { accountId: 'different' }),
        seed('workflow-new'),
      ];
      for (const e of initial)
        store
          .prepare('INSERT INTO documents(kind,id,json) VALUES(?,?,?)')
          .run('mail-event', e.id, JSON.stringify(e));
      const beforeSend = received.length;
      const body = {
        ids: ['workflow-one', 'workflow-two', 'workflow-done', 'workflow-other'],
        filters: {
          account: 'workflow-test',
          handled: 'pending',
          kind: 'reply',
          query: 'workflow',
          importTaskId: 'unassigned',
          from: '2026-10-28',
          to: '2026-10-28',
        },
      };
      assert.deepEqual(await request('/followup/mark-handled', { method: 'POST', body }), {
        updated: 2,
        skipped: 2,
      });
      assert.deepEqual(await request('/followup/mark-handled', { method: 'POST', body }), {
        updated: 0,
        skipped: 4,
      });
      const getEvent = (id) =>
        JSON.parse(
          store.prepare("SELECT json FROM documents WHERE kind='mail-event' AND id=?").get(id).json,
        );
      assert.equal(getEvent('workflow-one').handled, true);
      assert.equal(getEvent('workflow-one').text, 'Original text');
      assert.equal(getEvent('workflow-one').importTaskIds, undefined);
      assert.equal(getEvent('workflow-new').handled, false);
      assert.equal(getEvent('workflow-other').handled, false);
      assert.equal(received.length, beforeSend);
      await request('/followup/events/workflow-one', { method: 'PATCH', body: { handled: false } });
      assert.equal(getEvent('workflow-one').handled, false);
      for (const e of initial)
        store.prepare("DELETE FROM documents WHERE kind='mail-event' AND id=?").run(e.id);
      store.close();
    });
    await t.test('批次报告 API：固定收件人、草稿归组、防重复和CSRF', async () => {
      const c = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '报告归组草稿',
          subject: 'test',
          body: 'body',
          listId: list.id,
          mode: 'live',
          rate: 1,
        },
      });
      assert.equal(c.recipients[0].fields.source_list_id, list.id);
      assert.equal(c.recipients[0].fields.source_recipient_id, list.contacts[0].id);
      await request('/report-batches', {
        method: 'POST',
        body: { name: '组', campaignIds: [c.id] },
        headers: { 'x-postlane-token': '' },
        expected: 403,
      });
      const b = await request('/report-batches', {
        method: 'POST',
        body: { name: '组', campaignIds: [c.id] },
      });
      assert.deepEqual(b.recipients, ['xuyuan@example.com', 'mtong@example.com']);
      assert.ok((await request('/report-batches')).some((v) => v.id === b.id));
      await request('/report-batches', {
        method: 'POST',
        body: { name: '重复', campaignIds: [c.id] },
        expected: 400,
      });
    });
    await t.test('Excel 多工作表与数值字段解析', async () => {
      const w = new ExcelJS.Workbook();
      w.addWorksheet('第一组').addRows([
        ['邮箱', '姓名', '金额', 'channel_id', 'channel_name', 'channel_url'],
        [
          'c@example.com',
          '小可',
          1200,
          'UCtYe2zSP5vEnwHFhR3ZDsIA',
          'AWDCars',
          'https://www.youtube.com/channel/UCtYe2zSP5vEnwHFhR3ZDsIA',
        ],
      ]);
      w.addWorksheet('第二组').addRows([
        ['Email', 'Name'],
        ['d@example.com', 'Lin'],
      ]);
      const fd = new FormData();
      fd.append('file', new Blob([await w.xlsx.writeBuffer()]), 'contacts.xlsx');
      const result = await request('/import', { method: 'POST', body: fd });
      assert.equal(result.sheets.length, 2);
      assert.equal(result.sheets[0].rows[0].金额, '1200');
      assert.equal(result.sheets[0].rows[0].channel_id, 'UCtYe2zSP5vEnwHFhR3ZDsIA');
      assert.equal(result.sheets[0].rows[0].channel_name, 'AWDCars');
      assert.equal(
        result.sheets[0].rows[0].channel_url,
        'https://www.youtube.com/channel/UCtYe2zSP5vEnwHFhR3ZDsIA',
      );
      const bad = new FormData();
      bad.append('file', new Blob(['坏文件']), 'broken.xlsx');
      await request('/import', { method: 'POST', body: bad, expected: 400 });
      const duplicate = new FormData();
      duplicate.append('file', new Blob(['邮箱,邮箱\na@example.com,b@example.com']), 'bad.csv');
      await request('/import', { method: 'POST', body: duplicate, expected: 400 });
    });
    await t.test('演练启动幂等，逐收件人记录与结果导出', async () => {
      campaign = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '演练测试',
          subject: '你好 {{姓名}}',
          body: '欢迎来自{{公司}}的你',
          listId: list.id,
          mode: 'simulation',
          rate: 60,
          scheduledAt: null,
        },
      });
      await request('/campaigns/' + campaign.id + '/action', {
        method: 'POST',
        body: { action: 'start' },
      });
      await request('/campaigns/' + campaign.id + '/action', {
        method: 'POST',
        body: { action: 'start' },
        expected: 400,
      });
      const result = await poll(campaign.id, (c) => c.status === 'completed');
      assert.ok(result.recipients.every((r) => r.status === 'simulated'));
      assert.equal(received.length, 0);
      assert.match(await request('/campaigns/' + campaign.id + '/export'), /演练完成/);
    });
    await t.test('缺失变量阻止发送', async () => {
      const c = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '缺失变量',
          subject: '{{不存在}}',
          body: '正文',
          listId: list.id,
          mode: 'simulation',
          rate: 20,
        },
      });
      const result = await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'start' },
        expected: 400,
      });
      assert.match(result.error, /缺少变量/);
    });
    await t.test('发件授权码加密存储，不返回浏览器', async () => {
      const s = await request('/settings', {
        method: 'PUT',
        body: {
          name: '测试工作室',
          from: 'sender@example.com',
          host: 'localhost',
          port: smtpPort,
          secure: true,
          user: 'sender@example.com',
          password: 'test-secret-123',
        },
      });
      assert.equal(s.password, undefined);
      assert.equal(s.hasPassword, true);
      const db = new Database(path.join(dir, 'postlane.sqlite'));
      const raw = db.prepare("SELECT json FROM documents WHERE kind='settings'").get().json;
      db.close();
      assert.ok(!raw.includes('test-secret-123'));
      await request('/settings/verify', { method: 'POST' });
    });
    await t.test(
      'Marketing 账号与任务：Audience/页脚校验、API Key 脱敏、演练无远程请求',
      async () => {
        const body = {
          provider: 'mailchimp-marketing',
          name: '营销账号',
          from: 'marketing@example.com',
          server: 'us21',
          audienceId: '',
          password: 'fake-marketing-us21',
        };
        const a = await request('/accounts', { method: 'POST', body });
        assert.equal(a.provider, 'mailchimp-marketing');
        assert(!a.password);
        await request('/accounts', {
          method: 'POST',
          body: { ...body, from: 'another@example.com', server: 'us21.evil.com' },
          expected: 400,
        });
        const c = await request('/campaigns', {
          method: 'POST',
          body: {
            name: 'Marketing 演练',
            subject: '标题',
            body: '正文',
            listId: list.id,
            mode: 'live',
            rate: 60,
            accountId: a.id,
          },
        });
        const noAudience = await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'start', confirmLive: true, marketingFooterAccepted: true },
          expected: 400,
        });
        assert.match(noAudience.error, /Audience/);
        await request('/accounts/' + a.id, {
          method: 'PUT',
          body: { ...body, password: '', audienceId: 'aud1' },
        });
        const noFooter = await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'start', confirmLive: true },
          expected: 400,
        });
        assert.match(noFooter.error, /页脚/);
        await request('/campaigns/' + c.id, { method: 'PUT', body: { ...c, mode: 'simulation' } });
        await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'start' },
        });
        await poll(c.id, (v) => v.status === 'completed');
        const state = await request('/state');
        assert(!JSON.stringify(state).includes(body.password));
      },
    );

    await t.test('Mailchimp 账号：无 SMTP 字段、密钥加密和保留、渠道不可更换', async () => {
      const body = {
        provider: 'mailchimp',
        name: 'Transactional',
        from: 'sender@example.com',
        password: 'fake-mailchimp-secret',
      };
      const account = await request('/accounts', { method: 'POST', body });
      assert.equal(account.provider, 'mailchimp');
      assert.equal(account.hasPassword, true);
      assert.equal(account.password, undefined);
      const db = new Database(path.join(dir, 'postlane.sqlite'), { readonly: true });
      const before = JSON.parse(
        db.prepare("SELECT json FROM documents WHERE kind='account' AND id=?").get(account.id).json,
      );
      assert(before.password && before.password !== body.password);
      assert(!JSON.stringify(before).includes(body.password));
      await request('/accounts/' + account.id, { method: 'PUT', body: { ...body, password: '' } });
      const after = JSON.parse(
        db.prepare("SELECT json FROM documents WHERE kind='account' AND id=?").get(account.id).json,
      );
      assert.equal(before.password, after.password);
      db.close();
      await request('/accounts', { method: 'POST', body, expected: 400 });
      await request('/accounts', {
        method: 'POST',
        body: { ...body, from: 'other@example.com', password: '' },
        expected: 400,
      });
      await request('/accounts/' + account.id, {
        method: 'PUT',
        body: {
          ...body,
          provider: 'smtp',
          host: 'localhost',
          port: 465,
          secure: true,
          user: body.from,
        },
        expected: 400,
      });
      const state = await request('/state');
      assert(!JSON.stringify(state).includes(body.password));
    });

    await t.test('多账号隔离：任务绑定、凭据保留、无效账号拒绝', async () => {
      const data = {
        name: '账号 A',
        from: 'a@example.com',
        host: 'localhost',
        port: smtpPort,
        secure: true,
        user: 'sender@example.com',
        password: 'test-secret-123',
      };
      const a = await request('/accounts', { method: 'POST', body: data });
      const b = await request('/accounts', {
        method: 'POST',
        body: { ...data, name: '账号 B', from: 'b@example.com' },
      });
      assert.equal(a.password, undefined);
      await request('/accounts/' + a.id, { method: 'PUT', body: { ...data, password: '' } });
      await request('/accounts/' + a.id + '/verify', { method: 'POST' });
      const one = await request('/lists', {
        method: 'POST',
        body: { name: '隔离测试', emailColumn: '邮箱', rows: [{ 邮箱: 'target@example.com' }] },
      });
      for (const account of [a, b]) {
        const c = await request('/campaigns', {
          method: 'POST',
          body: {
            name: '绑定测试',
            subject: '账号隔离',
            body: '正文',
            listId: one.id,
            mode: 'live',
            rate: 60,
            accountId: account.id,
          },
        });
        await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'start', confirmLive: true },
        });
        await request('/accounts/' + account.id, {
          method: 'PUT',
          body: { ...data, from: account.from },
          expected: 400,
        });
        const done = await poll(c.id, (c) => c.status === 'completed');
        assert.equal(done.senderEmail, account.from);
        // Message-ID is stamped with the sender's own domain: a forged or unresolvable
        // domain in that header is a spam signal, so it must match the envelope sender.
        assert.match(done.recipients[0].messageId, /@example\.com>$/);
        assert(received.at(-1).text.includes(done.recipients[0].messageId));
        assert.equal(received.at(-1).envelope.mailFrom.address, account.from);
        await request('/campaigns/' + c.id, {
          method: 'PUT',
          body: { ...c, accountId: b.id },
          expected: 400,
        });
      }
      await request('/test-email', {
        method: 'POST',
        body: { to: 'target@example.com', subject: '无效账号', body: '正文', accountId: 'missing' },
        expected: 404,
      });
      const state = await request('/state');
      assert(state.accounts.some((x) => x.id === a.id));
      assert(state.accounts.every((x) => !x.password));
      received = [];
    });
    await t.test('真实 SMTP 测试信：TLS、认证和单一收件人信封', async () => {
      await request('/test-email', {
        method: 'POST',
        body: { to: 'test@example.com', subject: 'Hello', body: '<script>danger</script>' },
      });
      // An earlier subtest may still have a delivery in flight, so select the envelope this
      // call asked for instead of assuming the fixture is otherwise empty.
      const sent = received.filter((r) =>
        r.envelope.rcptTo.some((t) => t.address === 'test@example.com'),
      );
      assert.equal(sent.length, 1);
      assert.equal(sent[0].envelope.rcptTo.length, 1);
      assert.equal(sent[0].envelope.rcptTo[0].address, 'test@example.com');
      assert.match(sent[0].text, /multipart\/alternative/);
    });
    await t.test('Mailbox API protects drafts, shared presets and manual sending', async () => {
      const a = await request('/accounts', {
        method: 'POST',
        body: {
          provider: 'smtp',
          name: 'Mailbox fixture',
          from: 'mailbox-fixture@gmail.com',
          user: 'sender@example.com',
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          password: 'test-secret-123',
        },
      });
      await request('/inbox/drafts', {
        method: 'POST',
        headers: { 'x-postlane-token': '' },
        body: { accountId: a.id, to: 'test@example.com', subject: 'Draft', body: 'Not sent' },
        expected: 403,
      });
      let d = await request('/inbox/drafts', {
        method: 'POST',
        body: { accountId: a.id, to: '', subject: '', body: 'Incomplete draft' },
      });
      await request('/inbox/drafts/' + d.id + '/send', {
        method: 'POST',
        body: { version: d.version, confirm: true },
        expected: 400,
      });
      d = await request('/inbox/drafts', {
        method: 'POST',
        body: { ...d, to: 'test@example.com', subject: 'Mailbox draft', body: 'Exact draft' },
      });
      await request('/inbox/reply-preset', {
        method: 'PUT',
        headers: { 'x-postlane-token': '' },
        body: { rules: 'test' },
        expected: 403,
      });
      await request('/inbox/reply-preset', { method: 'PUT', body: { rules: '' } });
      assert.equal((await request('/inbox/reply-preset')).rules, '');
      await request('/inbox/drafts/' + d.id + '/send', {
        method: 'POST',
        body: { version: d.version, confirm: false },
        expected: 400,
      });
      assert.equal(
        (await request('/inbox?accountId=' + a.id)).drafts.find((x) => x.id === d.id).body,
        'Exact draft',
      );
      await request('/inbox/drafts/' + d.id, { method: 'DELETE' });
      assert.equal((await request('/inbox?accountId=' + a.id)).drafts.length, 0);
    });
    await t.test('真实批量发送：确认、SMTP 拒绝记录及仅重试失败', async () => {
      const l = await request('/lists', {
        method: 'POST',
        body: {
          name: 'SMTP 测试',
          emailColumn: '邮箱',
          rows: [
            { 邮箱: 'ok@example.com', 姓名: 'One' },
            { 邮箱: 'reject@example.com', 姓名: 'Two' },
          ],
        },
      });
      const c = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '真实测试',
          subject: 'Hello {{姓名}}',
          body: 'Private message for {{姓名}}',
          listId: l.id,
          mode: 'live',
          rate: 60,
        },
      });
      await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'start' },
        expected: 400,
      });
      await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'start', confirmLive: true },
      });
      await poll(c.id, (c) => c.recipients[0].status === 'sent');
      const result = await poll(c.id, (c) => c.status === 'completed_errors');
      assert.equal(result.recipients[0].status, 'sent');
      assert.equal(result.recipients[1].status, 'failed');
      assert.match(result.recipients[1].error, /550/);
      assert.equal(received.at(-1).envelope.rcptTo.length, 1);
      assert.match(received.at(-1).text, /Hello One/);
      const before = received.length;
      await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'retry', confirmLive: true },
      });
      await poll(c.id, (c) => c.status === 'completed_errors');
      assert.equal(received.length, before, '已成功邮件不会被重试');
    });
    await t.test('原样正文发送且单封失败不阻塞后续收件人', async () => {
      const l = await request('/lists', {
        method: 'POST',
        body: {
          name: '原样测试',
          emailColumn: '邮箱',
          rows: [
            {
              邮箱: 'verbatim@example.com',
              原标题: 'Original title',
              原正文: 'Original {{literal}}\n\nA & B',
            },
            {
              邮箱: 'reject@example.com',
              原标题: 'Original title',
              原正文: 'Original {{literal}}\n\nA & B',
            },
            {
              邮箱: 'never@example.com',
              原标题: 'Original title',
              原正文: 'Original {{literal}}\n\nA & B',
            },
          ],
        },
      });
      const c = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '原样测试',
          subject: '{{原标题}}',
          body: '{{原正文}}',
          listId: l.id,
          mode: 'live',
          rate: 60,
          plainOnly: true,
          stopOnError: true,
          senderEmail: 'sender@example.com',
        },
      });
      await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'start', confirmLive: true },
      });
      const result = await poll(c.id, (v) => v.status === 'completed_errors');
      assert.deepEqual(
        result.recipients.map((r) => r.status),
        ['sent', 'failed', 'sent'],
      );
      const mail = received.find((m) => m.envelope.rcptTo[0].address === 'verbatim@example.com');
      assert.match(mail.text, /Content-Type: text\/plain/i);
      assert.ok(!mail.text.includes('text/html'));
      assert.ok(mail.text.includes('Original {{literal}}\r\n\r\nA & B'));
    });
    await t.test('定时任务不提前启动，取消后不发信', async () => {
      const c = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '定时演练',
          subject: 'Hello',
          body: 'Hi',
          listId: list.id,
          mode: 'simulation',
          rate: 60,
          scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      const scheduled = await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'start' },
      });
      assert.equal(scheduled.status, 'scheduled');
      await wait(400);
      assert.ok(
        (await request('/campaigns/' + c.id)).recipients.every((r) => r.status === 'pending'),
      );
      const cancelled = await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'cancel' },
      });
      assert.ok(cancelled.recipients.every((r) => r.status === 'cancelled'));
    });
    await t.test('预约到期自动执行演练', async () => {
      const c = await request('/campaigns', {
        method: 'POST',
        body: {
          name: '到期预约',
          subject: 'Hello',
          body: 'Hi',
          listId: list.id,
          mode: 'simulation',
          rate: 60,
          scheduledAt: new Date(Date.now() + 900).toISOString(),
        },
      });
      const scheduled = await request('/campaigns/' + c.id + '/action', {
        method: 'POST',
        body: { action: 'start' },
      });
      assert.equal(scheduled.status, 'scheduled');
      const result = await poll(c.id, (value) => value.status === 'completed');
      assert.ok(result.recipients.every((r) => r.status === 'simulated'));
    });
    await t.test('跟进：默认跟踪、延长暂停、处理持久化、退信排除与 CSRF', async () => {
      const state = await request('/state');
      const live = state.campaigns.find((c) => c.mode === 'live' && c.counts.sent);
      const full = await request('/campaigns/' + live.id);
      assert(full.tracking.until);
      const extended = await request('/campaigns/' + live.id + '/tracking', {
        method: 'PUT',
        body: { enabled: true, days: 30 },
      });
      assert(Date.parse(extended.until) > Date.now() + 29 * 86400000);
      await request('/campaigns/' + live.id + '/tracking', {
        method: 'PUT',
        body: { enabled: false },
      });
      assert.equal((await request('/campaigns/' + live.id)).tracking.enabled, false);
      await request('/campaigns/' + live.id + '/tracking', {
        method: 'PUT',
        body: { enabled: true, days: 1000 },
        expected: 400,
      });
      const db = new Database(path.join(dir, 'postlane.sqlite'));
      const e = {
        id: 'fixture-reply',
        type: 'reply',
        accountEmail: 'a@example.com',
        from: ['user@example.com'],
        subject: '<script>alert(1)</script>',
        text: '=SUM(1,2)',
        date: new Date().toISOString(),
        handled: false,
        links: [],
      };
      db.prepare('INSERT INTO documents(kind,id,json) VALUES(?,?,?)').run(
        'mail-event',
        e.id,
        JSON.stringify(e),
      );
      db.prepare('INSERT INTO documents(kind,id,json) VALUES(?,?,?)').run(
        'suppression',
        'blocked@example.com',
        JSON.stringify({ id: 'blocked@example.com', reason: '收件地址永久退信' }),
      );
      db.close();
      assert.equal((await request('/followup')).pending, 1);
      await request('/followup/events/' + e.id, {
        method: 'PATCH',
        body: { handled: true },
        headers: { 'x-postlane-token': 'invalid' },
        expected: 403,
      });
      await request('/followup/events/' + e.id, { method: 'PATCH', body: { handled: true } });
      assert.equal((await request('/followup')).pending, 0);
      const exported = await fetch(origin + '/api/followup/export?handled=done');
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get('content-disposition'), /postlane-followup.xlsx/);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()));
      const worksheet = workbook.getWorksheet('回复与跟进');
      const bodyColumn = worksheet.getRow(1).values.indexOf('对方回复内容');
      assert.match(worksheet.getRow(2).getCell(bodyColumn).value, /^=SUM/);
      assert.equal(worksheet.getRow(2).getCell(bodyColumn).type, ExcelJS.ValueType.String);
      const emptyResponse = await fetch(origin + '/api/followup/export?handled=pending');
      const emptyBook = new ExcelJS.Workbook();
      await emptyBook.xlsx.load(Buffer.from(await emptyResponse.arrayBuffer()));
      assert.equal(emptyBook.getWorksheet('回复与跟进').rowCount, 1);
      await request('/followup/events/' + e.id, { method: 'PATCH', body: { handled: false } });
      const l = await request('/lists', {
        method: 'POST',
        body: {
          name: '退信排除',
          emailColumn: '邮箱',
          rows: [{ 邮箱: 'blocked@example.com' }, { 邮箱: 'allowed@example.com' }],
        },
      });
      assert.equal(l.contacts.length, 1);
      assert.match(l.issues[0].reason, /永久退信/);
      assert(!JSON.stringify(await request('/followup')).includes('test-secret-123'));
    });
    await t.test(
      'reply-only usage blocks campaign APIs and preserves manual drafting',
      async () => {
        const a = await request('/accounts', {
          method: 'POST',
          body: {
            provider: 'smtp',
            name: 'Manual sender',
            from: 'manual@gmail.com',
            user: 'manual@gmail.com',
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            password: 'fake-app-password',
          },
        });
        const input = {
          name: 'Blocked batch',
          subject: 'Subject',
          body: 'Body',
          listId: list.id,
          mode: 'live',
          accountId: a.id,
          rate: 1,
        };
        const existing = await request('/campaigns', { method: 'POST', body: input });
        const usage = await request(`/accounts/${a.id}/usage`, {
          method: 'PATCH',
          body: { replyOnly: true, defaultManualSender: true },
        });
        assert.equal(usage.replyOnly, true);
        assert.equal(usage.password, undefined);
        assert.equal(usage.hasPassword, true);
        assert(!(await request('/import-accounts')).some((x) => x.id === a.id));
        assert.match(
          (await request('/campaigns', { method: 'POST', body: input, expected: 400 })).error,
          /只做回复用/,
        );
        assert.match(
          (
            await request(`/campaigns/${existing.id}/action`, {
              method: 'POST',
              body: { action: 'start', confirmLive: true },
              expected: 400,
            })
          ).error,
          /只做回复用/,
        );
        const d = await request('/inbox/drafts', {
          method: 'POST',
          body: {
            accountId: a.id,
            to: 'person@example.com',
            subject: 'Manual',
            body: 'Manual only',
          },
        });
        assert.equal(d.accountId, a.id);
        assert.equal(d.status, 'draft');
      },
    );
    await t.test(
      'disabled senders retain credentials, pause schedules and cannot send',
      async () => {
        const body = {
          provider: 'smtp',
          name: 'Disabled test',
          from: 'disabled@gmail.com',
          user: 'sender@example.com',
          host: 'localhost',
          port: smtpPort,
          secure: true,
          password: 'test-secret-123',
        };
        const a = await request('/accounts', { method: 'POST', body });
        await request('/accounts/' + a.id + '/verify', { method: 'POST' });
        assert((await request('/import-accounts')).some((x) => x.id === a.id));
        const c = await request('/campaigns', {
          method: 'POST',
          body: {
            name: 'Future test',
            subject: 'Test',
            body: 'Original',
            listId: list.id,
            mode: 'live',
            accountId: a.id,
            rate: 1,
            scheduledAt: new Date(Date.now() + 3600000).toISOString(),
          },
        });
        await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'start', confirmLive: true },
        });
        const gmail = await request('/accounts', {
          method: 'POST',
          body: { ...body, from: 'disabled2@gmail.com', host: 'smtp.gmail.com' },
        });
        const d = await request('/inbox/drafts', {
          method: 'POST',
          body: {
            accountId: gmail.id,
            to: 'target@example.com',
            subject: 'Test',
            body: 'Original',
          },
        });
        await request('/accounts/' + gmail.id + '/availability', {
          method: 'PATCH',
          body: { disabled: true },
        });
        const disabled = await request('/accounts/' + a.id + '/availability', {
          method: 'PATCH',
          body: { disabled: true, reason: 'Spam folder' },
        });
        assert.equal(disabled.disabled, true);
        assert.equal(disabled.hasPassword, true);
        assert.equal(disabled.password, undefined);
        assert.equal((await request('/campaigns/' + c.id)).status, 'cancelled');
        assert.equal((await request('/campaigns/' + c.id)).returnedToPool, true);
        assert(!(await request('/import-accounts')).some((x) => x.id === a.id));
        await request('/inbox/drafts/' + d.id + '/send', {
          method: 'POST',
          body: { confirm: true, version: d.version },
          expected: 400,
        });
        await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'resume', confirmLive: true },
          expected: 400,
        });
        await request('/campaigns/' + c.id + '/action', {
          method: 'POST',
          body: { action: 'cancel' },
          expected: 400,
        });
        const edited = await request('/accounts/' + a.id, {
          method: 'PUT',
          body: { ...body, password: '' },
        });
        assert.equal(edited.disabled, true);
        assert.equal(edited.disabledReason, 'Spam folder');
        await request('/accounts/' + a.id + '/availability', {
          method: 'PATCH',
          body: { disabled: false },
        });
        await request('/accounts/' + a.id + '/verify', { method: 'POST' });
        assert((await request('/import-accounts')).some((x) => x.id === a.id));
      },
    );
    await t.test('进程重启保留记录，将提交中的邮件标记为待核对', async () => {
      await stop();
      const db = new Database(path.join(dir, 'postlane.sqlite'));
      const raw = JSON.parse(
        db.prepare("SELECT json FROM documents WHERE kind='campaign' AND id=?").get(campaign.id)
          .json,
      );
      raw.status = 'running';
      raw.recipients[0].status = 'sending';
      db.prepare("UPDATE documents SET json=? WHERE kind='campaign' AND id=?").run(
        JSON.stringify(raw),
        campaign.id,
      );
      db.close();
      await launch();
      const result = await request('/campaigns/' + campaign.id);
      assert.ok(['running', 'attention'].includes(result.status));
      assert.equal(result.recipients[0].status, 'uncertain');
      assert.equal((await request('/lists/' + list.id)).contacts.length, 2);
      assert.equal((await request('/state')).settings.hasPassword, true);
    });
  } finally {
    await stop();
    await new Promise((resolve) => smtp.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
