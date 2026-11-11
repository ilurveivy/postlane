import { effectiveHandled } from '../src/followup-filter.js';
// Pure read model: never imports the live store or changes delivery records.
export const UNASSIGNED = 'unassigned';
export function taskMetadata(input) {
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  if (!name || name.length > 100) throw Error('任务名称须为 1–100 个字符');
  if (description.length > 500) throw Error('用途说明最多 500 个字符');
  return {
    name,
    description,
    sourceFileName: String(input.sourceFileName || '').slice(0, 300),
    sheetName: String(input.sheetName || '').slice(0, 100),
  };
}
const stamp = (v) => Date.parse(v) || 0;
const norm = (v) =>
  String(v || '')
    .trim()
    .toLowerCase();
const initial = () => ({
  total: 0,
  unverified: 0,
  unassigned: 0,
  pending: 0,
  scheduled: 0,
  running: 0,
  retry: 0,
  uncertain: 0,
  sent: 0,
  failed: 0,
  cancelled: 0,
  handled: 0,
  pendingHandling: 0,
  receivedReplies: 0,
  replied: 0,
  awaitingReply: 0,
  noReply: 0,
  legacyHandled: 0,
  conversations: 0,
});
export function importTaskWorkspace({
  tasks = [],
  lists = [],
  campaigns = [],
  receipts = [],
  events = [],
  replies = [],
  messages = [],
}) {
  const listMap = new Map(lists.map((l) => [l.id, l]));
  const contacts = new Map(
    lists.map((l) => [l.id, new Map((l.contacts || []).map((r) => [r.id, r]))]),
  );
  const taskMap = new Map(tasks.map((t) => [t.id, { ...t }]));
  // Receipt-backed historical tasks are virtual until edited. No startup migration.
  for (const receipt of receipts) {
    const l = receipt.result;
    if (!l?.id || [...taskMap.values()].some((t) => t.sourceListIds?.includes(l.id))) continue;
    const id = 'legacy-import-' + l.id;
    taskMap.set(id, {
      id,
      name: l.name,
      description: '',
      sourceListIds: [l.id],
      createdAt: l.createdAt || null,
      origin: 'receipt',
      sourceFileName: '',
      sheetName: '',
    });
  }
  const owners = new Map();
  for (const t of taskMap.values())
    for (const id of t.sourceListIds || []) {
      if (owners.has(id) && owners.get(id) !== t.id) owners.set(id, UNASSIGNED);
      else owners.set(id, t.id);
    }
  // Explicit, evidence-backed aliases only; never infer duplicates from email alone.
  const aliases = new Map();
  for (const t of taskMap.values())
    for (const [from, to] of Object.entries(t.sourceRecordAliases || {})) {
      const [fl, fr] = from.split(':');
      const [tl, tr] = to.split(':');
      const a = contacts.get(fl)?.get(fr),
        b = contacts.get(tl)?.get(tr);
      if (
        owners.get(fl) === t.id &&
        owners.get(tl) === t.id &&
        a &&
        b &&
        norm(a.email) === norm(b.email)
      )
        aliases.set(from, to);
    }
  const campaignMap = new Map(campaigns.map((c) => [c.id, c]));
  const rowMaps = new Map(
    campaigns.map((c) => [c.id, new Map((c.recipients || []).map((r) => [r.id, r]))]),
  );
  function source(r, listId, seen = new Set()) {
    const f = r.fields || {};
    const ids = [...new Set([f.source_list_id, r.sourceListId].filter(Boolean))];
    if (ids.length > 1) return null;
    const id = ids[0] || listId,
      rid = f.source_recipient_id || r.id;
    const key = `${id}:${rid}`;
    if (seen.has(key)) return null;
    const original = contacts.get(id)?.get(rid);
    if (!original || norm(original.email) !== norm(r.email)) return null;
    const next = original.fields?.source_list_id || original.sourceListId;
    if (next && !(next === id && (original.fields?.source_recipient_id || original.id) === rid))
      return source(original, id, new Set([...seen, key]));
    const taskId = owners.get(id);
    return taskId && taskId !== UNASSIGNED
      ? { taskId, recordId: aliases.get(`${id}:${rid}`) || `${id}:${rid}` }
      : null;
  }
  function attribution(c, r, seen = new Set()) {
    const key = `${c.id}:${r.id}`;
    if (seen.has(key)) return null;
    const cid = r.logicalCampaignId || r.fields?.postlane_retry_campaign_id;
    const rid = r.logicalRecipientId || r.fields?.postlane_retry_recipient_id;
    if (cid && rid) {
      const parent = rowMaps.get(cid)?.get(rid);
      if (!parent || norm(parent.email) !== norm(r.email)) return null;
      return attribution(campaignMap.get(cid), parent, new Set([...seen, key]));
    }
    return source(r, c.listId) || { taskId: UNASSIGNED, recordId: key };
  }
  const groups = new Map(
    [...taskMap].map(([id, t]) => [
      id,
      { ...t, counts: initial(), records: new Map(), campaignIds: new Set() },
    ]),
  );
  groups.set(UNASSIGNED, {
    id: UNASSIGNED,
    name: '历史未归属',
    description: '缺少可确认的导入任务关联；包含待分类历史记录。',
    origin: 'unknown',
    counts: initial(),
    records: new Map(),
    campaignIds: new Set(),
  });
  function record(a, fallback) {
    const g = groups.get(a?.taskId || UNASSIGNED),
      key = a?.recordId || fallback;
    if (!g.records.has(key)) g.records.set(key, { id: key, attempts: [], status: 'unassigned' });
    return [g, g.records.get(key)];
  }
  for (const [id, tid] of owners) {
    if (tid === UNASSIGNED) continue;
    for (const r of listMap.get(id)?.contacts || []) {
      if (/副本|测试|留档/.test(r.fields?.recipient_type || r.fields?.用途 || '')) continue;
      if (aliases.has(`${id}:${r.id}`)) continue;
      const [, rec] = record({ taskId: tid, recordId: `${id}:${r.id}` });
      rec.email = r.email;
    }
  }
  const bouncedRows = new Set(
    events
      .filter((e) => e.type === 'bounce')
      .flatMap((e) => (e.links || []).map((l) => `${l.campaignId}:${l.recipientId}`)),
  );
  const rowAttribution = new Map(),
    campaignSlices = {};
  for (const c of campaigns)
    for (const r of c.recipients || []) {
      const a = attribution(c, r);
      rowAttribution.set(`${c.id}:${r.id}`, a);
      if (
        c.mode !== 'live' ||
        /副本|测试|留档/.test(r.fields?.recipient_type || r.fields?.用途 || '')
      )
        continue;
      const [g, rec] = record(a, `${c.id}:${r.id}`);
      rec.email = r.email;
      rec.attempts.push({
        bounced: r.deliveryStatus === 'bounced' || bouncedRows.has(`${c.id}:${r.id}`),
        campaignId: c.id,
        accountId: c.accountId,
        status: c.status === 'cancelled' && r.status === 'pending' ? 'cancelled' : r.status,
        campaignStatus: c.status,
        returnedToPool: !!c.returnedToPool,
        nextRetryAt: r.retryAt,
        date: r.sentAt || c.startedAt || c.createdAt,
        scheduledAt: c.scheduledAt,
        sentAt: r.sentAt,
      });
      g.campaignIds.add(c.id);
      campaignSlices[c.id] ||= {};
      campaignSlices[c.id][g.id] ||= { total: 0, counts: {} };
      const slice = campaignSlices[c.id][g.id];
      slice.total++;
      slice.counts[r.status] = (slice.counts[r.status] || 0) + 1;
    }
  for (const g of groups.values())
    for (const rec of g.records.values()) {
      const aa = rec.attempts;
      let status = 'unassigned';
      if (aa.some((a) => a.status === 'sent')) status = 'sent';
      else if (aa.some((a) => ['uncertain', 'needs_review'].includes(a.status)))
        status = 'uncertain';
      else if (aa.some((a) => a.status === 'retry_wait')) status = 'retry';
      else if (
        aa.some(
          (a) =>
            a.status === 'sending' || (a.status === 'pending' && a.campaignStatus === 'running'),
        )
      )
        status = 'running';
      else if (aa.some((a) => a.status === 'pending')) status = 'pending';
      else if (aa.some((a) => a.status === 'failed')) status = 'failed';
      else if (aa.length) status = aa.some((a) => a.returnedToPool) ? 'unassigned' : 'cancelled';
      if (
        status === 'unassigned' &&
        !aa.some((a) => a.returnedToPool) &&
        ['receipt', 'historical'].includes(g.origin)
      )
        status = 'unverified';
      rec.status = status;
      g.counts[status]++;
      if (aa.some((a) => a.status === 'pending' && a.campaignStatus === 'scheduled'))
        g.counts.scheduled++;
      const bounces = aa.filter((a) => a.bounced);
      const recovered =
        bounces.length &&
        aa.some(
          (a) =>
            a.status === 'sent' &&
            !a.bounced &&
            stamp(a.sentAt) > Math.max(...bounces.map((b) => stamp(b.sentAt))),
        );
      rec.deliveryFailed =
        status === 'failed' ||
        !!(
          bounces.length &&
          !recovered &&
          !['pending', 'running', 'retry', 'uncertain'].includes(status)
        );
      rec.bounced = !!(bounces.length && !recovered);
      rec.scheduled = aa.some((a) => a.status === 'pending' && a.campaignStatus === 'scheduled');
      if (status !== 'failed' && rec.deliveryFailed) g.counts.failed++;
      g.counts.total++;
    }
  // Union referenced message IDs per account; never join conversations by subject/email.
  const parents = new Map();
  const key = (a, m) => `${a}:${m}`;
  function root(k) {
    if (!parents.has(k)) parents.set(k, k);
    let p = parents.get(k);
    if (p !== k) {
      p = root(p);
      parents.set(k, p);
    }
    return p;
  }
  function join(a, b) {
    parents.set(root(a), root(b));
  }
  for (const m of [...messages, ...events, ...replies]) {
    if (!m.messageId) continue;
    for (const ref of [...(Array.isArray(m.references) ? m.references : []), m.inReplyTo].filter(
      Boolean,
    ))
      join(key(m.accountId, m.messageId), key(m.accountId, ref));
  }
  const decorated = events.map((e) => {
    const ids = [
      ...new Set(
        (e.links || []).map(
          (l) => rowAttribution.get(`${l.campaignId}:${l.recipientId}`)?.taskId || UNASSIGNED,
        ),
      ),
    ];
    return {
      ...e,
      handled: effectiveHandled(e),
      importTaskIds: ids.length ? ids : [UNASSIGNED],
      importTaskNames: (ids.length ? ids : [UNASSIGNED]).map(
        (id) => groups.get(id)?.name || '历史未归属',
      ),
      conversationKey: e.messageId
        ? root(key(e.accountId, e.messageId))
        : `${e.accountId}:event:${e.id}`,
    };
  });
  for (const e of decorated)
    for (const id of e.importTaskIds) {
      const g = groups.get(id);
      if (g) g.counts[e.handled ? 'handled' : 'pendingHandling']++;
    }
  const conversations = new Map();
  for (const e of decorated.filter((e) => e.type === 'reply')) {
    const prior = conversations.get(e.conversationKey);
    if (!prior)
      conversations.set(e.conversationKey, {
        latest: e,
        firstDates: new Map(e.importTaskIds.map((id) => [id, stamp(e.date)])),
        tasks: new Set(e.importTaskIds),
      });
    else {
      for (const id of e.importTaskIds)
        prior.firstDates.set(id, Math.min(prior.firstDates.get(id) ?? Infinity, stamp(e.date)));
      e.importTaskIds.forEach((id) => prior.tasks.add(id));
      if (stamp(e.date) > stamp(prior.latest.date)) prior.latest = e;
    }
  }
  const outgoing = new Map();
  for (const m of [
    ...replies.filter((r) => r.status === 'sent'),
    ...messages.filter((m) => m.outgoing && m.remote && m.folders?.includes('sent')),
  ]) {
    if (!m.messageId || (!m.inReplyTo && !m.references?.length)) continue;
    const k = root(key(m.accountId, m.messageId));
    outgoing.set(k, Math.max(outgoing.get(k) || 0, stamp(m.sentAt || m.date)));
  }
  for (const [k, conv] of conversations) {
    const e = conv.latest;
    const state =
      (outgoing.get(k) || 0) > stamp(e.date)
        ? 'replied'
        : e.followupDisposition === 'no_reply'
          ? 'noReply'
          : 'awaitingReply';
    for (const id of conv.tasks) {
      const g = groups.get(id);
      if (g) {
        g.counts.conversations++;
        g.counts.receivedReplies++;
        if ((outgoing.get(k) || 0) > conv.firstDates.get(id)) g.counts.replied++;
        if (state !== 'replied') g.counts[state]++;
        if (e.handled && !e.handlingSource) g.counts.legacyHandled++;
      }
    }
    for (const ev of decorated)
      if (ev.conversationKey === k && ev.type === 'reply') ev.followupStatus = state;
  }
  const items = [...groups.values()]
    .map(({ records, campaignIds, ...g }) => ({
      ...g,
      campaignIds: [...campaignIds],
      scheduledDays: [
        ...new Set(
          [...records.values()]
            .flatMap((r) => r.attempts.map((a) => a.scheduledAt))
            .filter((v) => stamp(v))
            .map((v) => new Date(stamp(v) + 8 * 3600000).toISOString().slice(0, 10)),
        ),
      ],
      sentDays: [
        ...new Set(
          [...records.values()]
            .flatMap((r) => r.attempts.filter((a) => a.status === 'sent').map((a) => a.sentAt))
            .filter((v) => stamp(v))
            .map((v) => new Date(stamp(v) + 8 * 3600000).toISOString().slice(0, 10)),
        ),
      ],
      accountIds: [
        ...new Set(
          [...records.values()].flatMap((r) => r.attempts.map((a) => a.accountId)).filter(Boolean),
        ),
      ],
      complete: g.counts.total > 0 && g.counts.sent === g.counts.total,
    }))
    .sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt));
  return { items, events: decorated, campaignSlices, groups, at: new Date().toISOString() };
}
