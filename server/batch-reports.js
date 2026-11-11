import { executionReportTo, reportTo } from './report-recipients.js';
import { createBatchReportView } from './batch-report-view.js';
import { assertActivityAllowed, workersEnabled, runActivity } from './runtime-policy.js';
import { failureOutcome } from './delivery-policy.js';
import { randomUUID } from 'node:crypto';
import { all, get, put, db } from './store.js';
import { settings, sendOne, registerReportQueue } from './mailer.js';
import { syncMail, tracking } from './followup.js';
import { gmailAccount } from './followup-domain.js';
import {
  reportRecipients,
  AUDIT_DELAY,
  cancelledBeforeSending,
  terminalBatch,
  reportModel,
  reportText,
  executionStart,
  progressProblems,
} from './batch-report-domain.js';
export function createBatch(name, ids) {
  if (!name?.trim() || !Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw Error('请输入批次名称并选择任务');
  const campaigns = ids.map((id) => get('campaign', id));
  if (campaigns.some((c) => !c || c.status !== 'draft' || c.mode !== 'live'))
    throw Error('仅可将真实发送的草稿任务归入批次');
  if (all('report-batch').some((b) => b.campaignIds.some((id) => ids.includes(id))))
    throw Error('任务已经属于报告批次');
  return put('report-batch', {
    id: randomUUID(),
    name: name.trim().slice(0, 160),
    campaignIds: ids,
    recipients: reportTo(),
    status: 'waiting',
    createdAt: new Date().toISOString(),
  });
}
// Repair only the former builder default, preserving ordinary task preferences.
export function restoreBuilderReports() {
  db.transaction(() => {
    const generated = new Set(
      all('list')
        .filter((l) => l.builderGenerated)
        .map((l) => l.id),
    );
    for (const c of all('campaign'))
      if (generated.has(c.listId) && c.emailReports === false)
        put('campaign', { ...c, emailReports: true });
    for (const b of all('report-batch')) {
      if (b.emailReports !== false || b.sample || b.mergedInto || !b.campaignIds.length) continue;
      const campaigns = b.campaignIds.map((id) => get('campaign', id));
      if (
        campaigns.every((c) => c && c.mode === 'live' && generated.has(c.listId)) &&
        !cancelledBeforeSending(campaigns)
      )
        put('report-batch', { ...b, emailReports: true });
    }
  })();
}
if (workersEnabled) restoreBuilderReports();

export function ensureBatch(c) {
  if (c.mode !== 'live' || process.env.DISABLE_BATCH_REPORTS === 'true') return;
  let b = all('report-batch').find((b) => b.campaignIds.includes(c.id));
  if (!b)
    b = put('report-batch', {
      id: randomUUID(),
      name: c.name,
      campaignIds: [c.id],
      // Legacy builder drafts incorrectly disabled reports along with archive copies.
      emailReports: get('list', c.listId)?.builderGenerated ? true : (c.emailReports ?? true),
      recipients: reportTo(),
      status: 'waiting',
      createdAt: new Date().toISOString(),
    });
  if (b.completedAt && ['running', 'scheduled'].includes(c.status)) {
    b = put('report-batch', {
      ...b,
      revision: (b.revision || 0) + 1,
      completedAt: null,
      auditDueAt: null,
      auditSkippedReason: null,
      lastProgressAt: null,
      status: 'waiting',
    });
  }
  if (!b.startedAt)
    put('report-batch', { ...b, startedAt: c.startedAt || new Date().toISOString() });
}
export const batches = createBatchReportView({ all, get });
export function retryReport(id, confirmed = false) {
  const r = get('batch-report', id);
  if (!r) throw Error('报告不存在');
  if (obsoleteProgress(r)) throw Error('批次已结束或已重新执行，旧进度通知无需重发');
  if (r.deliveries.some((d) => d.status === 'sending')) throw Error('报告正在提交，请稍后重试');
  if (r.deliveries.some((d) => d.status === 'needs_review') && !confirmed)
    throw Error('请先核对发件箱并确认报告重发');
  if (!r.deliveries.some((d) => ['failed', 'needs_review'].includes(d.status)))
    throw Error('没有可重试的明确失败；状态不明请核对发件箱');
  r.deliveries = r.deliveries.map((d) =>
    ['failed', 'needs_review'].includes(d.status)
      ? { ...d, status: 'pending', attempts: 0, reconcileChecks: 0, error: '', nextAt: 0 }
      : d,
  );
  put('batch-report', r);
  return r;
}
for (const r of workersEnabled ? all('batch-report') : []) {
  let changed = false;
  for (const d of r.deliveries)
    if (d.status === 'sending') {
      d.status = 'uncertain';
      d.error = '服务在报告提交期间中断，请核对发件箱';
      changed = true;
    }
  if (changed) put('batch-report', r);
}
export function reportId(b, kind) {
  return `${b.id}:${kind}${b.revision ? ':r' + b.revision : ''}`;
}
function makeReport(b, kind, campaigns, coverage = [], customId) {
  const id = customId || reportId(b, kind);
  if (get('batch-report', id)) return;
  const account = campaigns
    .map((c) => settings(c.accountId))
    .find((a) => a && !a.disabled && (!a.provider || a.provider === 'smtp') && a.password);
  const events = all('mail-event').filter((e) => Date.parse(e.date) <= Date.parse(b.auditDueAt));
  const model = reportModel(b, campaigns, events, coverage);
  put('batch-report', {
    id,
    batchId: b.id,
    kind,
    recoveryVersion: 2,
    revision: b.revision || 0,
    accountId: account?.id || campaigns[0]?.accountId,
    mode: 'live',
    subject: `[Postlane] ${kind === 'progress' ? (model.hasProblems ? '异常通知' : '进度通知') : kind === 'execution' ? '执行报告' : b.sample ? '核查报告样例' : '12小时核查报告'} · ${b.name}`,
    text: reportText(kind, model),
    coverage,
    createdAt: new Date().toISOString(),
    deliveries: (b.sample ? executionReportTo() : reportRecipients(kind)).map((email) => ({
      email,
      status: account ? 'pending' : 'failed',
      error: account ? '' : '没有可发送报告的SMTP账号',
      attempts: 0,
      nextAt: 0,
      messageId: `<${randomUUID()}@postlane.local>`,
    })),
  });
}
// Historical previews use the normal renderer and durable SMTP queue, once per request.
export function sampleReports({ name, campaignIds, requestId }) {
  if (
    !name?.trim() ||
    !Array.isArray(campaignIds) ||
    !campaignIds.length ||
    new Set(campaignIds).size !== campaignIds.length ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId || '')
  )
    throw Error('请输入历史批次名称、任务和唯一请求编号');
  const id = `sample-${requestId}`;
  const existing = get('report-batch', id);
  if (existing) {
    if (
      JSON.stringify(existing.campaignIds) !== JSON.stringify(campaignIds) ||
      existing.name !== name.trim()
    )
      throw Error('请求编号已用于其他批次');
    return existing;
  }
  const campaigns = campaignIds.map((id) => get('campaign', id));
  if (campaigns.some((c) => !c || c.mode !== 'live') || !terminalBatch(campaigns))
    throw Error('样例报告仅支持已结束的真实发送任务');
  const now = new Date().toISOString();
  const completedAt = new Date(
    Math.max(
      ...campaigns.flatMap((c) => [
        Date.parse(c.completedAt) || 0,
        ...c.recipients.map((r) => Date.parse(r.sentAt) || 0),
      ]),
    ),
  ).toISOString();
  const starts = campaigns.map((c) => Date.parse(c.startedAt)).filter(Number.isFinite);
  const coverage = [...new Set(campaigns.map((c) => c.accountId))].map((id) => {
    const a = settings(id),
      s = get('mail-sync', id);
    const ok = gmailAccount(a) && !s?.error && Date.parse(s?.lastSyncAt) >= Date.now() - 15 * 60000;
    return {
      email: a?.from || id,
      ok,
      checkedAt: s?.lastSyncAt,
      reason: s?.error || '最近15分钟内没有成功核查记录',
    };
  });
  return db.transaction(() => {
    const b = put('report-batch', {
      id,
      name: name.trim(),
      campaignIds,
      sample: true,
      recipients: executionReportTo(),
      status: 'completed',
      createdAt: now,
      startedAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      completedAt,
      auditDueAt: now,
    });
    makeReport(b, 'execution', campaigns);
    makeReport(b, 'audit', campaigns, coverage);
    return b;
  })();
}
let busy = false;
export async function reportTick(...args) {
  return runActivity(() => reportTickImpl(...args));
}
async function reportTickImpl() {
  assertActivityAllowed();
  if (busy) return;
  busy = true;
  try {
    for (let b of all('report-batch')) {
      if (b.sample || b.mergedInto) continue;
      const campaigns = b.campaignIds.map((id) => get('campaign', id));
      if (campaigns.some((c) => !c)) continue;
      for (const r of all('batch-report').filter((r) => r.batchId === b.id))
        cancelObsoleteProgress(r);
      if (!b.completedAt) {
        if (!terminalBatch(campaigns)) {
          const started = executionStart(campaigns);
          const problems = progressProblems(campaigns);
          const last = Math.max(b.lastProgressAt || 0, started || Date.now());
          if (
            b.emailReports !== false &&
            started &&
            ((problems && !b.lastProgressAt) || Date.now() - last >= 30 * 60000)
          ) {
            const n = (b.progressRevision || 0) + 1;
            makeReport(b, 'progress', campaigns, [], `${b.id}:progress:${n}`);
            put('report-batch', { ...b, lastProgressAt: Date.now(), progressRevision: n });
          }
          continue;
        }
        const end = Math.max(
          ...campaigns.map((c) =>
            Math.max(
              Date.parse(c.completedAt) || 0,
              ...c.recipients.map((r) => Date.parse(r.sentAt) || 0),
            ),
          ),
        );
        b = put('report-batch', {
          ...b,
          status: 'completed',
          completedAt: new Date(end || Date.now()).toISOString(),
          auditDueAt: new Date((end || Date.now()) + AUDIT_DELAY).toISOString(),
        });
      }
      if (b.emailReports === false) continue;
      makeReport(b, 'execution', campaigns);
      if (cancelledBeforeSending(campaigns)) {
        if (!b.auditSkippedReason)
          put('report-batch', { ...b, auditSkippedReason: '全部任务在发送前取消，无需收信核查' });
        continue;
      }
      if (Date.now() < Date.parse(b.auditDueAt) || get('batch-report', reportId(b, 'audit')))
        continue;
      if (b.auditRetryAt > Date.now()) continue;
      if (!auditBusy) {
        const work = runActivity(() => runAudit(b, campaigns));
        if (!campaigns.some((c) => gmailAccount(settings(c.accountId)))) await work;
        else void work.catch((e) => console.error('Audit scheduler:', e.message));
      }
    }
  } finally {
    busy = false;
  }
}
let auditBusy = false;
async function runAudit(b, campaigns) {
  auditBusy = true;
  try {
    const attemptAt = Date.now();
    const sync = await syncMail({ force: true });
    if (sync.running) return;
    const coverage = [...new Set(campaigns.map((c) => c.accountId))].map((id) => {
      const a = settings(id),
        s = get('mail-sync', id);
      const enabled = campaigns.filter((c) => c.accountId === id).every((c) => tracking(c).enabled);
      const ok =
        gmailAccount(a) &&
        enabled &&
        s?.complete === true &&
        !s?.error &&
        Date.parse(s?.lastSyncAt) >= attemptAt;
      return {
        email: a?.from || id,
        ok,
        checkedAt: s?.lastSyncAt,
        reason: ok
          ? ''
          : !gmailAccount(a)
            ? '当前渠道不支持IMAP核查'
            : !enabled
              ? '任务收信跟踪已关闭'
              : s?.error ||
                (s?.complete === false
                  ? '邮箱扫描尚未完成，下一次继续'
                  : '尚未获得本次成功核查记录'),
      };
    });
    // One fresh read attempt per due run. A failed scan is visibly marked, not a zero rate.
    const failures = (b.auditAttempts || 0) + 1;
    const recoverable = coverage.some(
      (c) => !c.ok && c.reason !== '当前渠道不支持IMAP核查' && c.reason !== '任务收信跟踪已关闭',
    );
    put('report-batch', {
      ...get('report-batch', b.id),
      auditAttempts: failures,
      auditLastCoverage: coverage,
      auditRetryAt: Date.now() + 15 * 60000,
    });
    if (recoverable && failures < 3) return;
    // A reopened batch must not receive a stale audit from an earlier revision.
    if ((get('report-batch', b.id)?.revision || 0) !== (b.revision || 0)) return;
    makeReport(b, 'audit', campaigns, coverage);
  } finally {
    auditBusy = false;
  }
}
function obsoleteProgress(r) {
  if (r.kind !== 'progress') return false;
  const b = get('report-batch', r.batchId);
  if (!b || b.mergedInto || b.completedAt || (b.revision || 0) !== (r.revision || 0)) return true;
  const campaigns = b.campaignIds.map((id) => get('campaign', id));
  return campaigns.some((c) => !c) || terminalBatch(campaigns);
}
function cancelObsoleteProgress(r) {
  if (!obsoleteProgress(r)) return false;
  let changed = false;
  for (const d of r.deliveries)
    if (['pending', 'failed'].includes(d.status)) {
      d.status = 'cancelled';
      d.error = '批次已结束或已重新执行，取消过时进度通知';
      changed = true;
    }
  if (changed) put('batch-report', r);
  return true;
}
export async function deliverReport(...args) {
  return runActivity(() => deliverReportImpl(...args));
}
async function deliverReportImpl(job, key, send = sendOne) {
  assertActivityAllowed();
  let r = get('batch-report', job.id);
  // Recheck immediately before SMTP submission, even if reportTick has not run yet.
  if (cancelObsoleteProgress(r)) return;
  const d = r.deliveries.find(
    (d) => d.status === 'pending' && (!d.nextAt || d.nextAt <= Date.now()),
  );
  if (!d) return;
  d.status = 'sending';
  d.attempts++;
  put('batch-report', r);
  try {
    const a = settings(r.accountId);
    if (!a || (a.provider && a.provider !== 'smtp')) throw Error('报告需要SMTP发件账号');
    const result = await send(a, d.email, r.subject, r.text, true, d.messageId);
    if (!result.accepted?.length) throw Error('SMTP未接受报告收件人');
    d.status = 'sent';
    d.sentAt = new Date().toISOString();
    d.error = '';
  } catch (e) {
    const outcome = failureOutcome(e, d.attempts);
    Object.assign(d, outcome);
    if (d.status === 'retry_wait') {
      d.status = 'pending';
      d.nextAt = outcome.retryAt;
    }
  }
  put('batch-report', r);
  put('queue_account', { id: key, nextAt: Date.now() + 30000 });
}
registerReportQueue({
  list: () =>
    all('batch-report')
      .filter((r) =>
        r.deliveries.some((d) => d.status === 'pending' && (!d.nextAt || d.nextAt <= Date.now())),
      )
      .map((r) => ({ ...r, reportJob: true })),
  run: deliverReport,
  error: (error, job) => {
    const r = get('batch-report', job.id);
    if (!r) return;
    for (const d of r.deliveries)
      if (d.status === 'sending') {
        d.status = 'uncertain';
        d.error = '报告队列中断，请核对发件箱';
      }
    put('batch-report', r);
  },
});
if (workersEnabled && process.env.DISABLE_BATCH_REPORTS !== 'true') {
  setInterval(
    () =>
      workersEnabled && reportTick().catch((e) => console.error('Report scheduler:', e.message)),
    15000,
  ).unref();
}
