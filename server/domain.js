import { randomUUID, randomInt } from 'node:crypto';
import { addressRule } from './address-rules.js';
import { withChannelMetadata } from './channel-metadata.js';
export const emailValid = (value) =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value);
export const variables = (text) => [
  ...new Set([...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1])),
];
export function render(text, fields) {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key) =>
    Object.hasOwn(fields, key) ? String(fields[key] ?? '') : '',
  );
}
export function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
export function emailHtml(body, name) {
  return `<div style="background:#f4f6f3;padding:32px;font-family:Arial,sans-serif;color:#243a34"><div style="max-width:600px;margin:auto;background:#fff;border-radius:12px;padding:36px"><div style="font-size:14px;font-weight:bold;color:#36725c;border-bottom:1px solid #e5ebe7;padding-bottom:20px">${escapeHtml(name)}</div><div style="font-size:15px;line-height:1.9;white-space:pre-wrap;padding-top:20px">${escapeHtml(body)}</div></div></div>`;
}
export function normalizeList(name, rows, emailColumn, preserveFields = []) {
  const seen = new Set(),
    contacts = [],
    issues = [];
  rows.forEach((row, i) => {
    const email = String(row[emailColumn] ?? '')
      .trim()
      .toLowerCase();
    if (!emailValid(email)) {
      issues.push({ row: i + 2, email, reason: '邮箱格式无效' });
      return;
    }
    if (seen.has(email)) {
      issues.push({ row: i + 2, email, reason: '重复邮箱' });
      return;
    }
    // Placeholder and role mailboxes bounce or never read; filtering them at import keeps
    // them out of the sender's reputation, not just out of this one batch.
    const rule = addressRule(email, { checkDomain: false });
    if (rule?.status === 'invalid') {
      issues.push({ row: i + 2, email, reason: rule.reason });
      return;
    }
    seen.add(email);
    const fields = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        ['email_subject', 'email_content', ...preserveFields].includes(k)
          ? String(v ?? '')
          : String(v ?? '').trim(),
      ]),
    );
    contacts.push({ id: randomUUID(), email, fields: withChannelMetadata(fields) });
  });
  return {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    columns: Object.keys(rows[0] ?? {}),
    emailColumn,
    contacts,
    issues,
    sourceCount: rows.length,
  };
}
export function validateCampaign(c) {
  if (!c.subject?.trim() || !c.body?.trim()) throw new Error('请填写邮件主题和正文');
  if (!c.recipients?.length) throw new Error('请先选择收件人名单');
  const keys = variables(c.subject + '\n' + c.body);
  for (const recipient of c.recipients) {
    if (!emailValid(recipient.email)) throw new Error('收件人邮箱无效');
    const missing = keys.filter(
      (k) => !Object.hasOwn(recipient.fields, k) || !String(recipient.fields[k] ?? '').trim(),
    );
    if (missing.length) throw new Error(`${recipient.email} 缺少变量：${missing.join('、')}`);
  }
}
export function csv(rows) {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let s = String(value ?? '');
            if (/^[\s]*[=+@\-]/.test(s)) s = "'" + s;
            return '"' + s.replaceAll('"', '""') + '"';
          })
          .join(','),
      )
      .join('\r\n')
  );
}

export function sendDelay(c) {
  if (c.mode === 'simulation') return 250;
  return c.randomInterval !== false ? randomInt(30000, 120001) : 60000 / c.rate;
}
