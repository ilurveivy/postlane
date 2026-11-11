import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-builder-test-'));
process.env.DISABLE_BATCH_REPORTS = 'true';
process.env.DISABLE_MAIL_SYNC = 'true';
process.env.DISABLE_SLEEP_GUARD = 'true';
process.env.POSTLANE_REPORT_TO = 'xuyuan@example.com,mtong@example.com';
process.env.POSTLANE_EXECUTION_REPORT_TO = 'mtong@example.com';
process.env.POSTLANE_ARCHIVE_RECIPIENTS = 'xuyuan@example.com,mtong@example.com';
const { get, put, all, db } = await import('../server/store.js');
const { builderSources, previewBuilder, createBuilder, archiveRecipients } =
  await import('../server/campaign-builder.js');
const ARCHIVE_RECIPIENTS = archiveRecipients();
const { startBatch } = await import('../server/import-batch.js');
const { timer } = await import('../server/mailer.js');
clearInterval(timer);
function setup(count = 3) {
  db.prepare('DELETE FROM documents').run();
  for (let i = 0; i < count; i++)
    put('account', {
      id: 'a' + i,
      from: `sender${i}@example.com`,
      password: 'test-only',
      verifiedAt: new Date().toISOString(),
    });
}
function input(count = 10) {
  return {
    name: 'Equal distribution',
    accountIds: ['a0', 'a1', 'a2'],
    mode: 'live',
    imported: {
      name: 'Original',
      rows: Array.from({ length: count }, (_, i) => ({
        business_email: `r${i}@example.com`,
        email_subject: `  Subject ${i}  `,
        email_content: `Hi ${i}\n\n原文 {{literal}}\n`,
        channel_id: 'UCtYe2zSP5vEnwHFhR3ZDsIA',
        channel_name: `Channel ${i}`,
        custom_metadata: `Keep ${i}`,
      })),
      emailColumn: 'business_email',
      subjectColumn: 'email_subject',
      bodyColumn: 'email_content',
    },
  };
}
function submit(d, action = 'draft') {
  const p = previewBuilder(d);
  return createBuilder({
    ...d,
    fingerprint: p.fingerprint,
    requestId: randomUUID(),
    action,
    confirmLive: action === 'start',
  });
}
test('reply-only accounts cannot be selected, submitted or used to resume a batch', async () => {
  setup();
  const result = submit(input());
  put('account', { ...get('account', 'a0'), replyOnly: true });
  assert.ok(!builderSources().accounts.some((a) => a.id === 'a0'));
  assert.throws(() => previewBuilder(input()), /不可用/);
  assert.throws(() => startBatch(result.batchId), /只做回复用/);
  const { advanceCampaign } = await import('../server/mailer.js');
  const c = get('campaign', result.campaignIds[0]);
  put('campaign', { ...c, status: 'scheduled' });
  let sent = false;
  await advanceCampaign(c, 'live:a0', async () => {
    sent = true;
  });
  assert.equal(sent, false);
  assert.equal(get('campaign', c.id).status, 'cancelled');
});
test('equal allocation preserves original content and only selected last-message copies', () => {
  setup();
  const d = { ...input(), archiveTo: ARCHIVE_RECIPIENTS };
  const p = previewBuilder(d);
  assert.deepEqual(
    p.groups.map((g) => g.formal),
    [4, 3, 3],
  );
  assert.equal(p.total, 16);
  const r = submit(d);
  const cs = r.campaignIds.map((id) => get('campaign', id));
  for (const c of cs)
    for (const recipient of c.recipients) {
      const original = get('list', recipient.fields.source_list_id).contacts.find(
        (v) => v.id === recipient.fields.source_recipient_id,
      );
      assert.ok(original);
      assert.equal(recipient.fields.channel_name, original.fields.channel_name);
      assert.equal(recipient.fields.custom_metadata, original.fields.custom_metadata);
      assert.equal(
        recipient.fields.channel_url,
        'https://www.youtube.com/channel/UCtYe2zSP5vEnwHFhR3ZDsIA',
      );
    }
  cs.forEach((c, i) => {
    const n = p.groups[i].formal;
    assert.equal(c.recipients.length, n + 2);
    assert.deepEqual(
      c.recipients.slice(n).map((r) => r.email),
      ARCHIVE_RECIPIENTS,
    );
    for (const copy of c.recipients.slice(n)) {
      assert.equal(copy.fields.email_subject, c.recipients[n - 1].fields.email_subject);
      assert.equal(copy.fields.email_content, c.recipients[n - 1].fields.email_content);
    }
  });
  assert.deepEqual(
    cs
      .flatMap((c) => c.recipients.filter((r) => r.fields.recipient_type === '外部收件人'))
      .map((r) => [r.email, r.fields.email_subject, r.fields.email_content]),
    d.imported.rows.map((r) => [r.business_email, r.email_subject, r.email_content]),
  );
  assert.equal(get('report-batch', r.batchId).emailReports, true);
  assert.equal(builderSources().lists.length, 0);
});
test('300 formal emails across 30 senders yield 10 + 2 each; defaults send no copies', () => {
  setup(30);
  const d = { ...input(300), accountIds: Array.from({ length: 30 }, (_, i) => 'a' + i) };
  assert.equal(previewBuilder(d).copies, 0);
  const p = previewBuilder({ ...d, archiveTo: ARCHIVE_RECIPIENTS });
  assert.equal(p.total, 360);
  assert.ok(p.groups.every((g) => g.formal === 10 && g.copies === 2));
});
test('zero-allocation accounts have no tasks or copies; one checked recipient yields one copy', () => {
  setup();
  const d = { ...input(2), archiveTo: [ARCHIVE_RECIPIENTS[1]] };
  const p = previewBuilder(d);
  assert.deepEqual(
    p.groups.map((g) => [g.formal, g.copies]),
    [
      [1, 1],
      [1, 1],
      [0, 0],
    ],
  );
  assert.equal(submit(d).campaignIds.length, 2);
});
test('idempotent retry and stale preview cannot double assign', () => {
  setup();
  const d = input();
  const fingerprint = previewBuilder(d).fingerprint;
  const request = { ...d, fingerprint, requestId: randomUUID(), action: 'draft' };
  const result = createBuilder(request);
  assert.deepEqual(createBuilder(request), result);
  assert.throws(() => createBuilder({ ...request, requestId: randomUUID() }), /没有可安排/);
  assert.equal(all('campaign').length, 3);
});
test('account changes, empty content, invalid schedule and missing confirmation do not write tasks', () => {
  setup();
  const d = input();
  const fingerprint = previewBuilder(d).fingerprint;
  put('account', { ...get('account', 'a0'), disabled: true });
  assert.throws(
    () => createBuilder({ ...d, fingerprint, requestId: randomUUID(), action: 'draft' }),
    /已不可用/,
  );
  put('account', { ...get('account', 'a0'), disabled: false });
  assert.throws(
    () => previewBuilder({ ...d, scheduledAt: new Date(Date.now() - 1000).toISOString() }),
    /未来/,
  );
  assert.throws(
    () => createBuilder({ ...d, fingerprint, requestId: randomUUID(), action: 'start' }),
    /确认真实发送/,
  );
  assert.throws(
    () =>
      previewBuilder({
        ...d,
        imported: { ...d.imported, rows: [{ ...d.imported.rows[0], email_content: '' }] },
      }),
    /缺少/,
  );
  assert.equal(all('list').length, 0);
  assert.equal(all('campaign').length, 0);
});
test('scheduled drafts retain time when starting a batch', () => {
  setup();
  const scheduledAt = new Date(Date.now() + 3600000).toISOString();
  const r = submit({ ...input(), scheduledAt });
  startBatch(r.batchId);
  assert.ok(r.campaignIds.every((id) => get('campaign', id).status === 'scheduled'));
});
test('ordered selection, source leftovers, simulation, suppression and cancellation', () => {
  setup();
  const d = { ...input(), limit: 4 };
  const simulated = submit({ ...d, mode: 'simulation' });
  assert.equal(simulated.batchId, null);
  assert.equal(builderSources().lists[0].count, 10);
  const source = builderSources().lists[0];
  const later = {
    ...get('list', source.id),
    id: 'later',
    name: 'Later',
    createdAt: new Date(Date.now() + 1000).toISOString(),
    contacts: [
      {
        id: 'later-row',
        email: 'later@example.com',
        fields: { email_subject: 'Later', email_content: 'Later body' },
      },
    ],
  };
  put('list', later);
  put('suppression', { id: 'r0@example.com', reason: 'Opt out' });
  const next = {
    name: 'Pending',
    accountIds: d.accountIds,
    listIds: [later.id, source.id],
    mode: 'live',
    limit: 4,
  };
  const p = previewBuilder(next);
  assert.equal(p.samples[0].first.email, 'r1@example.com');
  assert.equal(p.issues.length, 1);
  const result = submit(next);
  assert.equal(builderSources().lists.find((l) => l.id === source.id).count, 6);
  result.campaignIds.forEach((id) =>
    put('campaign', { ...get('campaign', id), status: 'cancelled' }),
  );
  assert.equal(builderSources().lists.find((l) => l.id === source.id).count, 10);
  assert.equal(builderSources().lists.length, 2);
});
test('live start creates scheduled tasks only after explicit confirmation', () => {
  setup();
  const r = submit(
    { ...input(), scheduledAt: new Date(Date.now() + 3600000).toISOString() },
    'start',
  );
  assert.equal(r.status, 'scheduled');
  assert.ok(r.campaignIds.every((id) => get('campaign', id).status === 'scheduled'));
});
test('reports are independent of zero, one or two selected archive recipients', async () => {
  const { reportTick } = await import('../server/batch-reports.js');
  for (const archiveTo of [[], ARCHIVE_RECIPIENTS.slice(0, 1), ARCHIVE_RECIPIENTS]) {
    setup();
    const result = submit({ ...input(), archiveTo });
    for (const id of result.campaignIds)
      put('campaign', {
        ...get('campaign', id),
        status: 'paused',
        startedAt: new Date(Date.now() - 3600000).toISOString(),
      });
    await reportTick();
    assert.equal(all('batch-report').filter((r) => r.kind === 'progress').length, 1);
    for (const id of result.campaignIds) {
      const c = get('campaign', id);
      put('campaign', {
        ...c,
        status: 'completed',
        completedAt: new Date().toISOString(),
        recipients: c.recipients.map((r) => ({ ...r, status: 'sent' })),
      });
    }
    await reportTick();
    await reportTick();
    const execution = all('batch-report').filter((r) => r.kind === 'execution');
    assert.equal(execution.length, 1);
    assert.deepEqual(
      execution[0].deliveries.map((d) => d.email),
      ['mtong@example.com'],
    );
    assert.equal(all('campaign').flatMap((c) => c.recipients).length, 10 + 3 * archiveTo.length);
    assert.ok(get('report-batch', result.batchId).auditDueAt);
  }
});
test('simulation stays report-free and converted builder drafts enable reports', async () => {
  const { ensureBatch, reportTick } = await import('../server/batch-reports.js');
  for (const legacy of ['current', 'false', 'missing']) {
    setup();
    const result = submit({ ...input(1), mode: 'simulation' });
    const draft = get('campaign', result.campaignIds[0]);
    await reportTick();
    assert.equal(all('batch-report').length, 0);
    assert.equal(all('report-batch').length, 0);
    if (legacy === 'false') draft.emailReports = false;
    if (legacy === 'missing') delete draft.emailReports;
    const live = { ...draft, mode: 'live', status: 'running', startedAt: new Date().toISOString() };
    put('campaign', live);
    const disabled = process.env.DISABLE_BATCH_REPORTS;
    try {
      process.env.DISABLE_BATCH_REPORTS = 'false';
      ensureBatch(live);
    } finally {
      process.env.DISABLE_BATCH_REPORTS = disabled;
    }
    assert.equal(all('report-batch')[0].emailReports, true);
    put('campaign', {
      ...live,
      status: 'completed',
      completedAt: new Date().toISOString(),
      recipients: live.recipients.map((r) => ({ ...r, status: 'sent' })),
    });
    await reportTick();
    assert.equal(all('batch-report').filter((r) => r.kind === 'execution').length, 1);
  }
});
test('legacy builder repair restores completed reports once without changing cancelled or ordinary batches', async () => {
  setup();
  const { restoreBuilderReports, reportTick } = await import('../server/batch-reports.js');
  const result = submit(input());
  for (const id of result.campaignIds) {
    const c = get('campaign', id);
    put('campaign', {
      ...c,
      emailReports: false,
      status: 'completed',
      completedAt: new Date().toISOString(),
      recipients: c.recipients.map((r) => ({ ...r, status: 'sent' })),
    });
  }
  put('report-batch', {
    ...get('report-batch', result.batchId),
    emailReports: false,
    completedAt: new Date().toISOString(),
    auditDueAt: new Date(Date.now() + 43200000).toISOString(),
  });
  put('campaign', {
    id: 'ordinary',
    mode: 'live',
    status: 'completed',
    emailReports: false,
    recipients: [],
  });
  put('report-batch', { id: 'ordinary-batch', campaignIds: ['ordinary'], emailReports: false });
  put('campaign', {
    ...get('campaign', result.campaignIds[0]),
    id: 'cancelled',
    status: 'cancelled',
    recipients: [{ status: 'cancelled' }],
  });
  put('report-batch', { id: 'cancelled-batch', campaignIds: ['cancelled'], emailReports: false });
  restoreBuilderReports();
  assert.equal(get('report-batch', 'ordinary-batch').emailReports, false);
  assert.equal(get('report-batch', 'cancelled-batch').emailReports, false);
  assert.equal(get('campaign', 'ordinary').emailReports, false);
  assert.ok(result.campaignIds.every((id) => get('campaign', id).emailReports));
  await reportTick();
  restoreBuilderReports();
  await reportTick();
  assert.equal(all('batch-report').length, 1);
  assert.equal(all('batch-report')[0].batchId, result.batchId);
  assert.equal(all('batch-report')[0].kind, 'execution');
});

test('automatic batches for ordinary live tasks retain report delivery', async () => {
  setup();
  const { ensureBatch } = await import('../server/batch-reports.js');
  const disabled = process.env.DISABLE_BATCH_REPORTS;
  try {
    process.env.DISABLE_BATCH_REPORTS = 'false';
    ensureBatch({ id: 'ordinary', name: 'Ordinary', mode: 'live', listId: 'ordinary-list' });
  } finally {
    process.env.DISABLE_BATCH_REPORTS = disabled;
  }
  assert.equal(all('report-batch')[0].emailReports, true);
});
