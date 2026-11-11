import { correlate, eventId } from './followup-domain.js';
import { explicitOptOut } from './batch-report-domain.js';
import { finishCampaign } from './delivery-policy.js';

export function createFollowupIngest({ get, put }) {
  function ingestMessage(account, targets, m) {
    const result = correlate(m, targets, account.from);
    if (!result) return;
    if (result.type === 'sent') {
      for (const t of result.matches) {
        const c = get('campaign', t.campaignId),
          r = c?.recipients.find((r) => r.id === t.recipientId);
        if (!r) continue;
        r.sentEvidence = {
          messageId: m.messageId,
          date: m.date,
          checkedAt: new Date().toISOString(),
          confidence: result.confidence,
        };
        if (
          ['uncertain', 'needs_review'].includes(r.status) &&
          result.confidence === 'message-id'
        ) {
          r.previousStatus = { status: r.status, error: r.error };
          r.status = 'sent';
          r.error = '';
          r.reconciledAt = new Date().toISOString();
          if (c.recoveryVersion === 2 && c.status === 'attention') finishCampaign(c);
        }
        put('campaign', c);
      }
      return;
    }
    const id = eventId(account.id, m),
      old = get('mail-event', id);
    const links = result.matches.map((t) => ({
      campaignId: t.campaignId,
      recipientId: t.recipientId,
      email: t.email,
    }));
    put('mail-event', {
      ...m,
      id,
      accountId: account.id,
      accountEmail: account.from,
      type: result.type,
      confidence: result.confidence,
      permanent: result.permanent,
      links,
      folders: [...new Set([...(old?.folders || []), m.folder])],
      handled: old?.handled || false,
      handledAt: old?.handledAt || null,
      firstSeenAt: old?.firstSeenAt || new Date().toISOString(),
    });
    if (result.type === 'bounce')
      for (const t of result.matches) {
        const c = get('campaign', t.campaignId),
          r = c?.recipients.find((r) => r.id === t.recipientId);
        if (r) {
          r.deliveryStatus = 'bounced';
          r.bounceEventId = id;
          put('campaign', c);
        }
        // 5.1.x is a permanent recipient-address failure. Policy/reputation failures don't blacklist addresses.
        if (
          /Status:\s*5\.1\.1\b/i.test(m.text || '') ||
          (/Status:\s*5\.1\.0\b/i.test(m.text || '') && /recipient not found/i.test(m.text || ''))
        )
          put('suppression', {
            id: t.email,
            email: t.email,
            reason: '收件地址永久退信',
            eventId: id,
            createdAt: new Date().toISOString(),
          });
      }
    if (result.type === 'reply' && explicitOptOut(m.text))
      for (const t of result.matches)
        put('suppression', {
          id: t.email,
          email: t.email,
          reason: '收件人明确要求退订',
          eventId: id,
          createdAt: new Date().toISOString(),
        });
    if (result.type === 'reply' || result.type === 'archive_reply')
      for (const t of result.matches) {
        const c = get('campaign', t.campaignId),
          r = c?.recipients.find((r) => r.id === t.recipientId);
        if (r) {
          r.lastReplyAt = m.date;
          // A reply ends the sequence: the prospect answered, so a "just following up"
          // email would be embarrassing.
          if (r.nextFollowUpAt || (!r.followUpsStopped && r.followUps?.length)) {
            r.nextFollowUpAt = 0;
            r.followUpsStopped = '已收到回复';
          }
          put('campaign', c);
        }
      }
  }

  return ingestMessage;
}
