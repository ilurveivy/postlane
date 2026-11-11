import test from 'node:test';
import assert from 'node:assert/strict';
import { mailchimpClient, sendMailchimp, verifyMailchimp } from '../server/mailchimp.js';

const account = { from: 'sender@example.com', name: '发件人' };
// Exercise the actual SDK's serialization and its unusual resolved-error behavior.
function fakeClient(reply) {
  const client = mailchimpClient('test-api-key');
  client.requestConfig.adapter = async (config) => {
    assert.equal(config.timeout, 30000);
    assert.equal(config.maxRedirects, 0);
    const data = await reply(JSON.parse(config.data), config.url);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  return client;
}
test('Mailchimp SDK：单独信封、标题正文原样、关闭合并与追踪', async () => {
  const subject = '  测试 {{保持原样}}  ',
    body = '第一行\r\n\r\n末行 *|NAME|*  ';
  const client = fakeClient((request, url) => {
    assert.match(url, /\/messages\/send$/);
    assert.equal(request.key, 'test-api-key');
    assert.deepEqual(request.message.to, [{ email: 'target@example.com', type: 'to' }]);
    assert.equal(request.message.subject, subject);
    assert.equal(request.message.text, body);
    assert.equal(request.message.from_email, account.from);
    for (const field of ['merge', 'auto_html', 'auto_text', 'track_opens', 'track_clicks'])
      assert.equal(request.message[field], false);
    assert.equal(request.message.html, undefined);
    return [{ email: 'target@example.com', status: 'sent', _id: 'message-123' }];
  });
  assert.deepEqual(await sendMailchimp(client, account, 'target@example.com', subject, body), {
    accepted: ['target@example.com'],
    messageId: 'message-123',
    providerStatus: 'sent',
  });
});
test('Mailchimp SDK：queued/scheduled 保留原始状态；拒绝和未知结果不算成功', async () => {
  for (const status of ['queued', 'scheduled']) {
    const result = await sendMailchimp(
      fakeClient(() => [{ email: 'target@example.com', status, _id: 'id' }]),
      account,
      'target@example.com',
      '标题',
      '正文',
    );
    assert.equal(result.providerStatus, status);
  }
  for (const status of ['rejected', 'invalid']) {
    await assert.rejects(
      sendMailchimp(
        fakeClient(() => [{ email: 'target@example.com', status, reject_reason: 'unsub' }]),
        account,
        'target@example.com',
        '标题',
        '正文',
      ),
      /拒绝发送：unsub/,
    );
  }
  for (const reply of [
    [],
    {},
    [{ email: 'wrong@example.com', status: 'sent', _id: 'id' }],
    [{ email: 'target@example.com', status: 'sent' }],
  ])
    await assert.rejects(
      sendMailchimp(
        fakeClient(() => reply),
        account,
        'target@example.com',
        '标题',
        '正文',
      ),
      { code: 'EDELIVERYUNKNOWN' },
    );
});
test('Mailchimp SDK：HTTP 错误和超时不泄漏 API Key，提交不确定禁止自动重试', async () => {
  for (const http of [undefined, 401, 402, 429, 500]) {
    const client = fakeClient(() => {
      throw Object.assign(new Error('test-api-key secret response'), {
        isAxiosError: true,
        response: http ? { status: http, data: { message: 'test-api-key' } } : undefined,
      });
    });
    await assert.rejects(
      sendMailchimp(client, account, 'target@example.com', '标题', '正文'),
      (error) => {
        assert(!JSON.stringify(error).includes('test-api-key'));
        assert(!error.message.includes('test-api-key'));
        assert.equal(error.code, !http || http >= 500 ? 'EDELIVERYUNKNOWN' : 'EMAILCHIMP');
        return true;
      },
    );
  }
});
test('Mailchimp SDK：验证凭证与发件域名，无发送请求', async () => {
  const domain = {
    domain: 'example.com',
    verified_at: '2026-09-14',
    valid_signing: true,
    dmarc: { valid: true },
  };
  await verifyMailchimp(
    fakeClient((request, url) => {
      assert.match(url, /\/senders\/domains$/);
      return [domain];
    }),
    account.from,
  );
  for (const entry of [
    { ...domain, verified_at: null },
    { ...domain, valid_signing: false },
    { ...domain, dmarc: { valid: false } },
    { ...domain, domain: 'other.com' },
  ])
    await assert.rejects(
      verifyMailchimp(
        fakeClient(() => [entry]),
        account.from,
      ),
      /域名/,
    );
});
