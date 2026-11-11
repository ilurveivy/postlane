import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversations, filterThreads, mailId } from '../server/inbox-domain.js';
const base = {
  accountId: 'a',
  accountEmail: 'a@gmail.com',
  from: ['person@example.com'],
  to: ['a@gmail.com'],
  subject: 'Hello',
  text: 'Original',
  date: '2026-09-16T00:00:00Z',
  folders: ['inbox'],
  seen: false,
};
const msg = (id, extra = {}) => ({ ...base, id: mailId('a', id), messageId: id, ...extra });
test('threads link through references, not matching subjects, and isolate accounts', () => {
  const groups = conversations([
    msg('<1>'),
    msg('<2>', { references: ['<1>'] }),
    msg('<3>'),
    msg('<1>', { id: 'other', accountId: 'b' }),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(
    groups.find((t) => t.messages.some((m) => m.messageId === '<2>')).messages.length,
    2,
  );
  const t = conversations([
    msg('<old>', { date: '2026-09-14T00:00:00Z' }),
    msg('<new>', { references: ['<old>'], date: '2026-09-18T00:00:00Z' }),
  ]);
  assert.equal(filterThreads(t, { from: '2026-09-16', to: '2026-09-16' }).length, 0);
  assert.equal(
    filterThreads(conversations([msg('<cn>', { date: '2026-09-15T17:00:00Z' })]), {
      from: '2026-09-16',
      to: '2026-09-16',
    }).length,
    1,
  );
});
test('drafts preserve Reply-To and headers, guard concurrent edits/new mail and do not resend', async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-inbox-'));
  process.env.DISABLE_MAIL_SYNC = 'true';
  process.env.DISABLE_BATCH_REPORTS = 'true';
  const { put, get, encrypt } = await import('../server/store.js');
  const { timer } = await import('../server/mailer.js');
  clearInterval(timer);
  const { saveDraft, queueDraft, deliverDraft, getThread, deleteDraft } =
    await import('../server/inbox.js');
  put('account', {
    id: 'a',
    from: 'a@gmail.com',
    user: 'a@gmail.com',
    host: 'smtp.gmail.com',
    password: encrypt('fake'),
  });
  const original = msg('<original>', { replyTo: ['reply@example.com'] });
  put('inbox-message', original);
  const t = getThread(original.id);
  let d = saveDraft({ threadId: t.id, body: 'Thanks', contextVersion: t.contextVersion });
  assert.equal(d.to, 'reply@example.com');
  assert.equal(d.inReplyTo, '<original>');
  assert.deepEqual(d.references, ['<original>']);
  const old = d;
  d = saveDraft({ ...d, body: 'Updated' });
  assert.throws(() => saveDraft({ ...old, body: 'stale' }), /其他窗口/);
  put(
    'inbox-message',
    msg('<fresh>', { references: ['<original>'], date: '2026-09-16T01:00:00Z' }),
  );
  assert.throws(() => queueDraft(d.id, { version: d.version, confirm: true }), /新来信/);
  d = saveDraft({ ...d, contextVersion: getThread(t.id).contextVersion });
  assert.throws(() => queueDraft(d.id, { version: d.version, confirm: false }), /确认/);
  const queued = queueDraft(d.id, { version: d.version, confirm: true });
  assert.equal(queueDraft(d.id, { version: d.version, confirm: true }).messageId, queued.messageId);
  let sends = 0;
  await deliverDraft(queued, 'live:a', async (...args) => {
    sends++;
    assert.equal(args[1], 'reply@example.com');
    assert.equal(args[6].inReplyTo, '<original>');
    return { accepted: ['reply@example.com'] };
  });
  await deliverDraft(queued, 'live:a', async () => {
    sends++;
  });
  assert.equal(sends, 1);
  assert.equal(get('reply-draft', d.id).status, 'sent');
  assert.equal(getThread(original.id).messages.length, 3);
  assert.throws(() => deleteDraft(d.id), /只能删除/);
  let u = saveDraft({ accountId: 'a', to: 'someone@example.com', subject: 'Test', body: 'Test' });
  u = queueDraft(u.id, { version: u.version, confirm: true });
  await deliverDraft(u, 'live:a', async () => {
    throw Object.assign(Error('Interrupted'), { code: 'ESOCKET' });
  });
  assert.equal(get('reply-draft', u.id).status, 'uncertain');
  assert.throws(() => queueDraft(u.id, { version: u.version, confirm: true }), /待确认/);
  let late = saveDraft({ threadId: t.id, body: 'Late' });
  late = queueDraft(late.id, { version: late.version, confirm: true });
  put(
    'inbox-message',
    msg('<later>', { references: ['<original>'], date: '2026-09-16T02:00:00Z' }),
  );
  await deliverDraft(late, 'live:a', async () => {
    throw Error('must not send');
  });
  assert.equal(get('reply-draft', late.id).status, 'failed');
});
test('SMTP composer emits a threaded reply with one recipient and stable Message-ID', async () => {
  const nodemailer = (await import('nodemailer')).default;
  const { simpleParser } = await import('mailparser');
  const { sendOne } = await import('../server/mailer.js');
  const result = await sendOne(
    { from: 'sender@example.com', name: 'Sender' },
    'reply@example.com',
    'Re: hello',
    'Exact reply\n第二行',
    true,
    '<stable@postlane.local>',
    {
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<parent@example.com>'],
    },
    () => nodemailer.createTransport({ streamTransport: true, buffer: true }),
  );
  const m = await simpleParser(result.message);
  assert.equal(m.messageId, '<stable@postlane.local>');
  assert.equal(m.inReplyTo, '<parent@example.com>');
  assert.deepEqual(m.references, ['<root@example.com>', '<parent@example.com>']);
  assert.equal(m.to.value.length, 1);
  assert.equal(m.to.value[0].address, 'reply@example.com');
  assert.equal(m.text.trim(), 'Exact reply\n第二行');
});
test('IMAP indexing parses real MIME in read-only mode and reports flags and UID validity', async () => {
  const { scanInbox } = await import('../server/inbox-imap.js');
  const source = Buffer.from(
    'From: Person <person@example.com>\r\nTo: a@gmail.com\r\nReply-To: partner@example.com\r\nMessage-ID: <imap-test@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <parent@example.com>\r\nDate: Wed, 16 Sep 2026 08:00:00 +0800\r\nSubject: Re: Subject\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal message',
  );
  const messages = [],
    folders = [];
  const client = {
    list: async () => [{ path: 'INBOX' }],
    mailboxOpen: async (p, o) => {
      assert.equal(o.readOnly, true);
      return { uidValidity: 12 };
    },
    search: async (q) => (q.seen ? [2] : [1, 2]),
    fetch: async function* (ids, q) {
      assert.equal(q.source.maxLength, 1048576);
      for (const uid of ids)
        yield { uid, source, flags: new Set(uid === 2 ? ['\\Seen'] : []), size: source.length };
    },
  };
  await scanInbox(
    { id: 'a', from: 'a@gmail.com' },
    'test',
    {},
    (m) => messages.push(m),
    (p, c, s) => folders.push({ p, c, s }),
    async (a, p, fn) => fn(client),
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].replyTo[0], 'partner@example.com');
  assert.equal(messages[0].inReplyTo, '<parent@example.com>');
  assert.equal(messages[0].text, 'Original message');
  assert.equal(messages[1].seen, true);
  assert.equal(folders[0].c.validity, '12');
  assert.deepEqual(folders[0].s.seenUids, [2]);
});

test('exact Sent evidence reconciles uncertain replies without resubmission', async () => {
  const { put, get } = await import('../server/store.js');
  const { ingestInboxMessage } = await import('../server/inbox.js');
  put('reply-draft', {
    id: 'uncertain-fixture',
    accountId: 'a',
    messageId: '<uncertain@example.com>',
    status: 'uncertain',
  });
  ingestInboxMessage(
    msg('<unrelated@example.com>', {
      outgoing: true,
      folders: ['sent'],
      locations: [{ path: 'Sent', uid: 1, validity: '1', folder: 'sent' }],
    }),
  );
  assert.equal(get('reply-draft', 'uncertain-fixture').status, 'uncertain');
  ingestInboxMessage(
    msg('<uncertain@example.com>', {
      outgoing: true,
      folders: ['sent'],
      locations: [{ path: 'Sent', uid: 2, validity: '1', folder: 'sent' }],
    }),
  );
  assert.equal(get('reply-draft', 'uncertain-fixture').status, 'sent');
});
test('empty Gmail search results may be false and must not break indexing', async () => {
  const { scanInbox } = await import('../server/inbox-imap.js');
  let captured;
  const client = {
    list: async () => [{ path: 'INBOX' }],
    mailboxOpen: async () => ({ uidValidity: 1 }),
    search: async () => false,
    fetch: async function* () {
      throw Error('empty folders must not fetch');
    },
  };
  await scanInbox(
    { id: 'a', from: 'a@gmail.com' },
    'test',
    {},
    () => {},
    (path, cursor, snapshot) => {
      captured = { cursor, snapshot };
    },
    async (a, p, fn) => fn(client),
  );
  assert.equal(captured.cursor.total, 0);
  assert.deepEqual(captured.snapshot.seenUids, []);
  assert.deepEqual(captured.snapshot.ids, []);
});

test('mailbox cutoff includes Beijing midnight and hides older cached messages', async () => {
  const { inSyncWindow } = await import('../server/inbox-domain.js');
  assert.equal(inSyncWindow('2026-09-09T15:59:59Z'), false);
  assert.equal(inSyncWindow('2026-09-09T16:00:00Z'), true);
  const { put } = await import('../server/store.js');
  const { inboxMessages } = await import('../server/inbox.js');
  const old = msg('<before-cutoff>', { date: '2026-09-09T15:59:59Z' });
  const boundary = msg('<at-cutoff>', { date: '2026-09-09T16:00:00Z' });
  put('inbox-message', old);
  put('inbox-message', boundary);
  assert.equal(
    inboxMessages().some((m) => m.id === old.id),
    false,
  );
  assert.equal(
    inboxMessages().some((m) => m.id === boundary.id),
    true,
  );
});

test('bounded IMAP sync resets legacy cursors and excludes mail before the exact cutoff', async () => {
  const { scanInbox } = await import('../server/inbox-imap.js');
  const messages = [],
    cursors = [];
  const client = {
    list: async () => [{ path: 'INBOX' }],
    mailboxOpen: async () => ({ uidValidity: 1 }),
    search: async (q) => {
      assert.equal(q.sentSince.toISOString(), '2026-09-09T00:00:00.000Z');
      assert.equal(q.all, undefined);
      return q.seen ? [] : [1, 2];
    },
    fetch: async function* (ids) {
      assert.deepEqual(ids, [1, 2]);
      for (const uid of ids)
        yield {
          uid,
          flags: new Set(),
          size: 200,
          source: Buffer.from(
            `From: person@example.com\r\nMessage-ID: <cutoff-${uid}>\r\nDate: ${uid === 1 ? 'Wed, 09 Sep 2026 23:59:59' : 'Thu, 10 Sep 2026 00:00:00'} +0800\r\n\r\nBody`,
          ),
        };
    },
  };
  await scanInbox(
    { id: 'a', from: 'a@gmail.com' },
    'fake',
    { INBOX: { validity: '1', high: 100, low: 1 } },
    (m) => messages.push(m),
    (p, c) => cursors.push(c),
    async (a, p, run) => run(client),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].messageId, '<cutoff-2>');
  assert.equal(cursors[0].syncStart, '2026-09-10T00:00:00+08:00');
});

test('AI generation uses optional shared preset and full thread without changing or sending draft', async () => {
  const { put, get } = await import('../server/store.js');
  const { saveDraft, generateSuggestion, saveReplyPreset } = await import('../server/inbox.js');
  for (let i = 0; i < 20; i++)
    put(
      'inbox-message',
      msg(`<long-${i}>`, {
        references: i ? ['<long-0>'] : [],
        date: new Date(Date.parse('2026-09-16T00:00:00Z') + i * 1000).toISOString(),
        text: `message ${i}`,
      }),
    );
  const d = saveDraft({ threadId: mailId('a', '<long-0>'), body: 'My editable draft' });
  saveReplyPreset('');
  let seen;
  await generateSuggestion(d.id, async (messages) => {
    seen = messages;
    return { text: 'Suggestion' };
  });
  const context = JSON.parse(seen[1].content);
  assert.equal(context.conversation.length, 20);
  assert.equal(context.conversation[0].text, 'message 0');
  assert.equal(context.conversation.at(-1).text, 'message 19');
  assert.equal(context.currentDraft, 'My editable draft');
  assert.match(seen[0].content, /暂未配置/);
  saveReplyPreset('Do not promise discounts.');
  await generateSuggestion(d.id, async (messages) => {
    assert.match(messages[0].content, /Do not promise discounts/);
    return { text: 'Suggestion' };
  });
  assert.equal(get('reply-draft', d.id).status, 'draft');
  assert.equal(get('reply-draft', d.id).body, 'My editable draft');
  saveReplyPreset('');
});
test('follow-up opens the exact account and message with original mail and later replies', async () => {
  const { put } = await import('../server/store.js');
  const { threadForFollowup } = await import('../server/inbox.js');
  const accountId = 'followup-account';
  const originalId = '<followup-original>';
  const replyId = '<followup-reply>';
  put(
    'inbox-message',
    msg(originalId, {
      accountId,
      id: mailId(accountId, originalId),
      outgoing: true,
      folders: ['sent'],
    }),
  );
  put('mail-event', {
    ...base,
    id: 'followup-event',
    accountId,
    messageId: replyId,
    headers: `References: ${originalId}`,
    type: 'auto_reply',
    handled: false,
  });
  put(
    'inbox-message',
    msg('<followup-later>', {
      accountId,
      id: mailId(accountId, '<followup-later>'),
      references: [originalId, replyId],
      date: '2026-09-17T01:00:00Z',
    }),
  );
  // The same Message-ID in another mailbox and the same subject are not identity matches.
  put(
    'inbox-message',
    msg(replyId, { accountId: 'other-account', id: mailId('other-account', replyId) }),
  );
  put(
    'inbox-message',
    msg('<same-subject-unrelated>', {
      accountId,
      id: mailId(accountId, '<same-subject-unrelated>'),
    }),
  );
  const resolved = threadForFollowup('followup-event');
  assert.equal(resolved.thread.accountId, accountId);
  assert.equal(resolved.messageId, mailId(accountId, replyId));
  assert.equal(resolved.thread.messages.length, 3);
  assert.ok(resolved.thread.messages.some((m) => m.messageId === originalId));
  assert.ok(resolved.thread.messages.some((m) => m.messageId === '<followup-later>'));
  assert.ok(resolved.thread.contextVersion);
  put('mail-event', {
    ...base,
    id: 'folder-followup',
    accountId,
    messageId: originalId,
    type: 'folder',
  });
  assert.equal(threadForFollowup('folder-followup').messageId, mailId(accountId, originalId));
});
test('missing, unidentifiable and out-of-window follow-ups do not fall back to a subject match', async () => {
  const { put } = await import('../server/store.js');
  const { threadForFollowup } = await import('../server/inbox.js');
  assert.throws(() => threadForFollowup('no-event'), /跟进记录不存在/);
  put('mail-event', { ...base, id: 'no-message-id', type: 'reply' });
  assert.throws(() => threadForFollowup('no-message-id'), /无法准确打开/);
  put('mail-event', {
    ...base,
    id: 'old-followup',
    messageId: '<old-followup>',
    type: 'reply',
    date: '2026-09-01T00:00:00Z',
  });
  assert.throws(() => threadForFollowup('old-followup'), /尚未同步或不在当前收信范围/);
});

test('cross-account manual replies preserve headers, linked conversation and mailbox ownership', async () => {
  const { put, get, encrypt } = await import('../server/store.js');
  const { saveDraft, queueDraft, deliverDraft, getThread, threadForFollowup } =
    await import('../server/inbox.js');
  for (const id of ['source-cross', 'manual-cross'])
    put('account', {
      id,
      from: `${id}@gmail.com`,
      user: `${id}@gmail.com`,
      host: 'smtp.gmail.com',
      password: encrypt('fake'),
      replyOnly: id === 'manual-cross',
    });
  const incoming = msg('<cross-original>', {
    accountId: 'source-cross',
    accountEmail: 'source-cross@gmail.com',
    id: mailId('source-cross', '<cross-original>'),
    replyTo: ['cross@example.com'],
  });
  put('inbox-message', incoming);
  put('mail-event', { ...incoming, id: 'cross-event', type: 'reply' });
  let draft = saveDraft({ threadId: incoming.id, body: 'Cross account reply' });
  assert.equal(draft.accountId, 'source-cross');
  draft = saveDraft({ ...draft, accountId: 'manual-cross' });
  assert.equal(draft.sourceAccountId, 'source-cross');
  assert.equal(draft.to, 'cross@example.com');
  assert.equal(draft.inReplyTo, incoming.messageId);
  assert.throws(() => saveDraft({ ...draft, threadId: null }), /会话/);
  const queued = queueDraft(draft.id, { version: draft.version, confirm: true });
  await deliverDraft(
    queued,
    'live:manual-cross',
    async (a, to, subject, body, plain, messageId, headers) => {
      assert.equal(a.id, 'manual-cross');
      assert.equal(to, 'cross@example.com');
      assert.equal(headers.inReplyTo, incoming.messageId);
      return { accepted: [to] };
    },
  );
  assert.equal(get('reply-draft', draft.id).status, 'sent');
  assert.equal(getThread(incoming.id).accountId, 'source-cross');
  assert.equal(getThread(incoming.id).messages.length, 2);
  assert.equal(threadForFollowup('cross-event').thread.messages.length, 2);
  const second = saveDraft({ threadId: incoming.id, body: 'Next' });
  put(
    'inbox-message',
    msg('<cross-return>', {
      accountId: 'manual-cross',
      accountEmail: 'manual-cross@gmail.com',
      id: mailId('manual-cross', '<cross-return>'),
      references: [queued.messageId],
      date: '2026-10-22T14:00:00Z',
    }),
  );
  assert.equal(getThread(incoming.id).messages.length, 3);
  assert.throws(() => queueDraft(second.id, { version: second.version, confirm: true }), /新来信/);
  put(
    'inbox-message',
    msg('<cross-other>', {
      accountId: 'unrelated',
      id: mailId('unrelated', '<cross-other>'),
      references: [incoming.messageId],
    }),
  );
  assert.equal(getThread(incoming.id).messages.length, 3);
});
