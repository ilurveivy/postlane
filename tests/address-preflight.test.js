import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDomain, preflightAddresses, applyPreflight } from '../server/address-preflight.js';
const error = (code) => Object.assign(new Error(code), { code });
const resolver = (mx, a = [], aaaa = []) =>
  Object.fromEntries(
    [
      ['resolveMx', mx],
      ['resolve4', a],
      ['resolve6', aaaa],
    ].map(([k, v]) => [
      k,
      async () => {
        if (v instanceof Error) throw v;
        return v;
      },
    ]),
  );
test('DNS: MX, Null MX, nonexistent domain and implicit fallback are distinct', async () => {
  assert.equal(
    (await inspectDomain('x', resolver([{ exchange: 'mail.x', priority: 10 }]))).status,
    'clear',
  );
  assert.equal(
    (await inspectDomain('x', resolver([{ exchange: '', priority: 0 }]))).status,
    'invalid',
  );
  assert.equal((await inspectDomain('x', resolver(error('ENOTFOUND')))).status, 'invalid');
  assert.equal(
    (await inspectDomain('x', resolver(error('ENODATA'), ['1.2.3.4']))).status,
    'warning',
  );
  assert.equal(
    (await inspectDomain('x', resolver(error('ENODATA'), error('ENODATA'), error('ENODATA'))))
      .status,
    'invalid',
  );
  assert.equal((await inspectDomain('x', resolver(error('ETIMEOUT')))).status, 'warning');
  assert.equal((await inspectDomain('x', resolver([], error('ESERVFAIL'), []))).status, 'warning');
});
test('history block, typo risk, dedup and original content retention', async () => {
  const results = await preflightAddresses([' A@gmail.com ', 'a@gmail.com', 'b@gmial.com', 'bad'], {
    resolverFactory: () => resolver([{ exchange: 'mail.x', priority: 10 }]),
    lookupSuppression: (email) => (email === 'a@gmail.com' ? { reason: '退订' } : null),
  });
  assert.deepEqual(
    results.map((r) => r.status),
    ['invalid', 'warning', 'invalid'],
  );
  const list = {
    contacts: [{ email: 'a@gmail.com', fields: { body: ' original\n' } }, { email: 'b@gmial.com' }],
    issues: [],
  };
  applyPreflight(list, results);
  assert.equal(list.contacts.length, 1);
  assert.equal(list.preflight.excluded[0].fields.body, ' original\n');
  assert.equal(list.contacts[0].email, 'b@gmial.com');
});
test('bounded deadline does not classify unqueried domains as invalid', async () => {
  const result = await preflightAddresses(['a@foo.com'], { budgetMs: 0 });
  assert.equal(result[0].status, 'warning');
});
