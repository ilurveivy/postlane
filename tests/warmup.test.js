import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTLANE_MODE = 'live';
process.env.DISABLE_BACKUP = 'true';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-warmup-'));

const {
  MIN_GAP_MS,
  accountPool,
  checkWarmupPlacement,
  normalizeConfig,
  nextPairs,
  pickTopic,
  rotationPairs,
  runWarmupRound,
  saveWarmupConfig,
  warmupSummary,
} = await import('../server/warmup.js');
const { localParts } = await import('../server/send-policy.js');

const account = (id, extra = {}) => ({
  id,
  name: id,
  from: `${id}@example.dev`,
  user: `${id}@example.dev`,
  password: 'enc',
  provider: 'smtp',
  ...extra,
});

const cfg = (extra = {}) => normalizeConfig({ accountIds: ['a', 'b'], dailyCount: 3, ...extra });

test('配置：一个账号开不起来，天数被夹在 1..10', () => {
  // 只有一个邮箱时「互寄」无从谈起 —— 这一条是用户明确要求的语义。
  assert.equal(normalizeConfig({ enabled: true, accountIds: ['a'] }).enabled, false);
  assert.equal(normalizeConfig({ enabled: true, accountIds: ['a', 'b'] }).enabled, true);
  assert.equal(normalizeConfig({ accountIds: ['a', 'b'], dailyCount: 99 }).dailyCount, 10);
  assert.equal(normalizeConfig({ accountIds: ['a', 'b'], dailyCount: 0 }).dailyCount, 1);
  assert.equal(normalizeConfig({ accountIds: ['a', 'b'] }).dailyCount, 3);
  assert.deepEqual(normalizeConfig({ accountIds: ['a', 'a', 'b'] }).accountIds, ['a', 'b']);
});

test('账号池：停用的、只做回复的、Mailchimp 渠道都不参与互寄', () => {
  const accounts = [
    account('a'),
    account('b'),
    account('c', { disabled: true }),
    account('d', { replyOnly: true }),
    account('e', { provider: 'mailchimp' }),
    account('f', { from: '' }),
  ];
  const pool = accountPool(cfg({ accountIds: ['a', 'b', 'c', 'd', 'e', 'f', 'ghost'] }), accounts);
  assert.deepEqual(
    pool.map((x) => x.id),
    ['a', 'b'],
  );
});

test('轮换配对：两个账号互寄且永不发给自己，三个账号每轮换一个人', () => {
  assert.deepEqual(rotationPairs(['a', 'b'], 0), [
    { fromAccountId: 'a', toAccountId: 'b' },
    { fromAccountId: 'b', toAccountId: 'a' },
  ]);
  assert.deepEqual(rotationPairs(['a', 'b'], 7), rotationPairs(['a', 'b'], 0));
  // 第 0 轮寄给下一个人，第 1 轮跳过一个人，第 2 轮回到第 0 轮。
  assert.deepEqual(
    rotationPairs(['a', 'b', 'c'], 0).map((p) => p.toAccountId),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    rotationPairs(['a', 'b', 'c'], 1).map((p) => p.toAccountId),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(rotationPairs(['a', 'b', 'c'], 2), rotationPairs(['a', 'b', 'c'], 0));
  for (const round of [0, 1, 2, 3, 4])
    for (const p of rotationPairs(['a', 'b', 'c'], round))
      assert.notEqual(p.fromAccountId, p.toAccountId, '永远不给自己发');
  assert.deepEqual(rotationPairs(['a'], 0), []);
});

test('节奏：每天每账号有上限，两次之间至少隔 40 分钟', () => {
  const now = Date.UTC(2026, 0, 5, 3, 0); // SG 11:00
  const pool = [account('a'), account('b')];
  assert.deepEqual(
    nextPairs(cfg(), pool, [], now).map((p) => p.fromAccountId),
    ['a', 'b'],
  );
  const justSent = [
    {
      fromAccountId: 'a',
      toAccountId: 'b',
      sentAt: now - 60_000,
      placement: '',
    },
    {
      fromAccountId: 'b',
      toAccountId: 'a',
      sentAt: now - 60_000,
      placement: '',
    },
  ];
  assert.deepEqual(nextPairs(cfg(), pool, justSent, now), [], '刚发过就要等，不能连着刷');
  assert.equal(
    nextPairs(cfg(), pool, justSent, now + MIN_GAP_MS, { ignoreGap: true }).length,
    2,
    '手动试发可以跳过间隔',
  );
  // 到了每日上限就彻底停，手动点也不会多发。
  const used = justSent.map((m) => ({ ...m, sentAt: now - 10 * 60_000 - MIN_GAP_MS }));
  assert.deepEqual(nextPairs(cfg({ dailyCount: 1 }), pool, used, now), []);
});

test('试发一轮：两个账号各发出两封，记录 Message-ID，失败只影响那一个账号', async () => {
  const sent = [];
  const stored = [];
  const deps = {
    loadConfig: () => cfg({ dailyCount: 3 }),
    accounts: () => [account('a'), account('b'), account('c')],
    messages: () => stored,
    putMessage: (m) => stored.push(m),
    newId: () => 'w-' + stored.length,
    send: async (from, to, subject, body, plainOnly) => {
      if (from.id === 'c') throw new Error('SMTP 530 auth required');
      sent.push({ from: from.from, to, subject, plainOnly });
      return { messageId: `<${from.id}-${stored.length}@example.dev>` };
    },
  };
  const result = await runWarmupRound({
    force: true,
    now: Date.UTC(2026, 0, 5, 3, 0),
    deps: { ...deps, loadConfig: () => cfg({ accountIds: ['a', 'b', 'c'] }) },
  });
  // 三个账号各自发一封，其中 c 的 SMTP 失败 —— 另外两封照发。
  assert.equal(result.sent, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /530/);
  assert.equal(
    sent.every((s) => s.plainOnly === true),
    true,
    '预热信只发纯文本',
  );
  assert.equal(
    sent.some((s) => s.from === s.to),
    false,
  );
  assert.equal(stored.length, 2);
  assert.ok(stored.every((m) => m.messageId.startsWith('<') && m.placement === ''));
});

test('试发一轮：开关关掉就不发，账号不够就明说原因', async () => {
  const deps = {
    loadConfig: () => cfg({ enabled: false }),
    accounts: () => [account('a'), account('b')],
    messages: () => [],
    putMessage: () => assert.fail('不该写信件记录'),
    send: () => assert.fail('不该发送'),
  };
  assert.equal((await runWarmupRound({ deps })).reason, 'disabled');
  const single = await runWarmupRound({
    force: true,
    deps: { ...deps, loadConfig: () => cfg({ accountIds: ['a'] }) },
  });
  assert.equal(single.reason, 'need-two-accounts');
  assert.equal(single.sent, 0);
});

function fakeClient(placements) {
  let current = '';
  return {
    async mailboxOpen(path) {
      current = path;
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

test('落箱检查：能读出「进收件箱 / 进垃圾箱 / 没到」，没到的会先重试再判定', async () => {
  const now = Date.UTC(2026, 0, 5, 3, 0);
  const messages = [
    { id: 'm1', toAccountId: 'b', messageId: '<in-inbox@x>', sentAt: now - 5 * 60_000 },
    { id: 'm2', toAccountId: 'b', messageId: '<in-junk@x>', sentAt: now - 5 * 60_000 },
    { id: 'm3', toAccountId: 'b', messageId: '<nowhere@x>', sentAt: now - 5 * 60_000 },
  ];
  const written = new Map();
  const deps = {
    messages: () => messages.map((m) => ({ ...m, ...(written.get(m.id) || {}) })),
    accounts: () => [account('a'), account('b')],
    putMessage: (m) => written.set(m.id, m),
    password: () => 'pw',
    connect: (acct, password, run) =>
      run(fakeClient({ INBOX: ['in-inbox@x'], '[Gmail]/Spam': ['in-junk@x'] })),
  };
  const first = await checkWarmupPlacement({ now, deps });
  assert.equal(first.checked, 3);
  assert.equal(written.get('m1').placement, 'inbox');
  assert.equal(written.get('m2').placement, 'junk');
  assert.equal(written.get('m3').placement, '', '第一次没找到不急着判死');
  assert.equal(written.get('m3').attempts, 1);

  await checkWarmupPlacement({ now, deps });
  await checkWarmupPlacement({ now, deps });
  assert.equal(written.get('m3').placement, 'missing', '三次都找不到才算没到');
});

test('落箱检查：太新的信先不查（SMTP 不是瞬时的）', async () => {
  const now = Date.UTC(2026, 0, 5, 3, 0);
  const deps = {
    messages: () => [{ id: 'm1', toAccountId: 'b', messageId: '<x@x>', sentAt: now - 5000 }],
    accounts: () => [account('b')],
    putMessage: () => assert.fail('不该写入'),
    connect: () => assert.fail('不该连接'),
  };
  assert.deepEqual(await checkWarmupPlacement({ now, deps }), {
    checked: 0,
    accounts: 0,
    errors: [],
  });
});

test('落箱率：按最近 20 封算，没有结论时不伪造数字', () => {
  const summary = warmupSummary();
  assert.equal(summary.recent.inboxRate, null, '还没检测过就是 null，不是 100%');
  assert.equal(summary.todaySent, 0);
  assert.equal(summary.pendingChecks, 0);
});

test('话题库：同一个种子稳定，换个人就换话题', () => {
  const a = pickTopic('a@x|b@x|0|2026-01-05');
  assert.deepEqual(pickTopic('a@x|b@x|0|2026-01-05'), a);
  const seen = new Set(
    ['a@x|b@x|0|d', 'b@x|a@x|0|d', 'a@x|c@x|0|d', 'c@x|a@x|0|d'].map((s) => pickTopic(s).subject),
  );
  assert.ok(seen.size > 1, '不同配对不该念同一段稿子');
  assert.equal(/https?:|www\./i.test(a.body), false, '预热信里不能有链接');
});

test('配置能存能读，单账号时开关自动落回关', () => {
  saveWarmupConfig({ enabled: true, accountIds: ['a', 'b'], dailyCount: 5 });
  assert.equal(warmupSummary().config.dailyCount, 5);
  saveWarmupConfig({ accountIds: ['a'] });
  const after = warmupSummary().config;
  assert.equal(after.enabled, false);
  assert.deepEqual(after.accountIds, ['a']);
  // 时间戳用的是新加坡日期，避免跨时区把「今天」算错。
  assert.equal(typeof localParts(Date.now()).date, 'string');
});
