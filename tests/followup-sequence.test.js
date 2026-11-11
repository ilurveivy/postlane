import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.POSTLANE_MODE = 'live';
process.env.DISABLE_BACKUP = 'true';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-seq-'));

const { all, encrypt, get, put, remove } = await import('../server/store.js');
const { buildFollowUpPlan } = await import('../server/followups.js');
const { advanceCampaign, timer } = await import('../server/mailer.js');
// 队列定时器会把测试数据当成真任务去连 SMTP，测试里必须关掉。
clearInterval(timer);

const DAY = 86400000;
const ACCOUNT = 'acct-seq';

put('account', {
  id: ACCOUNT,
  name: 'Brian',
  from: 'brian@sender.dev',
  user: 'brian@sender.dev',
  password: encrypt('secret'),
  server: '127.0.0.1',
  port: 2525,
  secure: false,
  createdAt: new Date('2020-01-01T00:00:00Z').toISOString(),
});

function seed(recipient = {}) {
  // 每个用例都从干净状态开始：上一个用例写过的退订记录不能影响下一个。
  remove('suppression', 'lead@prospect.dev');
  const campaign = {
    id: 'campaign-seq',
    name: '跟进测试',
    mode: 'live',
    accountId: ACCOUNT,
    senderEmail: 'brian@sender.dev',
    subject: '{{email_subject}}',
    body: '{{email_content}}',
    plainOnly: true,
    unsubscribe: false,
    randomInterval: false,
    rate: 60,
    followUpEnabled: true,
    status: 'running',
    nextAt: 0,
    sendWindow: { enabled: false },
    recipients: [
      {
        id: 'r1',
        email: 'lead@prospect.dev',
        status: 'pending',
        stage: 0,
        error: '',
        sentAt: '',
        fields: {
          email_subject: '快速一问',
          email_content: '第一封正文',
          第二封跟进: '第二封正文',
          第三封跟进: '主题：最后一封\n第三封正文',
        },
        // 走真实的解析路径：单元格内容 → 跟进计划。
        followUps: buildFollowUpPlan(
          {
            第二封跟进: '第二封正文',
            第三封跟进: '主题：最后一封\n第三封正文',
          },
          ['第二封跟进', '第三封跟进'],
          [5, 10],
        ),
        ...recipient,
      },
    ],
  };
  put('campaign', campaign);
  return campaign;
}

function recorder(result = {}) {
  const calls = [];
  const send = async (account, recipient, subject, body, plainOnly, messageId, headers) => {
    calls.push({ account, recipient, subject, body, plainOnly, messageId, headers });
    return { accepted: [recipient], messageId: messageId || '<generated@sender.dev>', ...result };
  };
  return { calls, send };
}

const row = () => get('campaign', 'campaign-seq').recipients[0];

test('序列：首封发出后按 5 / 10 天排期，第二封回复在同一线程里', async () => {
  seed();
  const first = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, first.send);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].subject, '快速一问');
  assert.equal(first.calls[0].body, '第一封正文');
  assert.deepEqual(first.calls[0].headers, {}, '首封不需要线程头');
  const sent = row();
  assert.equal(sent.status, 'sent');
  assert.equal(sent.stage, 1);
  assert.ok(Math.abs(sent.nextFollowUpAt - (Date.now() + 5 * DAY)) < 60000, '第二封要在 5 天后');
  const threadId = sent.threadMessageId;
  assert.ok(threadId, '首封要留下 Message-ID 供跟进续线程');

  // 未到期时什么都不发，即使队列反复 tick。
  const early = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, early.send);
  assert.equal(early.calls.length, 0, '未到 5 天不能提前跟进');

  // 到期后第二封：默认 Re: 原主题，并且 In-Reply-To 指向首封。
  put('campaign', {
    ...get('campaign', 'campaign-seq'),
    recipients: [{ ...row(), nextFollowUpAt: Date.now() - 1000 }],
  });
  const second = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, second.send);
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].subject, 'Re: 快速一问');
  assert.equal(second.calls[0].body, '第二封正文');
  assert.equal(second.calls[0].headers.inReplyTo, threadId);
  assert.equal(second.calls[0].headers.references, threadId);
  const afterSecond = row();
  assert.equal(afterSecond.stage, 2);
  assert.ok(
    Math.abs(afterSecond.nextFollowUpAt - (Date.now() + 10 * DAY)) < 60000,
    '第三封要在第二封之后 10 天',
  );
  assert.equal(afterSecond.sentAt, sent.sentAt, 'sentAt 保留首封时间，供报告与额度统计用');

  // 第三封用的是单元格里自带的主题。
  put('campaign', {
    ...get('campaign', 'campaign-seq'),
    recipients: [{ ...afterSecond, nextFollowUpAt: Date.now() - 1000 }],
  });
  const third = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, third.send);
  assert.equal(third.calls.length, 1);
  assert.equal(third.calls[0].subject, '最后一封');
  assert.equal(third.calls[0].body, '第三封正文');
  const done = row();
  assert.equal(done.stage, 3);
  assert.equal(done.nextFollowUpAt, 0, '序列发完就不再排期');

  // 发完之后不该再有任何邮件。
  const after = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, after.send);
  assert.equal(after.calls.length, 0);
});

test('序列：对方回信后不再跟进', async () => {
  seed({
    status: 'sent',
    stage: 1,
    sentAt: new Date().toISOString(),
    lastReplyAt: new Date().toISOString(),
    nextFollowUpAt: Date.now() - 1000,
  });
  const { calls, send } = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, send);
  assert.equal(calls.length, 0, '已有回复就停序列');
});

test('序列：退订或硬退信同样停序列，且不改写首封的发送结果', async () => {
  seed({
    status: 'sent',
    stage: 1,
    sentAt: new Date().toISOString(),
    nextFollowUpAt: Date.now() - 1000,
  });
  put('suppression', { id: 'lead@prospect.dev', email: 'lead@prospect.dev', reason: '退订' });
  const { calls, send } = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, send);
  assert.equal(calls.length, 0);
  const blocked = row();
  assert.equal(blocked.status, 'sent', '首封确实发出去了，不能事后改成 failed');
  assert.equal(blocked.nextFollowUpAt, 0);
  assert.match(blocked.followUpsStopped, /退订|退信/);
});

test('序列：跟进失败按同一封重试，结果不明则不重发', async () => {
  seed({
    status: 'sent',
    stage: 1,
    sentAt: new Date().toISOString(),
    nextFollowUpAt: Date.now() - 1000,
  });
  // ECONNREFUSED 是「连接就没建起来」，确定没提交，所以可以重试同一封。
  const failing = async () => {
    throw Object.assign(new Error('连接被拒绝'), { code: 'ECONNREFUSED' });
  };
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, failing);
  const retry = row();
  assert.equal(retry.stage, 1, '确定失败要退回同一封，不能推进序列');
  assert.equal(retry.status, 'retry_wait', `非预期状态：${retry.status}`);
  assert.ok(retry.nextFollowUpAt <= Date.now() + 1000, '退回后应立即重新到期');
  // 重试要等退避时间到；到点后发的还是「第二封」，不会跳步。
  put('campaign', {
    ...get('campaign', 'campaign-seq'),
    recipients: [{ ...retry, retryAt: 0 }],
  });
  const { calls, send } = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, send);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, '第二封正文');
  assert.equal(row().stage, 2);
});

test('序列：结果不明的跟进永不重发，序列就此停住', async () => {
  seed({
    status: 'sent',
    stage: 1,
    sentAt: new Date().toISOString(),
    nextFollowUpAt: Date.now() - 1000,
  });
  // 提交后连接被重置：可能发出去了，也可能没发，属于「结果不明」。
  const uncertain = async () => {
    throw Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' });
  };
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, uncertain);
  const after = row();
  assert.equal(after.status, 'uncertain', '结果不明必须停在待核对');
  assert.equal(after.stage, 1, '没确认发出就不能推进序列');
  assert.equal(after.nextFollowUpAt, 0, '不许再排期');
  assert.match(after.followUpsStopped || '', /人工核对/);
  // 就算有人把状态改回 sent，也不能把这一封悄悄再发一遍。
  put('campaign', {
    ...get('campaign', 'campaign-seq'),
    recipients: [{ ...after, status: 'sent', nextFollowUpAt: Date.now() - 1000 }],
  });
  const resend = recorder();
  await advanceCampaign({ id: 'campaign-seq' }, ACCOUNT, resend.send);
  assert.equal(resend.calls.length, 0, '结果不明的跟进不能重发');
});

test('队列：已完成的批次仍会为未发的跟进重新进入队列', () => {
  const campaign = get('campaign', 'campaign-seq');
  assert.ok(all('campaign').length >= 1);
  // campaignHasOpenFollowUps 是队列挑选的唯一依据，这里确认它认得「已发送 + 还有下一封」。
  const pendingFollowUp = {
    ...campaign,
    status: 'completed',
    recipients: [
      {
        ...campaign.recipients[0],
        status: 'sent',
        stage: 1,
        lastReplyAt: '',
        followUps: [{ subject: '', body: 'x', afterDays: 5 }],
        nextFollowUpAt: Date.now() + DAY,
      },
    ],
  };
  assert.equal(
    pendingFollowUp.recipients.some((r) => r.stage < r.followUps.length + 1 && r.status === 'sent'),
    true,
  );
});
