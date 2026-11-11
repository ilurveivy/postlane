import { randomUUID } from 'node:crypto';
import { emailValid } from './domain.js';
import { gmailAccount } from './followup-domain.js';

// Pure draft operations: persistence and conversation context are injected.
export function createReplyDrafts({
  get,
  put,
  remove,
  settings,
  threadById,
  contextVersion,
  now = () => new Date().toISOString(),
}) {
  function saveDraft(input) {
    const old = input.id ? get('reply-draft', input.id) : null;
    if (input.id && !old) throw Error('草稿不存在');
    if (old && old.version !== input.version) throw Error('草稿已在其他窗口更新，请重新打开');
    if (old && !['draft', 'failed'].includes(old.status))
      throw Error('已提交或状态待确认的邮件不能编辑');
    if (old && old.threadId !== (input.threadId || null)) throw Error('不能更改已有草稿的会话');
    const t = input.threadId ? threadById(input.threadId) : null;
    const accountId = input.accountId || t?.accountId,
      a = settings(accountId);
    if (!a || !gmailAccount(a) || !a.password) throw Error('请选择已配置的Gmail账号');
    if (a.disabled) throw Error('发件账号已停用');
    const parent =
      t?.messages.find((m) => m.id === input.replyMessageId) ||
      t?.messages.filter((m) => !m.outgoing).at(-1) ||
      t?.messages.at(-1);
    const to = parent
      ? (parent.outgoing ? parent.to : parent.replyTo?.length ? parent.replyTo : parent.from)[0]
      : input.to;
    if (parent && !emailValid(to || '')) throw Error('原邮件的回复地址无效');
    if (String(to || '').length > 320) throw Error('收件地址过长');
    if (input.body?.length > 100000 || input.subject?.length > 500) throw Error('邮件内容过长');
    const subject = parent
      ? /^(re:)\s*/i.test(parent.subject)
        ? parent.subject
        : 'Re: ' + parent.subject
      : String(input.subject || '');
    const references = parent
      ? [...new Set([...(parent.references || []), parent.messageId].filter(Boolean))]
      : [];
    return put('reply-draft', {
      id: old?.id || randomUUID(),
      accountId,
      accountEmail: a.from,
      to: String(to || ''),
      subject,
      body: String(input.body || ''),
      threadId: t?.id || null,
      replyMessageId: parent?.id || null,
      sourceAccountId: parent?.accountId || null,
      inReplyTo: parent?.messageId || '',
      references,
      referenceLinks: (t?.messages || [])
        .filter((m) => references.includes(m.messageId))
        .map((m) => ({ accountId: m.accountId, messageId: m.messageId })),
      contextVersion: input.contextVersion || old?.contextVersion || (t ? contextVersion(t) : ''),
      status: 'draft',
      version: (old?.version || 0) + 1,
      createdAt: old?.createdAt || now(),
      updatedAt: now(),
    });
  }
  function queueDraft(id, { version, confirm } = {}) {
    const d = get('reply-draft', id);
    if (!d) throw Error('草稿不存在');
    if (['queued', 'sending', 'sent'].includes(d.status)) return d;
    if (['uncertain', 'needs_review'].includes(d.status))
      throw Error('发送结果待确认，请先核对原邮箱，不能直接重发');
    if (settings(d.accountId)?.disabled) throw Error('发件账号已停用');
    if (confirm !== true || d.version !== version) throw Error('请核对最新草稿后确认发送');
    if (!emailValid(d.to)) throw Error('请填写有效的收件邮箱');
    if (!d.subject.trim() || !d.body.trim()) throw Error('标题和正文不能为空');
    if (d.threadId && contextVersion(threadById(d.threadId)) !== d.contextVersion)
      throw Error('会话有新来信，请重新打开并核对后再发送');
    if (get('suppression', d.to.toLowerCase()))
      throw Error('收件地址已停止发送，请先核查退信或退订记录');
    return put('reply-draft', {
      ...d,
      status: 'queued',
      messageId: `<${randomUUID()}@postlane.local>`,
      updatedAt: now(),
    });
  }
  function deleteDraft(id) {
    const d = get('reply-draft', id);
    if (!d || !['draft', 'failed'].includes(d.status))
      throw Error('只能删除未发送草稿或明确失败的邮件');
    remove('reply-draft', id);
    return { ok: true };
  }
  function replyPreset() {
    return { rules: get('reply-preset', 'default')?.rules || '' };
  }
  function saveReplyPreset(rules) {
    put('reply-preset', { id: 'default', rules, updatedAt: now() });
    return replyPreset();
  }

  return { saveDraft, queueDraft, deleteDraft, replyPreset, saveReplyPreset };
}
