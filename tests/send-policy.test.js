import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DAILY_CAP,
  TIME_ZONE,
  dailyCapFor,
  dayNumber,
  hasOptOutWording,
  localParts,
  minutesOf,
  nextWindowOpenAt,
  rampCap,
  rampFor,
  sentOnDate,
  sentToday,
  unsubscribeFooter,
  unsubscribeHeaders,
  windowConfig,
  windowOpen,
} from '../server/send-policy.js';

// Singapore is UTC+8 with no daylight saving, so these instants are stable fixtures.
const MONDAY_9AM = Date.parse('2026-03-02T01:00:00Z');
const MONDAY_10AM = Date.parse('2026-03-02T02:00:00Z');
const MONDAY_6PM = Date.parse('2026-03-02T10:00:00Z');
const MONDAY_8PM = Date.parse('2026-03-02T12:00:00Z');
const SATURDAY_8PM = Date.parse('2026-03-07T12:00:00Z');
const SUNDAY_NOON = Date.parse('2026-03-08T04:00:00Z');
const MONDAY_DAY_30 = Date.parse('2026-03-31T02:00:00Z');

const DAY = 86400000;

test('发送策略：时区与本地时间解析固定在新加坡', () => {
  assert.equal(TIME_ZONE, 'Asia/Singapore');
  const local = localParts(MONDAY_10AM);
  assert.equal(local.date, '2026-03-02');
  assert.equal(local.weekday, 1);
  assert.equal(local.minutes, 10 * 60);
  assert.equal(localParts(MONDAY_8PM).minutes, 20 * 60);
});

test('发送策略：时间段解析拒绝非法值，全周时段视为不限时段', () => {
  assert.equal(minutesOf('09:00'), 540);
  assert.equal(minutesOf('9:05'), 545);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf('09:60'), null);
  assert.equal(minutesOf(''), null);
  assert.equal(windowConfig({}), null, '没有配置窗口时按 24 小时发送');
  assert.deepEqual(
    [...windowConfig({ sendWindow: { days: [1, 2], start: '09:00', end: '18:00' } }).days],
    [1, 2],
  );
  // Start after end is a configuration mistake: treat it as "no restriction" instead of
  // never sending at all, so a typo cannot silently freeze a campaign.
  assert.equal(windowConfig({ sendWindow: { days: [1], start: '18:00', end: '09:00' } }), null);
  assert.equal(windowConfig({ sendWindow: { days: [], start: '09:00', end: '18:00' } }), null);
});

test('发送策略：窗口按新加坡时间判断，结束时刻不包含在内', () => {
  const campaign = {
    sendWindow: { enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  };
  assert.equal(windowOpen(campaign, MONDAY_9AM), true);
  assert.equal(windowOpen(campaign, MONDAY_10AM), true);
  assert.equal(windowOpen(campaign, MONDAY_6PM), false);
  assert.equal(windowOpen(campaign, MONDAY_8PM), false);
  assert.equal(windowOpen(campaign, SATURDAY_8PM), false);
  assert.equal(windowOpen({ sendWindow: { enabled: false } }, SATURDAY_8PM), true);
  assert.equal(windowOpen({}, SATURDAY_8PM), true);
});

test('发送策略：窗口外算出下一个可发送时刻', () => {
  const campaign = {
    sendWindow: { enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  };
  assert.equal(nextWindowOpenAt(campaign, MONDAY_10AM), MONDAY_10AM, '窗口内返回当前时刻');
  // Monday 20:00 → Tuesday 09:00 (Singapore).
  assert.equal(nextWindowOpenAt(campaign, MONDAY_8PM), Date.parse('2026-03-03T01:00:00Z'));
  // Saturday 20:00 → the following Monday 09:00, skipping the weekend.
  assert.equal(nextWindowOpenAt(campaign, SATURDAY_8PM), Date.parse('2026-03-09T01:00:00Z'));
  assert.equal(nextWindowOpenAt(campaign, SUNDAY_NOON), Date.parse('2026-03-09T01:00:00Z'));
  assert.equal(nextWindowOpenAt({}, SATURDAY_8PM), SATURDAY_8PM, '不限时段时立刻可发');
});

test('发送策略：新账号按 20 → 30 → 50 → 100 → 200 爬坡', () => {
  assert.equal(rampCap(1), 20);
  assert.equal(rampCap(3), 20);
  assert.equal(rampCap(4), 30);
  assert.equal(rampCap(7), 30);
  assert.equal(rampCap(8), 50);
  assert.equal(rampCap(14), 50);
  assert.equal(rampCap(15), 100);
  assert.equal(rampCap(30), 100);
  assert.equal(rampCap(31), MAX_DAILY_CAP);
  assert.equal(rampCap(9999), MAX_DAILY_CAP);

  const createdAt = new Date(MONDAY_9AM).toISOString();
  assert.equal(dayNumber(createdAt, MONDAY_9AM), 1);
  assert.equal(dayNumber(createdAt, MONDAY_9AM + 3 * DAY), 4);
  assert.equal(dayNumber('not-a-date', MONDAY_9AM), null);
  assert.equal(dailyCapFor({ createdAt }, MONDAY_9AM), 20);
  assert.equal(dailyCapFor({ createdAt }, MONDAY_9AM + 4 * DAY), 30);
  assert.equal(rampFor({ createdAt }, MONDAY_9AM + 4 * DAY).day, 5);
});

test('发送策略：显式上限优先但仍受 200 封硬顶约束', () => {
  const createdAt = new Date(MONDAY_9AM).toISOString();
  assert.equal(dailyCapFor({ createdAt, dailyCap: 50 }, MONDAY_9AM), 50);
  assert.equal(dailyCapFor({ createdAt, dailyCap: 200 }, MONDAY_9AM), 200);
  assert.equal(dailyCapFor({ createdAt, dailyCap: 999 }, MONDAY_9AM), MAX_DAILY_CAP);
  // Accounts with no recorded date (legacy rows) are treated as mature rather than
  // throttled to a ramp they never agreed to.
  assert.equal(dailyCapFor({}, MONDAY_9AM), MAX_DAILY_CAP);
  assert.equal(
    dailyCapFor({ verifiedAt: new Date(MONDAY_9AM).toISOString() }, MONDAY_9AM + 31 * DAY),
    MAX_DAILY_CAP,
  );
});

test('发送策略：只统计当天已进入投递流程的邮件', () => {
  const at = new Date(MONDAY_10AM).toISOString();
  const campaigns = [
    {
      accountId: 'a1',
      mode: 'live',
      recipients: [
        { status: 'sent', sentAt: at },
        { status: 'uncertain', sentAt: at },
        { status: 'failed', sentAt: at },
        { status: 'pending' },
        { status: 'sent', sentAt: new Date(MONDAY_10AM + DAY).toISOString() },
      ],
    },
    { accountId: 'a1', mode: 'simulation', recipients: [{ status: 'sent', sentAt: at }] },
    { accountId: 'a2', mode: 'live', recipients: [{ status: 'sent', sentAt: at }] },
    { accountId: 'a3', mode: 'live', recipients: [{ status: 'sent' }] },
  ];
  assert.equal(sentOnDate(campaigns, ['a1'], '2026-03-02'), 2);
  assert.equal(sentOnDate(campaigns, ['a1', 'a2'], '2026-03-02'), 3);
  assert.equal(sentOnDate(campaigns, ['a2'], '2026-03-02'), 1);
  assert.equal(sentOnDate(campaigns, [], '2026-03-02'), 0);
  assert.equal(sentToday(campaigns, ['a1'], MONDAY_10AM), 2);
});

test('发送策略：退订说明与 List-Unsubscribe 头', () => {
  assert.equal(hasOptOutWording('正文里写了退订'), true);
  assert.equal(hasOptOutWording('Reply UNSUBSCRIBE to stop'), true);
  assert.equal(hasOptOutWording('取消订阅请联系我们'), true);
  assert.equal(hasOptOutWording('普通正文'), false);
  const footer = unsubscribeFooter('sender@acme.dev');
  assert.match(footer, /退订/);
  assert.match(footer, /sender@acme\.dev/);
  assert.deepEqual(unsubscribeHeaders('sender@acme.dev'), {
    'List-Unsubscribe': '<mailto:sender@acme.dev?subject=unsubscribe>',
  });
  assert.deepEqual(unsubscribeHeaders(''), {});
});
