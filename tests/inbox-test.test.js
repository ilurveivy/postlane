import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTLANE_MODE = 'live';
process.env.DISABLE_BACKUP = 'true';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-inboxtest-'));

const { checkTest, inboxTestSummary, sendTest, testableAccounts } =
  await import('../server/inbox-test.js');
const { all, put, remove } = await import('../server/store.js');

const account = (id, extra = {}) => ({
  id,
  name: id,
  from: `${id}@example.dev`,
  user: `${id}@example.dev`,
  password: 'enc',
  provider: 'smtp',
  ...extra,
});

const accounts = [
  account('sender'),
  account('reader'),
  account('off', { disabled: true }),
  account('replies', { replyOnly: true }),
  account('marketing', { provider: 'mailchimp-marketing' }),
];

test('只把可发信的账号列进下拉框', () => {
  assert.deepEqual(
    testableAccounts(accounts).map((a) => a.id),
    ['sender', 'reader'],
  );
});

test('发测试信：纯文本、Message-ID 落到记录里，正文和标题都不带「测试」字样', async () => {
  const sent = [];
  const stored = [];
  const record = await sendTest({
    fromAccountId: 'sender',
    toAccountId: 'reader',
    now: Date.UTC(2026, 0, 5, 3, 0),
    deps: {
      accounts: () => accounts,
      putRecord: (r) => stored.push(r),
      newId: () => 't1',
      send: async (...args) => {
        sent.push(args);
        return { messageId: '<t1@example.dev>' };
      },
    },
  });
  assert.equal(sent.length, 1);
  const [from, to, subject, body, plainOnly] = sent[0];
  assert.equal(from.id, 'sender');
  assert.equal(to, 'reader@example.dev');
  assert.equal(plainOnly, true, '只发纯文本');
  // 一封写着「TEST」的信更容易被过滤，那样测出来的结果就是假的。
  for (const text of [subject, body])
    assert.equal(/test|测试|demo/i.test(text), false, `不该出现测试字样：${text}`);
  assert.equal(/https?:|www\./i.test(body), false, '正文不能带链接');
  assert.equal(record.messageId, '<t1@example.dev>');
  assert.equal(record.placement, '');
  assert.equal(stored.length, 1);
});

test('发测试信：收件邮箱必须是本应用里的账号，否则读不到落箱', async () => {
  const deps = { accounts: () => accounts, putRecord: () => {}, send: () => assert.fail('不该发') };
  await assert.rejects(
    () => sendTest({ fromAccountId: 'sender', toAccountId: 'unknown', deps }),
    /收件邮箱必须是本应用里可用的账号/,
  );
  await assert.rejects(
    () => sendTest({ fromAccountId: 'off', toAccountId: 'reader', deps }),
    /请选择一个可用的发件账号/,
  );
  // 自己的另一个可用账号可以，寄给自己也允许（只验证服务商内部投递）。
  const sent = [];
  await sendTest({
    fromAccountId: 'sender',
    toAccountId: 'sender',
    deps: {
      ...deps,
      putRecord: () => {},
      send: async (...a) => (sent.push(a), { messageId: '<x@y>' }),
    },
  });
  assert.equal(sent.length, 1);
});

function fakeClient(placements) {
  let current = '';
  return {
    async mailboxOpen(folder) {
      current = folder;
      return {};
    },
    async list() {
      return [
        { path: 'INBOX', specialUse: '\\Inbox' },
        { path: '[Gmail]/Spam', specialUse: '\\Junk' },
      ];
    },
    async search({ header }) {
      const id = header['message-id'];
      return (placements[current] || []).includes(id) ? [1] : [];
    },
  };
}

function harness(records) {
  const written = new Map();
  return {
    written,
    deps: {
      list: () => records.map((r) => ({ ...r, ...(written.get(r.id) || {}) })),
      accounts: () => accounts,
      putRecord: (r) => written.set(r.id, r),
      password: () => 'pw',
      connect: (acct, password, run) =>
        run(fakeClient({ INBOX: ['in-inbox@x'], '[Gmail]/Spam': ['in-junk@x'] })),
    },
  };
}

test('检查落箱：收件箱 / 垃圾箱 / 没到，各自给一句人能看懂的结论', async () => {
  const now = Date.UTC(2026, 0, 5, 3, 0);
  const records = [
    {
      id: 'a',
      toAccountId: 'reader',
      to: 'reader@x',
      messageId: '<in-inbox@x>',
      sentAt: now - 300000,
    },
    {
      id: 'b',
      toAccountId: 'reader',
      to: 'reader@x',
      messageId: '<in-junk@x>',
      sentAt: now - 300000,
    },
    { id: 'c', toAccountId: 'reader', to: 'reader@x', messageId: '<lost@x>', sentAt: now - 300000 },
  ];
  const { written, deps } = harness(records);
  const result = await checkTest({ now, deps });
  assert.equal(result.checked, 3);
  assert.equal(written.get('a').placement, 'inbox');
  assert.equal(written.get('b').placement, 'junk');
  assert.equal(written.get('c').placement, '', '一次没找到不判死');
});

test('检查落箱：只有三次都找不到（或超过 6 小时）才算「没到」', async () => {
  const now = Date.UTC(2026, 0, 5, 3, 0);
  const records = [
    { id: 'c', toAccountId: 'reader', to: 'reader@x', messageId: '<lost@x>', sentAt: now - 300000 },
  ];
  const { written, deps } = harness(records);
  await checkTest({ now, deps });
  await checkTest({ now, deps });
  assert.equal(written.get('c').placement, '');
  await checkTest({ now, deps });
  assert.equal(written.get('c').placement, 'missing');
  assert.equal(written.get('c').attempts, 3);
});

test('检查落箱：太新的信不自动查，但指定 id 时立刻查', async () => {
  const now = Date.UTC(2026, 0, 5, 3, 0);
  const records = [
    {
      id: 'fresh',
      toAccountId: 'reader',
      to: 'reader@x',
      messageId: '<in-inbox@x>',
      sentAt: now - 4000,
    },
  ];
  const { written, deps } = harness(records);
  const auto = await checkTest({ now, deps });
  assert.equal(auto.checked, 0);
  assert.match(auto.reason, /没有待检查/);
  const forced = await checkTest({ now, id: 'fresh', deps });
  assert.equal(forced.checked, 1);
  assert.equal(written.get('fresh').placement, 'inbox');
});

test('检查落箱：IMAP 出错时不改写记录（网络抖动不等于落箱结果）', async () => {
  const now = Date.UTC(2026, 0, 5, 3, 0);
  const records = [
    {
      id: 'a',
      toAccountId: 'reader',
      to: 'reader@x',
      messageId: '<in-inbox@x>',
      sentAt: now - 300000,
    },
  ];
  const written = new Map();
  const result = await checkTest({
    now,
    deps: {
      list: () => records,
      accounts: () => accounts,
      putRecord: (r) => written.set(r.id, r),
      password: () => 'pw',
      connect: () => {
        throw new Error('ETIMEDOUT');
      },
    },
  });
  assert.equal(result.checked, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(written.size, 0, '记录保持原样，下次再查');
});

test('汇总：历史次数、待检查数、可自检与否', () => {
  for (const r of all('placement-test')) remove('placement-test', r.id);
  for (const a of all('account')) remove('account', a.id);
  put('account', account('sender'));
  put('placement-test', {
    id: 'h1',
    fromAccountId: 'sender',
    from: 'sender@x',
    toAccountId: 'reader',
    to: 'reader@x',
    messageId: '<h1@x>',
    sentAt: Date.now() - 600000,
    placement: 'junk',
    attempts: 1,
    checkedAt: Date.now(),
  });
  const summary = inboxTestSummary();
  assert.equal(summary.totals.checked, 1);
  assert.equal(summary.totals.junk, 1);
  assert.equal(summary.pending, 0);
  assert.equal(summary.canTest, true, '有一个可用账号就能自检');
  assert.match(summary.last.hint, /垃圾箱/);
  // 落箱是垃圾箱时，结论必须明确「先别发冷邮件」。
  assert.match(summary.last.hint, /先别发冷邮件/);
});
