import { applyPreflight } from './address-preflight.js';
import { taskMetadata } from './import-task-domain.js';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeList, validateCampaign } from './domain.js';
export function createImportBatch({
  all,
  get,
  put,
  transaction,
  eligibleAccounts,
  createBatch,
  attachImportTask,
}) {
  function importBatch(data, review = []) {
    taskMetadata(data);
    const { name, rows, emailColumn, subjectColumn, bodyColumn, requestId } = data;
    if (!name?.trim() || !Array.isArray(rows) || !rows.length || rows.length > 10000 || !requestId)
      throw Error('导入数据不完整');
    if (
      ![emailColumn, subjectColumn, bodyColumn].every(
        (k) => typeof k === 'string' && k && Object.hasOwn(rows[0], k),
      ) ||
      new Set([emailColumn, subjectColumn, bodyColumn]).size !== 3
    )
      throw Error('请选择不同的邮箱、标题、正文列');
    const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const existing = get('batch-import', requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Error('导入内容已变化，请重新选择文件');
      return existing.result;
    }
    const l = applyPreflight(
      normalizeList(name, rows, emailColumn, [subjectColumn, bodyColumn]),
      review,
    );
    l.contacts = l.contacts.filter((r) => {
      const blocked = get('suppression', r.email);
      if (!blocked) return true;
      l.issues.push({ email: r.email, reason: blocked.reason });
      return false;
    });
    if (!l.contacts.length) throw Error('没有可用收件人');
    if (
      l.contacts.some(
        (r) =>
          typeof r.fields[subjectColumn] !== 'string' ||
          !r.fields[subjectColumn].trim() ||
          typeof r.fields[bodyColumn] !== 'string' ||
          !r.fields[bodyColumn].trim(),
      )
    )
      throw Error('有收件人的标题或正文为空，请先补齐；未创建任何发送任务');
    const eligible = eligibleAccounts();
    const selected = data.accountIds || eligible.map((a) => a.id);
    if (
      !Array.isArray(selected) ||
      new Set(selected).size !== selected.length ||
      selected.some((id) => !eligible.some((a) => a.id === id))
    )
      throw Error('请选择已验证的SMTP账号');
    const count = Math.ceil(l.contacts.length / 10);
    if (selected.length < count)
      throw Error(
        `共${l.contacts.length}条，需要${count}个账号，目前选择${selected.length}个。每账号最多10条，不自动重复分配。`,
      );
    return transaction(() => {
      Object.assign(l, attachImportTask(l, data));
      put('list', l);
      const ids = [];
      for (let i = 0; i < count; i++) {
        const a = get('account', selected[i]);
        const list = put('list', {
          ...l,
          preflight: undefined, // The source list owns the full review; do not duplicate it per child.
          id: randomUUID(),
          builderGenerated: true,
          name: `${name} · ${i + 1}/${count}`,
          issues: [],
          contacts: l.contacts.slice(i * 10, i * 10 + 10).map((r) => ({
            ...r,
            fields: {
              ...r.fields,
              source_list_id: l.id,
              source_recipient_id: r.id,
              postlane_subject: r.fields[subjectColumn],
              postlane_body: r.fields[bodyColumn],
              recipient_type: '外部收件人',
            },
          })),
        });
        const c = {
          id: randomUUID(),
          name: list.name,
          listId: list.id,
          listName: list.name,
          subject: '{{postlane_subject}}',
          body: '{{postlane_body}}',
          mode: 'live',
          rate: 1,
          randomInterval: true,
          plainOnly: true,
          stopOnError: false,
          recoveryVersion: 2,
          accountId: a.id,
          senderEmail: a.from,
          status: 'draft',
          createdAt: new Date().toISOString(),
          recipients: list.contacts.map((r) => ({ ...r, status: 'pending', error: '' })),
        };
        validateCampaign(c);
        put('campaign', c);
        ids.push(c.id);
      }
      const batch = createBatch(name, ids);
      const result = { ...l, batchId: batch.id, campaignIds: ids };
      put('batch-import', { id: requestId, fingerprint, result });
      return result;
    })();
  }
  function startBatch(id) {
    const b = get('report-batch', id);
    if (!b || b.startedAt) throw Error('批次不存在或已经启动');
    const cs = b.campaignIds.map((id) => get('campaign', id));
    for (const c of cs) {
      if (!c || c.status !== 'draft' || c.mode !== 'live')
        throw Error('批次必须全部为未启动的真实任务');
      const a = get('account', c.accountId);
      if (a?.disabled) throw Error('发件账号已停用');
      if (a?.replyOnly) throw Error('该账号只做回复用，不能用于批量发送');
      if (!a?.password || (a.provider && a.provider !== 'smtp') || a.from !== c.senderEmail)
        throw Error('请核对任务绑定的SMTP账号');
      validateCampaign(c);
    }
    return transaction(() => {
      const now = new Date().toISOString();
      for (const c of cs) {
        put('campaign', {
          ...c,
          recoveryVersion: 2,
          status: c.scheduledAt && Date.parse(c.scheduledAt) > Date.now() ? 'scheduled' : 'running',
          startedAt: now,
          nextAt: 0,
        });
      }
      put('report-batch', { ...b, startedAt: now });
      return { ok: true, count: cs.length };
    })();
  }

  return { importBatch, startBatch };
}
