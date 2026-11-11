import { createHash } from 'node:crypto';
import { render } from './domain.js';
import { gmailAccount } from './followup-domain.js';
import { mailId, refsOf, conversations, filterThreads, inSyncWindow } from './inbox-domain.js';

export function createInboxView({ all, get, isSyncRunning = () => false }) {
  function mailboxAccounts() {
    const sent = new Set(
      all('campaign')
        .filter((c) => c.mode === 'live' && c.recipients.some((r) => r.status === 'sent'))
        .map((c) => c.accountId),
    );
    return all('account').filter(
      (a) => gmailAccount(a) && a.password && (a.verifiedAt || sent.has(a.id)),
    );
  }
  function inboxMessages() {
    const map = new Map();
    for (const c of all('campaign')) {
      if (c.mode !== 'live') continue;
      for (const r of c.recipients) {
        if (!r.messageId || r.status !== 'sent') continue;
        const id = mailId(c.accountId, r.messageId);
        map.set(id, {
          id,
          accountId: c.accountId,
          accountEmail: c.senderEmail,
          messageId: r.messageId,
          from: [c.senderEmail],
          to: [r.email],
          subject: render(c.subject, r.fields),
          text: render(c.body, r.fields),
          date: r.sentAt,
          seen: true,
          outgoing: true,
          folders: ['sent'],
          references: [],
          campaignNames: [c.name],
          submissionOnly: !r.sentEvidence,
        });
      }
    }
    for (const e of all('mail-event')) {
      if (!e.messageId || e.type === 'folder') continue;
      const id = mailId(e.accountId, e.messageId);
      map.set(id, {
        ...e,
        id,
        references: refsOf(e.headers),
        seen: !!e.handled,
        outgoing: false,
        folders: e.folders?.some((f) => /spam|junk|迷惑|垃圾/i.test(f)) ? ['junk'] : ['inbox'],
        campaignNames: [
          ...new Set(
            (e.links || []).map((l) => get('campaign', l.campaignId)?.name).filter(Boolean),
          ),
        ],
      });
    }
    for (const m of all('inbox-message'))
      map.set(m.id, {
        ...map.get(m.id),
        ...m,
        campaignNames: [
          ...new Set([...(map.get(m.id)?.campaignNames || []), ...(m.campaignNames || [])]),
        ],
      });
    return [...map.values()]
      .filter((m) => inSyncWindow(m.date))
      .map((m) => ({ ...m, seen: get('inbox-read', m.id)?.seen ?? m.seen }));
  }
  function threadById(id) {
    const threads = conversations(inboxMessages());
    const t = threads.find((t) => t.id === id || t.messages.some((m) => m.id === id));
    if (!t) throw Error('邮件会话不存在');
    // Only explicit platform replies can bridge accounts; shared subjects or
    // untrusted References alone must never merge unrelated mailboxes.
    const byId = new Map(),
      byMessage = new Map();
    for (const thread of threads) {
      byId.set(thread.id, thread);
      for (const m of thread.messages) {
        byId.set(m.id, thread);
        if (m.messageId) byMessage.set(mailId(m.accountId, m.messageId), thread);
      }
    }
    const bridges = all('reply-draft').filter(
      (d) => d.threadId && d.messageId && ['sent', 'uncertain', 'needs_review'].includes(d.status),
    );
    const edges = new Map();
    for (const d of bridges) {
      const source = byId.get(d.threadId),
        target = byMessage.get(mailId(d.accountId, d.messageId));
      if (!source || !target || source === target) continue;
      for (const [a, b] of [
        [source, target],
        [target, source],
      ]) {
        if (!edges.has(a)) edges.set(a, new Set());
        edges.get(a).add(b);
      }
    }
    const selected = new Set([t]);
    for (const thread of selected)
      for (const neighbor of edges.get(thread) || []) selected.add(neighbor);
    return {
      ...t,
      messages: [...selected]
        .flatMap((v) => v.messages)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id)),
    };
  }
  const contextVersion = (t) =>
    createHash('sha256')
      .update(
        t.messages
          .filter((m) => !m.outgoing)
          .map((m) => m.id)
          .sort()
          .join('|'),
      )
      .digest('hex');
  function inboxState(query = {}) {
    const threads = conversations(inboxMessages());
    const filtered = filterThreads(threads, query);
    const offset = Math.max(0, Number(query.offset) || 0);
    return {
      threads: filtered
        .slice(offset, offset + 40)
        .map(({ messages, ...t }) => ({ ...t, count: messages.length })),
      total: filtered.length,
      counts: Object.fromEntries(
        ['inbox', 'sent', 'junk', 'remote-drafts', 'trash'].map((f) => [
          f,
          threads.filter(
            (t) =>
              (!query.accountId || query.accountId === 'all' || t.accountId === query.accountId) &&
              t.folders.includes(f),
          ).length,
        ]),
      ),
      accounts: mailboxAccounts().map((a) => ({
        id: a.id,
        email: a.from,
        disabled: !!a.disabled,
        replyOnly: !!a.replyOnly,
        defaultManualSender: !!a.defaultManualSender,
      })),
      sync: all('inbox-sync').filter((s) => mailboxAccounts().some((a) => a.id === s.id)),
      running: isSyncRunning(),
      drafts: all('reply-draft')
        .filter(
          (d) => !query.accountId || query.accountId === 'all' || d.accountId === query.accountId,
        )
        .filter((d) => {
          const day = new Date(Date.parse(d.updatedAt) + 8 * 3600000).toISOString().slice(0, 10);
          return (
            (!query.from || day >= query.from) &&
            (!query.to || day <= query.to) &&
            (!query.q ||
              [d.to, d.subject, d.body]
                .join(' ')
                .toLowerCase()
                .includes(String(query.q).toLowerCase()))
          );
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    };
  }
  function getThread(id) {
    const t = threadById(id);
    return { ...t, contextVersion: contextVersion(t) };
  }
  function threadForFollowup(eventId) {
    const event = get('mail-event', eventId);
    if (!event) throw Error('跟进记录不存在，请刷新后重试');
    if (!event.messageId)
      throw Error('此记录缺少可定位的邮件标识，无法准确打开会话；请同步邮箱后重试');
    const messageId = mailId(event.accountId, event.messageId);
    let thread;
    try {
      thread = getThread(messageId);
    } catch {
      throw Error('对应邮件尚未同步或不在当前收信范围内，请同步邮箱后重试');
    }
    if (thread.accountId !== event.accountId || !thread.messages.some((m) => m.id === messageId))
      throw Error('邮件归属不一致，无法准确打开会话');
    return { thread, messageId };
  }

  return {
    mailboxAccounts,
    inboxMessages,
    threadById,
    contextVersion,
    inboxState,
    getThread,
    threadForFollowup,
  };
}
