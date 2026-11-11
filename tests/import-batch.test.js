import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'postlane-import-test-'));
process.env.DISABLE_BATCH_REPORTS = 'true';
process.env.DISABLE_MAIL_SYNC = 'true';
process.env.DISABLE_SLEEP_GUARD = 'true';
const { get, put, all } = await import('../server/store.js');
const { importBatch, startBatch } = await import('../server/import-batch.js');
const { timer, accountConcurrency } = await import('../server/mailer.js');
clearInterval(timer);
for (let i = 0; i < 3; i++)
  put('account', {
    id: 'a' + i,
    from: 'a' + i + '@example.com',
    host: 'local',
    password: 'test-only',
    verifiedAt: new Date().toISOString(),
  });
const rows = Array.from({ length: 21 }, (_, i) => ({
  email: `r${i}@example.com`,
  title: '  Original ' + i + '  ',
  body: 'Hi\n\n原文 ' + i + '\n',
  channel_id: 'UCtYe2zSP5vEnwHFhR3ZDsIA',
  channel_name: 'Original channel',
  custom_metadata: 'preserved',
}));
const data = {
  name: '分组',
  rows,
  emailColumn: 'email',
  subjectColumn: 'title',
  bodyColumn: 'body',
  requestId: 'req',
};
test('21 rows become 10/10/1 with distinct accounts, no archive, exact text, one report batch and idempotent retry', () => {
  const r = importBatch(data);
  assert.equal(r.campaignIds.length, 3);
  const cs = r.campaignIds.map((id) => get('campaign', id));
  assert.deepEqual(
    cs.map((c) => c.recipients.length),
    [10, 10, 1],
  );
  assert.equal(new Set(cs.map((c) => c.accountId)).size, 3);
  assert.ok(cs.every((c) => c.status === 'draft'));
  const rs = cs.flatMap((c) => c.recipients);
  assert.equal(rs.length, 21);
  rs.forEach((r, i) => {
    assert.equal(r.fields.postlane_subject, rows[i].title);
    assert.equal(r.fields.postlane_body, rows[i].body);
    assert.equal(r.fields.recipient_type, '外部收件人');
    assert.equal(r.fields.source_list_id, get('batch-import', data.requestId).result.id);
    assert.equal(r.fields.source_recipient_id, r.id);
    assert.equal(r.fields.channel_url, 'https://www.youtube.com/channel/UCtYe2zSP5vEnwHFhR3ZDsIA');
    assert.equal(r.fields.custom_metadata, 'preserved');
  });
  assert.equal(importBatch(data).batchId, r.batchId);
  assert.equal(all('campaign').length, 3);
  assert.equal(all('report-batch').length, 1);
  assert.ok(cs.every((c) => get('list', c.listId).builderGenerated));
  startBatch(r.batchId);
  assert.ok(cs.every((c) => get('campaign', c.id).status === 'running'));
  assert.throws(() => startBatch(r.batchId));
});
test('insufficient accounts or blank content fail before creating tasks', () => {
  const before = all('campaign').length;
  assert.throws(() => importBatch({ ...data, requestId: 'few', accountIds: ['a0'] }), /需要3个/);
  assert.throws(
    () => importBatch({ ...data, requestId: 'blank', rows: [{ ...rows[0], body: '' }] }),
    /为空/,
  );
  assert.equal(all('campaign').length, before);
  assert.ok(accountConcurrency <= 3);
});
test('macOS idle-sleep assertion is acquired once and released when work ends', async () => {
  const { createAwakeGuard } = await import('../server/awake.js');
  let needed = true,
    launched = 0,
    killed = 0;
  const child = new EventEmitter();
  child.kill = () => killed++;
  const g = createAwakeGuard({
    platform: 'darwin',
    needed: () => needed,
    launch: () => {
      launched++;
      return child;
    },
  });
  g.tick();
  g.tick();
  assert.equal(launched, 1);
  assert.equal(g.state().active, true);
  needed = false;
  g.tick();
  assert.equal(killed, 1);
  assert.equal(g.state().active, false);
  needed = true;
  g.tick();
  child.emit('error', new Error('denied'));
  assert.equal(g.state().active, false);
  assert.equal(g.state().error, 'denied');
});
