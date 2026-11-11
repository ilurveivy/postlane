// Sender-domain preflight: does the domain this account sends from actually authorise
// mail? SPF, DMARC and a DKIM key are what separate "lands in the inbox" from "lands in
// spam", and all three are visible in DNS, so there is nothing to guess.
//
// The checker never throws and never blocks: a DNS outage degrades to "unknown" with no
// warnings. Every lookup runs in parallel under a hard budget, because a verify button
// that takes half a minute is indistinguishable from a broken one.
import { Resolver } from 'node:dns/promises';

// Common DKIM selectors. A provider using a custom selector will not show up here, so a
// missing key is reported as "check with your provider", never as a hard failure.
const SELECTORS = [
  'default',
  'google',
  'selector1',
  'selector2',
  's1',
  'k1',
  'mail',
  'dkim',
  'postlane',
];
const CACHE_MS = 10 * 60000;
const BUDGET_MS = 2500;
const cache = new Map();

export function senderDomain(from) {
  const value = String(from ?? '').trim();
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(at + 1).toLowerCase() : '';
}

// A pending timer would keep the server process alive after shutdown, so always clear it.
async function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function txtRecords(resolver, name, ms) {
  try {
    const records = await withTimeout(resolver.resolveTxt(name), ms, []);
    return (records || []).map((chunks) => chunks.join('')).filter(Boolean);
  } catch {
    return [];
  }
}

export async function checkSenderDomain(
  from,
  { resolver = new Resolver({ timeout: 1500, tries: 1 }), timeoutMs = BUDGET_MS } = {},
) {
  const domain = senderDomain(from);
  if (!domain)
    return { domain: '', spf: false, dmarc: false, dkim: [], warnings: [], checkedAt: null };
  const cached = cache.get(domain);
  if (cached && cached.until > Date.now()) return cached.result;

  const names = [domain, `_dmarc.${domain}`, ...SELECTORS.map((s) => `${s}._domainkey.${domain}`)];
  const [domainRecords, dmarcRecords, ...selectorRecords] = await Promise.all(
    names.map((name) => txtRecords(resolver, name, timeoutMs)),
  );

  const spf = domainRecords.find((r) => /^v=spf1\b/i.test(r)) || '';
  const dmarc = dmarcRecords.find((r) => /^v=DMARC1\b/i.test(r)) || '';
  const policy = (
    /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i.exec(dmarc)?.[1] || ''
  ).toLowerCase();
  const dkim = SELECTORS.filter((_, i) =>
    selectorRecords[i].some((r) => /v=DKIM1|k=rsa|p=/i.test(r)),
  );

  const warnings = [];
  if (!spf) warnings.push(`${domain} 没有 SPF 记录，从这台服务器发出的邮件很容易被判为垃圾邮件`);
  if (!dmarc) warnings.push(`${domain} 没有 DMARC 记录，收件方无法确认你授权了哪些发信来源`);
  else if (policy === 'none')
    warnings.push(`${domain} 的 DMARC 策略是 p=none，只观察不拦截；建议改成 quarantine 或 reject`);
  if (!dkim.length)
    warnings.push(
      `${domain} 未发现常见选择器的 DKIM 公钥；如果服务商使用自定义选择器，这条可以忽略`,
    );

  const result = {
    domain,
    spf: Boolean(spf),
    dmarc: Boolean(dmarc),
    dmarcPolicy: policy,
    dkim,
    warnings,
    checkedAt: new Date().toISOString(),
  };
  cache.set(domain, { result, until: Date.now() + CACHE_MS });
  return result;
}

export function clearSenderDomainCache() {
  cache.clear();
}
