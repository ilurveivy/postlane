import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIT_DELAY,
  terminalBatch,
  reportModel,
  reportText,
  explicitOptOut,
} from '../server/batch-report-domain.js';
import { reportTo } from '../server/report-recipients.js';
// Report recipients are configuration, not code: pin them so assertions stay meaningful.
process.env.POSTLANE_REPORT_TO = 'xuyuan@example.com,mtong@example.com';
process.env.POSTLANE_EXECUTION_REPORT_TO = 'mtong@example.com';
const REPORT_TO = reportTo();
const campaign = (id, accountId = 'a') => ({
  id,
  name: id,
  accountId,
  mode: 'live',
  senderEmail: accountId + '@gmail.com',
  status: 'completed',
  startedAt: '2026-09-15T00:00:00Z',
  completedAt: '2026-09-15T00:10:00Z',
  recipients: [
    { email: 'person@example.com', status: 'sent', sentAt: '2026-09-15T00:09:00Z', fields: {} },
  ],
});
test('batch waits for all tasks and pending submissions, errors and cancellations remain explicit', () => {
  assert.equal(terminalBatch([campaign('a'), { ...campaign('b'), status: 'paused' }]), false);
  assert.equal(terminalBatch([campaign('a'), { ...campaign('b'), status: 'draft' }]), false);
  assert.equal(terminalBatch([{ ...campaign('a'), recipients: [{ status: 'sending' }] }]), false);
  assert.equal(
    terminalBatch([campaign('a'), { ...campaign('b'), status: 'completed_errors' }]),
    true,
  );
  assert.equal(AUDIT_DELAY, 43200000);
});
test('reply dedup, retry merge, archive exclusion and ambiguous cross-batch events', () => {
  const a = campaign('a'),
    retry = campaign('retry');
  a.recipients.push({
    email: REPORT_TO[1],
    status: 'sent',
    fields: { recipient_type: '末封留档副本' },
  });
  const event = {
    id: 'e',
    type: 'reply',
    accountId: 'a',
    accountEmail: 'a@gmail.com',
    from: ['person@example.com'],
    to: ['a@gmail.com'],
    text: 'Please unsubscribe me.',
    date: '2026-09-15T01:00:00Z',
    links: [{ campaignId: 'a', email: 'person@example.com' }],
  };
  const m = reportModel(
    { id: 'batch' },
    [a, retry],
    [
      event,
      { ...event, id: 'e2' },
      {
        ...event,
        id: 'ambiguous',
        links: [...event.links, { campaignId: 'old', email: 'person@example.com' }],
      },
    ],
  );
  assert.equal(m.stats.planned, 1);
  assert.equal(m.stats.accepted, 1);
  assert.equal(m.stats.replied, 1);
  assert.equal(m.stats.optOut, 1);
  assert.equal(m.stats.archiveSent, 1);
  assert.equal(m.ambiguous.length, 1);
});
test('negative feedback and quoted opt-outs do not imply unsubscribe; missing coverage is not zero rate', () => {
  assert.equal(explicitOptOut('This video is not out yet.'), false);
  assert.equal(explicitOptOut('Thanks\n> unsubscribe me'), false);
  assert.equal(explicitOptOut('Thanks\nOn Monday someone wrote:\nunsubscribe me'), false);
  assert.equal(explicitOptOut('Please stop emailing me.'), true);
  const m = reportModel(
    { id: 'x', name: 'x', completedAt: '2026-09-15T00:10:00Z', auditDueAt: '2026-09-15T12:10:00Z' },
    [campaign('a')],
    [],
    [{ email: 'a', ok: false, reason: 'offline' }],
  );
  assert.match(reportText('audit', m), /回复率：无法确认/);
});
test('report preserves reply body and both directions', () => {
  const text = 'Hi Brian,\r\n原文不改\n> history';
  const e = {
    type: 'reply',
    accountId: 'a',
    accountEmail: 'a@gmail.com',
    from: ['person@example.com'],
    to: ['a@gmail.com'],
    subject: 'Re: test',
    text,
    links: [{ campaignId: 'a', email: 'person@example.com' }],
  };
  const report = reportText(
    'audit',
    reportModel(
      { id: 'b', name: 'B', completedAt: '2026-09-15T01:00:00Z' },
      [campaign('a')],
      [e],
      [{ email: 'a', ok: true }],
    ),
  );
  assert.ok(report.includes(text));
  assert.ok(report.includes('平台发件账号（原From）：a@gmail.com'));
  assert.ok(report.includes('回复From：person@example.com'));
  assert.ok(report.includes('回复To：a@gmail.com'));
});
test('persistent report scheduler: explicit batch only, idempotent execution, 12h due and restart safe records', async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-report-test-'));
  process.env.DISABLE_BATCH_REPORTS = 'true';
  process.env.DISABLE_MAIL_SYNC = 'true';
  const { put, get, all } = await import('../server/store.js');
  const { createBatch, reportTick } = await import('../server/batch-reports.js');
  const { timer } = await import('../server/mailer.js');
  clearInterval(timer);
  put('campaign', campaign('historical'));
  await reportTick();
  assert.equal(all('batch-report').length, 0);
  put('campaign', { ...campaign('new'), status: 'draft' });
  const b = createBatch('batch', ['new']);
  await reportTick();
  assert.equal(all('batch-report').length, 0);
  const end = new Date().toISOString();
  put('campaign', { ...campaign('new'), completedAt: end });
  await reportTick();
  await reportTick();
  assert.equal(all('batch-report').length, 1);
  assert.equal(
    get('report-batch', b.id).auditDueAt,
    new Date(Date.parse(end) + AUDIT_DELAY).toISOString(),
  );
  assert.deepEqual(
    all('batch-report')[0].deliveries.map((d) => d.email),
    ['mtong@example.com'],
  );
  put('report-batch', {
    ...get('report-batch', b.id),
    auditDueAt: new Date(Date.now() - 1000).toISOString(),
  });
  await reportTick();
  await reportTick();
  assert.equal(all('batch-report').length, 2);
  assert.match(get('batch-report', b.id + ':audit').text, /回复率：无法确认/);
});
test('historical samples are idempotent and only sent to the sample recipient', async () => {
  const { get, all } = await import('../server/store.js');
  const { sampleReports, reportTick } = await import('../server/batch-reports.js');
  const input = { name: 'yesterday', campaignIds: ['historical'], requestId: 'sample-test-001' };
  const b = sampleReports(input);
  sampleReports(input);
  await reportTick();
  const reports = all('batch-report').filter((r) => r.batchId === b.id);
  assert.equal(reports.length, 2);
  for (const r of reports)
    assert.deepEqual(
      r.deliveries.map((d) => d.email),
      ['mtong@example.com'],
    );
  assert.match(get('batch-report', b.id + ':audit').text, /历史批次核查报告（样例）/);
  assert.throws(() => sampleReports({ ...input, campaignIds: ['new'] }), /请求编号/);
  assert.deepEqual(
    get('batch-report', all('report-batch').find((b) => !b.sample).id + ':audit').deliveries.map(
      (d) => d.email,
    ),
    REPORT_TO,
  );
});
test('each report recipient is delivered once; uncertain submission is not retried and 4xx is bounded', async () => {
  const { put, get } = await import('../server/store.js');
  const { deliverReport } = await import('../server/batch-reports.js');
  put('account', { id: 'test', user: 'local', from: 'local@example.com' });
  put('batch-report', {
    id: 'delivery',
    accountId: 'test',
    subject: 'report',
    text: 'body',
    deliveries: REPORT_TO.map((email, i) => ({
      email,
      messageId: '<stable' + i + '>',
      attempts: 0,
      status: 'pending',
    })),
  });
  const calls = [];
  await deliverReport({ id: 'delivery' }, 'test', async (...args) => {
    calls.push(args);
    return { accepted: [args[1]] };
  });
  await deliverReport({ id: 'delivery' }, 'test', async () => {
    throw Object.assign(new Error('lost'), { code: 'ECONNECTION' });
  });
  await deliverReport({ id: 'delivery' }, 'test', async () => {
    throw Error('must not send again');
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][5], '<stable0>');
  assert.deepEqual(
    get('batch-report', 'delivery').deliveries.map((d) => d.status),
    ['sent', 'uncertain'],
  );
  put('batch-report', {
    id: 'temp',
    accountId: 'test',
    deliveries: [
      { email: 'local@example.com', status: 'pending', attempts: 0, messageId: 'stable' },
    ],
  });
  for (let n = 0; n < 3; n++) {
    const r = get('batch-report', 'temp');
    r.deliveries[0].nextAt = 0;
    put('batch-report', r);
    await deliverReport({ id: 'temp' }, 'test', async () => {
      throw Object.assign(new Error('temporary'), { responseCode: 451 });
    });
  }
  assert.equal(get('batch-report', 'temp').deliveries[0].status, 'failed');
  assert.equal(get('batch-report', 'temp').deliveries[0].attempts, 3);
});

test('distinct logical rows to the same email remain distinct, linked retries count once', () => {
  const a = campaign('logical');
  a.recipients = [
    { id: 'one', email: 'same@example.com', status: 'uncertain', resolvedBy: 'retry' },
    { id: 'two', email: 'same@example.com', status: 'sent' },
  ];
  const retry = campaign('retry');
  retry.recipients = [
    {
      id: 'copy',
      logicalCampaignId: 'logical',
      logicalRecipientId: 'one',
      email: 'same@example.com',
      status: 'sent',
    },
  ];
  const m = reportModel({ id: 'b' }, [a, retry]);
  assert.equal(m.stats.planned, 2);
  assert.equal(m.stats.accepted, 2);
  assert.equal(terminalBatch([a, retry]), true);
  delete a.recipients[0].resolvedBy;
  assert.equal(terminalBatch([a, retry]), false);
});
test('progress alerts are durable, throttled and followed by one final report', async () => {
  const { put, get, all } = await import('../server/store.js');
  const { reportTick } = await import('../server/batch-reports.js');
  put('campaign', {
    ...campaign('stalled'),
    status: 'attention',
    recipients: [{ id: 'r', email: 'p@example.com', status: 'needs_review' }],
  });
  put('report-batch', {
    id: 'progress-test',
    name: 'stalled',
    campaignIds: ['stalled'],
    startedAt: new Date(Date.now() - 3600000).toISOString(),
  });
  await reportTick();
  await reportTick();
  assert.equal(all('batch-report').filter((r) => r.batchId === 'progress-test').length, 1);
  assert.equal(
    get('batch-report', 'progress-test:progress:1').deliveries[0].email,
    'mtong@example.com',
  );
  assert.match(get('batch-report', 'progress-test:progress:1').subject, /异常通知/);
  put('campaign', { ...campaign('stalled'), completedAt: new Date().toISOString() });
  await reportTick();
  await reportTick();
  assert.equal(get('batch-report', 'progress-test:progress:1').deliveries[0].status, 'cancelled');
  assert.equal(
    all('batch-report').filter((r) => r.batchId === 'progress-test' && r.kind === 'execution')
      .length,
    1,
  );
});
test('scheduled waiting never counts toward progress interval; real errors still notify immediately', async () => {
  const { put, get } = await import('../server/store.js');
  const { reportTick } = await import('../server/batch-reports.js');
  const now = Date.now(),
    submitted = new Date(now - 3 * 3600000).toISOString();
  const c = {
    ...campaign('scheduled-progress'),
    status: 'scheduled',
    completedAt: null,
    startedAt: submitted,
    scheduledAt: new Date(now + 60000).toISOString(),
    recipients: [{ id: 'r', email: 'p@example.com', status: 'pending', fields: {} }],
  };
  put('campaign', c);
  put('report-batch', {
    id: 'scheduled-progress-batch',
    name: 'Scheduled',
    campaignIds: [c.id],
    startedAt: submitted,
  });
  await reportTick();
  assert.equal(get('batch-report', 'scheduled-progress-batch:progress:1'), null);
  c.status = 'running';
  c.scheduledAt = new Date(now - 10000).toISOString();
  c.recipients[0].attempts = [{ startedAt: new Date(now - 5000).toISOString() }];
  put('campaign', c);
  await reportTick();
  assert.equal(get('batch-report', 'scheduled-progress-batch:progress:1'), null);
  c.recipients[0].attempts[0].startedAt = new Date(now - 31 * 60000).toISOString();
  c.scheduledAt = new Date(now - 32 * 60000).toISOString();
  put('campaign', c);
  await reportTick();
  const r = get('batch-report', 'scheduled-progress-batch:progress:1');
  assert.match(r.subject, /进度通知/);
  assert.doesNotMatch(r.subject, /异常/);
  assert.match(r.text, /执行耗时（不含预约等待）：186\d 秒/);
  const b = get('report-batch', 'scheduled-progress-batch');
  b.lastProgressAt = null;
  put('report-batch', b);
  c.status = 'attention';
  c.recipients[0].status = 'needs_review';
  c.recipients[0].attempts[0].startedAt = new Date().toISOString();
  put('campaign', c);
  await reportTick();
  assert.match(get('batch-report', 'scheduled-progress-batch:progress:2').subject, /异常通知/);
});
test('delivery cancels obsolete progress before SMTP while preserving sent and uncertain history', async () => {
  const { put, get } = await import('../server/store.js');
  const { deliverReport, retryReport } = await import('../server/batch-reports.js');
  const c = campaign('finished-before-report-tick');
  put('campaign', c);
  put('report-batch', { id: 'late-progress-batch', campaignIds: [c.id] });
  put('batch-report', {
    id: 'late-progress',
    batchId: 'late-progress-batch',
    kind: 'progress',
    deliveries: ['pending', 'failed', 'sent', 'uncertain', 'needs_review', 'sending'].map(
      (status) => ({ status, email: 'a@example.com', attempts: 0 }),
    ),
  });
  let sends = 0;
  await deliverReport({ id: 'late-progress' }, 'test', async () => {
    sends++;
  });
  assert.equal(sends, 0);
  assert.deepEqual(
    get('batch-report', 'late-progress').deliveries.map((d) => d.status),
    ['cancelled', 'cancelled', 'sent', 'uncertain', 'needs_review', 'sending'],
  );
  assert.throws(() => retryReport('late-progress', true), /旧进度通知无需重发/);
  c.status = 'running';
  put('campaign', c);
  put('report-batch', { id: 'late-progress-batch', campaignIds: [c.id], revision: 1 });
  put('batch-report', {
    id: 'old-revision',
    batchId: 'late-progress-batch',
    kind: 'progress',
    revision: 0,
    deliveries: [{ status: 'pending', attempts: 0 }],
  });
  await deliverReport({ id: 'old-revision' }, 'test', async () => {
    sends++;
  });
  assert.equal(sends, 0);
  assert.equal(get('batch-report', 'old-revision').deliveries[0].status, 'cancelled');
});
test('legacy retry linking validates content, preserves history and revises the original batch once', async () => {
  const { put, get } = await import('../server/store.js');
  const { linkLegacyRetries } = await import('../server/batch-link.js');
  const a = {
    ...campaign('legacy-a'),
    subject: 's',
    body: 'b',
    recipients: [{ id: 'r', email: 'p@example.com', status: 'uncertain', fields: {} }],
  };
  const retry = {
    ...campaign('legacy-retry'),
    subject: 's',
    body: 'b',
    recipients: [{ id: 'rr', email: 'p@example.com', status: 'sent', fields: {} }],
  };
  put('campaign', a);
  put('campaign', retry);
  put('report-batch', {
    id: 'legacy-b',
    campaignIds: [a.id],
    completedAt: new Date().toISOString(),
  });
  put('report-batch', { id: 'legacy-child', campaignIds: [retry.id] });
  const links = [{ originalCampaign: a.id, originalId: 'r', retryId: retry.id }];
  linkLegacyRetries(links);
  linkLegacyRetries(links);
  assert.equal(get('report-batch', 'legacy-b').revision, 1);
  assert.equal(get('report-batch', 'legacy-child').mergedInto, 'legacy-b');
  assert.equal(get('campaign', a.id).recipients[0].status, 'uncertain');
  assert.equal(
    reportModel({}, [get('campaign', a.id), get('campaign', retry.id)]).stats.accepted,
    1,
  );
});
test('cancelled unsent batches skip audits, but attempted or partially sent batches do not', async () => {
  const { cancelledBeforeSending } = await import('../server/batch-report-domain.js');
  const cancelled = {
    ...campaign('cancel-before-send'),
    status: 'cancelled',
    recipients: [{ id: 'r', email: 'person@example.com', status: 'cancelled', fields: {} }],
  };
  assert.equal(cancelledBeforeSending([cancelled]), true);
  assert.equal(cancelledBeforeSending([]), false);
  for (const evidence of [
    { sentAt: '2026-09-17T00:00:00Z' },
    { messageId: '<submitted>' },
    { attempts: [{ status: 'failed' }] },
    { status: 'uncertain' },
  ])
    assert.equal(
      cancelledBeforeSending([
        { ...cancelled, recipients: [{ ...cancelled.recipients[0], ...evidence }] },
      ]),
      false,
    );
  assert.equal(cancelledBeforeSending([cancelled, campaign('actually-sent')]), false);
  const { put, get } = await import('../server/store.js');
  const { createBatch, reportTick, ensureBatch } = await import('../server/batch-reports.js');
  put('campaign', { ...cancelled, status: 'draft' });
  const batch = createBatch('Cancelled before scheduled start', [cancelled.id]);
  put('campaign', cancelled);
  put('report-batch', {
    ...batch,
    completedAt: cancelled.completedAt,
    auditDueAt: '2026-09-16T00:00:00Z',
  });
  await reportTick();
  await reportTick();
  assert.ok(get('report-batch', batch.id).auditSkippedReason);
  assert.equal(get('batch-report', batch.id + ':audit'), null);
  const disabled = process.env.DISABLE_BATCH_REPORTS;
  try {
    process.env.DISABLE_BATCH_REPORTS = 'false';
    ensureBatch({ ...cancelled, status: 'running' });
  } finally {
    process.env.DISABLE_BATCH_REPORTS = disabled;
  }
  assert.equal(get('report-batch', batch.id).auditSkippedReason, null);
});
test('correction reports identify their original and do not claim a 12-hour cutoff', () => {
  const model = reportModel(
    {
      id: 'actual-batch',
      correctionOf: 'old-report',
      correctionNote: '原报告对应取消预约；本报告对应实际执行批次。',
      auditDueAt: '2026-09-18T00:50:00Z',
    },
    [campaign('sent')],
  );
  const text = reportText('audit', model);
  assert.match(text, /核查更正报告（截至指定时间）/);
  assert.match(text, /更正原报告：old-report/);
  assert.doesNotMatch(text, /批次完成12小时核查报告/);
  assert.match(text, /收信覆盖：不完整/);
});
