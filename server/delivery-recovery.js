import { applyEvidence } from './delivery-evidence.js';
export { applyEvidence } from './delivery-evidence.js';
import { assertActivityAllowed, workersEnabled, runActivity } from './runtime-policy.js';
import { ImapFlow } from 'imapflow';
import { all, get, put, decrypt } from './store.js';
import { smtpProxy } from './network.js';
import { finishCampaign } from './delivery-policy.js';
export async function sentEvidence(account, password, ids, makeClient = (o) => new ImapFlow(o)) {
  assertActivityAllowed();
  if (account.host !== 'smtp.gmail.com') throw Error('当前账号暂不支持自动发件箱核对');
  const client = makeClient({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: account.user, pass: password },
    proxy: smtpProxy(account.host),
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  client.on('error', () => {});
  const deadline = setTimeout(() => client.close(), 60000);
  try {
    await client.connect();
    const folder = (await client.list()).find((f) => f.specialUse === '\\Sent');
    if (!folder) throw Error('未找到已发送文件夹');
    await client.mailboxOpen(folder.path, { readOnly: true });
    for (const id of [...new Set(ids.filter(Boolean))]) {
      if ((await client.search({ header: { 'Message-ID': id } }, { uid: true })).length)
        return { messageId: id, checkedAt: new Date().toISOString(), confidence: 'message-id' };
    }
    return null;
  } finally {
    clearTimeout(deadline);
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}
let busy = false;
export async function recoveryTick(...args) {
  return runActivity(() => recoveryTickImpl(...args));
}
async function recoveryTickImpl(check = sentEvidence) {
  assertActivityAllowed();
  if (busy) return;
  busy = true;
  try {
    const jobs = [
      ...all('campaign')
        .filter(
          (c) =>
            c.recoveryVersion === 2 &&
            !['cancelled', 'paused', 'draft', 'scheduled'].includes(c.status),
        )
        .map((c) => ({ kind: 'campaign', doc: c, rows: c.recipients })),
      ...all('batch-report')
        .filter((r) => r.recoveryVersion === 2)
        .map((r) => ({ kind: 'batch-report', doc: r, rows: r.deliveries })),
    ];
    const seen = new Set();
    for (const job of jobs) {
      if (seen.has(job.doc.accountId)) continue;
      const row = job.rows.find(
        (r) => r.status === 'uncertain' && (r.reconcileAt || 0) <= Date.now(),
      );
      if (!row) continue;
      seen.add(job.doc.accountId);
      let evidence,
        error = '';
      try {
        const a = get('account', job.doc.accountId);
        if (!a?.password) throw Error('发件账号不可用');
        evidence = await check(a, decrypt(a.password), [
          row.messageId,
          ...(Array.isArray(row.attempts) ? row.attempts.map((a) => a.messageId) : []),
        ]);
      } catch (e) {
        error = String(e.message).slice(0, 250);
      }
      const fresh = get(job.kind, job.doc.id);
      const current = (job.kind === 'campaign' ? fresh.recipients : fresh.deliveries).find((r) =>
        job.kind === 'campaign' ? r.id === row.id : r.email === row.email,
      );
      if (current?.status !== 'uncertain' || current.messageId !== row.messageId) continue;
      applyEvidence(current, evidence, error);
      if (job.kind === 'campaign' && fresh.status !== 'paused' && fresh.status !== 'cancelled')
        finishCampaign(fresh);
      put(job.kind, fresh);
    }
  } finally {
    busy = false;
  }
}
if (workersEnabled && process.env.DISABLE_DELIVERY_RECOVERY !== 'true')
  setInterval(
    () =>
      workersEnabled && recoveryTick().catch((e) => console.error('Delivery recovery:', e.message)),
    15000,
  ).unref();
