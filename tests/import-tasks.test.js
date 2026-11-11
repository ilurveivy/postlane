import test from 'node:test';
import assert from 'node:assert/strict';
import { importTaskWorkspace as workspace, taskMetadata } from '../server/import-task-domain.js';
const row = (id, extra = {}) => ({
  id,
  email: id + '@example.com',
  fields: { recipient_type: '外部收件人' },
  ...extra,
});
const source = row('one');
const base = () => ({
  tasks: [{ id: 'task', name: '合作邀约', sourceListIds: ['list'] }],
  lists: [{ id: 'list', contacts: [source] }],
  campaigns: [],
});
const send = (id, status = 'sent') => ({
  id,
  listId: 'list',
  mode: 'live',
  status: 'completed',
  recipients: [row('one', { status })],
});
const count = (data) => workspace(data).items.find((t) => t.id === 'task').counts;
test('source rows exist before scheduling and names are validated', () => {
  assert.equal(count(base()).unassigned, 1);
  assert.throws(() => taskMetadata({ name: ' ' }));
  assert.throws(() => taskMetadata({ name: 'x', description: 'x'.repeat(501) }));
});
test('one import split into many campaigns remains one task; retry folds', () => {
  const d = base();
  d.campaigns = [send('old', 'failed'), send('new')];
  assert.equal(count(d).sent, 1);
  assert.equal(count(d).failed, 0);
  assert.equal(count(d).total, 1);
});
test('mixed source campaigns attributed per row, copies and simulation excluded', () => {
  const d = base();
  d.tasks.push({ id: 'b', sourceListIds: ['b'] });
  d.lists.push({ id: 'b', contacts: [row('two')] });
  const c = send('c');
  c.recipients.push(
    row('two', { status: 'sent', fields: { source_list_id: 'b', source_recipient_id: 'two' } }),
    row('archive', { status: 'sent', fields: { recipient_type: '末封留档副本' } }),
  );
  d.campaigns = [c, { ...send('sim'), mode: 'simulation' }];
  const w = workspace(d);
  assert.equal(w.campaignSlices.c.task.total, 1);
  assert.equal(w.campaignSlices.c.b.total, 1);
  assert.equal(w.items.find((t) => t.id === 'unassigned').counts.total, 0);
});
test('broken source is visible, not guessed by email or name', () => {
  const d = base();
  d.campaigns = [{ ...send('bad'), listId: 'missing' }];
  const w = workspace(d);
  assert.equal(w.items.find((t) => t.id === 'unassigned').counts.total, 1);
  assert.equal(count(d).unassigned, 1);
});
test('legacy handled is never a successful reply; later inbound reopens', () => {
  const d = base();
  d.campaigns = [send('c')];
  const e = {
    id: 'e',
    type: 'reply',
    accountId: 'a',
    messageId: 'm1',
    date: '2026-10-01T01:00:00Z',
    handled: true,
    links: [{ campaignId: 'c', recipientId: 'one' }],
  };
  d.events = [e];
  assert.equal(count(d).legacyHandled, 1);
  assert.equal(count(d).replied, 0);
  d.events.push({
    ...e,
    id: 'e2',
    messageId: 'm2',
    inReplyTo: 'm1',
    handled: false,
    date: '2026-10-02T01:00:00Z',
  });
  assert.equal(count(d).conversations, 1);
  assert.equal(count(d).awaitingReply, 1);
});
test('reply needs successful send after latest incoming and same account', () => {
  const d = base();
  d.campaigns = [send('c')];
  d.events = [
    {
      id: 'e',
      type: 'reply',
      accountId: 'a',
      messageId: 'm1',
      date: '2026-10-01T01:00:00Z',
      links: [{ campaignId: 'c', recipientId: 'one' }],
    },
  ];
  d.replies = [
    {
      messageId: 'm2',
      inReplyTo: 'm1',
      accountId: 'a',
      status: 'failed',
      sentAt: '2026-10-02T00:00:00Z',
    },
  ];
  assert.equal(count(d).awaitingReply, 1);
  d.replies[0].status = 'sent';
  assert.equal(count(d).replied, 1);
  d.replies[0].accountId = 'b';
  assert.equal(count(d).replied, 0);
});
test('receipt projection is deterministic and does not mutate input', () => {
  const d = base();
  d.tasks = [];
  d.receipts = [{ result: { id: 'list', name: '历史任务' } }];
  const original = JSON.stringify(d);
  const w = workspace(d);
  assert.equal(w.items[0].id, 'legacy-import-list');
  assert.equal(JSON.stringify(d), original);
});
test('paused pending, uncertain and permanent failure stay separate', () => {
  const d = base();
  d.campaigns = [send('c', 'pending')];
  d.campaigns[0].status = 'paused';
  assert.equal(count(d).pending, 1);
  d.campaigns[0].recipients[0].status = 'uncertain';
  assert.equal(count(d).uncertain, 1);
  d.campaigns[0].recipients[0].status = 'failed';
  assert.equal(count(d).failed, 1);
});
test('unattributed retries retain one logical message and source cycles stay unresolved', () => {
  const d = base();
  d.tasks = [];
  d.campaigns = [
    send('old', 'failed'),
    {
      ...send('retry'),
      recipients: [
        row('copy', {
          status: 'sent',
          email: 'one@example.com',
          logicalCampaignId: 'old',
          logicalRecipientId: 'one',
        }),
      ],
    },
  ];
  assert.equal(workspace(d).items.find((t) => t.id === 'unassigned').counts.total, 1);
  assert.equal(workspace(d).items.find((t) => t.id === 'unassigned').counts.sent, 1);
});
test('cancelled pending is not scheduled and stale retry timestamps do not imply retry', () => {
  const d = base();
  d.campaigns = [{ ...send('cancel', 'pending'), status: 'cancelled' }];
  assert.equal(count(d).cancelled, 1);
  d.campaigns = [send('fail', 'failed')];
  d.campaigns[0].recipients[0].retryAt = 123;
  assert.equal(count(d).failed, 1);
});
test('historical receipt without proven allocation is not advertised as unscheduled', () => {
  const d = base();
  d.tasks = [];
  d.receipts = [{ result: { id: 'list', name: '历史导入' } }];
  const c = workspace(d).items.find((t) => t.origin === 'receipt').counts;
  assert.equal(c.unverified, 1);
  assert.equal(c.unassigned, 0);
});
test('task date indexes use Beijing day and only actual successful submission timestamps', () => {
  const d = base();
  d.campaigns = [send('c')];
  d.campaigns[0].scheduledAt = '2026-10-28T16:30:00Z';
  d.campaigns[0].recipients[0].sentAt = '2026-10-29T17:00:00Z';
  const t = workspace(d).items.find((t) => t.id === 'task');
  assert.deepEqual(t.scheduledDays, ['2026-10-29']);
  assert.deepEqual(t.sentDays, ['2026-10-30']);
});
test('handled, received reply and sent reply counts are independent; new incoming preserves ever-replied', () => {
  const d = base();
  d.campaigns = [send('c')];
  const e = {
    id: 'e',
    type: 'reply',
    accountId: 'a',
    messageId: 'm1',
    date: '2026-10-01T01:00:00Z',
    links: [{ campaignId: 'c', recipientId: 'one' }],
    handled: false,
  };
  d.events = [e];
  let n = count(d);
  assert.equal(n.handled, 0);
  assert.equal(n.receivedReplies, 1);
  assert.equal(n.replied, 0);
  e.handled = true;
  n = count(d);
  assert.equal(n.handled, 1);
  assert.equal(n.receivedReplies, 1);
  assert.equal(n.replied, 0);
  assert.equal(n.awaitingReply, 1);
  d.replies = [
    {
      accountId: 'a',
      messageId: 'm2',
      inReplyTo: 'm1',
      status: 'sent',
      sentAt: '2026-10-02T00:00:00Z',
    },
  ];
  d.events.push({
    ...e,
    id: 'e2',
    messageId: 'm3',
    inReplyTo: 'm2',
    date: '2026-10-03T01:00:00Z',
    handled: false,
  });
  n = count(d);
  assert.equal(n.handled, 1);
  assert.equal(n.pendingHandling, 1);
  assert.equal(n.receivedReplies, 1);
  assert.equal(n.replied, 1);
  assert.equal(n.awaitingReply, 1);
});
test('a reply sent before a second task receives its first message does not count as replied for that task', () => {
  const d = base();
  d.tasks.push({ id: 'task-b', sourceListIds: ['list-b'] });
  d.lists.push({ id: 'list-b', contacts: [row('two')] });
  d.campaigns = [
    send('a'),
    {
      id: 'b',
      mode: 'live',
      status: 'completed',
      listId: 'list-b',
      recipients: [row('two', { status: 'sent' })],
    },
  ];
  d.events = [
    {
      id: 'e1',
      type: 'reply',
      accountId: 'a',
      messageId: 'm1',
      date: '2026-10-01T00:00:00Z',
      links: [{ campaignId: 'a', recipientId: 'one' }],
    },
    {
      id: 'e2',
      type: 'reply',
      accountId: 'a',
      messageId: 'm3',
      inReplyTo: 'm2',
      date: '2026-10-03T00:00:00Z',
      links: [{ campaignId: 'b', recipientId: 'two' }],
    },
  ];
  d.replies = [
    {
      accountId: 'a',
      messageId: 'm2',
      inReplyTo: 'm1',
      status: 'sent',
      sentAt: '2026-10-02T00:00:00Z',
    },
  ];
  const w = workspace(d);
  assert.equal(w.items.find((t) => t.id === 'task').counts.replied, 1);
  assert.equal(w.items.find((t) => t.id === 'task-b').counts.replied, 0);
});

test('historical exact aliases do not duplicate source rows or classify archives as pending', () => {
  const d = base();
  d.tasks[0].origin = 'historical';
  d.tasks[0].sourceListIds.push('old');
  d.tasks[0].sourceRecordAliases = { 'old:original': 'list:one' };
  d.lists.push({ id: 'old', contacts: [row('original', { email: source.email })] });
  d.lists[0].contacts.push(row('copy', { fields: { 用途: '本人确认副本' } }));
  assert.equal(count(d).total, 1);
  assert.equal(count(d).unverified, 1);
  const c = send('old-send');
  c.listId = 'old';
  c.recipients = [row('original', { email: source.email, status: 'sent' })];
  d.campaigns.push(c);
  assert.equal(count(d).sent, 1);
  assert.equal(count(d).total, 1);
});

test('scheduled counts exclude drafts; bounce failure is unique and recovered by later successful retry', () => {
  const d = base();
  const c = send('c', 'pending');
  c.status = 'draft';
  d.campaigns = [c];
  assert.equal(count(d).scheduled, 0);
  c.status = 'scheduled';
  assert.equal(count(d).scheduled, 1);
  c.status = 'completed';
  c.recipients[0].status = 'sent';
  c.recipients[0].sentAt = '2026-10-01T00:00:00Z';
  d.events = [1, 2].map((n) => ({
    id: 'bounce' + n,
    type: 'bounce',
    accountId: 'a',
    links: [{ campaignId: 'c', recipientId: 'one' }],
  }));
  assert.equal(count(d).sent, 1);
  assert.equal(count(d).failed, 1);
  assert.equal(count(d).scheduled, 0);
  const retry = send('retry');
  retry.recipients[0].sentAt = '2026-10-02T00:00:00Z';
  d.campaigns.push(retry);
  assert.equal(count(d).failed, 0);
  assert.equal(count(d).sent, 1);
});
