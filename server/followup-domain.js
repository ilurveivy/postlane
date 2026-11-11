import { createHash } from 'node:crypto';
import { render } from './domain.js';
export const DAY = 86400000;
export const gmailAccount = (a) =>
  a && (!a.provider || a.provider === 'smtp') && a.host === 'smtp.gmail.com';
export const lastSend = (c) =>
  Math.max(0, ...c.recipients.map((r) => Date.parse(r.sentAt || '') || 0));
export function trackingFor(c, saved) {
  const start = lastSend(c);
  return {
    id: c.id,
    enabled: true,
    until: start ? new Date(start + 14 * DAY).toISOString() : null,
    ...saved,
  };
}
export function targetsFor(campaigns) {
  return campaigns.flatMap((c) =>
    c.recipients
      .filter((r) => r.sentAt || r.status === 'sending')
      .map((r) => ({
        campaignId: c.id,
        recipientId: r.id,
        email: r.email.toLowerCase(),
        subject: render(c.subject, r.fields),
        messageId: r.messageId,
        attemptIds: (r.attempts || []).map((a) => a.messageId),
        sentAt: r.sentAt || c.startedAt,
        archive:
          r.fields?.recipient_type === '末封留档副本' ||
          /留档|副本/.test(r.fields?.recipient_type || ''),
      })),
  );
}
const normalized = (s) =>
  String(s || '')
    .replace(/^(\s*(re|fw|fwd)\s*:\s*)+/gi, '')
    .trim()
    .toLowerCase();
export function correlate(message, targets, sender) {
  const headers = message.headers || '';
  const refs = new Set((headers.match(/<[^<>\s]+>/g) || []).concat(message.inReplyTo || []));
  const outgoing = message.from.includes(sender.toLowerCase());
  // Never associate a delivery failure using addresses quoted in the original body.
  const dsn = /(?:^|\n)(?:Final-Recipient|Original-Recipient):\s*rfc822;\s*([^\s\r\n]+)/gi;
  const failed = [...(message.text || '').matchAll(dsn)].map((m) => m[1].toLowerCase());
  const failedHeader = headers.match(/X-Failed-Recipients:\s*([^\r\n]+)/i)?.[1] || '';
  failed.push(
    ...failedHeader
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
  const bounce =
    !outgoing &&
    (failed.length > 0 || message.from.some((a) => /^(mailer-daemon|postmaster)@/i.test(a)));
  const exact = targets.filter((t) =>
    [t.messageId, ...(t.attemptIds || [])].some(
      (id) => id && (outgoing ? id === message.messageId : refs.has(id)),
    ),
  );
  let matches = exact;
  let confidence = 'message-id';
  if (!matches.length) {
    confidence = 'address-subject';
    matches = targets.filter((t) => {
      if (Date.parse(message.date) + 300000 < Date.parse(t.sentAt)) return false;
      if (bounce) return failed.includes(t.email);
      return (
        (outgoing ? message.to.includes(t.email) : message.from.includes(t.email)) &&
        normalized(message.subject) === normalized(t.subject)
      );
    });
  }
  if (
    !matches.length ||
    (outgoing && !['\\Sent', '\\Drafts', '\\Junk', '\\Trash'].includes(message.specialUse))
  )
    return null;
  // Recipient/subject matches can span retries: retain links, never use them to auto-confirm an uncertain attempt.
  const type = outgoing
    ? message.specialUse === '\\Sent'
      ? 'sent'
      : 'folder'
    : bounce
      ? /Action:\s*failed/i.test(message.text || '')
        ? 'bounce'
        : 'delivery_notice'
      : /Auto-Submitted:\s*(?!no\b)\S+/i.test(headers)
        ? 'auto_reply'
        : matches.every((t) => t.archive)
          ? 'archive_reply'
          : 'reply';
  return {
    type,
    confidence,
    matches,
    permanent: type === 'bounce' && /Status:\s*5\./i.test(message.text || ''),
  };
}
export function eventId(accountId, m) {
  return createHash('sha256')
    .update(accountId + ':' + (m.messageId || m.key))
    .digest('hex');
}
