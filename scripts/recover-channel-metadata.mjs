// Input: [{file, sheet, row, fields}] extracted from verified original spreadsheets.
// Dry-run by default. Only existing list/campaign records are updated.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { recoverChannels } from '../server/channel-recovery.js';

const [database, sourceFile, flag] = process.argv.slice(2);
if (!database || !sourceFile || (flag && flag !== '--apply'))
  throw Error('Usage: node scripts/recover-channel-metadata.mjs DATABASE SOURCES.json [--apply]');
const sources = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const db = new Database(database, { readonly: flag !== '--apply' });
const plan = () => {
  const documents = db
    .prepare("SELECT kind,id,json FROM documents WHERE kind IN ('campaign','list')")
    .all()
    .map((r) => ({ ...r, value: JSON.parse(r.json) }));
  if (
    documents.some(
      (d) =>
        d.kind === 'campaign' &&
        (['running', 'scheduled'].includes(d.value.status) ||
          d.value.recipients?.some((r) => r.status === 'sending')),
    )
  )
    throw Error('Wait until sending and scheduled campaigns are idle before recovery');
  return recoverChannels(documents, sources);
};
let result = plan(),
  backup;
if (flag === '--apply' && result.changes.length) {
  backup = path.resolve(`${database}.before-channel-recovery-${Date.now()}.sqlite`);
  await db.backup(backup);
  fs.chmodSync(backup, 0o600);
  result = db
    .transaction(() => {
      const current = plan();
      const update = db.prepare('UPDATE documents SET json=? WHERE kind=? AND id=? AND json=?');
      for (const change of current.changes)
        if (
          update.run(JSON.stringify(change.value), change.kind, change.id, change.json).changes !==
          1
        )
          throw Error('Record changed during recovery');
      return current;
    })
    .immediate();
}
console.log(
  JSON.stringify(
    {
      applied: flag === '--apply',
      backup,
      documents: result.changes.length,
      records: result.changes.reduce((n, c) => n + c.count, 0),
      conflicts: result.conflicts,
    },
    null,
    2,
  ),
);
db.close();
