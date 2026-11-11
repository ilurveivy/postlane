import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFailure,
  failureOutcome,
  candidate,
  finishCampaign,
  prepareRetry,
} from '../server/delivery-policy.js';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-recovery-'));
process.env.DISABLE_DELIVERY_RECOVERY = 'true';
process.env.DISABLE_BATCH_REPORTS = 'true';
process.env.DISABLE_MAIL_SYNC = 'true';
const { put, get, encrypt } = await import('../server/store.js');
const { advanceCampaign, timer } = await import('../server/mailer.js');
clearInterval(timer);
const { applyEvidence, sentEvidence, recoveryTick } =
  await import('../server/delivery-recovery.js');
test('SMTP stage distinguishes safe retries from ambiguous submission and permanent failures', () => {
  assert.equal(classifyFailure({ code: 'ETIMEDOUT', command: 'CONN' }), 'temporary');
  assert.equal(classifyFailure({ code: 'ESOCKET', command: 'DATA' }), 'unknown');
  assert.equal(classifyFailure({ code: 'ETIMEDOUT' }), 'unknown');
  assert.equal(classifyFailure({ responseCode: 451 }), 'temporary');
  assert.equal(classifyFailure({ responseCode: 550 }), 'permanent');
  assert.equal(classifyFailure({ responseCode: 535 }), 'account');
  assert.equal(failureOutcome({ responseCode: 451 }, 3).status, 'failed');
});
test('retry row cannot stall a later pending row, and unresolved rows prevent completion', () => {
  const c = {
    recipients: [
      { id: 'a', status: 'retry_wait', retryAt: 200 },
      { id: 'b', status: 'pending' },
    ],
  };
  assert.equal(candidate(c, 100).id, 'b');
  c.recipients[1].status = 'sent';
  assert.equal(candidate(c, 100), undefined);
  assert.equal(candidate(c, 200).id, 'a');
  assert.equal(finishCampaign({ recipients: [{ status: 'uncertain' }] }).status, 'attention');
});
test('recipient error preserves attempts and allows sibling without pausing other campaigns', async () => {
  put('account', { id: 'a', user: 'a@example.com', from: 'a@example.com' });
  const c = {
    id: 'test',
    accountId: 'a',
    senderEmail: 'a@example.com',
    mode: 'live',
    status: 'running',
    recoveryVersion: 2,
    stopOnError: true,
    subject: 'original',
    body: 'original body',
    rate: 1,
    recipients: [
      { id: 'r1', email: 'one@example.com', fields: {}, status: 'pending' },
      { id: 'r2', email: 'two@example.com', fields: {}, status: 'pending' },
    ],
  };
  put('campaign', c);
  await advanceCampaign(c, 'a', async () => {
    throw Object.assign(Error('connection lost'), { code: 'ESOCKET', command: 'DATA' });
  });
  assert.equal(get('campaign', 'test').status, 'running');
  assert.equal(get('campaign', 'test').recipients[0].status, 'uncertain');
  const calls = [];
  await advanceCampaign(c, 'a', async (...args) => {
    calls.push(args);
    return { accepted: [args[1]], messageId: args[5] };
  });
  assert.equal(calls[0][1], 'two@example.com');
  assert.equal(calls[0][2], 'original');
  assert.equal(calls[0][3], 'original body');
  assert.equal(get('campaign', 'test').recipients[0].attempts.length, 1);
  await advanceCampaign(c, 'a', async () => {
    throw Error('must not send');
  });
  assert.equal(get('campaign', 'test').status, 'attention');
});
test('known temporary errors retry in place, stable logical row and bounded attempts', async () => {
  const c = {
    id: 'bounded',
    accountId: 'a',
    senderEmail: 'a@example.com',
    mode: 'live',
    status: 'running',
    subject: 's',
    body: 'b',
    rate: 1,
    recipients: [{ id: 'r', email: 'one@example.com', fields: {}, status: 'pending' }],
  };
  put('campaign', c);
  for (let i = 0; i < 3; i++) {
    let fresh = get('campaign', c.id);
    fresh.recipients[0].retryAt = 0;
    put('campaign', fresh);
    await advanceCampaign(c, 'a', async () => {
      throw Object.assign(Error('later'), { responseCode: 451 });
    });
  }
  const row = get('campaign', c.id).recipients[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts.length, 3);
  assert.equal(new Set(row.attempts.map((a) => a.messageId)).size, 3);
});
test('missing sent evidence never silently resends and exact evidence resolves original row', () => {
  const r = {
    status: 'uncertain',
    failureKind: 'unknown',
    attempts: [{ messageId: '<id>', status: 'uncertain' }],
  };
  applyEvidence(r, null, '', 0);
  applyEvidence(r, null, '', 300000);
  applyEvidence(r, null, '', 900000);
  assert.equal(r.status, 'needs_review');
  assert.throws(() => prepareRetry(r), /确认/);
  applyEvidence(r, { messageId: '<id>', checkedAt: new Date().toISOString() });
  assert.equal(r.status, 'sent');
  assert.equal(r.attempts[0].status, 'sent');
});
test('read-only Sent search uses exact Message-ID and never a recipient-only match', async () => {
  const calls = [];
  const result = await sentEvidence(
    { host: 'smtp.gmail.com', user: 'a' },
    'secret',
    ['<one>'],
    () => ({
      on() {},
      connect: async () => {},
      list: async () => [{ path: 'Sent', specialUse: '\\Sent' }],
      mailboxOpen: async (...args) => calls.push(args),
      search: async (...args) => {
        calls.push(args);
        return [1];
      },
      logout: async () => {},
      close() {},
    }),
  );
  assert.equal(result.messageId, '<one>');
  assert.deepEqual(calls[0], ['Sent', { readOnly: true }]);
  assert.deepEqual(calls[1][0], { header: { 'Message-ID': '<one>' } });
});
test('recovery resolves uncertain campaign without sending and tolerates unavailability', async () => {
  put('account', { id: 'recovery', host: 'smtp.gmail.com', password: encrypt('test') });
  put('campaign', {
    id: 'recover',
    accountId: 'recovery',
    status: 'attention',
    recoveryVersion: 2,
    recipients: [{ id: 'r', status: 'uncertain', messageId: '<recover>' }],
  });
  await recoveryTick(async () => ({ messageId: '<recover>', checkedAt: new Date().toISOString() }));
  assert.equal(get('campaign', 'recover').status, 'completed');
});

test('report delivery reconciliation supports numeric attempt counts', () => {
  const row = { status: 'uncertain', attempts: 2 };
  applyEvidence(row, { messageId: '<report>', checkedAt: new Date().toISOString() });
  assert.equal(row.status, 'sent');
});
