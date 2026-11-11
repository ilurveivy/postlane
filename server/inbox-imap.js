import { assertActivityAllowed } from './runtime-policy.js';
import { bindImapAbort } from './imap-abort.js';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { smtpProxy } from './network.js';
import { mailId, refsOf, INBOX_SYNC_START, inSyncWindow } from './inbox-domain.js';
const addresses = (field) =>
  (field?.value || []).map((v) => v.address?.toLowerCase()).filter(Boolean);
const folderName = (f) =>
  f.path === 'INBOX'
    ? 'inbox'
    : { '\\Sent': 'sent', '\\Junk': 'junk', '\\Drafts': 'remote-drafts', '\\Trash': 'trash' }[
        f.specialUse
      ];
export async function withInboxClient(account, password, run, { signal } = {}) {
  signal?.throwIfAborted();
  assertActivityAllowed();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: account.user, pass: password },
    proxy: smtpProxy('smtp.gmail.com'),
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  client.on('error', () => {});
  const unbindAbort = bindImapAbort(client, signal);
  const deadline = setTimeout(() => client.close(), 180000);
  try {
    await client.connect();
    const result = await run(client);
    signal?.throwIfAborted();
    return result;
  } finally {
    clearTimeout(deadline);
    try {
      if (signal?.aborted) client.close();
      else await client.logout();
    } catch {
      client.close();
    } finally {
      unbindAbort();
    }
  }
}
export async function scanInbox(
  account,
  password,
  previous,
  onMessage,
  onFolder,
  runWithClient = withInboxClient,
  options = {},
) {
  return runWithClient(
    account,
    password,
    async (client) => {
      const folders = (await client.list()).filter((f) => folderName(f));
      for (const folder of folders) {
        const box = await client.mailboxOpen(folder.path, { readOnly: true });
        const validity = String(box.uidValidity),
          prior = previous[folder.path];
        const valid = prior?.validity === validity && prior?.syncStart === INBOX_SYNC_START;
        // IMAP dates have day precision; include the UTC boundary day, then filter exactly.
        const scope = { sentSince: new Date('2026-09-09T00:00:00Z') };
        const ids = ((await client.search(scope, { uid: true })) || []).sort((a, b) => a - b);
        const fresh = valid ? ids.filter((id) => id > prior.high) : [];
        const older = valid ? ids.filter((id) => id < prior.low) : ids;
        const selected = [...new Set([...fresh.slice(0, 30), ...older.slice(-30)])];
        if (selected.length)
          for await (const raw of client.fetch(
            selected,
            { source: { start: 0, maxLength: 1048576 }, envelope: true, flags: true, size: true },
            { uid: true },
          )) {
            const uid = raw.uid;
            const p = await simpleParser(raw.source || Buffer.alloc(0), {
              skipImageLinks: true,
              skipTextToHtml: true,
            });
            if (!inSyncWindow(p.date)) continue;
            const messageId =
              p.messageId ||
              `<imap-${mailId(account.id, folder.path + ':' + validity + ':' + uid)}@local>`;
            options.signal?.throwIfAborted();
            await onMessage({
              id: mailId(account.id, messageId),
              accountId: account.id,
              accountEmail: account.from,
              messageId,
              from: addresses(p.from),
              to: addresses(p.to),
              replyTo: addresses(p.replyTo),
              subject: p.subject || '',
              date: (p.date || new Date()).toISOString(),
              references: Array.isArray(p.references) ? p.references : refsOf(p.references),
              inReplyTo: p.inReplyTo || '',
              text: (p.text || '[没有可读取的正文，请在原邮箱查看]').slice(0, 100000),
              truncated: raw.size > 1048576 || (p.text || '').length > 100000,
              attachments: (p.attachments || []).map((a) => ({
                name: a.filename || '附件',
                size: a.size,
              })),
              seen: raw.flags.has('\\Seen'),
              outgoing: addresses(p.from).includes(account.from.toLowerCase()),
              folders: [folderName(folder)],
              locations: [{ path: folder.path, uid, validity, folder: folderName(folder) }],
              submissionOnly: false,
              remote: true,
            });
          }
        const high = valid
          ? Math.max(prior.high, ...fresh.slice(0, 30), 0)
          : Math.max(...selected, 0);
        const low = Math.min(...(valid ? [prior.low, ...older.slice(-30)] : selected), Infinity);
        const seenUids = (await client.search({ ...scope, seen: true }, { uid: true })) || [];
        options.signal?.throwIfAborted();
        await onFolder(
          folder.path,
          {
            validity,
            syncStart: INBOX_SYNC_START,
            high,
            low: Number.isFinite(low) ? low : 0,
            remaining: ids.filter((id) => id < low).length,
            total: ids.length,
          },
          { ids, seenUids },
        );
      }
    },
    options,
  );
}
export async function markRemoteSeen(account, password, messages, seen, options = {}) {
  return withInboxClient(
    account,
    password,
    async (client) => {
      const groups = new Map();
      for (const m of messages)
        for (const l of m.locations || []) {
          if (!groups.has(l.path)) groups.set(l.path, []);
          groups.get(l.path).push(l);
        }
      for (const [path, ls] of groups) {
        const box = await client.mailboxOpen(path);
        if (ls.some((l) => l.validity !== String(box.uidValidity)))
          throw Error('邮箱索引已变化，请先同步');
        if (seen)
          await client.messageFlagsAdd(
            ls.map((l) => l.uid),
            ['\\Seen'],
            { uid: true },
          );
        else
          await client.messageFlagsRemove(
            ls.map((l) => l.uid),
            ['\\Seen'],
            { uid: true },
          );
      }
    },
    options,
  );
}
