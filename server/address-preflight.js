import { Resolver } from 'node:dns/promises';
import { addressRule } from './address-rules.js';
import { emailValid } from './domain.js';

const cache = new Map();
const uncertain = (reason) => ({ status: 'warning', reason });
const missing = (e) => e?.code === 'ENOTFOUND';
const absent = (e) => e?.code === 'ENODATA';
// MX absence alone is not invalid: SMTP permits implicit A/AAAA routing.
export async function inspectDomain(domain, resolver) {
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length && mx.every((r) => r.priority === 0 && (!r.exchange || r.exchange === '.')))
      return { status: 'invalid', reason: '域名明确声明不接收邮件（Null MX）' };
    if (mx.some((r) => r.exchange && r.exchange !== '.'))
      return { status: 'clear', reason: '域名有邮件路由；未验证具体邮箱或投递能力' };
  } catch (e) {
    if (missing(e)) return { status: 'invalid', reason: '域名不存在（DNS NXDOMAIN）' };
    if (!absent(e)) return uncertain('域名查询失败或超时，未确认有效性');
  }
  const results = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
  if (results.some((r) => r.status === 'fulfilled' && r.value.length))
    return uncertain('无 MX，存在备用地址路由；无法确认邮件接收能力');
  if (results.every((r) => r.status === 'fulfilled' || missing(r.reason) || absent(r.reason)))
    return { status: 'invalid', reason: '域名没有 MX 或备用 A/AAAA 邮件路由' };
  return uncertain('备用邮件路由查询失败或超时，未确认有效性');
}

export async function preflightAddresses(
  emails,
  { resolverFactory, lookupSuppression = () => null, budgetMs = 8000, domainRules = true } = {},
) {
  const unique = [
    ...new Set(
      emails.map((v) =>
        String(v || '')
          .trim()
          .toLowerCase(),
      ),
    ),
  ];
  const domains = [...new Set(unique.filter(emailValid).map((e) => e.split('@')[1]))];
  const checks = new Map();
  const deadline = Date.now() + budgetMs;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, domains.length) }, async () => {
      while (cursor < domains.length) {
        const domain = domains[cursor++];
        const cached = !resolverFactory && cache.get(domain);
        if (cached && cached.until > Date.now()) {
          checks.set(domain, cached.result);
          continue;
        }
        if (Date.now() >= deadline || process.env.PREFLIGHT_DNS === 'disabled') {
          checks.set(domain, uncertain('本次未完成域名查询，需人工核查'));
          continue;
        }
        const resolver = resolverFactory
          ? resolverFactory()
          : new Resolver({ timeout: 1200, tries: 1 });
        let timer;
        const result = await Promise.race([
          inspectDomain(domain, resolver),
          new Promise((resolve) => {
            timer = setTimeout(
              () => {
                resolve(uncertain('域名查询超时，未确认有效性'));
                resolver.cancel?.();
              },
              Math.min(2500, Math.max(1, deadline - Date.now())),
            );
          }),
        ]).finally(() => clearTimeout(timer));
        checks.set(domain, result);
        if (!resolverFactory) {
          if (cache.size >= 2000) cache.delete(cache.keys().next().value);
          cache.set(domain, {
            result,
            until: Date.now() + (result.status === 'warning' ? 30000 : 300000),
          });
        }
      }
    }),
  );
  return unique.map((email) => {
    const blocked = lookupSuppression(email);
    // Imports stay lenient about domains (only the send review blocks them), so the
    // operator's own file is never silently rewritten at import time.
    const rule = addressRule(email, { checkDomain: domainRules });
    let result = !emailValid(email)
      ? { status: 'invalid', reason: '邮箱格式无效' }
      : rule?.status === 'invalid'
        ? rule
        : blocked
          ? { status: 'invalid', reason: blocked.reason }
          : checks.get(email.split('@')[1]);
    // A role mailbox is a warning, not a block: info@ is a real target for small teams.
    if (rule?.status === 'warning' && result?.status !== 'invalid') result = rule;
    const typo = {
      'gmial.com': 'gmail.com',
      'gamil.com': 'gmail.com',
      'gmai.com': 'gmail.com',
      'outlok.com': 'outlook.com',
      'hotmial.com': 'hotmail.com',
    }[email.split('@')[1]];
    if (typo && result.status !== 'invalid')
      result = uncertain(`域名疑似拼写错误，请核对是否为 ${typo}；未自动修改`);
    return { email, ...result };
  });
}

export function applyPreflight(list, results = []) {
  const byEmail = new Map(results.map((r) => [r.email, r]));
  list.preflight = { checkedAt: new Date().toISOString(), results, excluded: [] };
  list.contacts = list.contacts.filter((contact) => {
    const result = byEmail.get(contact.email);
    if (result?.status !== 'invalid') return true;
    list.preflight.excluded.push(contact); // Preserve original fields, including subject and body.
    list.issues.push({ email: contact.email, reason: result.reason });
    return false;
  });
  return list;
}
