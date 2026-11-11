export const effectiveHandled = (e) =>
  e.handlingSource === 'manual'
    ? !!e.handled
    : !!e.handled || ['bounce', 'delivery_notice'].includes(e.type);
export const followupTypes = {
  reply: '外部回复',
  archive_reply: '留档确认',
  auto_reply: '自动回复',
  bounce: '已退信',
  delivery_notice: '投递通知',
  folder: '邮箱记录',
};
export function filterFollowup(
  events,
  {
    account = '',
    campaign = '',
    handled = 'all',
    kind = 'all',
    query = '',
    importTaskId = '',
    from = '',
    to = '',
  } = {},
) {
  return events.filter(
    (e) =>
      (!importTaskId || e.importTaskIds?.includes(importTaskId)) &&
      (!from || (e.date && Date.parse(e.date) >= Date.parse(from + 'T00:00:00+08:00'))) &&
      (!to || (e.date && Date.parse(e.date) < Date.parse(to + 'T00:00:00+08:00') + 86400000)) &&
      (!account || e.accountId === account) &&
      (!campaign || (e.links || []).some((l) => l.campaignId === campaign)) &&
      (handled === 'all' || effectiveHandled(e) === (handled === 'done')) &&
      (kind === 'all' ||
        (kind === 'actionable'
          ? ['reply', 'bounce', 'delivery_notice', 'auto_reply'].includes(e.type)
          : kind === e.type)) &&
      `${e.subject || ''} ${(e.from || []).join(' ')} ${e.text || ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
}
