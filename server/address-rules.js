// Rules for addresses that must never be sent to.
//
// Cold-email lists are usually scraped or pasted from templates, so they contain
// placeholder mailboxes (`your.email@good.idea`, `john.doe@company.com`) and role
// mailboxes (`noreply@`, `postmaster@`). Sending to them is always a mistake: the
// placeholders hard-bounce and bounces are what wreck a sender's reputation.
//
// `blocked` addresses are filtered out; `warn` addresses are kept but flagged, because
// `info@` / `contact@` are legitimate targets for small businesses.

const PLACEHOLDER_LOCALS = new Set([
  'your.email',
  'your.email.address',
  'youremail',
  'your.email.here',
  'yourname',
  'your.name',
  'your-email',
  'your_email',
  'yourname.lastname',
  'name',
  'email',
  'email.address',
  'example',
  'example.email',
  'test',
  'test.email',
  'demo',
  'sample',
  'foo',
  'bar',
  'xxx',
  'abc',
  'someone',
  'user',
  'username',
  'john.doe',
  'jane.doe',
  'johndoe',
  'janedoe',
  'john.smith',
  'jane.smith',
  'first.last',
  'firstname.lastname',
  'first.lastname',
]);

// Only domains that exist purely as placeholders. Real providers (mail.com, test.com,
// domain.com) are deliberately absent — blocking a real domain would silently drop
// legitimate recipients.
const PLACEHOLDER_DOMAINS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'example.edu',
  'example.email',
  'yourdomain.com',
  'your-domain.com',
  'email.com',
  'localhost',
]);

const BLOCKED_ROLES = new Set([
  'noreply',
  'no-reply',
  'no.reply',
  'donotreply',
  'do-not-reply',
  'do.not.reply',
  'do_not_reply',
  'mailer-daemon',
  'mailer.daemon',
  'postmaster',
  'abuse',
  'bounce',
  'bounces',
  'notifications',
  'notification',
]);

const WARN_ROLES = new Set([
  'info',
  'contact',
  'hello',
  'hi',
  'sales',
  'support',
  'service',
  'admin',
  'administrator',
  'webmaster',
  'hostmaster',
  'unsubscribe',
  'root',
  'team',
  'office',
]);

/**
 * Classify an address without touching DNS.
 * Returns `{ status: 'invalid' | 'warning', reason }`, or null when the address looks
 * like a normal personal mailbox and DNS should decide.
 */
export function addressRule(email, { checkDomain = true } = {}) {
  const value = String(email ?? '')
    .trim()
    .toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at),
    domain = value.slice(at + 1);
  // Domain-level placeholders are judged by the preflight gate, not at import: dropping
  // imported rows because of their domain would be a silent edit of the operator's file.
  if (checkDomain && PLACEHOLDER_DOMAINS.has(domain))
    return { status: 'invalid', reason: '占位符域名（example.com 这类示例地址）' };
  if (PLACEHOLDER_LOCALS.has(local))
    return { status: 'invalid', reason: '占位符地址（表格模板里的示例邮箱）' };
  if (/^your[._-]/.test(local) || /^your(name|email|mail)$/.test(local))
    return { status: 'invalid', reason: '占位符地址（表格模板里的示例邮箱）' };
  const base = local.split('+')[0].split('.')[0];
  if (BLOCKED_ROLES.has(local) || BLOCKED_ROLES.has(base))
    return { status: 'invalid', reason: '自动回复/退信地址，永远不会有人读' };
  if (WARN_ROLES.has(local) || WARN_ROLES.has(base))
    return { status: 'warning', reason: '角色邮箱（info/support 这类），回复率通常很低' };
  return null;
}

/** True when the address must be filtered out before sending. */
export const addressBlocked = (email) => addressRule(email)?.status === 'invalid';
