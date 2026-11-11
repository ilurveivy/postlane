import { assertActivityAllowed, workersEnabled, runActivity } from './runtime-policy.js';
import { returnToPool } from './return-to-pool.js';
import { candidate, campaignReadyAt, finishCampaign, failureOutcome } from './delivery-policy.js';
import { createAccountQueue } from './account-queue.js';
import { randomUUID } from 'node:crypto';
import { marketingClient, marketingCall, advanceMarketing } from './marketing.js';
import nodemailer from 'nodemailer';
import { mailchimpClient, sendMailchimp, verifyMailchimp } from './mailchimp.js';
import { smtpProxy } from './network.js';
import { all, get, put, decrypt } from './store.js';
import { render, emailHtml, sendDelay } from './domain.js';
export function settings(accountId) {
  return accountId ? get('account', accountId) : get('settings', 'smtp');
}
const legacy = settings();
if (workersEnabled && legacy && !get('account', 'smtp')) put('account', { ...legacy, id: 'smtp' });
export function assertAccountAvailable(s) {
  if (s?.disabled)
    throw Object.assign(new Error('发件账号不可用：' + (s.disabledReason || '已停用')), {
      code: 'EAUTH',
    });
}
export function transport(s = settings()) {
  assertActivityAllowed();
  assertAccountAvailable(s);
  if (!s?.host || !s?.password) throw new Error('请先在发件设置中配置 SMTP 账号');
  return nodemailer.createTransport({
    host: s.host,
    proxy: smtpProxy(s.host),
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure,
    auth: { user: s.user, pass: decrypt(s.password) },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}
export async function verifyAccount(...args) {
  return runActivity(() => verifyAccountImpl(...args));
}
async function verifyAccountImpl(s) {
  assertActivityAllowed();
  if (s.provider === 'mailchimp-marketing') {
    const client = marketingClient(decrypt(s.password), s.server);
    await marketingCall(() => client.ping.get());
    if (s.audienceId) await marketingCall(() => client.lists.getList(s.audienceId));
    return;
  }
  if (s.provider === 'mailchimp')
    return verifyMailchimp(mailchimpClient(decrypt(s.password)), s.from);
  const t = transport(s);
  try {
    await t.verify();
  } finally {
    t.close();
  }
}
export async function sendOne(...args) {
  return runActivity(() => sendOneImpl(...args));
}
async function sendOneImpl(
  s,
  recipient,
  subject,
  body,
  plainOnly = false,
  stableMessageId,
  replyHeaders = {},
  makeTransport = transport,
) {
  assertActivityAllowed();
  assertAccountAvailable(s);
  if (s.provider === 'mailchimp-marketing')
    throw new Error('Marketing 必须通过活动提交，不能使用逐封发送通道');
  if (s.provider === 'mailchimp')
    return sendMailchimp(mailchimpClient(decrypt(s.password)), s, recipient, subject, body);
  const t = makeTransport(s);
  try {
    return await t.sendMail({
      messageId: stableMessageId,
      ...(replyHeaders.inReplyTo
        ? { inReplyTo: replyHeaders.inReplyTo, references: replyHeaders.references }
        : {}),
      from: { name: s.name, address: s.from },
      to: recipient,
      subject,
      text: body,
      ...(plainOnly ? {} : { html: emailHtml(body, s.name) }),
    });
  } finally {
    t.close();
  }
}
for (const c of workersEnabled ? all('campaign') : []) {
  let changed = false;
  for (const r of c.recipients)
    if (r.status === 'sending') {
      r.status = 'uncertain';
      r.error = '服务在提交期间中断，自动核对发件箱';
      r.failureKind = 'unknown';
      r.reconcileAt = Date.now() + 60000;
      changed = true;
    }
  if (c.status === 'running' && c.recoveryVersion !== 2) {
    Object.assign(c, returnToPool(c, '旧执行任务中断，未发送邮件退回未排期'));
    changed = true;
  }
  if (changed) put('campaign', c);
}
function accountKey(c) {
  const a = settings(c.accountId);
  return `${c.mode === 'simulation' ? 'simulation' : 'live'}:${String(
    a?.user || a?.from || c.accountId || 'smtp',
  )
    .trim()
    .toLowerCase()}`;
}
export async function advanceCampaign(...args) {
  return runActivity(() => advanceCampaignImpl(...args));
}
async function advanceCampaignImpl(selected, key, send = sendOne) {
  assertActivityAllowed();
  let c = get('campaign', selected.id);
  if (!c || !['running', 'scheduled'].includes(c.status)) return;
  if (c.status === 'scheduled') {
    c.status = 'running';
    put('campaign', c);
  }
  const chosen = settings(c.accountId);
  if (chosen?.replyOnly || (c.mode === 'live' && chosen?.disabled)) {
    put(
      'campaign',
      returnToPool(
        c,
        chosen?.replyOnly
          ? '账号仅用于回复，未发送邮件退回未排期'
          : '账号已停用，未发送邮件退回未排期',
      ),
    );
    return;
  }
  if (c.mode === 'live' && chosen?.provider === 'mailchimp-marketing') {
    await advanceMarketing(c, chosen, marketingClient(decrypt(chosen.password), chosen.server), {
      get: () => get('campaign', c.id),
      save: (value) => put('campaign', value),
    });
    return;
  }
  const row = candidate(c);
  if (!row) {
    put('campaign', finishCampaign(c));
    return;
  }
  if (c.mode === 'live' && get('suppression', row.email)) {
    row.status = 'failed';
    row.error = '收件地址永久退信或已退订，已阻止发送';
    put('campaign', finishCampaign(c));
    return;
  }
  row.status = 'sending';
  if (c.mode === 'live') row.messageId = `<${randomUUID()}@postlane.local>`;
  row.attempts ||= [];
  row.attempts.push({
    messageId: row.messageId,
    startedAt: new Date().toISOString(),
    status: 'sending',
  });
  put('campaign', c);
  let outcome = {};
  let status,
    error = '',
    messageId = row.messageId || '',
    providerStatus = '';
  try {
    if (c.mode === 'simulation') {
      await new Promise((r) => setTimeout(r, 200));
      status = 'simulated';
    } else {
      const account = settings(c.accountId);
      if (!account) throw new Error('发件账号不存在');
      if (c.senderEmail && account.from !== c.senderEmail)
        throw new Error('发件账号与任务绑定账号不一致，已暂停');
      const result = await send(
        account,
        row.email,
        render(c.subject, row.fields),
        render(c.body, row.fields),
        c.plainOnly === true,
        row.messageId,
      );
      if (!result.accepted?.length) throw new Error('发送服务未接受此收件人');
      status = 'sent';
      messageId = result.messageId;
      providerStatus = result.providerStatus || '';
    }
  } catch (e) {
    outcome = failureOutcome(e, row.attempts.length - (row.retryBase || 0));
    status = outcome.status;
    error = outcome.error;
  }
  c = get('campaign', c.id);
  const current = c.recipients.find((r) => r.id === row.id);
  Object.assign(current, {
    ...outcome,
    status,
    error,
    messageId,
    providerStatus,
    sentAt: new Date().toISOString(),
  });
  const attempt =
    current.attempts.find((a) => a.messageId === row.messageId) || current.attempts.at(-1);
  Object.assign(attempt, { status, error, completedAt: new Date().toISOString() });
  if (outcome.failureKind === 'account') {
    // Authentication affects the account, unlike an individual recipient failure.
    put('queue_account', { id: key, nextAt: Date.now() + 15 * 60000, error, blocked: true });
  }
  c.nextAt = Date.now() + sendDelay(c);
  put('queue_account', {
    ...get('queue_account', key),
    id: key,
    blocked: outcome.failureKind === 'account',
    error: outcome.failureKind === 'account' ? error : '',
    nextAt: Math.max(c.nextAt, outcome.failureKind === 'account' ? Date.now() + 15 * 60000 : 0),
  });
  if (c.status === 'running') finishCampaign(c);
  put('campaign', c);
}
const configuredLimit = Number(process.env.SEND_ACCOUNT_CONCURRENCY || 3);
export const accountConcurrency =
  Number.isInteger(configuredLimit) && configuredLimit >= 1 ? Math.min(configuredLimit, 3) : 3;
let reportQueue, replyQueue;
export function registerReplyQueue(value) {
  replyQueue = value;
}
export function registerReportQueue(value) {
  reportQueue = value;
}
const queue = createAccountQueue({
  limit: accountConcurrency,
  list: () =>
    (replyQueue?.list() || []).concat(
      all('campaign')
        .reverse()
        .filter(
          (c) =>
            c.status === 'running' ||
            (c.status === 'scheduled' && Date.parse(c.scheduledAt) <= Date.now()),
        )
        .concat(reportQueue?.list() || []),
    ),
  key: accountKey,
  readyAt: (c, key) =>
    Math.max(
      c.recipients ? campaignReadyAt(c) : c.nextAt || 0,
      get('queue_account', key)?.nextAt || 0,
    ),
  run: (c, key) =>
    c.replyJob
      ? replyQueue.run(c, key)
      : c.reportJob
        ? reportQueue.run(c, key)
        : advanceCampaign(c, key),
  onError: (error, c, key) => {
    if (c.replyJob) return replyQueue.error(error, c);
    if (c.reportJob) return reportQueue.error(error, c);
    // Never leave an interrupted submission eligible for automatic resubmission.
    const current = get('campaign', c.id);
    if (current) {
      for (const row of current.recipients) {
        if (row.status === 'sending') {
          row.status = 'uncertain';
          row.error = '队列执行异常，自动核对发件箱';
          row.failureKind = 'unknown';
          row.reconcileAt = Date.now() + 60000;
        }
      }
      put('campaign', current);
    }
    if (current) put('campaign', finishCampaign(current));
    console.error('Queue error:', error.message);
  },
});
export const timer = workersEnabled
  ? setInterval(() => {
      if (workersEnabled) queue.tick();
    }, 350)
  : null;
timer?.unref();
