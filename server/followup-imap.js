import { assertActivityAllowed } from './runtime-policy.js';
import { bindImapAbort } from './imap-abort.js';
import { ImapFlow } from 'imapflow';
import libqp from 'libqp';
import iconv from 'iconv-lite';
import { smtpProxy } from './network.js';
const addresses = (a) => (a || []).map((v) => v.address?.toLowerCase()).filter(Boolean);
export async function scanMailbox(
  account,
  password,
  since,
  cursors,
  onMessage,
  onFolder,
  makeClient = (options) => new ImapFlow(options),
  { signal } = {},
) {
  signal?.throwIfAborted();
  assertActivityAllowed();
  const client = makeClient({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: account.user, pass: password },
    proxy: smtpProxy('smtp.gmail.com'),
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  client.on('error', () => {});
  const unbindAbort = bindImapAbort(client, signal);
  const deadline = setTimeout(() => client.close(), 180000);
  try {
    await client.connect();
    const listed = await client.list();
    if (!Array.isArray(listed)) throw Error('IMAP 文件夹查询失败，将自动重试');
    const folders = listed.filter(
      (f) =>
        f.path === 'INBOX' ||
        ['\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\All'].includes(f.specialUse),
    );
    // Sent first permits reference-based reconciliation before incoming messages are processed.
    folders.sort((a, b) => Number(b.specialUse === '\\Sent') - Number(a.specialUse === '\\Sent'));
    for (const folder of folders) {
      const box = await client.mailboxOpen(folder.path, { readOnly: true });
      if (!box || box.uidValidity == null)
        throw Error(`IMAP 打开文件夹失败（${folder.path}），未推进同步进度，将自动重试`);
      const previous = cursors[folder.path];
      const valid = previous?.validity === String(box.uidValidity);
      const query =
        folder.specialUse === '\\Drafts'
          ? { all: true }
          : valid
            ? { uid: `${previous.uid + 1}:*` }
            : { since: new Date(since) };
      let ids = await client.search(query, { uid: true });
      // ImapFlow may return false on a failed SEARCH. Only [] means no messages;
      // treating failure as empty would advance uidNext and permanently skip mail.
      if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
        throw Error(`IMAP 邮件查询失败（${folder.path}），未推进同步进度，将自动重试`);
      if (valid && folder.specialUse !== '\\Drafts') ids = ids.filter((id) => id > previous.uid);
      let max = valid ? previous.uid : 0;
      const completeRange = ids.length <= 500;
      if (ids.length) {
        // Bound a pass; unfinished folders resume at the last processed UID on the next sync.
        ids = ids.sort((a, b) => a - b).slice(0, 500);
        const batch = [];
        for await (const m of client.fetch(
          ids,
          {
            envelope: true,
            headers: ['references', 'in-reply-to', 'auto-submitted', 'x-failed-recipients'],
            bodyStructure: true,
          },
          { uid: true },
        )) {
          const e = m.envelope || {};
          batch.push({
            uid: m.uid,
            key: String(m.emailId || `${folder.path}:${box.uidValidity}:${m.uid}`),
            folder: folder.path,
            specialUse: folder.specialUse,
            date: e.date || new Date().toISOString(),
            from: addresses(e.from),
            to: addresses(e.to),
            subject: e.subject || '',
            messageId: e.messageId || '',
            inReplyTo: e.inReplyTo,
            headers: m.headers?.toString() || '',
            structure: m.bodyStructure,
          });
        }
        for (const m of batch) {
          // Callback screens metadata first; unrelated email bodies are never downloaded or stored.
          if (await onMessage(m, true)) {
            if (!m.from.includes(account.from.toLowerCase())) {
              const parts = [];
              const walk = (n) => {
                if (!n) return;
                if (['text/plain', 'message/delivery-status'].includes(n.type)) parts.push(n);
                for (const c of n.childNodes || []) walk(c);
              };
              walk(m.structure);
              if (parts.length) {
                const data = await client.fetchOne(
                  m.uid,
                  {
                    bodyParts: parts
                      .slice(0, 8)
                      .map((p) => ({ key: p.part || '1', maxLength: 24000 })),
                  },
                  { uid: true },
                );
                if (!data || !data.bodyParts)
                  throw Error(`IMAP 正文读取失败（${folder.path}），未推进同步进度，将自动重试`);
                m.text = parts
                  .slice(0, 8)
                  .map((p) => {
                    let bytes = data.bodyParts?.get(p.part || '1') || Buffer.alloc(0);
                    if (p.encoding?.toLowerCase() === 'base64')
                      bytes = Buffer.from(bytes.toString(), 'base64');
                    if (p.encoding?.toLowerCase() === 'quoted-printable')
                      bytes = libqp.decode(bytes);
                    const charset = p.parameters?.charset || 'utf-8';
                    return iconv.decode(bytes, iconv.encodingExists(charset) ? charset : 'utf-8');
                  })
                  .join('\n')
                  .slice(0, 64000);
              } else m.text = '此邮件没有可读取的纯文本正文，请前往邮箱查看。';
            }
            delete m.structure;
            await onMessage(m, false);
          }
          max = Math.max(max, m.uid);
        }
      }
      if (completeRange && box.uidNext) max = Math.max(max, Number(box.uidNext) - 1);
      cursors[folder.path] = { validity: String(box.uidValidity), uid: max };
      signal?.throwIfAborted();
      await onFolder(
        {
          path: folder.path,
          specialUse: folder.specialUse,
          total: box.exists,
          scanned: ids.length,
          complete: completeRange,
        },
        cursors,
      );
    }
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
