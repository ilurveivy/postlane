import { reportModel } from './batch-report-domain.js';
export function createBatchReportView({ all, get }) {
  return () =>
    all('report-batch')
      .filter((b) => !b.mergedInto)
      .map((b) => ({
        originalTaskCount: b.campaignIds.filter((id) => !get('campaign', id)?.parentBatchId).length,
        linkedRetryCount: b.campaignIds.filter((id) => get('campaign', id)?.parentBatchId).length,
        summary: reportModel(b, b.campaignIds.map((id) => get('campaign', id)).filter(Boolean))
          .stats,
        nextActionAt:
          Math.min(
            ...b.campaignIds.flatMap((id) =>
              (get('campaign', id)?.recipients || [])
                .filter((r) => !r.resolvedBy)
                .flatMap((r) =>
                  r.status === 'retry_wait'
                    ? [r.retryAt || Date.now()]
                    : r.status === 'uncertain'
                      ? [r.reconcileAt || Date.now()]
                      : [],
                ),
            ),
          ) || null,
        ...b,
        reports: all('batch-report')
          .filter((r) => r.batchId === b.id)
          .map(({ text, ...r }) => r),
      }));
}
