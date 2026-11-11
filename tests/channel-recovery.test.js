import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverChannels } from '../server/channel-recovery.js';
import { normalizeList } from '../server/domain.js';
import { channelMetadata } from '../server/channel-metadata.js';
const id = 'UCtYe2zSP5vEnwHFhR3ZDsIA';
const fields = { email_subject: ' Subject ', email_content: 'Body\n' };
const sources = [
  {
    file: 'original.xlsx',
    sheet: 'Sheet1',
    row: 2,
    fields: {
      ...fields,
      business_email: 'TO@example.com',
      channel_id: id,
      channel_name: 'Channel',
    },
  },
];
const document = () => ({
  kind: 'campaign',
  value: {
    id: 'c',
    subject: '{{email_subject}}',
    body: '{{email_content}}',
    status: 'completed',
    recipients: [
      { id: 'r', email: 'to@example.com', status: 'sent', sentAt: 'saved', fields: { ...fields } },
    ],
  },
});
test('import retains arbitrary source columns and derives links only from valid channel IDs', () => {
  const l = normalizeList(
    'test',
    [{ email: 'to@example.com', 频道ID: id, 频道名称: 'Channel', ...fields, custom: 'Keep me' }],
    'email',
  );
  assert.equal(l.contacts[0].fields.channel_url, `https://www.youtube.com/channel/${id}`);
  assert.equal(l.contacts[0].fields['频道ID'], id);
  assert.equal(l.contacts[0].fields.custom, 'Keep me');
  assert.equal(l.contacts[0].fields.email_content, fields.email_content);
  assert.equal(channelMetadata({ channel_id: 'not-a-channel' }).channel_url, '');
});
test('recovery is exact, non-mutating, idempotent and preserves delivery state', () => {
  const original = document(),
    before = structuredClone(original);
  const result = recoverChannels([original], sources);
  assert.equal(result.changes.length, 1);
  const r = result.changes[0].value.recipients[0];
  assert.equal(r.fields.channel_name, 'Channel');
  assert.equal(r.channelRecovery.row, 2);
  assert.equal(r.status, 'sent');
  assert.equal(r.sentAt, 'saved');
  assert.equal(r.fields.email_subject, fields.email_subject);
  assert.deepEqual(original, before);
  assert.equal(recoverChannels(result.changes, sources).changes.length, 0);
  const different = document();
  different.value.recipients[0].fields.email_content += 'different';
  assert.equal(recoverChannels([different], sources).changes.length, 0);
  assert.equal(recoverChannels([document()], [...sources, ...sources]).conflicts.length, 1);
  const conflict = document();
  conflict.value.recipients[0].fields.channel_name = 'Other';
  assert.equal(recoverChannels([conflict], sources).conflicts.length, 1);
});
test('recovery refuses metadata that would change a historical rendered message', () => {
  const d = document();
  d.value.subject = '{{channel_name}} Subject ';
  // With the old missing name this renders exactly the source title.
  assert.equal(recoverChannels([d], sources).conflicts[0].reason, 'would alter rendered message');
});
