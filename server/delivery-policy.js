export const MAX_ATTEMPTS = 3;
export const retryDelay = (attempt) => Math.min(30 * 60000, 60000 * 2 ** Math.max(0, attempt - 1));
export const OPEN_DELIVERY = ['pending', 'sending', 'retry_wait', 'uncertain', 'needs_review'];
export function classifyFailure(error) {
  const code = String(error.code || '');
  const command = String(error.command || '').toUpperCase();
  if (code === 'EAUTH' || [530, 534, 535].includes(error.responseCode)) return 'account';
  if (error.responseCode >= 400 && error.responseCode < 500) return 'temporary';
  if (error.responseCode >= 500) return 'permanent';
  // A failed connection/authentication/envelope cannot have submitted DATA.
  const preData = /^(CONN|CONNECT|EHLO|HELO|STARTTLS|AUTH(?: .*|)|MAIL FROM|RCPT TO)$/.test(
    command,
  );
  if (
    ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ||
    (preData && ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET'].includes(code))
  )
    return 'temporary';
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'EDELIVERYUNKNOWN'].includes(code))
    return 'unknown';
  return 'permanent';
}
export function failureOutcome(error, attempts, now = Date.now()) {
  const kind = classifyFailure(error);
  const text = String(error.response || error.message || '发送失败').slice(0, 300);
  if (kind === 'unknown')
    return {
      status: 'uncertain',
      error: '提交结果待核对：' + text,
      reconcileAt: now + 60000,
      failureKind: kind,
    };
  if (kind === 'account')
    return { status: 'needs_review', error: '账号认证需要处理：' + text, failureKind: kind };
  if (kind === 'temporary' && attempts < MAX_ATTEMPTS)
    return {
      status: 'retry_wait',
      error: text,
      retryAt: now + retryDelay(attempts),
      failureKind: kind,
    };
  return { status: 'failed', error: text, failureKind: kind };
}
export function candidate(c, now = Date.now()) {
  return (
    c.recipients.find((r) => r.status === 'pending') ||
    c.recipients.find((r) => r.status === 'retry_wait' && (r.retryAt || 0) <= now)
  );
}
export function campaignReadyAt(c, now = Date.now()) {
  if (candidate(c, now)) return c.nextAt || 0;
  const retries = c.recipients.filter((r) => r.status === 'retry_wait');
  if (retries.length)
    return Math.max(c.nextAt || 0, Math.min(...retries.map((r) => r.retryAt || 0)));
  // Run once to update completion / attention state without occupying the account thereafter.
  return c.nextAt || 0;
}
export function finishCampaign(c, now = Date.now()) {
  if (c.recipients.some((r) => ['pending', 'sending', 'retry_wait'].includes(r.status))) return c;
  if (c.recipients.some((r) => ['uncertain', 'needs_review'].includes(r.status))) {
    c.status = 'attention';
    return c;
  }
  c.status = c.recipients.some((r) => ['failed', 'cancelled'].includes(r.status))
    ? 'completed_errors'
    : 'completed';
  c.completedAt ||= new Date(now).toISOString();
  return c;
}
export function prepareRetry(row, confirmed = false) {
  if (!['failed', 'needs_review'].includes(row.status)) throw Error('此邮件尚不可手动重试');
  if (row.failureKind === 'unknown' && !confirmed)
    throw Error('请先核对发件箱并确认重发，可能产生重复邮件');
  row.status = 'pending';
  row.error = '';
  row.retryAt = 0;
  row.reconcileChecks = 0;
  row.manualRetries = (row.manualRetries || 0) + 1;
  row.retryBase = row.attempts?.length || 0;
}
