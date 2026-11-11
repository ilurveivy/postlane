import test from 'node:test';
import assert from 'node:assert/strict';
import { correlate, eventId, trackingFor, targetsFor } from '../server/followup-domain.js';
import { scanMailbox } from '../server/followup-imap.js';
function failedSearchClient(result) {
  return {
    on() {},
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return [{ path: 'INBOX', specialUse: '\\Inbox' }];
    },
    async mailboxOpen() {
      return { uidValidity: 1, uidNext: 301, exists: 300 };
    },
    async search() {
      return result;
    },
  };
}
test('failed IMAP searches never advance new or existing cursors; retry reads the same range', async () => {
  for (const initial of [{}, { INBOX: { validity: '1', uid: 2 } }]) {
    for (const result of [false, undefined, null, {}, [0], [NaN]]) {
      const cursors = structuredClone(initial),
        mock = failedSearchClient(result);
      let persisted = 0,
        loggedOut = 0;
      mock.logout = async () => {
        loggedOut++;
      };
      const scan = () =>
        scanMailbox(
          { user: 'x', from: 'sender@gmail.com' },
          'fake',
          '2026-09-14',
          cursors,
          () => false,
          () => {
            persisted++;
          },
          () => mock,
        );
      await assert.rejects(scan(), /IMAP 邮件查询失败/);
      assert.deepEqual(cursors, initial);
      assert.equal(persisted, 0);
      assert.equal(loggedOut, 1);
      let query;
      mock.search = async (q) => {
        query = q;
        return [];
      };
      await scan();
      if (initial.INBOX) assert.equal(query.uid, '3:*');
      else assert.ok(query.since instanceof Date);
      assert.equal(cursors.INBOX.uid, 300);
      assert.equal(persisted, 1);
    }
  }
});
test('a later folder failure preserves completed folders but does not checkpoint the failed folder', async () => {
  const mock = failedSearchClient(false),
    cursors = { INBOX: { validity: '1', uid: 2 } };
  mock.list = async () => [
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'INBOX', specialUse: '\\Inbox' },
  ];
  let searches = 0;
  mock.search = async () => (++searches === 1 ? [] : false);
  const saved = [];
  await assert.rejects(
    scanMailbox(
      { user: 'x', from: 'sender@gmail.com' },
      'fake',
      '2026-09-14',
      cursors,
      () => false,
      (f) => saved.push(f.path),
      () => mock,
    ),
    /IMAP 邮件查询失败/,
  );
  assert.deepEqual(saved, ['Sent']);
  assert.equal(cursors.Sent.uid, 300);
  assert.equal(cursors.INBOX.uid, 2);
});
test('failed mailbox open or body fetch cannot be mistaken for successful empty content', async () => {
  for (const stage of ['open', 'body']) {
    const mock = failedSearchClient([3]),
      cursors = { INBOX: { validity: '1', uid: 2 } };
    if (stage === 'open') mock.mailboxOpen = async () => false;
    mock.fetch = async function* () {
      yield {
        uid: 3,
        envelope: { from: [{ address: 'other@example.com' }] },
        bodyStructure: { type: 'text/plain', part: '1' },
      };
    };
    mock.fetchOne = async () => false;
    let ingested = 0,
      persisted = 0;
    await assert.rejects(
      scanMailbox(
        { user: 'x', from: 'sender@gmail.com' },
        'fake',
        '2026-09-14',
        cursors,
        (m, screen) => {
          if (screen) return true;
          ingested++;
        },
        () => {
          persisted++;
        },
        () => mock,
      ),
      /IMAP .*失败/,
    );
    assert.equal(ingested, 0);
    assert.equal(persisted, 0);
    assert.equal(cursors.INBOX.uid, 2);
  }
});
const target = {
  campaignId: 'c1',
  recipientId: 'r1',
  email: 'person@example.com',
  subject: 'Hello',
  messageId: '<m1@example.com>',
  sentAt: '2026-09-14T10:00:00Z',
};
const base = {
  from: ['person@example.com'],
  to: ['sender@gmail.com'],
  subject: 'Re: Hello',
  date: '2026-09-15T10:00:00Z',
  messageId: '<reply@example.com>',
  headers: 'In-Reply-To: <m1@example.com>',
  specialUse: '\\Inbox',
};
test('引用优先：相同标题和留档副本不会误关联；改标题也可匹配', () => {
  const x = correlate(
    { ...base, subject: 'Different' },
    [target, { ...target, email: 'me@gmail.com', messageId: '<copy>', archive: true }],
    'sender@gmail.com',
  );
  assert.equal(x.type, 'reply');
  assert.equal(x.matches.length, 1);
  assert.equal(x.matches[0].email, target.email);
  const a = correlate(
    { ...base, headers: 'In-Reply-To: <copy>', from: ['me@gmail.com'] },
    [{ ...target, email: 'me@gmail.com', messageId: '<copy>', archive: true }],
    'sender@gmail.com',
  );
  assert.equal(a.type, 'archive_reply');
});
test('匹配不会使用正文中的无关地址；地址退信和自动回复分开', () => {
  const m = {
    ...base,
    from: ['mailer-daemon@googlemail.com'],
    headers: '',
    text: 'Final-Recipient: rfc822; person@example.com\r\nAction: failed\r\nStatus: 5.1.1\r\nQuote other@example.com',
  };
  const x = correlate(m, [target, { ...target, email: 'other@example.com' }], 'sender@gmail.com');
  assert.equal(x.type, 'bounce');
  assert.equal(x.matches.length, 1);
  assert(x.permanent);
  assert.equal(
    correlate(
      { ...base, headers: base.headers + '\r\nAuto-Submitted: auto-replied' },
      [target],
      'sender@gmail.com',
    ).type,
    'auto_reply',
  );
  assert.equal(
    correlate(
      { ...base, headers: base.headers + '\r\nAuto-Submitted: no' },
      [target],
      'sender@gmail.com',
    ).type,
    'reply',
  );
});
test('已发送核对：ID 确认与旧记录模糊匹配分开，重复扫描事件 ID 不变', () => {
  const sent = {
    ...base,
    from: ['sender@gmail.com'],
    to: [target.email],
    subject: 'Hello',
    messageId: target.messageId,
    specialUse: '\\Sent',
  };
  assert.equal(correlate(sent, [target], 'sender@gmail.com').confidence, 'message-id');
  assert.equal(
    correlate({ ...sent, messageId: '<other>' }, [target], 'sender@gmail.com').confidence,
    'address-subject',
  );
  assert.equal(correlate({ ...sent, specialUse: '\\All' }, [target], 'sender@gmail.com'), null);
  assert.equal(eventId('a', base), eventId('a', { ...base, folder: 'other' }));
  assert.notEqual(eventId('a', base), eventId('b', base));
  assert.equal(
    correlate({ ...base, headers: '', date: '2026-01-01' }, [target], 'sender@gmail.com'),
    null,
  );
});
test('跟踪从最后发送计算，暂停与自定义期限保留，草稿没有目标', () => {
  const c = {
    id: 'c',
    subject: '{{s}}',
    recipients: [{ id: 'r', email: target.email, sentAt: target.sentAt, fields: { s: 'Hello' } }],
  };
  assert.equal(trackingFor(c).until, '2026-09-28T10:00:00.000Z');
  assert.equal(trackingFor(c, { enabled: false }).enabled, false);
  assert.equal(targetsFor([c])[0].subject, 'Hello');
  assert.equal(trackingFor({ id: 'x', recipients: [] }).until, null);
});
test('IMAP 只读，持久化游标补查、不改已读、不读取无关正文；UIDVALIDITY 改变重新查', async () => {
  const opened = [],
    queries = [],
    messages = [],
    folders = [];
  let fetched = 0;
  const mock = {
    on() {},
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return [{ path: 'INBOX', specialUse: '\\Inbox' }];
    },
    async mailboxOpen(p, o) {
      opened.push(o);
      return { uidValidity: 1, exists: 4 };
    },
    async search(q) {
      queries.push(q);
      return [2, 3];
    },
    async *fetch(ids) {
      for (const uid of ids)
        yield {
          uid,
          emailId: String(uid),
          envelope: { ...base, from: [{ address: base.from[0] }], to: [{ address: base.to[0] }] },
          headers: Buffer.from(base.headers),
          bodyStructure: {
            type: 'text/plain',
            part: '1',
            encoding: 'quoted-printable',
            parameters: { charset: 'utf-8' },
          },
        };
    },
    async fetchOne() {
      fetched++;
      return { bodyParts: new Map([['1', Buffer.from('Hello =E4=BD=A0=E5=A5=BD')]]) };
    },
  };
  const cursors = { INBOX: { validity: '1', uid: 2 } };
  await scanMailbox(
    { user: 'x', from: 'sender@gmail.com' },
    'fake',
    '2026-09-14',
    cursors,
    async (m, screen) => {
      if (screen) return true;
      messages.push(m);
    },
    (f) => folders.push(f),
    () => mock,
  );
  assert.deepEqual(opened, [{ readOnly: true }]);
  assert.equal(queries[0].uid, '3:*');
  assert.equal(fetched, 1);
  assert.equal(messages[0].text, 'Hello 你好');
  assert.equal(cursors.INBOX.uid, 3);
  cursors.INBOX.validity = 'old';
  queries.length = 0;
  await scanMailbox(
    { user: 'x', from: 'sender@gmail.com' },
    'fake',
    '2026-09-14',
    cursors,
    () => false,
    () => {},
    () => mock,
  );
  assert(queries[0].since instanceof Date);
  assert.equal(fetched, 1);
});
test('首次补查没有新邮件时保留邮箱高水位，不在下一轮扫描全部历史', async () => {
  const queries = [];
  const mock = {
    on() {},
    async connect() {},
    async logout() {},
    close() {},
    async list() {
      return [{ path: 'INBOX', specialUse: '\\Inbox' }];
    },
    async mailboxOpen() {
      return { uidValidity: 1, uidNext: 301, exists: 300 };
    },
    async search(q) {
      queries.push(q);
      return [];
    },
  };
  const cursors = {};
  await scanMailbox(
    { user: 'x', from: 'sender@gmail.com' },
    'fake',
    '2026-09-14',
    cursors,
    () => false,
    () => {},
    () => mock,
  );
  assert.equal(cursors.INBOX.uid, 300);
  await scanMailbox(
    { user: 'x', from: 'sender@gmail.com' },
    'fake',
    '2026-09-14',
    cursors,
    () => false,
    () => {},
    () => mock,
  );
  assert.equal(queries[1].uid, '301:*');
});
