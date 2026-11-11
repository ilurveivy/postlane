import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FOLLOW_UP_DELAYS,
  buildFollowUpPlan,
  campaignHasOpenFollowUps,
  detectFollowUpColumns,
  dueFollowUp,
  earliestFollowUpAt,
  hasOpenFollowUp,
  parseFollowUpCell,
  scheduleNextFollowUp,
  stageOf,
  validateFollowUpPlan,
} from '../server/followups.js';
import { candidate, campaignReadyAt } from '../server/delivery-policy.js';

const DAY = 86400000;
const sent = (over = {}) => ({
  id: 'r1',
  email: 'a@b.co',
  status: 'sent',
  stage: 1,
  sentAt: new Date().toISOString(),
  followUps: [{ afterDays: 5 }, { afterDays: 10 }],
  nextFollowUpAt: Date.now() - 1000,
  ...over,
});

test('跟进列：识别中文表头与 ASCII 别名', () => {
  assert.deepEqual(detectFollowUpColumns(['business_email', '第二封跟进', '第三封跟进']), [
    '第二封跟进',
    '第三封跟进',
  ]);
  assert.deepEqual(detectFollowUpColumns(['follow_up_2', 'Follow Up 3']), [
    'follow_up_2',
    'Follow Up 3',
  ]);
  // 没有这两个列时不该误判成别的列。
  assert.deepEqual(detectFollowUpColumns(['邮箱', '标题', '正文']), ['', '']);
});

test('跟进单元格：整格是正文，或以「主题：」开头单独给主题', () => {
  assert.deepEqual(parseFollowUpCell('上周发的想法，补充一句'), {
    subject: '',
    body: '上周发的想法，补充一句',
  });
  assert.deepEqual(parseFollowUpCell('主题：关于排期\n正文第一行\n第二行'), {
    subject: '关于排期',
    body: '正文第一行\n第二行',
  });
  assert.deepEqual(parseFollowUpCell('Subject: quick one\r\nbody here'), {
    subject: 'quick one',
    body: 'body here',
  });
  // 只有一行「主题：」而没有正文时，不该吞掉内容。
  assert.deepEqual(parseFollowUpCell('主题：只有标题'), {
    subject: '',
    body: '主题：只有标题',
  });
  assert.equal(parseFollowUpCell('   '), null);
  assert.equal(parseFollowUpCell(''), null);
  assert.equal(parseFollowUpCell(null), null);
});

test('跟进计划：空单元格表示到此为止，第三封不会越过空着的第二封', () => {
  const columns = ['第二封跟进', '第三封跟进'];
  const both = buildFollowUpPlan(
    { 第二封跟进: '第二封正文', 第三封跟进: '第三封正文' },
    columns,
    [5, 10],
  );
  assert.deepEqual(
    both.map((s) => [s.body, s.afterDays]),
    [
      ['第二封正文', 5],
      ['第三封正文', 10],
    ],
  );
  const onlySecond = buildFollowUpPlan({ 第二封跟进: '第二封正文' }, columns, [5, 10]);
  assert.equal(onlySecond.length, 1);
  assert.equal(onlySecond[0].afterDays, 5);
  // 只填第三封、第二封留空：序列在空处结束，不能凭空跳发第三封。
  const skipped = buildFollowUpPlan({ 第三封跟进: '第三封正文' }, columns, [5, 10]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(buildFollowUpPlan({}, columns), []);
  // 未识别到列时同样没有跟进。
  assert.deepEqual(buildFollowUpPlan({ 第二封跟进: 'x' }, ['', '']), []);
});

test('跟进计划：默认间隔是「5 天后第二封、再 10 天后第三封」', () => {
  const plan = buildFollowUpPlan({ 第二封跟进: 'a', 第三封跟进: 'b' }, [
    '第二封跟进',
    '第三封跟进',
  ]);
  assert.deepEqual(DEFAULT_FOLLOW_UP_DELAYS, [5, 10]);
  assert.deepEqual(
    plan.map((s) => s.afterDays),
    [5, 10],
  );
});

test('跟进计划：长度与间隔会被校验', () => {
  assert.throws(() => validateFollowUpPlan([{ body: 'x'.repeat(30001), afterDays: 5 }]), /正文/);
  assert.throws(() => validateFollowUpPlan([{ body: 'x', afterDays: 0 }]), /间隔/);
  assert.throws(() => validateFollowUpPlan([{ body: 'x', afterDays: 999 }]), /间隔/);
  assert.equal(validateFollowUpPlan([{ body: 'x', afterDays: 7 }]).length, 1);
  assert.equal(validateFollowUpPlan([]).length, 0);
});

test('阶段：只有「已确认发出」才有资格发跟进', () => {
  assert.equal(stageOf(sent()), 1);
  assert.equal(stageOf({ status: 'pending' }), 0);
  // 老数据没有 stage 字段：已发送等于发过 1 封。
  assert.equal(stageOf({ status: 'sent' }), 1);
  assert.equal(hasOpenFollowUp(sent()), true);
  assert.equal(dueFollowUp(sent(), Date.now()), true);
  // 还没到时间。
  assert.equal(dueFollowUp(sent({ nextFollowUpAt: Date.now() + DAY }), Date.now()), false);
  assert.equal(hasOpenFollowUp(sent({ nextFollowUpAt: Date.now() + DAY })), true);
  // 已回复 / 已退订 / 硬退信 / 结果不明 都不再发。
  assert.equal(hasOpenFollowUp(sent({ lastReplyAt: new Date().toISOString() })), false);
  assert.equal(hasOpenFollowUp(sent({ optedOutAt: new Date().toISOString() })), false);
  assert.equal(hasOpenFollowUp(sent({ deliveryStatus: 'bounced' })), false);
  assert.equal(hasOpenFollowUp(sent({ status: 'uncertain' })), false);
  assert.equal(hasOpenFollowUp(sent({ status: 'failed' })), false);
  // 第二封之后还剩第三封，第三封之后才算发完。
  assert.equal(hasOpenFollowUp(sent({ stage: 2 })), true);
  assert.equal(hasOpenFollowUp(sent({ stage: 3 })), false);
  assert.equal(hasOpenFollowUp(sent({ followUps: [] })), false);
});

test('排期：每封成功后才算下一封的起点', () => {
  // 只发出首封时，第二封在 5 天后。
  const first = sent({ stage: 1, nextFollowUpAt: 0 });
  assert.equal(scheduleNextFollowUp(first, 1000), 1000 + 5 * DAY);
  // 第二封发出后，第三封在再 10 天后。
  const second = sent({ stage: 2, nextFollowUpAt: 0 });
  assert.equal(scheduleNextFollowUp(second, 1000), 1000 + 10 * DAY);
  assert.equal(second.nextFollowUpAt, 1000 + 10 * DAY);
  // 第三封之后没有下一封。
  const last = sent({ stage: 3, nextFollowUpAt: 0 });
  assert.equal(scheduleNextFollowUp(last, 1000), 0);
  assert.equal(last.nextFollowUpAt, 0);
});

test('队列：首封永远优先，跟进只在到期后成为候选', () => {
  const now = Date.now();
  const due = sent({ id: 'due', nextFollowUpAt: now - 1 });
  const pending = { id: 'p', email: 'c@d.co', status: 'pending' };
  const future = sent({ id: 'future', nextFollowUpAt: now + DAY });
  const campaign = { recipients: [future, due, pending], nextAt: 0, followUpEnabled: true };
  assert.equal(candidate(campaign, now).id, 'p', '批量首封不能被跟进挤到后面');
  assert.equal(candidate({ recipients: [future, due] }, now).id, 'due');
  assert.equal(candidate({ recipients: [future] }, now), undefined);
  // 没到期时，队列应该睡到下一封跟进的时间，而不是空转。
  assert.equal(campaignReadyAt({ recipients: [future], nextAt: 0 }, now), future.nextFollowUpAt);
  assert.equal(earliestFollowUpAt(campaign), now - 1);
  assert.equal(campaignHasOpenFollowUps(campaign), true);
  assert.equal(campaignHasOpenFollowUps({ recipients: [{ status: 'pending' }] }), false);
  // 队列每 350ms 扫一次，所以任务级标记必须能挡住没有跟进的任务。
  assert.equal(campaignHasOpenFollowUps({ ...campaign, followUpEnabled: false }), false);
  assert.equal(campaignHasOpenFollowUps({ followUpEnabled: true }), false);
});
