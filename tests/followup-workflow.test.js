import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingSelection, markHandled } from '../server/followup-workflow.js';
import { filterFollowup } from '../src/followup-filter.js';
test('processing filters never infer handled from reply status', () => {
  const events = [
    { id: 'replied', type: 'reply', handled: false, followupStatus: 'replied' },
    { id: 'handled', type: 'reply', handled: true, followupStatus: 'awaitingReply' },
  ];
  assert.deepEqual(
    filterFollowup(events, { handled: 'pending' }).map((e) => e.id),
    ['replied'],
  );
  assert.deepEqual(
    filterFollowup(events, { handled: 'done' }).map((e) => e.id),
    ['handled'],
  );
});
test('selection intersects snapshot, current filters and pending state across pages', () => {
  const events = Array.from({ length: 250 }, (_, i) => ({
    id: String(i),
    accountId: i === 249 ? 'other' : 'a',
    handled: i === 248,
    subject: 'sample',
    date: '2026-10-28T01:00:00Z',
    type: 'reply',
  }));
  const ids = events.slice(0, 249).map((e) => e.id);
  const selected = pendingSelection(
    events,
    { account: 'a', kind: 'reply', from: '2026-10-28', to: '2026-10-28' },
    ids,
  );
  assert.equal(selected.length, 248);
  assert.equal(events[0].handled, false);
});
test('marking handled preserves content and explicit communication decisions', () => {
  const e = { id: '1', text: 'Original', followupDisposition: 'no_reply', handled: false };
  assert.deepEqual(markHandled(e, 'now'), {
    ...e,
    handled: true,
    handledAt: 'now',
    handlingSource: 'manual',
  });
});

test('bounce and delivery notices default to done without hiding replies or overriding manual reopen', () => {
  const events = [
    { id: 'b', type: 'bounce', handled: false },
    { id: 'n', type: 'delivery_notice', handled: false },
    { id: 'r', type: 'reply', handled: false },
    { id: 'm', type: 'bounce', handled: false, handlingSource: 'manual' },
  ];
  assert.deepEqual(
    filterFollowup(events, { handled: 'done' }).map((e) => e.id),
    ['b', 'n'],
  );
  assert.deepEqual(
    pendingSelection(events, { handled: 'pending' }, ['b', 'n', 'r', 'm']).map((e) => e.id),
    ['r', 'm'],
  );
});
