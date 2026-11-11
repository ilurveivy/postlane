import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  marketingClient,
  marketingAudiences,
  marketingGroups,
  advanceMarketing,
  syncMarketing,
  marketingTest,
} from '../server/marketing.js';

const account = { from: 'sender@example.com', name: 'Company', audienceId: 'aud1', server: 'us21' };
const hash = (email) => createHash('md5').update(email).digest('hex');
async function fixture(t, options = {}) {
  const calls = [],
    campaigns = new Map(),
    segments = new Map();
  let sends = 0,
    created = 0;
  const members = new Map(
    [
      ['a@example.com', 'subscribed'],
      ['b@example.com', 'subscribed'],
      ['unsub@example.com', 'unsubscribed'],
      ['pending@example.com', 'pending'],
    ].map(([email, status]) => [hash(email), { email_address: email, status }]),
  );
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {},
      path = req.url.split('?')[0];
    calls.push({ path, method: req.method, body, auth: req.headers.authorization });
    const send = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (path === '/lists')
      return send({
        lists: [{ id: 'aud1', name: 'Subscribers', stats: { member_count: 2 } }],
        total_items: 1,
      });
    if (path === '/lists/aud1') return send({ id: 'aud1' });
    if (path.startsWith('/lists/aud1/members/')) {
      const id = path.split('/').at(-1);
      if (req.method === 'PUT') {
        if (!members.has(id))
          members.set(id, { email_address: body.email_address, status: body.status_if_new });
        return send(members.get(id));
      }
      return send(members.get(id) || { detail: 'missing' }, members.has(id) ? 200 : 404);
    }
    if (path === '/lists/aud1/segments') {
      const id = segments.size + 1;
      segments.set(id, body.static_segment);
      return send({ id });
    }
    if (path.match(/\/segments\/\d+\/members$/)) {
      const list = segments.get(Number(path.split('/')[4])) || [];
      const emails = options.extraMember ? [...list, 'outsider@example.com'] : list;
      return send({
        members: emails.map((email_address) => ({ email_address })),
        total_items: emails.length,
      });
    }
    if (path === '/campaigns' && req.method === 'POST') {
      const id = 'remote' + ++created;
      campaigns.set(id, {
        id,
        status: 'save',
        ...body,
        recipients: {
          ...body.recipients,
          recipient_count: (segments.get(body.recipients.segment_opts?.saved_segment_id) || [])
            .length,
        },
      });
      return send({ id });
    }
    const id = path.split('/')[2],
      campaign = campaigns.get(id);
    if (!campaign && !path.startsWith('/reports/')) return send({ error: 'unknown' }, 404);
    if (path.endsWith('/content')) return send({});
    if (path.endsWith('/send-checklist')) return send({ is_ready: !options.notReady });
    if (path.endsWith('/actions/send')) {
      sends++;
      campaign.status = 'sent';
      return send(options.sendError ? { detail: 'secret api key' } : {}, options.sendError || 200);
    }
    if (path.endsWith('/actions/test')) return send({});
    if (path.startsWith('/reports/'))
      return send({
        emails_sent: 1,
        bounces: { hard_bounces: 0, soft_bounces: 0 },
        unsubscribed: 0,
      });
    if (req.method === 'GET') return send(campaign);
    send({}, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = marketingClient('fake-key-us21', 'us21');
  client.basePath = `http://127.0.0.1:${server.address().port}`;
  return {
    client,
    calls,
    campaigns,
    segments,
    members,
    get sends() {
      return sends;
    },
  };
}
function task(emails = ['a@example.com', 'b@example.com']) {
  return {
    id: 'local-task-123',
    name: '测试',
    status: 'running',
    subject: '{{标题}}',
    body: '{{正文}}',
    recipients: emails.map((email, i) => ({
      id: String(i),
      email,
      status: 'pending',
      fields: { 标题: '  原标题  ', 正文: '正文\r\n  原空格  ' },
    })),
  };
}
function state(c) {
  let value = structuredClone(c);
  return {
    get: () => structuredClone(value),
    save: (c) => {
      value = structuredClone(c);
    },
  };
}

test('Marketing SDK：独立账号配置，读取 Audience', async (t) => {
  const f = await fixture(t);
  const b = marketingClient('other-key-us7', 'us7');
  assert.equal(f.client.config.apiKey, 'fake-key-us21');
  assert.equal(b.config.apiKey, 'other-key-us7');
  assert.throws(() => marketingClient('key', 'us21.evil.com'));
  assert.deepEqual(await marketingAudiences(f.client), [
    { id: 'aud1', name: 'Subscribers', count: 2 },
  ]);
});
test('Marketing 活动：相同内容合并、精确分组、原文提交、只发一次、汇总报告', async (t) => {
  const f = await fixture(t),
    store = state(task());
  await advanceMarketing(store.get(), account, f.client, store);
  await advanceMarketing(store.get(), account, f.client, store);
  assert.equal(store.get().status, 'completed');
  assert.equal(f.sends, 1);
  assert.equal(f.campaigns.size, 1);
  assert.deepEqual(f.segments.get(1), ['a@example.com', 'b@example.com']);
  const create = f.calls.find((c) => c.path === '/campaigns');
  assert.equal(create.body.type, 'plaintext');
  assert.equal(create.body.settings.subject_line, '  原标题  ');
  assert.deepEqual(create.body.recipients, {
    list_id: 'aud1',
    segment_opts: { saved_segment_id: 1 },
  });
  assert.equal(
    f.calls.find((c) => c.path.endsWith('/content')).body.plain_text,
    '正文\r\n  原空格  ',
  );
  assert(store.get().recipients.every((r) => r.status === 'sent' && r.messageId === 'remote1'));
  const synced = await syncMarketing(f.client, store.get());
  assert.equal(synced.marketing.groups[0].report.emailsSent, 1);
  assert.equal(f.sends, 1);
});
test('Marketing：不同原文拆分，原生合并标签阻止静默改写', () => {
  const c = task();
  c.recipients[1].fields.正文 = '另一个正文';
  assert.equal(marketingGroups(c).length, 2);
  c.recipients[1].fields.正文 = '*|FNAME|*';
  assert.throws(() => marketingGroups(c), /合并标签/);
});
test('Marketing：退订/待确认/未知联系人不发送，不向整个 Audience 发送', async (t) => {
  const f = await fixture(t),
    store = state(task(['unsub@example.com', 'pending@example.com', 'missing@example.com']));
  await advanceMarketing(store.get(), account, f.client, store);
  await advanceMarketing(store.get(), account, f.client, store);
  assert.equal(f.sends, 0);
  assert.equal(f.campaigns.size, 0);
  assert.equal(store.get().status, 'completed_errors');
  assert(!f.calls.some((c) => c.method === 'PUT'));
});
test('Marketing：明确许可后仅添加新联系人，不覆盖退订状态', async (t) => {
  const f = await fixture(t),
    c = task(['new@example.com', 'unsub@example.com']);
  c.marketingImportConsent = true;
  const store = state(c);
  await advanceMarketing(store.get(), account, f.client, store);
  const updates = f.calls.filter((c) => c.method === 'PUT' && c.path.includes('/members/'));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].body, {
    email_address: 'new@example.com',
    status_if_new: 'subscribed',
  });
  assert.equal(f.members.get(hash('unsub@example.com')).status, 'unsubscribed');
  assert.deepEqual(f.segments.get(1), ['new@example.com']);
  assert.equal(f.sends, 1);
});
test('Marketing：分组被扩大或检查不通过时禁止发送', async (t) => {
  for (const options of [{ extraMember: true }, { notReady: true }]) {
    const f = await fixture(t, options),
      store = state(task());
    await advanceMarketing(store.get(), account, f.client, store);
    assert.equal(f.sends, 0);
    assert.equal(store.get().status, 'cancelled');
    assert.equal(store.get().marketing.groups[0].status, 'failed');
  }
});
test('Marketing：发送返回 5xx 标为待核对，恢复/同步不重复提交', async (t) => {
  const f = await fixture(t, { sendError: 500 }),
    store = state(task());
  await advanceMarketing(store.get(), account, f.client, store);
  assert.equal(f.sends, 1);
  assert.equal(store.get().status, 'cancelled');
  assert(store.get().recipients.every((r) => r.status === 'uncertain'));
  assert(!JSON.stringify(store.get()).includes('secret api key'));
  const resume = store.get();
  resume.status = 'running';
  store.save(resume);
  await advanceMarketing(store.get(), account, f.client, store);
  assert.equal(f.sends, 1);
  const synced = await syncMarketing(f.client, store.get());
  assert(synced.recipients.every((r) => r.status === 'sent'));
  assert.equal(f.sends, 1);
});
test('Marketing：创建/发送中断记录不会自动重做', async (t) => {
  const f = await fixture(t);
  for (const status of ['creating', 'submitting']) {
    const c = task();
    c.marketing = { groups: marketingGroups(c) };
    c.marketing.groups[0].status = status;
    const store = state(c);
    await advanceMarketing(store.get(), account, f.client, store);
    assert.equal(store.get().marketing.groups[0].status, 'uncertain');
  }
  assert.equal(f.calls.length, 0);
});
test('Marketing：暂停期间不提交，测试邮件只调用 test 接口', async (t) => {
  const f = await fixture(t),
    c = task();
  c.status = 'paused';
  const store = state(c);
  await advanceMarketing(store.get(), account, f.client, store);
  assert.equal(f.sends, 0);
  await marketingTest(f.client, account, 'self@example.com', 'test', '正文');
  assert.equal(f.sends, 0);
  assert.deepEqual(f.calls.find((c) => c.path.endsWith('/actions/test')).body, {
    test_emails: ['self@example.com'],
    send_type: 'plaintext',
  });
});

test('Marketing：取消后仅重试失败行，不夹带已取消行', async (t) => {
  const f = await fixture(t),
    c = task();
  c.recipients[1].status = 'cancelled';
  c.marketing = { groups: marketingGroups(c) };
  Object.assign(c.marketing.groups[0], {
    status: 'preparing',
    emails: ['a@example.com', 'b@example.com'],
    eligibleIds: ['0', '1'],
    segmentId: 999,
    remoteId: 'old-unsent',
  });
  const store = state(c);
  await advanceMarketing(store.get(), account, f.client, store);
  assert.deepEqual(f.segments.get(1), ['a@example.com']);
  assert.equal(f.sends, 1);
  assert.equal(store.get().recipients[1].status, 'cancelled');
  await advanceMarketing(store.get(), account, f.client, store);
  assert.equal(f.sends, 1);
});
