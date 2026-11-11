// Shared state transition; no storage or network side effects.
export function applyEvidence(row, evidence, error = '', now = Date.now()) {
  row.reconcileChecks = (row.reconcileChecks || 0) + 1;
  row.reconcileHistory ||= [];
  row.reconcileHistory.push({ checkedAt: new Date(now).toISOString(), found: !!evidence, error });
  if (evidence) {
    row.status = 'sent';
    row.error = '';
    row.sentEvidence = evidence;
    row.reconciledAt = evidence.checkedAt;
    row.messageId = evidence.messageId;
    const attempt = (Array.isArray(row.attempts) ? row.attempts : []).find(
      (a) => a.messageId === evidence.messageId,
    );
    if (attempt) {
      attempt.status = 'sent';
      attempt.reconciledAt = evidence.checkedAt;
    }
  } else if (row.reconcileChecks >= 3) {
    row.status = 'needs_review';
    row.error = error
      ? '自动核对未完成：' + error
      : '三次核对未查到发送记录；请确认后重发，发件箱无记录不能保证未投递';
  } else {
    row.reconcileAt = now + [60000, 5 * 60000, 15 * 60000][row.reconcileChecks];
    row.error = error ? '发件箱核对暂不可用，将重试：' + error : '未查到发送记录，等待再次核对';
  }
}
