import { assertActivityAllowed } from './runtime-policy.js';
import transactional from '@mailchimp/mailchimp_transactional';

export function mailchimpClient(key) {
  assertActivityAllowed();
  const client = transactional(key);
  client.requestConfig.timeout = 30000;
  client.requestConfig.maxRedirects = 0;
  return client;
}

// The official SDK resolves HTTP/network errors instead of throwing them.
// Never forward its error object: it contains the API key in request data.
export async function mailchimpCall(call) {
  assertActivityAllowed();
  let result;
  try {
    result = await call();
  } catch (error) {
    result = error;
  }
  if (result instanceof Error || result?.isAxiosError || result?.status === 'error') {
    const http = result.response?.status;
    const uncertain = !http || http >= 500 || http === 408;
    throw Object.assign(
      new Error(
        uncertain
          ? 'Mailchimp 连接中断或服务异常，请到 Mailchimp 核对发送记录'
          : http === 401
            ? 'Mailchimp API Key 无效，请使用 Transactional API Key'
            : http === 402
              ? 'Mailchimp 额度或套餐不足，请检查账户'
              : `Mailchimp 请求被拒绝（HTTP ${http}），请检查账号和域名配置`,
      ),
      { code: uncertain ? 'EDELIVERYUNKNOWN' : 'EMAILCHIMP' },
    );
  }
  return result;
}

export async function verifyMailchimp(client, from) {
  const result = await mailchimpCall(() => client.senders.domains());
  if (!Array.isArray(result)) throw new Error('Mailchimp 返回了无效的域名信息');
  const domain = from.split('@')[1].toLowerCase();
  const entry = result.find((item) => item.domain?.toLowerCase() === domain);
  if (!entry?.verified_at || !entry.valid_signing || !entry.dmarc?.valid)
    throw new Error('请在 Mailchimp 完成此发件域名的验证、DKIM 和 DMARC 认证');
}

export async function sendMailchimp(client, s, recipient, subject, body) {
  const result = await mailchimpCall(() =>
    client.messages.send({
      async: false,
      message: {
        from_email: s.from,
        from_name: s.name,
        to: [{ email: recipient, type: 'to' }],
        subject,
        text: body,
        auto_html: false,
        auto_text: false,
        merge: false,
        track_opens: false,
        track_clicks: false,
      },
    }),
  );
  const row = Array.isArray(result) && result.length === 1 ? result[0] : null;
  if (!row || row.email?.toLowerCase() !== recipient.toLowerCase())
    throw Object.assign(new Error('Mailchimp 返回结果不完整，请核对发送记录'), {
      code: 'EDELIVERYUNKNOWN',
    });
  if (['rejected', 'invalid'].includes(row.status)) {
    // Limit remote text to documented reason tokens, never raw response data.
    const reasons = [
      'hard-bounce',
      'soft-bounce',
      'spam',
      'unsub',
      'custom',
      'invalid-sender',
      'invalid',
      'test-mode-limit',
      'unsigned',
      'rule',
    ];
    const reason = reasons.includes(row.reject_reason) ? row.reject_reason : row.status;
    throw new Error(`Mailchimp 拒绝发送：${reason}`);
  }
  if (!['sent', 'queued', 'scheduled'].includes(row.status) || !row._id)
    throw Object.assign(new Error('Mailchimp 状态无法确认，请核对发送记录'), {
      code: 'EDELIVERYUNKNOWN',
    });
  return { accepted: [recipient], messageId: row._id, providerStatus: row.status };
}
