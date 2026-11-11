import { effectiveHandled } from '../src/followup-filter.js';
import { gmailAccount, trackingFor } from './followup-domain.js';
export function createFollowupView({ all, get, isRunning = () => false }) {
  return function followupState() {
    const campaigns = all('campaign');
    return {
      running: isRunning(),
      intervalMinutes: 60,
      latestIncomingAt: all('mail-event')
        .filter((e) => ['reply', 'bounce', 'delivery_notice', 'auto_reply'].includes(e.type))
        .reduce((latest, e) => (e.firstSeenAt > latest ? e.firstSeenAt : latest), ''),
      pending: all('mail-event').filter((e) => !effectiveHandled(e) && e.type === 'reply').length,
      accounts: all('account').map((a) => ({
        id: a.id,
        email: a.from,
        supported: gmailAccount(a),
        ...(get('mail-sync', a.id) || {}),
      })),
      tracking: campaigns
        .filter((c) => c.mode === 'live')
        .map((c) => ({
          ...trackingFor(c, get('tracking', c.id)),
          name: c.name,
          accountId: c.accountId,
          supported: gmailAccount(get('account', c.accountId)),
        })),
    };
  };
}
