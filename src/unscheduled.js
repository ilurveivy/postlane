// Compare original email content, not list names: imports can be split across campaigns.
function contentKey(r) {
  const f = r.fields || {};
  const subject = f.email_subject ?? f.postlane_subject ?? f['邮件标题'] ?? f['标题'];
  const body = f.email_content ?? f.postlane_body ?? f['邮件话术'] ?? f['邮件正文'] ?? f['正文'];
  if (subject == null || body == null) return null;
  return JSON.stringify([r.email.toLowerCase(), subject, body]);
}
const retryKey = (r) =>
  r.fields?.postlane_retry_campaign_id &&
  JSON.stringify([r.fields.postlane_retry_campaign_id, r.fields.postlane_retry_recipient_id]);
export function unscheduledLists(lists, campaigns) {
  const assignedIds = new Set();
  const assignedSources = new Set();
  const sourceKey = (r, listId) =>
    `${r.fields?.source_list_id || r.sourceListId || listId}:${r.fields?.source_recipient_id || r.id}`;
  const assignedContent = new Set();
  const retryBlockedContent = new Set();
  const assignedRetries = new Set();
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  for (const c of campaigns) {
    if (c.mode !== 'live') continue;
    for (const r of c.recipients || []) {
      if (c.status === 'cancelled' && !['sent', 'sending', 'uncertain'].includes(r.status))
        continue;
      assignedIds.add(r.id);
      assignedSources.add(sourceKey(r, c.listId));
      if (retryKey(r)) assignedRetries.add(retryKey(r));
      const key = contentKey(r);
      if (key) assignedContent.add(key);
      if (key && (r.status !== 'failed' || r.resolvedBy)) retryBlockedContent.add(key);
    }
  }
  const seen = new Set();
  return lists
    .filter((l) => !l.builderGenerated)
    .map((l) => ({
      ...l,
      contacts: l.contacts.filter((r) => {
        const key = contentKey(r);
        const retryId = r.fields?.postlane_retry_campaign_id;
        if (retryId) {
          if (assignedRetries.has(retryKey(r))) return false;
          const original = byId.get(retryId);
          const failed = original?.recipients.find(
            (v) => v.id === r.fields.postlane_retry_recipient_id,
          );
          if (
            original?.mode !== 'live' ||
            !['completed_errors', 'completed', 'cancelled'].includes(original.status) ||
            failed?.status !== 'failed' ||
            failed.resolvedBy ||
            !key ||
            contentKey(failed) !== key ||
            retryBlockedContent.has(key)
          )
            return false;
        } else if (
          assignedIds.has(r.id) ||
          assignedSources.has(sourceKey(r, l.id)) ||
          (key && assignedContent.has(key))
        )
          return false;
        const unique = key || r.id;
        if (seen.has(unique)) return false;
        seen.add(unique);
        return true;
      }),
    }))
    .filter((l) => l.contacts.length);
}
