import { createHash } from 'node:crypto';
export const INBOX_SYNC_START = '2026-09-10T00:00:00+08:00';
export const inSyncWindow = (date) => Date.parse(date) >= Date.parse(INBOX_SYNC_START);
export const mailId = (accountId, messageId) =>
  createHash('sha256')
    .update(accountId + ':' + messageId)
    .digest('hex');
export const refsOf = (s) => [...new Set(String(s || '').match(/<[^<>\s]+>/g) || [])];
export function conversations(messages) {
  const parent = new Map();
  const root = (k) => {
    if (!parent.has(k)) parent.set(k, k);
    if (parent.get(k) !== k) parent.set(k, root(parent.get(k)));
    return parent.get(k);
  };
  for (const m of messages) {
    const keys = [m.messageId || m.id, ...(m.references || []), m.inReplyTo]
      .filter(Boolean)
      .map((k) => m.accountId + ':' + k);
    for (const k of keys) parent.set(root(k), root(keys[0]));
  }
  const groups = new Map();
  for (const m of messages) {
    const key = root(m.accountId + ':' + (m.messageId || m.id));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.values()]
    .map((ms) => {
      ms.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
      const last = ms.at(-1);
      return {
        id: ms[0].id,
        accountId: last.accountId,
        accountEmail: last.accountEmail,
        subject: ms[0].subject || '（无主题）',
        date: last.date,
        snippet: (last.text || '').replace(/\s+/g, ' ').slice(0, 160),
        unread: ms.some((m) => !m.outgoing && !m.seen),
        participants: [...new Set(ms.flatMap((m) => (m.outgoing ? m.to : m.from)))],
        folders: [...new Set(ms.flatMap((m) => m.folders || []))],
        campaignNames: [...new Set(ms.flatMap((m) => m.campaignNames || []))],
        messages: ms,
      };
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
export function filterThreads(
  threads,
  { accountId = 'all', folder = 'inbox', from = '', to = '', q = '', unread = 'false' } = {},
) {
  return threads.filter(
    (t) =>
      (accountId === 'all' || t.accountId === accountId) &&
      (folder === 'all' || t.folders.includes(folder)) &&
      (unread !== 'true' || t.unread) &&
      t.messages.some((m) => {
        const day = new Date(Date.parse(m.date) + 8 * 3600000).toISOString().slice(0, 10);
        return (!from || day >= from) && (!to || day <= to);
      }) &&
      (!q ||
        [t.subject, ...t.participants, ...t.messages.map((m) => m.text || '')]
          .join(' ')
          .toLowerCase()
          .includes(q.toLowerCase())),
  );
}
