import { randomUUID } from 'node:crypto';
import { all, decrypt, get, put } from './store.js';
import { localParts, windowOpen } from './send-policy.js';
import { draining, verificationMode, workersEnabled } from './runtime-policy.js';
import { sendOne } from './mailer.js';
import { withInboxClient } from './inbox-imap.js';

/**
 * Warm-up by mutual sending.
 *
 * One mailbox cannot warm anything up: there is nobody to send to, and mail from an account to
 * itself proves nothing. So the pool needs at least two accounts that mail each other.
 *
 * Be honest about what this buys: it does not raise your reputation with strangers. What it does
 * is (a) keep a little ordinary two-way traffic on a fresh mailbox, and (b) - the useful part -
 * tell you whether your mail actually reaches an inbox, because we can read the receiving side
 * and report Inbox / Junk / never arrived. Treat the inbox rate as the product, not the sending.
 */
export const WARMUP_ID = 'warmup';
export const MIN_POOL = 2;
export const MAX_DAILY_COUNT = 10;
export const DEFAULT_DAILY_COUNT = 3;
/** One mail per account per gap, so a day's worth spreads across hours instead of bursting. */
export const MIN_GAP_MS = 40 * 60 * 1000;
/** A warm-up mail is only looked for after this long; SMTP is not instant. */
const CHECK_MIN_AGE_MS = 60 * 1000;
/** Give delivery a few tries before calling it "never arrived". */
const MAX_CHECK_ATTEMPTS = 3;
const MISSING_GRACE_MS = 6 * 60 * 60 * 1000;

/** Warm-up runs every day of the week, a little wider than the cold-email window. */
export const WARMUP_WINDOW = {
  sendWindow: {
    enabled: true,
    days: [1, 2, 3, 4, 5, 6, 7],
    start: '09:00',
    end: '21:00',
  },
};

// Neutral, human, boring on purpose: no links, no images, no signature, nothing to sell.
// Mixed languages are fine (real inboxes do that) and stop every account from sending the same
// phrasing, which is exactly the pattern filters look for.
const TOPICS = [
  {
    subject: 'the spreadsheet from yesterday',
    body: 'Did the file come through on your side? Mine shows the totals only, not the breakdown.\n\nNo rush, whenever you get a minute.',
  },
  {
    subject: 'moving the usual slot',
    body: 'Something came up this morning so I am running late.\n\nSame time tomorrow instead?',
  },
  {
    subject: 'invoice for last month',
    body: 'I think last month got billed twice - the second one shows the same reference.\n\nCan you check on your side and let me know.',
  },
  {
    subject: 'notes from the call',
    body: 'Wrote up what we agreed and put it in the shared folder.\n\nTwo things are still open, marked in bold at the bottom.',
  },
  {
    subject: '那个表格你这边还有吗',
    body: '我本地只剩最后一版了，怕不是最新的。\n\n你方便的时候发我一份吧，不急。',
  },
  {
    subject: 're: 下周的安排',
    body: '下周三我有空，周四整天在外面。\n\n你先定，我跟着调整就行。',
  },
  {
    subject: 'quick question about the format',
    body: 'Are we sending these as PDF or keeping them editable?\n\nAsking because the second one is easier to review but harder to sign.',
  },
  {
    subject: 'the thing you sent last week',
    body: 'Finally read it properly - the middle section is the part I keep coming back to.\n\nWant me to write a short version of it?',
  },
  {
    subject: 'found your cable',
    body: 'It was under the second desk the whole time. I put it in the top drawer.\n\nStill no idea how it got there.',
  },
  {
    subject: 'before I forget',
    body: 'The deadline moved to the end of the month - saw it in the notice this morning.\n\nNothing else changes.',
  },
];

const usableAccount = (a) =>
  Boolean(a && a.from && !a.disabled && !a.replyOnly && (a.provider === 'smtp' || !a.provider));

export function normalizeConfig(raw = {}) {
  const accountIds = [
    ...new Set(
      (Array.isArray(raw.accountIds) ? raw.accountIds : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
  const count = Math.round(Number(raw.dailyCount));
  return {
    id: WARMUP_ID,
    // One mailbox cannot warm itself up, so the flag simply cannot be on without a partner.
    enabled: raw.enabled === true && accountIds.length >= MIN_POOL,
    accountIds,
    dailyCount: Number.isFinite(count)
      ? Math.min(MAX_DAILY_COUNT, Math.max(1, count))
      : DEFAULT_DAILY_COUNT,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export function warmupConfig() {
  const raw = get('warmup', WARMUP_ID);
  return raw ? normalizeConfig(raw) : normalizeConfig({});
}

export function saveWarmupConfig(patch = {}, now = Date.now()) {
  const next = normalizeConfig({ ...warmupConfig(), ...patch });
  next.createdAt = next.createdAt || now;
  next.updatedAt = now;
  return put('warmup', next);
}

export function accountPool(cfg = warmupConfig(), accounts = all('account')) {
  const byId = new Map((accounts || []).map((a) => [a.id, a]));
  return cfg.accountIds.map((id) => byId.get(id)).filter(usableAccount);
}

/** Round-robin over the pool; `round` shifts the pairing so nobody mails the same person twice. */
export function rotationPairs(ids, round = 0) {
  const pool = (ids || []).filter(Boolean);
  const n = pool.length;
  if (n < MIN_POOL) return [];
  const step = 1 + (Math.max(0, Math.round(round)) % (n - 1));
  return pool.map((id, i) => ({ fromAccountId: id, toAccountId: pool[(i + step) % n] }));
}

export function pickTopic(seed = '') {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.codePointAt(0)) % 100003;
  return TOPICS[hash % TOPICS.length];
}

function progress(cfg, pool, messages, now) {
  const today = localParts(now).date;
  const perAccount = new Map(pool.map((a) => [a.id, 0]));
  let total = 0;
  for (const m of messages || []) {
    if (localParts(m.sentAt || 0).date !== today) continue;
    total += 1;
    if (perAccount.has(m.fromAccountId))
      perAccount.set(m.fromAccountId, perAccount.get(m.fromAccountId) + 1);
  }
  return { today, total, perAccount };
}

function lastSentBy(messages) {
  const last = new Map();
  for (const m of messages || []) {
    if ((last.get(m.fromAccountId) || 0) < (m.sentAt || 0))
      last.set(m.fromAccountId, m.sentAt || 0);
  }
  return last;
}

/** Which pairs may send right now: under the daily count, and past the per-account gap. */
export function nextPairs(cfg, pool, messages, now = Date.now(), { ignoreGap = false } = {}) {
  if (pool.length < MIN_POOL) return [];
  const { total, perAccount } = progress(cfg, pool, messages, now);
  const last = lastSentBy(messages);
  return rotationPairs(
    pool.map((a) => a.id),
    total,
  ).filter(
    (p) =>
      (perAccount.get(p.fromAccountId) || 0) < cfg.dailyCount &&
      (ignoreGap || now - (last.get(p.fromAccountId) || 0) >= MIN_GAP_MS),
  );
}

/**
 * Send one round: at most one mail per account, each to a different member of the pool.
 * Failures are collected per pair - one broken account must not stop the others.
 */
export async function runWarmupRound({ force = false, now = Date.now(), deps = {} } = {}) {
  const {
    loadConfig = warmupConfig,
    accounts = () => all('account'),
    messages = () => all('warmup-message'),
    putMessage = (m) => put('warmup-message', m),
    send = sendOne,
    newId = () => randomUUID(),
  } = deps;
  const cfg = loadConfig();
  if (!cfg.enabled && !force) return { ran: false, reason: 'disabled', sent: 0 };
  const pool = accountPool(cfg, accounts());
  if (pool.length < MIN_POOL)
    return { ran: false, reason: 'need-two-accounts', sent: 0, pool: pool.length };
  if (!force && !windowOpen(WARMUP_WINDOW, now))
    return { ran: false, reason: 'outside-window', sent: 0 };
  const allMessages = messages();
  // Manual runs skip the gap and the window (you clicked the button) but never the daily count.
  const pairs = nextPairs(cfg, pool, allMessages, now, { ignoreGap: force });
  let sent = 0;
  const errors = [];
  for (const pair of pairs) {
    const from = pool.find((a) => a.id === pair.fromAccountId);
    const to = pool.find((a) => a.id === pair.toAccountId);
    if (!from || !to || from.id === to.id) continue;
    const topic = pickTopic(`${from.from}|${to.from}|${sent}|${localParts(now).date}`);
    const sentAt = Date.now();
    try {
      const info = await send(from, to.from, topic.subject, topic.body, true);
      putMessage({
        id: newId(),
        fromAccountId: from.id,
        toAccountId: to.id,
        from: from.from,
        to: to.from,
        subject: topic.subject,
        text: topic.body,
        messageId: String(info?.messageId || ''),
        sentAt,
        placement: '',
        attempts: 0,
        checkedAt: 0,
        error: '',
      });
      sent += 1;
    } catch (error) {
      errors.push({ from: from.from, error: error.message });
    }
  }
  return { ran: true, sent, errors };
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
 * Read the receiving mailbox and record where each warm-up mail landed.
 * This is the part worth having: "Junk" here means cold email from this account is junk too.
 */
export async function checkWarmupPlacement({ now = Date.now(), limit = 6, deps = {} } = {}) {
  const {
    messages = () => all('warmup-message'),
    accounts = () => all('account'),
    putMessage = (m) => put('warmup-message', m),
    connect = withInboxClient,
    password = (a) => decrypt(a.password),
  } = deps;
  const t = now;
  const pending = (messages() || [])
    .filter((m) => !m.placement && m.messageId && t - (m.sentAt || 0) >= CHECK_MIN_AGE_MS)
    .sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
  if (!pending.length) return { checked: 0, accounts: 0, errors: [] };
  const byRecipient = new Map();
  for (const m of pending) {
    const list = byRecipient.get(m.toAccountId) || [];
    if (list.length < limit) list.push(m);
    byRecipient.set(m.toAccountId, list);
  }
  const accountList = accounts() || [];
  let checked = 0;
  const errors = [];
  for (const [toAccountId, list] of byRecipient) {
    const account = accountList.find((a) => a.id === toAccountId);
    if (!usableAccount(account) || !account.password) {
      errors.push({ account: toAccountId, error: '收件账号不可用或缺少授权码' });
      continue;
    }
    try {
      await connect(account, password(account), async (client) => {
        const junk = await junkPath(client);
        for (const m of list) {
          let placement = '';
          if (await searchFolder(client, 'INBOX', m.messageId)) placement = 'inbox';
          else if (junk && (await searchFolder(client, junk, m.messageId))) placement = 'junk';
          const attempts = (m.attempts || 0) + 1;
          const giveUp = attempts >= MAX_CHECK_ATTEMPTS || t - (m.sentAt || 0) > MISSING_GRACE_MS;
          // Still pending reads as "" so the row stays in the queue for another try.
          const next = {
            ...m,
            attempts,
            checkedAt: t,
            error: '',
            placement: placement || (giveUp ? 'missing' : ''),
          };
          putMessage(next);
          checked += 1;
        }
      });
    } catch (error) {
      errors.push({ account: account.from, error: error.message });
    }
  }
  return { checked, accounts: byRecipient.size, errors };
}

/** Everything the settings panel shows, in one object. */
export function warmupSummary(now = Date.now()) {
  const cfg = warmupConfig();
  const messages = all('warmup-message') || [];
  const pool = accountPool(cfg);
  const { total, perAccount } = progress(cfg, pool, messages, now);
  const recent = messages
    .filter((m) => m.placement)
    .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0))
    .slice(-20);
  const count = (p) => recent.filter((m) => m.placement === p).length;
  return {
    config: cfg,
    pool: pool.map((a) => ({
      id: a.id,
      name: a.name,
      from: a.from,
      sentToday: perAccount.get(a.id) || 0,
    })),
    accountTotal: (all('account') || []).filter(usableAccount).length,
    canEnable: pool.length >= MIN_POOL,
    todaySent: total,
    pendingChecks: messages.filter((m) => !m.placement).length,
    recent: {
      checked: recent.length,
      inbox: count('inbox'),
      junk: count('junk'),
      missing: count('missing'),
      inboxRate: recent.length ? Math.round((count('inbox') / recent.length) * 100) : null,
    },
    lastSentAt: messages.reduce((s, m) => Math.max(s, m.sentAt || 0), 0),
  };
}

/** Background round: only when the pool is open for business. */
export async function warmupTick(now = Date.now()) {
  if (!workersEnabled || draining || verificationMode) return { ran: false, reason: 'workers-off' };
  const cfg = warmupConfig();
  if (!cfg.enabled) return { ran: false, reason: 'disabled' };
  try {
    const result = await runWarmupRound({ now });
    if (result.sent) console.log(`Warm-up: sent ${result.sent} message(s)`);
    for (const e of result.errors || [])
      console.error(`Warm-up send failed for ${e.from}: ${e.error}`);
    const placed = await checkWarmupPlacement({ now });
    for (const e of placed.errors || []) console.error(`Warm-up check failed: ${e.error}`);
    return { ...result, checked: placed.checked };
  } catch (error) {
    console.error('Warm-up round failed:', error.message);
    return { ran: false, reason: 'error', error: error.message };
  }
}

export const warmupTimer = workersEnabled ? setInterval(() => void warmupTick(), 5 * 60_000) : null;
warmupTimer?.unref();
