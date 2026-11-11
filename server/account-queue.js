// Locks are acquired synchronously before dispatch, including across timer ticks.
export function createAccountQueue({
  list,
  key,
  readyAt,
  run,
  onError,
  limit = 3,
  now = Date.now,
}) {
  const active = new Set();
  return {
    active,
    tick() {
      const seen = new Set();
      for (const campaign of list()) {
        const account = key(campaign);
        if (seen.has(account)) continue;
        if (active.size >= limit) break;
        if (active.has(account) || readyAt(campaign, account) > now()) continue;
        seen.add(account);
        active.add(account);
        Promise.resolve()
          .then(() => run(campaign, account))
          .catch((error) => onError(error, campaign, account))
          .catch((error) => console.error('Account queue error:', error.message))
          .finally(() => active.delete(account));
      }
    },
  };
}
