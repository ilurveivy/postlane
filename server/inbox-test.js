import { randomUUID } from 'node:crypto';
import { all, decrypt, put, remove } from './store.js';
import { sendOne } from './mailer.js';
import { withInboxClient } from './inbox-imap.js';
import { draining, verificationMode, workersEnabled } from './runtime-policy.js';

/**
 * Inbox placement self-test.
 *
 * There is no way to know whether cold email will land in the inbox before you send it, except
 * to send something and look. So: one plain personal-looking mail from the sending account to a
 * mailbox you can read (it has to be an account in this app, because the check uses its IMAP),
 * then report whether it landed in INBOX, in Junk, or never arrived.
 *
 * Deliberately not a "warm-up network": keeping traffic flowing between your own mailboxes buys
 * nothing with strangers' filters, and the only assumption worth testing is "does my mail reach
 * an inbox". One test on demand answers that; a queue of fake conversations does not.
 *
 * The mail itself must look ordinary - a message whose body says "TEST" is more likely to be
 * filtered, which would make the result a lie. Identification is the Message-ID only.
 */
const CHECK_MIN_AGE_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const MISSING_GRACE_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY = 20;
const MAX_PENDING = 5;

const TEMPLATES = [
  {
    subject: 'quick one about the schedule',
    body: 'Did we land on Thursday or Friday in the end? I have both written down somewhere.\n\nEither works for me, just want to put it in the diary.',
  },
  {
    subject: 'the file from earlier',
    body: 'I finally opened it - the second tab is the one I was looking for.\n\nThanks for sending it over.',
  },
  {
    subject: '上次说的那个表格',
    body: '我这边看完了，改动不多，主要是最后一列的口径。\n\n你方便的时候确认一下就行，不急。',
  },
];

const usableAccount = (a) =>
  Boolean(a && a.from && !a.disabled && !a.replyOnly && (a.provider === 'smtp' || !a.provider));

export function testableAccounts(accounts = all('account')) {
  return (accounts || []).filter(usableAccount);
}

function templateFor(seed) {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.codePointAt(0)) % 100003;
  return TEMPLATES[hash % TEMPLATES.length];
}

function records() {
  return (all('placement-test') || []).sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
}

function prune(now) {
  const list = records();
  const old = list.filter((r) => r.placement && now - (r.sentAt || 0) > 7 * 86400000);
  const keep = list.slice(-MAX_HISTORY);
  const drop = [...old, ...list.slice(0, Math.max(0, list.length - MAX_HISTORY))];
  for (const r of new Set(drop)) remove('placement-test', r.id);
}

/** Send one test message. Returns the record; placement is filled in by checkTest(). */
export async function sendTest({ fromAccountId, toAccountId, now = Date.now(), deps = {} } = {}) {
  const {
    accounts = () => all('account'),
    putRecord = (r) => put('placement-test', r),
    send = sendOne,
    newId = () => randomUUID(),
  } = deps;
  const list = accounts() || [];
  const from = list.find((a) => a.id === fromAccountId);
  const to = list.find((a) => a.id === toAccountId);
  if (!usableAccount(from)) throw new Error('请选择一个可用的发件账号');
  if (!usableAccount(to))
    throw new Error('收件邮箱必须是本应用里可用的账号 —— 落箱要靠它的 IMAP 去读');
  const template = templateFor(`${from.from}|${to.from}|${now}`);
  const info = await send(from, to.from, template.subject, template.body, true);
  const record = {
    id: newId(),
    fromAccountId: from.id,
    from: from.from,
    toAccountId: to.id,
    to: to.from,
    subject: template.subject,
    messageId: String(info?.messageId || ''),
    sentAt: Date.now(),
    placement: '',
    attempts: 0,
    checkedAt: 0,
    error: '',
  };
  putRecord(record);
  prune(Date.now());
  return record;
}

async function searchFolder(client, path, messageId) {
  await client.mailboxOpen(path, { readOnly: true });
  const hits = await client.search({
    header: { 'message-id': String(messageId).replace(/[<>]/g, '') },
  });
  return Array.isArray(hits) && hits.length > 0;
}

async function junkPath(client) {
  const folders = await client.list();
  if (!Array.isArray(folders)) return '';
  const junk = folders.find(
    (f) => f.specialUse === '\\Junk' || /spam|junk|垃圾|迷惑/i.test(String(f.path || f.name || '')),
  );
  return junk?.path && junk.path !== 'INBOX' ? junk.path : '';
}

/**
 * Look the message up in the receiving mailbox and record where it landed.
 * A single miss is not a verdict (delivery is not instant); it takes MAX_ATTEMPTS or a day.
 */
export async function checkTest({
  id = '',
  now = Date.now(),
  limit = MAX_PENDING,
  deps = {},
} = {}) {
  const {
    list = () => records(),
    accounts = () => all('account'),
    putRecord = (r) => put('placement-test', r),
    connect = withInboxClient,
    password = (a) => decrypt(a.password),
  } = deps;
  const pending = list()
    .filter((r) => !r.placement && r.messageId)
    .filter((r) => (id ? r.id === id : now - (r.sentAt || 0) >= CHECK_MIN_AGE_MS))
    .slice(0, limit);
  if (!pending.length)
    return { checked: 0, reason: id ? '这封信还没有可检查的状态' : '没有待检查的信' };
  const accountList = accounts() || [];
  const results = [];
  const errors = [];
  for (const record of pending) {
    const account = accountList.find((a) => a.id === record.toAccountId);
    if (!usableAccount(account) || !account.password) {
      errors.push({ to: record.to, error: '收件账号不可用或缺少授权码' });
      continue;
    }
    try {
      let placement = '';
      await connect(account, password(account), async (client) => {
        if (await searchFolder(client, 'INBOX', record.messageId)) placement = 'inbox';
        else {
          const junk = await junkPath(client);
          if (junk && (await searchFolder(client, junk, record.messageId))) placement = 'junk';
        }
      });
      const attempts = (record.attempts || 0) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS || now - (record.sentAt || 0) > MISSING_GRACE_MS;
      const next = {
        ...record,
        attempts,
        checkedAt: now,
        error: '',
        placement: placement || (giveUp ? 'missing' : ''),
      };
      putRecord(next);
      results.push(next);
    } catch (error) {
      // Keep the record untouched: an IMAP hiccup says nothing about where the mail is.
      errors.push({ to: record.to, error: error.message });
    }
  }
  return { checked: results.length, results, errors };
}

export const PLACEMENT_TEXT = {
  inbox: '收件箱：链路正常，可以按节奏发',
  junk: '进了垃圾箱：先别发冷邮件，查 SPF/DKIM/DMARC 和域名历史',
  missing: '没到：大概率在 SMTP 层就被拒了，看账号的报错',
  '': '已发出，等 1 分钟后检查落箱',
};

export function inboxTestSummary() {
  const accounts = testableAccounts();
  const list = records();
  const last = list[list.length - 1] || null;
  const counted = list.filter((r) => r.placement);
  const count = (p) => counted.filter((r) => r.placement === p).length;
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, from: a.from })),
    last: last
      ? {
          ...last,
          hint: PLACEMENT_TEXT[last.placement] || PLACEMENT_TEXT[''],
        }
      : null,
    pending: list.filter((r) => !r.placement).length,
    history: list.slice(-10).reverse(),
    totals: {
      checked: counted.length,
      inbox: count('inbox'),
      junk: count('junk'),
      missing: count('missing'),
    },
    canTest: accounts.length >= 1,
  };
}

/** Background sweep: only looks at mail already sent, never sends anything. */
export async function pollPending(now = Date.now()) {
  if (!workersEnabled || draining || verificationMode) return { checked: 0 };
  try {
    return await checkTest({ now });
  } catch (error) {
    console.error('Placement check failed:', error.message);
    return { checked: 0, error: error.message };
  }
}

export const placementTimer = workersEnabled ? setInterval(() => void pollPending(), 90_000) : null;
placementTimer?.unref();
