import { assertActivityAllowed } from './runtime-policy.js';
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';

// This module does not open the database or acquire the mail queue lock.
export function replyAiConfig() {
  const dir = path.resolve(process.env.DATA_DIR || 'data');
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'reply-ai.json'), 'utf8'));
  const b = Buffer.from(config.apiKeyEncrypted, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    fs.readFileSync(path.join(dir, 'secret.key')),
    b.subarray(0, 12),
  );
  decipher.setAuthTag(b.subarray(-16));
  const apiKey = Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]).toString(
    'utf8',
  );
  return { baseUrl: config.baseUrl, model: config.model, apiKey };
}

export async function completeReplyText(
  messages,
  { config, fetchImpl = fetch, maxTokens = 2048 } = {},
) {
  assertActivityAllowed();
  config ||= replyAiConfig();
  if (!Array.isArray(messages) || !messages.length) throw Error('模型输入不能为空');
  const client = new OpenAI({
    baseURL: config.baseUrl.replace(/\/$/, ''),
    apiKey: config.apiKey,
    timeout: 90000,
    maxRetries: 0,
    fetch: (url, init) => fetchImpl(url, { ...init, redirect: 'error' }),
  });
  let data;
  try {
    data = await client.chat.completions.create({
      model: config.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      ...(config.model.startsWith('deepseek-')
        ? { temperature: 1, thinking: { type: 'disabled' } }
        : {}),
    });
  } catch (error) {
    // SDK error bodies may contain prompts or credentials; expose only safe metadata.
    const safe = new Error(
      error.status ? `模型接口请求失败（HTTP ${error.status}）` : '模型接口连接失败或超时',
    );
    safe.status = error.status;
    safe.code = error.code === 'invalid_api_key' ? 'invalid_api_key' : undefined;
    throw safe;
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw Error('模型未正常完成回复，请重新生成并审核');
  const text = choice.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw Error('模型未返回有效文本');
  return { text, model: data.model || config.model, usage: data.usage };
}
