import { createFollowupIngest } from './followup-ingest-core.js';
import { createFollowupView } from './followup-view.js';
import { assertActivityAllowed, workersEnabled, runActivity } from './runtime-policy.js';
import { all, get, put, decrypt } from './store.js';
import {
  DAY,
  gmailAccount,
  trackingFor,
  targetsFor,
  correlate,
  eventId,
} from './followup-domain.js';
import { scanMailbox } from './followup-imap.js';
export const tracking = (c) => trackingFor(c, get('tracking', c.id));
let running = false;
const INTERVAL = 60 * 60000;
const automaticSyncStartsAt = Date.now() + INTERVAL;
export const followupState = createFollowupView({ all, get, isRunning: () => running });
export function setTracking(c, changes) {
  const value = put('tracking', { ...tracking(c), ...changes, id: c.id });
  // Backfill from the campaign's original send date when extending/re-enabling tracking.
  const sync = get('mail-sync', c.accountId);
  if (sync) put('mail-sync', { ...sync, cursors: {}, nextAt: 0 });
  return value;
}
export const ingestMessage = createFollowupIngest({ get, put });
export async function syncMail(...args) {
  return runActivity(() => syncMailImpl(...args));
}
async function syncMailImpl({ force = false, accountId } = {}) {
  assertActivityAllowed();
  if (running) return { running: true };
  running = true;
  try {
    for (const account of all('account').filter(
      (a) => gmailAccount(a) && (!accountId || accountId === a.id),
    )) {
      const campaigns = all('campaign').filter(
        (c) =>
          c.mode === 'live' &&
          c.accountId === account.id &&
          tracking(c).enabled &&
          Date.parse(tracking(c).until) > Date.now(),
      );
      const targets = targetsFor(campaigns);
      if (!targets.length) continue;
      const prior = get('mail-sync', account.id) || { id: account.id, cursors: {} };
      if (!force && prior.nextAt > Date.now()) continue;
      let status = { ...prior, status: 'syncing', startedAt: new Date().toISOString() };
      put('mail-sync', status);
      const since = new Date(
        Math.max(
          Date.parse('2026-09-10T00:00:00+08:00'),
          Math.min(...targets.map((t) => Date.parse(t.sentAt) || Date.now())) - DAY,
        ),
      ).toISOString();
      try {
        const folders = [];
        await scanMailbox(
          account,
          decrypt(account.password),
          since,
          status.cursors || {},
          async (m, screen) => {
            if (screen)
              return (
                !!correlate(m, targets, account.from) ||
                m.from.some((a) => /^(mailer-daemon|postmaster)@/i.test(a))
              );
            ingestMessage(account, targets, m);
          },
          async (folder, cursors) => {
            folders.push(folder);
            status = { ...status, folders, cursors };
            put('mail-sync', status);
          },
        );
        put('mail-sync', {
          ...status,
          status: 'idle',
          complete: status.folders?.every((f) => f.complete !== false) ?? false,
          lastSyncAt: new Date().toISOString(),
          error: '',
          failures: 0,
          nextAt: Date.now() + INTERVAL,
        });
      } catch (e) {
        const failures = (prior.failures || 0) + 1;
        put('mail-sync', {
          ...status,
          status: 'error',
          error: String(e.message).slice(0, 250),
          failures,
          nextAt: Date.now() + INTERVAL,
        });
      }
    }
  } finally {
    running = false;
  }
  return { running: false };
}
// The minute timer only checks eligibility; no automatic mailbox connection is
// made during the first hour after startup. Manual sync bypasses this gate.
export const syncTimer = setInterval(() => {
  if (workersEnabled && Date.now() >= automaticSyncStartsAt) syncMail().catch(() => {});
}, 60000);
if (!workersEnabled || process.env.DISABLE_MAIL_SYNC === 'true') clearInterval(syncTimer);
syncTimer.unref();
