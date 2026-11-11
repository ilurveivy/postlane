// Explicit historical evidence manifest. Only adds import-task / import-source documents.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { render } from '../server/domain.js';
import { importTaskWorkspace } from '../server/import-task-domain.js';
const apply = process.argv.includes('--apply');
const db = new Database('data/postlane.sqlite', { readonly: !apply, fileMustExist: true });
db.pragma('busy_timeout=5000');
const read = (kind) =>
  db
    .prepare('SELECT json FROM documents WHERE kind=? ORDER BY id')
    .all(kind)
    .map((r) => JSON.parse(r.json));
const json = (p) => JSON.parse(fs.readFileSync(p));
const lists = read('list'),
  campaigns = read('campaign'),
  tasks = read('import-task');
const listMap = new Map(lists.map((l) => [l.id, l]));
const cm = new Map(campaigns.map((c) => [c.id, c]));
const records = [];
function add(name, ids, evidence, boundary = '导入结果明确对应的来源名单') {
  assert(ids.length, name);
  const selected = ids.map((id) => {
    assert(listMap.has(id), `Missing ${id}`);
    return listMap.get(id);
  });
  const id =
    'history-' +
    createHash('sha256').update(ids.slice().sort().join('|')).digest('hex').slice(0, 20);
  records.push({
    id,
    name,
    description: `历史归属恢复：${boundary}。只补关联，未重新排期或发送。`,
    origin: 'historical',
    schemaVersion: 1,
    sourceListIds: ids,
    evidence,
    boundary,
    createdAt:
      selected
        .map((l) => l.createdAt)
        .filter(Boolean)
        .sort()[0] || null,
  });
}
const campaignLists = (ids) => [
  ...new Set(
    ids.map((id) => {
      assert(cm.has(id), id);
      return cm.get(id).listId;
    }),
  ),
];
const early = 'outputs/pre-reliability-1789566530793/';
add(
  '09111527 · 首批20条',
  lists.filter((l) => /^09111527 第(?:2–11|12–21)行/.test(l.name)).map((l) => l.id),
  [early + 'first-account-send-report.json', early + 'second-account-send-report.json'],
  '两个已保存发送报告及对应执行名单；原始导入边界未完整保留',
);
const third = early + 'third-account-send-report.json';
add('pillow · 第三账号10条', campaignLists([json(third).campaignId]), [third]);
for (const [file, name] of [
  ['batch-83-created.json', '0914 创作者83'],
  ['batch-90-20260915-created.json', '0915 前90条'],
]) {
  const p = early + file;
  add(
    name,
    campaignLists(json(p).campaigns.map((c) => c.id)),
    [p],
    '历史创建清单的执行批次，非声称完整原始 Excel',
  );
}
const p100 = 'outputs/expanded-20260916/result.json';
add(
  '0916 今晚100条（原58＋新42）',
  campaignLists(json(p100).tasks.map((c) => c.id)),
  [p100],
  '历史确认的混合来源执行批次',
);
const p50 = 'outputs/scheduled-2100-20260916/manifest.json';
add('0916 21点新账号50条', campaignLists(json(p50).campaignIds), [p50], '历史确认的50条分配清单');
add('0916 第三表剩余45条', [json(p50).remainingListId], [p50]);
// Restore an immutable source snapshot, never a schedulable list.
const restoreFile = 'outputs/schedule-300-20260917/removed-lists-backup.json';
const restored = json(restoreFile).find((l) => l.id === 'd848a38d-aeb0-4bc3-b5a1-6c4aa2c520a5');
assert.equal(restored.contacts.length, 188);
let matched = 0;
for (const c of campaigns)
  for (const r of c.recipients) {
    if (
      r.fields?.source_list_id !== restored.id ||
      /副本|测试|留档/.test(r.fields?.recipient_type || '')
    )
      continue;
    const original = restored.contacts.find((x) => x.id === (r.fields.source_recipient_id || r.id));
    assert(original);
    assert.equal(original.email.toLowerCase(), r.email.toLowerCase());
    for (const key of ['email_subject', 'email_content'])
      if (original.fields[key] !== undefined) assert.equal(original.fields[key], r.fields[key]);
    matched++;
  }
assert.equal(matched, 188);
listMap.set(restored.id, restored);
add('创作者第三批04 · 原版188条', [restored.id], [restoreFile]);
const v2 = 'outputs/import-two-v2-20260917/result.json';
for (const r of json(v2)) add(r.name, [r.id], [v2]);
const p18 = 'outputs/import-20260918/result.json';
add('创作者20260918', [json(p18).id], [p18]);
const p22 = 'outputs/import-20260922/result.json';
add(
  '创作者20260920–0921',
  json(p22).map((r) => r.id),
  [p22],
);
const p24 = 'outputs/import-20260924/result.json';
add(
  '创作者20260923',
  json(p24)
    .filter((r) => r.name.startsWith('20260923'))
    .map((r) => r.id),
  [p24],
);
const p1022 = 'outputs/import-7382-20261022/import-result.json';
add(
  '重新触达20261022',
  json(p1022).map((r) => r.id),
  [p1022],
  '本次重新触达的导入结果，独立于原始触达轮次',
);
// The old 58-row receipt is the exact subset later placed in the 100-row batch.
const old58 = lists.find((l) => l.name === '0916 昨日两表剩余58条');
assert(old58);
const task100 = records.find((t) => t.name === '0916 今晚100条（原58＋新42）');
const targets = task100.sourceListIds.flatMap((id) =>
  listMap
    .get(id)
    .contacts.filter((r) => r.fields.recipient_type === '外部收件人')
    .map((r) => ({ id, r })),
);
task100.sourceRecordAliases = {};
for (const r of old58.contacts) {
  const matches = targets.filter(
    (x) =>
      x.r.email === r.email &&
      ['email_subject', 'email_content', 'source_row', 'source_sheet'].every(
        (k) => String(x.r.fields[k]) === String(r.fields[k]),
      ),
  );
  assert.equal(matches.length, 1, '58-row receipt must match exactly and uniquely');
  task100.sourceRecordAliases[`${old58.id}:${r.id}`] = `${matches[0].id}:${matches[0].r.id}`;
}
assert.equal(Object.keys(task100.sourceRecordAliases).length, 58);
task100.sourceListIds.push(old58.id);
task100.evidence.push('58-row exact match: email, subject, body, sheet, row');
for (const receipt of read('batch-import')) {
  const l = receipt.result;
  if (l.id === old58.id) continue;
  add(l.name, [l.id], [`database:batch-import:${receipt.id}`]);
  records.at(-1).id = 'legacy-import-' + l.id;
}
const builder = lists.find((l) => l.name === 'reseller_邮件_可直发');
assert(builder);
const builderBatch = read('report-batch').find((b) => b.name === 'reseller_第二批');
assert(builderBatch);
assert(
  builderBatch.campaignIds.every((id) =>
    cm
      .get(id)
      .recipients.filter((r) => !/副本|测试|留档/.test(r.fields?.recipient_type || ''))
      .every((r) => r.fields.source_list_id === builder.id),
  ),
);
add(
  'reseller_第二批',
  [builder.id],
  [`database:report-batch:${builderBatch.id}`],
  '独立导入来源与批次子任务的行级来源 ID 对应',
);
// Four explicit manual retries: match the original complete rendered message, not just email.
for (const c of campaigns.filter((c) => /^09111527 · 单封重试|^0915 用户确认重发/.test(c.name))) {
  const t = records.find(
    (t) => t.name === (c.name.startsWith('09111527') ? '09111527 · 首批20条' : '0915 前90条'),
  );
  const candidates = campaigns
    .filter((x) => t.sourceListIds.includes(x.listId) && x.id !== c.id)
    .flatMap((x) => x.recipients.map((r) => ({ c: x, r })));
  let linked = 0;
  for (const r of c.recipients) {
    const matches = candidates.filter(
      (x) =>
        x.r.email === r.email &&
        render(x.c.subject, x.r.fields) === render(c.subject, r.fields) &&
        render(x.c.body, x.r.fields) === render(c.body, r.fields),
    );
    if (matches.length !== 1) continue;
    linked++;
    const x = matches[0];
    t.sourceRecordAliases ||= {};
    t.sourceRecordAliases[`${c.listId}:${r.id}`] = `${x.c.listId}:${x.r.id}`;
  }
  if (!linked) continue;
  assert.equal(linked, c.recipients.length);
  t.sourceListIds.push(c.listId);
  t.evidence.push(
    `database:campaign:${c.id}; explicit retry + identical email, rendered subject and body`,
  );
}
const owned = new Set();
for (const t of records)
  for (const id of t.sourceListIds) {
    assert(!owned.has(id), 'duplicate source ownership');
    owned.add(id);
    assert(
      !tasks.some((old) => old.id !== t.id && old.sourceListIds?.includes(id)),
      'existing ownership conflict',
    );
  }
const args = {
  lists: [...read('import-source'), restored, ...lists],
  campaigns,
  receipts: read('batch-import'),
  events: read('mail-event'),
  replies: read('reply-draft'),
  messages: read('inbox-message'),
};
const before = importTaskWorkspace({ ...args, lists: [...read('import-source'), ...lists], tasks });
const after = importTaskWorkspace({
  ...args,
  tasks: [...tasks.filter((t) => !records.some((r) => r.id === t.id)), ...records],
});
const out = 'outputs/historical-task-backfill-20261029';
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const summary = {
  mode: apply ? 'apply' : 'dry-run',
  restoredSourceRows: matched,
  tasks: after.items
    .filter((t) => t.id !== 'unassigned')
    .map((t) => ({
      id: t.id,
      name: t.name,
      total: t.counts.total,
      sent: t.counts.sent,
      pending: t.counts.pending,
      unverified: t.counts.unverified,
      sourceLists: t.sourceListIds.length,
    })),
  remaining: [...after.groups.get('unassigned').records.values()].map((r) => ({
    id: r.id,
    email: r.email,
    campaigns: r.attempts.map((a) => ({ id: a.campaignId, name: cm.get(a.campaignId)?.name })),
  })),
  beforeUnassigned: before.items.find((t) => t.id === 'unassigned').counts,
  afterUnassigned: after.items.find((t) => t.id === 'unassigned').counts,
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(records, null, 2));
if (apply) {
  const backup = path.join(os.homedir(), 'Postlane-backups', 'history-backfill-' + Date.now());
  fs.mkdirSync(backup, { mode: 0o700 });
  await db.backup(path.join(backup, 'postlane.sqlite'));
  fs.chmodSync(path.join(backup, 'postlane.sqlite'), 0o600);
  fs.copyFileSync('data/secret.key', path.join(backup, 'secret.key'));
  fs.chmodSync(path.join(backup, 'secret.key'), 0o600);
  const check = new Database(path.join(backup, 'postlane.sqlite'), { readonly: true });
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
  check.close();
  summary.backup = backup;
  db.transaction(() => {
    const protectedHash = () =>
      createHash('sha256')
        .update(
          JSON.stringify(
            db
              .prepare(
                "SELECT kind,id,json FROM documents WHERE kind NOT IN ('import-task','import-source') ORDER BY kind,id",
              )
              .all(),
          ),
        )
        .digest('hex');
    const hash = protectedHash();
    for (const l of lists) {
      const current = db.prepare("SELECT json FROM documents WHERE kind='list' AND id=?").get(l.id);
      assert.equal(current?.json, JSON.stringify(l), 'Source changed during preview');
    }
    const put = db.prepare(
      'INSERT INTO documents(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json',
    );
    const oldSource = db
      .prepare("SELECT json FROM documents WHERE kind='import-source' AND id=?")
      .get(restored.id);
    if (oldSource) assert.deepEqual(JSON.parse(oldSource.json), restored);
    else put.run('import-source', restored.id, JSON.stringify(restored));
    for (const t of records) {
      const old = tasks.find((o) => o.id === t.id);
      if (old) {
        assert.deepEqual(old.sourceListIds, t.sourceListIds);
        continue;
      }
      put.run('import-task', t.id, JSON.stringify(t));
    }
    assert.equal(protectedHash(), hash, 'Delivery or other protected records changed');
    summary.protectedRecordsUnchanged = true;
  })();
}
fs.writeFileSync(
  path.join(out, apply ? 'applied.json' : 'preview.json'),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
db.close();
