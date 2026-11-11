import test from 'node:test';
import assert from 'node:assert/strict';
import { completeReplyText } from '../server/reply-ai.js';
const config = {
  baseUrl: 'http://gateway.invalid/v1/',
  model: 'deepseek-v4-flash',
  apiKey: 'test-only',
};
test('reply model sends configured model and refuses redirects', async () => {
  const result = await completeReplyText([{ role: 'user', content: 'test' }], {
    config,
    fetchImpl: async (url, req) => {
      assert.equal(url, 'http://gateway.invalid/v1/chat/completions');
      assert.equal(req.redirect, 'error');
      assert.equal(JSON.parse(req.body).model, config.model);
      assert.equal(JSON.parse(req.body).thinking.type, 'disabled');
      assert.equal(new Headers(req.headers).get('authorization'), 'Bearer test-only');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] });
    },
  });
  assert.equal(result.text, 'OK');
});
test('reply model rejects truncated/empty responses and hides upstream error bodies', async () => {
  for (const choice of [
    { finish_reason: 'length', message: { content: 'partial' } },
    { finish_reason: 'stop', message: { content: '' } },
  ]) {
    await assert.rejects(
      completeReplyText([{ role: 'user', content: 'test' }], {
        config,
        fetchImpl: async () => Response.json({ choices: [choice] }),
      }),
    );
  }
  await assert.rejects(
    completeReplyText([{ role: 'user', content: 'test' }], {
      config,
      fetchImpl: async () =>
        Response.json({ error: { message: 'private upstream text' } }, { status: 500 }),
    }),
    /HTTP 500/,
  );
});
