export function selectEligibleAccounts(accounts, campaigns) {
  const successful = new Set(
    campaigns.filter((c) => c.recipients.some((r) => r.status === 'sent')).map((c) => c.accountId),
  );
  return [...accounts]
    .reverse()
    .filter(
      (a) =>
        (!a.provider || a.provider === 'smtp') &&
        !a.disabled &&
        !a.replyOnly &&
        a.password &&
        (a.verifiedAt || successful.has(a.id)),
    )
    .map((a) => ({ id: a.id, email: a.from, name: a.name }));
}
