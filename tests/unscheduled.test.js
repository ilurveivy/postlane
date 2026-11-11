import test from 'node:test';
import assert from 'node:assert/strict';
import { unscheduledLists } from '../src/unscheduled.js';
const row = (id, body = 'Original body') => ({
  id,
  email: 'a@example.com',
  fields: { email_subject: 'Original subject', email_content: body },
});
test('explicit failed retries enter backlog once and disappear when reassigned or sent', () => {
  const failed = { ...row('failed'), status: 'failed' };
  const original = { id: 'old', mode: 'live', status: 'completed_errors', recipients: [failed] };
  const retry = row('retry');
  Object.assign(retry.fields, {
    postlane_retry_campaign_id: 'old',
    postlane_retry_recipient_id: 'failed',
  });
  const lists = [
    { contacts: [row('old-source')] },
    { contacts: [retry] },
    { contacts: [{ ...retry, id: 'duplicate' }] },
  ];
  assert.deepEqual(
    unscheduledLists(lists, [original])
      .flatMap((l) => l.contacts)
      .map((r) => r.id),
    ['retry'],
  );
  for (const status of ['pending', 'sending', 'sent', 'uncertain', 'retry_wait']) {
    const next = {
      id: 'next',
      mode: 'live',
      status: 'scheduled',
      recipients: [{ ...row('next-row'), status }],
    };
    assert.equal(unscheduledLists(lists, [original, next]).length, 0);
  }
  assert.equal(
    unscheduledLists(lists, [
      original,
      {
        id: 'retry-failed-again',
        mode: 'live',
        status: 'completed_errors',
        recipients: [{ ...retry, id: 'assigned-copy', status: 'failed' }],
      },
    ]).length,
    0,
  );
  failed.resolvedBy = 'successful-retry';
  assert.equal(unscheduledLists(lists, [original]).length, 0);
  delete failed.resolvedBy;
  failed.fields.email_content = 'Changed';
  assert.equal(
    unscheduledLists(lists, [original]).some((l) => l.contacts.some((r) => r.id === 'retry')),
    false,
  );
});
test('split imports and duplicate source lists do not inflate pending count', () => {
  const lists = [
    { id: 'source', contacts: [row('1'), row('2', 'Next')] },
    { id: 'copy', contacts: [row('3'), row('4', 'Next')] },
  ];
  const cs = [{ mode: 'live', status: 'scheduled', recipients: [row('split')] }];
  const result = unscheduledLists(lists, cs);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].contacts, [row('2', 'Next')]);
});
test('draft live mail is assigned, simulation does not consume the original', () => {
  const lists = [{ contacts: [row('1')] }];
  assert.equal(
    unscheduledLists(lists, [{ mode: 'simulation', status: 'completed', recipients: [row('1')] }])
      .length,
    1,
  );
  assert.equal(
    unscheduledLists(lists, [{ mode: 'live', status: 'draft', recipients: [row('1')] }]).length,
    0,
  );
});
test('cancelled unsent mail returns to backlog but uncertain mail stays excluded', () => {
  const lists = [{ contacts: [row('1')] }];
  assert.equal(
    unscheduledLists(lists, [
      { mode: 'live', status: 'cancelled', recipients: [{ ...row('1'), status: 'cancelled' }] },
    ]).length,
    1,
  );
  assert.equal(
    unscheduledLists(lists, [
      { mode: 'live', status: 'cancelled', recipients: [{ ...row('1'), status: 'uncertain' }] },
    ]).length,
    0,
  );
});

test('cancelled tasks release mail but an active assignment of the same source blocks it', () => {
  const r = row('source');
  const lists = [{ id: 'l', contacts: [r] }];
  const cancelled = {
    id: 'old',
    listId: 'l',
    mode: 'live',
    status: 'cancelled',
    recipients: [{ ...r, status: 'cancelled' }],
  };
  assert.equal(unscheduledLists(lists, [cancelled])[0].contacts.length, 1);
  const active = {
    id: 'new',
    listId: 'generated',
    mode: 'live',
    status: 'scheduled',
    recipients: [
      {
        ...r,
        id: 'new-row',
        status: 'pending',
        fields: {
          ...r.fields,
          source_list_id: 'l',
          source_recipient_id: 'source',
          email_content: 'changed rendering',
        },
      },
    ],
  };
  assert.equal(unscheduledLists(lists, [cancelled, active]).length, 0);
});
