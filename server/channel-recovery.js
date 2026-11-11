import { channelMetadata } from './channel-metadata.js';
import { render } from './domain.js';

const content = (r, campaign) =>
  campaign
    ? [render(campaign.subject || '', r.fields || {}), render(campaign.body || '', r.fields || {})]
    : [
        r.fields?.email_subject ??
          r.fields?.postlane_subject ??
          r.fields?.['邮件标题'] ??
          r.fields?.['标题'],
        r.fields?.email_content ??
          r.fields?.postlane_body ??
          r.fields?.['邮件正文'] ??
          r.fields?.['邮件话术'] ??
          r.fields?.['正文'],
      ];
const key = (email, subject, body) =>
  email && typeof subject === 'string' && subject.trim() && typeof body === 'string' && body.trim()
    ? JSON.stringify([email.trim().toLowerCase(), subject, body])
    : null;

// Match complete outgoing content, never the reply sender or a subject alone.
export function recoverChannels(documents, sources) {
  const index = new Map();
  for (const s of sources) {
    const f = s.fields;
    const k = key(f.business_email || f.email, f.email_subject, f.email_content);
    if (k) index.set(k, [...(index.get(k) || []), s]);
  }
  const changes = [],
    conflicts = [];
  for (const document of documents) {
    const value = structuredClone(document.value);
    const rows = document.kind === 'campaign' ? value.recipients : value.contacts;
    let count = 0;
    for (const r of rows || []) {
      const matches =
        index.get(key(r.email, ...content(r, document.kind === 'campaign' ? value : null))) || [];
      if (!matches.length) continue;
      // Multiple identical source rows still have ambiguous batch provenance.
      if (matches.length !== 1) {
        conflicts.push({
          kind: document.kind,
          id: value.id,
          recipientId: r.id,
          reason: 'ambiguous source',
        });
        continue;
      }
      const source = matches[0],
        old = channelMetadata(r.fields),
        next = channelMetadata(source.fields);
      if (Object.keys(old).some((k) => old[k] && next[k] && old[k] !== next[k])) {
        conflicts.push({
          kind: document.kind,
          id: value.id,
          recipientId: r.id,
          reason: 'channel conflict',
        });
        continue;
      }
      const fields = { ...r.fields };
      for (const [k, v] of Object.entries(next)) if (v && !fields[k]?.trim()) fields[k] = v;
      const recovery = { file: source.file, sheet: source.sheet, row: source.row };
      if (
        document.kind === 'campaign' &&
        (render(value.subject || '', fields) !== render(value.subject || '', r.fields || {}) ||
          render(value.body || '', fields) !== render(value.body || '', r.fields || {}))
      ) {
        conflicts.push({
          kind: document.kind,
          id: value.id,
          recipientId: r.id,
          reason: 'would alter rendered message',
        });
        continue;
      }
      if (JSON.stringify(fields) === JSON.stringify(r.fields)) continue;
      r.fields = fields;
      r.channelRecovery = recovery;
      count++;
    }
    if (count) changes.push({ ...document, value, count });
  }
  return { changes, conflicts };
}
