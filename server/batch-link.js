import { all, get, put, db } from './store.js';
import { render } from './domain.js';
export function linkLegacyRetries(links) {
  if (!Array.isArray(links) || !links.length) throw Error('缺少补发关联');
  return db.transaction(() => {
    const changed = new Set();
    for (const link of links) {
      const original = get('campaign', link.originalCampaign),
        retry = get('campaign', link.retryId);
      const row = original?.recipients.find((r) => r.id === link.originalId);
      const replacement = retry?.recipients[0];
      if (
        !row ||
        !replacement ||
        retry.recipients.length !== 1 ||
        original.id === retry.id ||
        original.accountId !== retry.accountId ||
        row.email !== replacement.email ||
        render(original.subject, row.fields) !== render(retry.subject, replacement.fields) ||
        render(original.body, row.fields) !== render(retry.body, replacement.fields)
      )
        throw Error('补发与原任务内容不匹配');
      if (
        replacement.status !== 'sent' ||
        !['completed', 'completed_errors'].includes(retry.status)
      )
        throw Error('仅合并已完成的成功补发');
      const b = all('report-batch').find(
        (b) => !b.mergedInto && b.campaignIds.includes(original.id),
      );
      if (!b) throw Error('原批次不存在');
      if (row.resolvedBy === retry.id) continue;
      replacement.logicalRecipientId = row.id;
      replacement.logicalCampaignId = original.id;
      row.resolvedBy = retry.id;
      retry.parentBatchId = b.id;
      put('campaign', original);
      put('campaign', retry);
      for (const child of all('report-batch').filter(
        (x) => x.id !== b.id && x.campaignIds.includes(retry.id),
      ))
        put('report-batch', { ...child, mergedInto: b.id });
      b.campaignIds = [...new Set([...b.campaignIds, retry.id])];
      put('report-batch', b);
      changed.add(b.id);
    }
    for (const id of changed) {
      const b = get('report-batch', id);
      put('report-batch', {
        ...b,
        revision: (b.revision || 0) + 1,
        completedAt: null,
        auditDueAt: null,
        status: 'waiting',
      });
    }
    return { updated: [...changed] };
  })();
}
