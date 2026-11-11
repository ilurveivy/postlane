import { workersEnabled } from './runtime-policy.js';
import { spawn } from 'node:child_process';
import { all } from './store.js';
export function createAwakeGuard({ needed, launch, platform = process.platform }) {
  let child = null,
    error = '';
  return {
    state: () => ({ supported: platform === 'darwin', active: !!child, error }),
    tick() {
      if (platform !== 'darwin') return;
      if (needed() && !child) {
        try {
          child = launch();
          const current = child;
          current.once('error', (e) => {
            error = e.message;
            if (child === current) child = null;
          });
          current.once('exit', () => {
            if (child === current) child = null;
          });
          error = '';
        } catch (e) {
          error = e.message;
        }
      } else if (!needed() && child) {
        child.kill();
        child = null;
      }
    },
    stop() {
      child?.kill();
      child = null;
    },
  };
}
const needed = () =>
  all('reply-draft').some((d) => ['queued', 'sending'].includes(d.status)) ||
  all('campaign').some(
    (c) =>
      ['running', 'scheduled'].includes(c.status) ||
      (c.recoveryVersion === 2 &&
        c.status === 'attention' &&
        c.recipients.some((r) => r.status === 'uncertain')),
  ) ||
  all('batch-report').some((r) =>
    r.deliveries.some((d) => ['pending', 'sending'].includes(d.status)),
  ) ||
  all('report-batch').some(
    (b) =>
      !b.mergedInto &&
      b.emailReports !== false &&
      !b.auditSkippedReason &&
      b.completedAt &&
      !all('batch-report').some(
        (r) =>
          r.batchId === b.id &&
          r.kind === 'audit' &&
          !r.correctionOf &&
          (r.revision || 0) === (b.revision || 0),
      ),
  );
const guard = createAwakeGuard({
  needed,
  launch: () =>
    spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }),
});
export const awakeState = () => guard.state();
if (workersEnabled && process.env.DISABLE_SLEEP_GUARD !== 'true') {
  guard.tick();
  setInterval(() => (workersEnabled ? guard.tick() : guard.stop()), 5000).unref();
  process.once('exit', () => guard.stop());
}
