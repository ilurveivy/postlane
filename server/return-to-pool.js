// Retire execution ownership without changing sent or uncertain delivery evidence.
export function returnToPool(campaign, reason = '') {
  return {
    ...campaign,
    status: 'cancelled',
    returnedToPool: true,
    completedAt: new Date().toISOString(),
    ...(reason ? { error: reason } : {}),
    recipients: campaign.recipients.map((r) =>
      ['pending', 'retry_wait'].includes(r.status) ? { ...r, status: 'cancelled' } : r,
    ),
  };
}
