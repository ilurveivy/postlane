import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The public origin must be set before anything imports the access guard, because that is
// where it is validated (https only, no path, no credentials).
process.env.POSTLANE_PUBLIC_ORIGIN = 'https://mail.example.com';
process.env.POSTLANE_MODE = 'live';
process.env.DISABLE_BACKUP = 'true';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-unsub-url-'));

const { emailFromToken, unsubscribeLinkAvailable, unsubscribeUrl } =
  await import('../server/unsubscribe.js');

test('配了公开域名之后，退订链接是完整可点的 HTTPS 地址', () => {
  assert.equal(unsubscribeLinkAvailable(), true);
  const url = unsubscribeUrl('Lead@Prospect.dev');
  assert.match(url, /^https:\/\/mail\.example\.com\/u\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  // 链接里的令牌必须能还原出同一个地址（否则点了也退不了）。
  assert.equal(emailFromToken(url.split('/u/')[1]), 'lead@prospect.dev');
});
