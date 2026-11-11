import { createReplyDrafts } from './reply-drafts-core.js';
import { assertActivityAllowed, workersEnabled, runActivity } from './runtime-policy.js';
import { all, get, put, remove, decrypt } from './store.js';
import { settings, sendOne, registerReplyQueue } from './mailer.js';
import { sendDelay } from './domain.js';
import { mailId } from './inbox-domain.js';
import { createInboxView } from './inbox-view.js';
import { scanInbox, markRemoteSeen } from './inbox-imap.js';
import { completeReplyText } from './reply-ai.js';
import { buildReplyMessages } from './reply-prompt.js';
const now = () => new Date().toISOString();
const inboxView = createInboxView({ all, get, isSyncRunning: () => syncRunning });
const { mailboxAccounts, contextVersion } = inboxView;
export const { inboxMessages, threadById, inboxState, getThread, threadForFollowup } = inboxView;
export function ingestInboxMessage(m) {
  const old = get('inbox-message', m.id);
  put('inbox-message', {
    ...old,
    ...m,
    folders: [...new Set([...(old?.folders || []), ...m.folders])],
    locations: [
      ...(old?.locations || []).filter((l) => l.path !== m.locations[0].path),
      ...m.locations,
    ],
  });
  remove('inbox-read', m.id);
  if (m.outgoing && m.folders.includes('sent')) {
    for (const d of all('reply-draft').filter(
      (d) => d.accountId === m.accountId && d.messageId === m.messageId && d.status === 'uncertain',
    ))
      put('reply-draft', {
        ...d,
        status: 'sent',
        sentAt: m.date,
        error: '',
        reconciledAt: now(),
        updatedAt: now(),
      });
  }
}
let syncRunning = false;
const locks = new Set();
export async function syncInbox(...args) {
  return runActivity(() => syncInboxImpl(...args));
}
async function syncInboxImpl(accountId, registeredOnly = false) {
  assertActivityAllowed();
  if (syncRunning) return;
  syncRunning = true;
  try {
    for (const a of mailboxAccounts().filter(
      (a) => (!accountId || a.id === accountId) && (!registeredOnly || get('inbox-sync', a.id)),
    )) {
      if (locks.has(a.id)) continue;
      locks.add(a.id);
      const state = get('inbox-sync', a.id) || { id: a.id, cursors: {} };
      put('inbox-sync', { ...state, status: 'syncing', startedAt: now() });
      try {
        await scanInbox(
          a,
          decrypt(a.password),
          state.cursors,
          ingestInboxMessage,
          async (path, cursor, snapshot) => {
            const ids = new Set(snapshot.ids),
              seen = new Set(snapshot.seenUids);
            for (const m of all('inbox-message').filter(
              (m) => m.accountId === a.id && m.locations?.some((l) => l.path === path),
            )) {
              const locations = m.locations.filter(
                (l) => l.path !== path || (l.validity === cursor.validity && ids.has(l.uid)),
              );
              const current = locations.find((l) => l.path === path);
              put('inbox-message', {
                ...m,
                locations,
                folders: [...new Set(locations.map((l) => l.folder).filter(Boolean))],
                ...(current ? { seen: seen.has(current.uid) } : {}),
              });
              if (current) remove('inbox-read', m.id);
            }
            state.cursors[path] = cursor;
            put('inbox-sync', { ...state, status: 'syncing' });
          },
        );
        put('inbox-sync', { ...state, status: 'idle', error: '', lastSyncAt: now() });
      } catch (e) {
        put('inbox-sync', {
          ...state,
          status: 'error',
          error: '邮箱同步失败：' + String(e.message).slice(0, 180),
        });
      } finally {
        locks.delete(a.id);
      }
    }
  } finally {
    syncRunning = false;
  }
}
export async function setThreadRead(...args) {
  return runActivity(() => setThreadReadImpl(...args));
}
async function setThreadReadImpl(id, seen) {
  assertActivityAllowed();
  const t = threadById(id),
    messages = t.messages.filter((m) => !m.outgoing);
  const accountIds = [...new Set(messages.map((m) => m.accountId))];
  if (accountIds.some((id) => locks.has(id))) throw Error('该账号正在同步，请稍后标记');
  accountIds.forEach((id) => locks.add(id));
  try {
    for (const accountId of accountIds) {
      const remote = messages.filter((m) => m.accountId === accountId && m.locations?.length);
      const a = settings(accountId);
      if (remote.length) await markRemoteSeen(a, decrypt(a.password), remote, seen);
    }
    for (const m of messages) put('inbox-read', { id: m.id, seen });
  } finally {
    accountIds.forEach((id) => locks.delete(id));
  }
  return { ok: true, remote: messages.some((m) => m.locations?.length) };
}
const draftOperations = createReplyDrafts({
  get,
  put,
  remove,
  settings,
  threadById,
  contextVersion,
  now,
});
export const { saveDraft, queueDraft, deleteDraft, replyPreset, saveReplyPreset } = draftOperations;
export async function generateSuggestion(...args) {
  return runActivity(() => generateSuggestionImpl(...args));
}
async function generateSuggestionImpl(id, complete = completeReplyText) {
  assertActivityAllowed();
  const d = get('reply-draft', id);
  if (!d || d.status !== 'draft') throw Error('请先保存可编辑草稿');
  const t = d.threadId ? threadById(d.threadId) : null;
  if (t && contextVersion(t) !== d.contextVersion) throw Error('有新来信，请重新打开会话');
  const result = await complete(buildReplyMessages(d, t, replyPreset().rules));
  return { text: result.text, draftVersion: d.version };
}
for (const d of workersEnabled ? all('reply-draft') : [])
  if (d.status === 'sending')
    put('reply-draft', {
      ...d,
      status: 'uncertain',
      error: '服务在提交时中断，请核对已发送邮箱',
      updatedAt: now(),
    });
export async function deliverDraft(...args) {
  return runActivity(() => deliverDraftImpl(...args));
}
async function deliverDraftImpl(job, key, send = sendOne) {
  assertActivityAllowed();
  let d = get('reply-draft', job.id);
  if (d?.status !== 'queued') return;
  if (d.threadId && contextVersion(threadById(d.threadId)) !== d.contextVersion) {
    put('reply-draft', {
      ...d,
      status: 'failed',
      error: '排队期间有新来信，请核对后重发',
      updatedAt: now(),
    });
    return;
  }
  d = { ...d, status: 'sending' };
  put('reply-draft', d);
  let attempted = false,
    accepted = false;
  try {
    const a = settings(d.accountId);
    if (a?.from !== d.accountEmail) throw Error('发件账号已变化');
    if (get('suppression', d.to.toLowerCase())) throw Error('收件地址已停止发送');
    if (a?.disabled) throw Error('发件账号已停用');
    attempted = true;
    const r = await send(a, d.to, d.subject, d.body, true, d.messageId, {
      inReplyTo: d.inReplyTo,
      references: d.references,
    });
    if (!r.accepted?.length) throw Object.assign(Error('SMTP未接受收件人'), { code: 'EREJECTED' });
    accepted = true;
    d = { ...d, status: 'sent', sentAt: now(), error: '' };
    put('inbox-message', {
      id: mailId(d.accountId, d.messageId),
      accountId: d.accountId,
      accountEmail: d.accountEmail,
      messageId: d.messageId,
      from: [d.accountEmail],
      to: [d.to],
      subject: d.subject,
      text: d.body,
      date: d.sentAt,
      outgoing: true,
      seen: true,
      folders: ['sent'],
      references: d.references,
      inReplyTo: d.inReplyTo,
      submissionOnly: true,
    });
  } catch (e) {
    d = {
      ...d,
      status:
        accepted ||
        (attempted &&
          !(e.responseCode >= 400 && e.responseCode < 600) &&
          !['EAUTH', 'EENVELOPE', 'EMESSAGE', 'EREJECTED'].includes(e.code))
          ? 'uncertain'
          : 'failed',
      error: String(e.message).slice(0, 250),
    };
  }
  put('reply-draft', { ...d, updatedAt: now() });
  put('queue_account', { id: key, nextAt: Date.now() + sendDelay({ mode: 'live' }) });
}
registerReplyQueue({
  list: () =>
    all('reply-draft')
      .filter((d) => d.status === 'queued')
      .map((d) => ({ ...d, mode: 'live', replyJob: true })),
  run: deliverDraft,
  error: (e, job) => {
    const d = get('reply-draft', job.id);
    if (d)
      put('reply-draft', {
        ...d,
        status: 'uncertain',
        error: '队列中断，请核对已发送邮箱',
        updatedAt: now(),
      });
  },
});
if (workersEnabled && process.env.DISABLE_MAIL_SYNC !== 'true')
  setInterval(() => {
    if (workersEnabled && all('inbox-sync').length) void syncInbox(undefined, true).catch(() => {});
  }, 300000).unref();
