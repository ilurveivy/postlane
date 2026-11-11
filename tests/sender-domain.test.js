import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSenderDomain,
  clearSenderDomainCache,
  senderDomain,
} from '../server/sender-domain.js';

// A resolver double: records every name it was asked for and answers from a table, so the
// preflight can be tested without touching the network.
function fakeResolver(records) {
  const asked = [];
  return {
    asked,
    resolveTxt: async (name) => {
      asked.push(name);
      const value = records[name];
      if (!value) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      // Real DNS splits long strings into chunks; join them back in the module under test.
      return [value.match(/.{1,60}/g) || [value]];
    },
  };
}

test('发件域名：从地址里取域名', () => {
  assert.equal(senderDomain('sender@acme.dev'), 'acme.dev');
  assert.equal(senderDomain(' Sender@ACME.DEV '), 'acme.dev');
  assert.equal(senderDomain('no-at-sign'), '');
  assert.equal(senderDomain(''), '');
  assert.equal(senderDomain(null), '');
});

test('发件域名：识别 SPF、DMARC 策略与常见 DKIM 选择器', async () => {
  clearSenderDomainCache();
  const resolver = fakeResolver({
    'acme.dev': 'v=spf1 include:_spf.google.com ~all',
    '_dmarc.acme.dev': 'v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.dev',
    'google._domainkey.acme.dev': 'v=DKIM1; k=rsa; p=MIGfMA0GCSq',
  });
  const check = await checkSenderDomain('sender@acme.dev', { resolver });
  assert.equal(check.domain, 'acme.dev');
  assert.equal(check.spf, true);
  assert.equal(check.dmarc, true);
  assert.equal(check.dmarcPolicy, 'quarantine');
  assert.deepEqual(check.dkim, ['google']);
  assert.deepEqual(check.warnings, []);
  assert.ok(check.checkedAt);
  // Every selector is probed, and the queries run in one batch rather than one by one.
  assert.ok(resolver.asked.includes('default._domainkey.acme.dev'));
  assert.ok(resolver.asked.includes('selector1._domainkey.acme.dev'));
});

test('发件域名：缺失记录只给建议，绝不抛错', async () => {
  clearSenderDomainCache();
  const resolver = {
    resolveTxt: async () => {
      throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' });
    },
  };
  const check = await checkSenderDomain('sender@acme.dev', { resolver });
  assert.equal(check.spf, false);
  assert.equal(check.dmarc, false);
  assert.deepEqual(check.dkim, []);
  assert.equal(check.warnings.length, 3);
  assert.match(check.warnings[0], /SPF/);
  assert.match(check.warnings[1], /DMARC/);
  assert.match(check.warnings[2], /DKIM/);
});

test('发件域名：p=none 允许发送但明确提示', async () => {
  clearSenderDomainCache();
  const resolver = fakeResolver({
    'acme.dev': 'v=spf1 -all',
    '_dmarc.acme.dev': 'v=DMARC1; p=none',
    'k1._domainkey.acme.dev': 'v=DKIM1; k=ed25519; p=abc',
  });
  const check = await checkSenderDomain('sender@acme.dev', { resolver });
  assert.equal(check.dmarcPolicy, 'none');
  assert.equal(check.warnings.length, 1);
  assert.match(check.warnings[0], /p=none/);
});

test('发件域名：同一域名短期内只查一次', async () => {
  clearSenderDomainCache();
  const resolver = fakeResolver({ 'acme.dev': 'v=spf1 ~all' });
  await checkSenderDomain('a@acme.dev', { resolver });
  const asked = resolver.asked.length;
  await checkSenderDomain('b@acme.dev', { resolver });
  assert.equal(resolver.asked.length, asked, '第二次应命中缓存');
  clearSenderDomainCache();
  await checkSenderDomain('c@acme.dev', { resolver });
  assert.ok(resolver.asked.length > asked, '清缓存后重新查询');
});

test('发件域名：没有域名时不做任何查询', async () => {
  clearSenderDomainCache();
  const resolver = fakeResolver({});
  const check = await checkSenderDomain('', { resolver });
  assert.deepEqual(check, {
    domain: '',
    spf: false,
    dmarc: false,
    dkim: [],
    warnings: [],
    checkedAt: null,
  });
  assert.equal(resolver.asked.length, 0);
});
