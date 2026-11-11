// One-click unsubscribe.
//
// Every message a campaign sends can carry a signed per-recipient link. The signature is an
// HMAC over the address, so the endpoint needs no database lookup to know who clicked and no
// login to be usable — a recipient must never have to authenticate to stop our email.
//
// The link exists only when POSTLANE_PUBLIC_ORIGIN is configured: a relative or guessed URL
// would point at nothing, which is worse than falling back to the `mailto:` header (that one
// keeps working, it just needs a reply).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { accessGuard, verificationMode } from './runtime-policy.js';
import { all, get, put } from './store.js';

const SECRET_ID = 'unsubscribe-secret';
let cached = null;

function tokenSecret() {
  if (cached) return cached;
  const existing = get('config', SECRET_ID);
  if (existing?.value) return (cached = Buffer.from(existing.value, 'hex'));
  const value = randomBytes(32).toString('hex');
  // A read-only demo instance must not write; its tokens are only valid for that process.
  if (!verificationMode)
    put('config', { id: SECRET_ID, value, createdAt: new Date().toISOString() });
  return (cached = Buffer.from(value, 'hex'));
}

export const normalizeEmail = (email) =>
  String(email ?? '')
    .trim()
    .toLowerCase();

const mac = (payload) => createHmac('sha256', tokenSecret()).update(payload).digest('base64url');

export function unsubscribeToken(email) {
  const payload = Buffer.from(normalizeEmail(email)).toString('base64url');
  return `${payload}.${mac(payload)}`;
}

export function emailFromToken(token) {
  const [payload, signature] = String(token ?? '').split('.');
  if (!payload || !signature) return '';
  const expected = Buffer.from(mac(payload));
  const supplied = Buffer.from(signature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return '';
  const email = normalizeEmail(Buffer.from(payload, 'base64url').toString('utf8'));
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

/** Whether a one-click link can be emitted at all (needs POSTLANE_PUBLIC_ORIGIN). */
export const unsubscribeLinkAvailable = () =>
  Boolean(String(accessGuard.publicOrigin || '').trim());

/** `https://host/u/<token>`, or '' when no public origin is configured. */
export function unsubscribeUrl(email) {
  const origin = String(accessGuard.publicOrigin || '').trim();
  if (!origin) return '';
  return `${origin}/u/${unsubscribeToken(email)}`;
}

/**
 * Records the opt-out. Suppression is what stops future batches; the campaign rows are
 * updated too so a queued follow-up disappears instead of waiting for the next gate to
 * notice.
 */
export function applyUnsubscribe(email, now = new Date()) {
  const address = normalizeEmail(email);
  const at = now.toISOString();
  const existing = get('suppression', address);
  put('suppression', {
    id: address,
    email: address,
    reason: existing?.reason || '收件人通过退订链接退订',
    source: existing?.source || 'unsubscribe-link',
    createdAt: existing?.createdAt || at,
    at,
  });
  let campaigns = 0;
  for (const campaign of all('campaign')) {
    let changed = false;
    for (const recipient of campaign.recipients || []) {
      if (normalizeEmail(recipient.email) !== address) continue;
      if (!recipient.optedOutAt) {
        recipient.optedOutAt = at;
        recipient.followUpsStopped = '收件人已退订';
        changed = true;
      }
      if (recipient.nextFollowUpAt) {
        recipient.nextFollowUpAt = 0;
        changed = true;
      }
    }
    if (changed) {
      campaigns += 1;
      put('campaign', campaign);
    }
  }
  return { email: address, campaigns, already: Boolean(existing) };
}

const escape = (text) =>
  String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Confirmation page: a GET must not unsubscribe on its own (link scanners prefetch URLs). */
export function confirmPage(email, token) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>退订确认</title>
<style>body{margin:0;background:#f4f6f3;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#243a34}
main{max-width:520px;margin:12vh auto;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.8;font-size:15px;color:#3f534c;margin:0 0 20px}
button{background:#36725c;color:#fff;border:0;border-radius:9px;padding:13px 22px;font-size:15px;cursor:pointer}
small{display:block;margin-top:18px;color:#8a9b94;font-size:13px;line-height:1.7}</style></head>
<body><main><h1>确认退订</h1>
<p>退订后我们不会再向 <strong>${escape(email)}</strong> 发送任何邮件。</p>
<form method="post" action="/u/${escape(token)}"><button type="submit">确认退订</button></form>
<small>如果这是误操作，直接关掉这个页面即可，不会有任何变化。</small></main></body></html>`;
}

export function finishedPage(email, already) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>已退订</title>
<style>body{margin:0;background:#f4f6f3;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#243a34}
main{max-width:520px;margin:12vh auto;background:#fff;border-radius:14px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 12px}p{line-height:1.8;font-size:15px;color:#3f534c;margin:0}</style></head>
<body><main><h1>已退订</h1><p><strong>${escape(email)}</strong> 已加入退订名单，${
    already ? '此前就已经在名单里，' : ''
  }不会再收到任何邮件。</p></main></body></html>`;
}

export function notFoundPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>链接无效</title></head><body style="font-family:sans-serif;padding:48px;color:#243a34">
<h1 style="font-size:20px">链接无效</h1><p>这个退订链接不完整或已损坏。直接回复原邮件「退订」同样有效。</p></body></html>`;
}
