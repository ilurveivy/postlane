import test from 'node:test';
import assert from 'node:assert/strict';
import { macHttpProxy, smtpProxy } from '../server/network.js';
test('使用现有 macOS HTTP CONNECT 配置，禁用或非法配置不生效', () => {
  assert.equal(
    macHttpProxy('  HTTPSEnable : 1\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 8118'),
    'http://127.0.0.1:8118',
  );
  assert.equal(
    macHttpProxy('  HTTPSEnable : 0\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 8118'),
    undefined,
  );
  assert.equal(
    macHttpProxy('  HTTPEnable : 1\n  HTTPProxy : 127.0.0.1\n  HTTPPort : 99999'),
    undefined,
  );
  assert.equal(smtpProxy('localhost'), undefined);
});

test('局域网入口只接受私网地址，拒绝公网和非法地址', async () => {
  const { privateAddress, allowedHosts } = await import('../server/access.js');
  for (const ip of [
    '10.23.181.239',
    '192.168.1.2',
    '172.16.0.1',
    '172.31.255.254',
    '::ffff:10.1.2.3',
    '127.0.0.1',
  ])
    assert.equal(privateAddress(ip), true);
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.168.1.999', 'evil.test'])
    assert.equal(privateAddress(ip), false);
  assert.deepEqual(allowedHosts(false), ['localhost', '127.0.0.1', '[::1]']);
});
