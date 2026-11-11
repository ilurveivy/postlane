import { assertActivityAllowed } from './runtime-policy.js';
import { returnToPool } from './return-to-pool.js';
import MarketingClient from '@mailchimp/mailchimp_marketing/src/ApiClient.js';
import { createHash } from 'node:crypto';
import { render } from './domain.js';

// The public SDK export is a singleton. Separate clients keep account keys isolated.
export function marketingClient(key, server) {
  assertActivityAllowed();
  if (!/^us\d{1,4}$/.test(server || '')) throw new Error('Mailchimp 服务器前缀应为 us 开头的编号');
  const client = new MarketingClient();
  client.setConfig({ apiKey: key, server });
  client.timeout = 30000;
  return client;
}
export async function marketingCall(fn) {
  assertActivityAllowed();
  try {
    return await fn();
  } catch (e) {
    const status = e.status || e.response?.status;
    const unknown = !status || status >= 500 || status === 408;
    // SDK errors contain the Authorization header. Return only a local message/code.
    throw Object.assign(
      new Error(
        unknown
          ? 'Mailchimp 请求结果不确定，请同步活动状态或到 Mailchimp 后台核对'
          : status === 401
            ? 'Marketing API Key 或服务器前缀无效'
            : status === 404
              ? 'Mailchimp 受众、联系人或活动不存在'
              : status === 429
                ? 'Mailchimp 请求过于频繁，请稍后再试'
                : `Mailchimp 请求被拒绝（HTTP ${status}），请检查套餐、发件身份和活动设置`,
      ),
      { code: unknown ? 'EDELIVERYUNKNOWN' : 'EMARKETING', status },
    );
  }
}
export async function marketingAudiences(client) {
  let lists = [],
    offset = 0;
  for (;;) {
    const page = await marketingCall(() => client.lists.getAllLists({ count: 100, offset }));
    if (!Array.isArray(page.lists)) throw new Error('Mailchimp 受众列表格式无效');
    lists.push(
      ...page.lists.map((l) => ({ id: l.id, name: l.name, count: l.stats?.member_count || 0 })),
    );
    offset += page.lists.length;
    if (offset >= page.total_items || !page.lists.length) return lists;
  }
}
export function marketingGroups(c) {
  const groups = new Map();
  for (const row of c.recipients) {
    const subject = render(c.subject, row.fields),
      body = render(c.body, row.fields);
    // Mailchimp expands its own merge tags. Do not silently change literal source text.
    if (/\*\|[^\r\n]*?\|\*/.test(subject + '\n' + body))
      throw new Error('原文包含 Mailchimp 合并标签，请先确认其替换含义后再使用此渠道');
    const key = JSON.stringify([subject, body]);
    if (!groups.has(key)) groups.set(key, { subject, body, rowIds: [], status: 'pending' });
    groups.get(key).rowIds.push(row.id);
  }
  return [...groups.values()];
}
export async function subscribedMember(client, audience, email, importConsent) {
  const hash = createHash('md5').update(email.toLowerCase()).digest('hex');
  let member;
  try {
    member = await marketingCall(() => client.lists.getListMember(audience, hash));
  } catch (e) {
    if (e.status !== 404) throw e;
    if (!importConsent)
      return {
        eligible: false,
        reason: '不在所选 Audience 中；请先导入受众或选择同步已获许可的新联系人',
      };
    // status_if_new never changes the subscription status of existing members.
    member = await marketingCall(() =>
      client.lists.setListMember(audience, hash, {
        email_address: email,
        status_if_new: 'subscribed',
      }),
    );
  }
  return member.status === 'subscribed'
    ? { eligible: true }
    : { eligible: false, reason: 'Mailchimp 联系人未订阅、已退订或已清理，本次不发送' };
}
async function segmentEmails(client, audience, id) {
  let emails = [],
    offset = 0;
  for (;;) {
    const page = await marketingCall(() =>
      client.lists.getSegmentMembersList(audience, id, { count: 1000, offset }),
    );
    if (!Array.isArray(page.members)) throw new Error('Mailchimp 分组成员格式无效');
    emails.push(...page.members.map((m) => m.email_address.toLowerCase()));
    offset += page.members.length;
    if (offset >= page.total_items || !page.members.length) return emails.sort();
  }
}
export async function prepareMarketing(client, account, group, title, checkpoint, active) {
  const ensureActive = () => {
    if (!active()) throw Object.assign(new Error('任务已暂停或取消'), { code: 'EPAUSED' });
  };
  if (!group.segmentId) {
    ensureActive();
    const segment = await marketingCall(() =>
      client.lists.createSegment(account.audienceId, {
        name: title.slice(0, 100),
        static_segment: group.emails,
      }),
    );
    if (!Number.isInteger(segment.id)) throw new Error('Mailchimp 未返回分组 ID');
    group.segmentId = segment.id;
    checkpoint();
  }
  if (!group.remoteId) {
    ensureActive();
    group.status = 'creating';
    checkpoint();
    const remote = await marketingCall(() =>
      client.campaigns.create({
        type: 'plaintext',
        recipients: {
          list_id: account.audienceId,
          segment_opts: { saved_segment_id: group.segmentId },
        },
        settings: {
          title,
          subject_line: group.subject,
          from_name: account.name,
          reply_to: account.from,
        },
        tracking: { opens: false, html_clicks: false, text_clicks: false },
      }),
    );
    if (!remote.id)
      throw Object.assign(new Error('Mailchimp 未返回活动 ID，请到后台核对草稿'), {
        code: 'EDELIVERYUNKNOWN',
      });
    group.remoteId = remote.id;
    group.status = 'preparing';
    checkpoint();
  }
  ensureActive();
  await marketingCall(() =>
    client.campaigns.setContent(group.remoteId, { plain_text: group.body }),
  );
  const emails = await segmentEmails(client, account.audienceId, group.segmentId);
  if (
    JSON.stringify(emails) !== JSON.stringify([...group.emails].map((e) => e.toLowerCase()).sort())
  )
    throw new Error('Mailchimp 分组成员与本次任务不一致，已停止发送');
  const remote = await marketingCall(() => client.campaigns.get(group.remoteId));
  if (
    remote.status !== 'save' ||
    remote.recipients?.list_id !== account.audienceId ||
    remote.recipients?.segment_opts?.saved_segment_id !== group.segmentId ||
    remote.recipients?.recipient_count !== group.emails.length
  )
    throw new Error('Mailchimp 活动状态或收件范围发生变化，请到后台核对');
  const checklist = await marketingCall(() => client.campaigns.getSendChecklist(group.remoteId));
  if (checklist.is_ready !== true)
    throw new Error('Mailchimp 发送检查未通过，请到后台活动中查看并修复发件域名、页脚或受众设置');
  ensureActive();
}

// Each group is a genuine Marketing campaign. Save identifiers before submission.
export async function advanceMarketing(c, account, client, store) {
  const patches = new Map();
  const active = () => store.get().status === 'running';
  const mark = (ids, patch) =>
    ids.forEach((id) => patches.set(id, { ...patches.get(id), ...patch }));
  const checkpoint = () => {
    const latest = store.get();
    latest.marketing = c.marketing;
    latest.recipients = latest.recipients.map((r) => ({ ...r, ...patches.get(r.id) }));
    store.save(latest);
    patches.clear();
  };
  c.marketing ||= { groups: marketingGroups(c) };
  const group = c.marketing.groups.find((g) =>
    ['pending', 'preparing', 'creating', 'submitting'].includes(g.status),
  );
  if (!group) {
    const latest = store.get();
    if (latest.status === 'running') {
      latest.status = latest.recipients.some((r) => ['failed', 'uncertain'].includes(r.status))
        ? 'completed_errors'
        : 'completed';
      latest.completedAt = new Date().toISOString();
      store.save(latest);
    }
    return;
  }
  // These markers survive crashes; never re-create or re-send blindly.
  if (['creating', 'submitting'].includes(group.status)) {
    group.status = 'uncertain';
    group.error = '服务在 Mailchimp 提交期间中断，请同步活动状态或核对后台';
    mark(group.eligibleIds || group.rowIds, { status: 'uncertain', error: group.error });
    checkpoint();
    return;
  }
  const pendingIds = group.rowIds.filter(
    (id) => c.recipients.find((r) => r.id === id)?.status === 'pending',
  );
  if (!pendingIds.length) {
    group.status = 'cancelled';
    checkpoint();
    return;
  }
  if (group.emails && group.eligibleIds.some((id) => !pendingIds.includes(id))) {
    // A cancelled task may later retry only its failed rows. Never reuse its old audience slice.
    group.previousDraftId = group.remoteId;
    delete group.emails;
    delete group.eligibleIds;
    delete group.segmentId;
    delete group.remoteId;
  }
  group.rowIds = pendingIds;
  try {
    if (!group.emails) {
      const eligible = [];
      for (const id of group.rowIds) {
        if (!active()) return;
        const row = c.recipients.find((r) => r.id === id);
        const result = await subscribedMember(
          client,
          account.audienceId,
          row.email,
          c.marketingImportConsent === true,
        );
        if (result.eligible) eligible.push(row);
        else mark([id], { status: 'failed', error: result.reason });
        checkpoint();
      }
      group.emails = eligible.map((r) => r.email);
      group.eligibleIds = eligible.map((r) => r.id);
      checkpoint();
    }
    if (!group.emails.length) {
      group.status = 'excluded';
      checkpoint();
      return;
    }
    const title = `Postlane ${c.id.slice(0, 8)} · ${c.marketing.groups.indexOf(group) + 1} · ${c.name}`;
    await prepareMarketing(client, account, group, title, checkpoint, active);
    // JS cannot interleave a pause between this synchronous check/persist and send call.
    if (!active()) return;
    group.status = 'submitting';
    group.sendAttempted = true;
    mark(group.eligibleIds, { status: 'sending', error: '' });
    checkpoint();
    await marketingCall(() => client.campaigns.send(group.remoteId));
    group.status = 'submitted';
    group.remoteStatus = 'pending';
    group.error = '';
    mark(group.eligibleIds, {
      status: 'sent',
      error: '',
      providerStatus: 'marketing-submitted',
      messageId: group.remoteId,
      sentAt: new Date().toISOString(),
    });
    checkpoint();
  } catch (e) {
    if (e.code === 'EPAUSED') return;
    group.status = e.code === 'EDELIVERYUNKNOWN' ? 'uncertain' : 'failed';
    group.error = e.message;
    mark(group.eligibleIds || group.rowIds, {
      status: group.status,
      error: e.message,
      messageId: group.remoteId || '',
    });
    checkpoint();
    const latest = store.get();
    if (latest.status === 'running') {
      store.save(returnToPool(latest, e.message));
    }
  }
}
export async function syncMarketing(client, c) {
  for (const group of c.marketing?.groups || []) {
    if (!group.remoteId) continue;
    const remote = await marketingCall(() => client.campaigns.get(group.remoteId));
    group.remoteStatus = remote.status;
    if (['sending', 'sent'].includes(remote.status)) {
      group.status = 'submitted';
      group.error = '';
      for (const row of c.recipients)
        if (group.eligibleIds?.includes(row.id))
          Object.assign(row, {
            status: 'sent',
            error: '',
            messageId: group.remoteId,
            providerStatus: `marketing-${remote.status}`,
            sentAt: row.sentAt || new Date().toISOString(),
          });
    }
    if (remote.status === 'sent') {
      const report = await marketingCall(() => client.reports.getCampaignReport(group.remoteId));
      group.report = {
        emailsSent: report.emails_sent,
        hardBounces: report.bounces?.hard_bounces,
        softBounces: report.bounces?.soft_bounces,
        unsubscribed: report.unsubscribed,
      };
    }
  }
  if (
    c.status === 'completed_errors' &&
    c.recipients.every((r) => ['sent', 'cancelled'].includes(r.status))
  )
    c.status = 'completed';
  return c;
}
export async function marketingTest(client, account, to, subject, body) {
  const remote = await marketingCall(() =>
    client.campaigns.create({
      type: 'plaintext',
      recipients: { list_id: account.audienceId },
      settings: {
        title: 'Postlane 测试邮件',
        subject_line: subject,
        from_name: account.name,
        reply_to: account.from,
      },
    }),
  );
  if (!remote.id) throw new Error('Mailchimp 未返回测试活动 ID');
  await marketingCall(() => client.campaigns.setContent(remote.id, { plain_text: body }));
  await marketingCall(() =>
    client.campaigns.sendTestEmail(remote.id, { test_emails: [to], send_type: 'plaintext' }),
  );
  return { accepted: [to], messageId: remote.id };
}
