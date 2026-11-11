import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { followupExportRows, followupWorkbook, followupXlsx } from '../server/followup-export.js';
import { filterFollowup } from '../src/followup-filter.js';
process.env.POSTLANE_REPORT_TO = 'xuyuan@example.com,mtong@example.com';
function fixture() {
  const fields = {
    channel_name: '创作者',
    channel_url: 'https://youtube.com/@creator',
    email_subject: '  Original  ',
    email_content: 'Hi\n\n{{literal}}\n',
  };
  const recipient = {
    id: 'r',
    email: 'to@example.com',
    status: 'sent',
    sentAt: '2026-09-18T11:00:00Z',
    messageId: '<sent>',
    fields: { ...fields, source_list_id: 'source', source_recipient_id: 'original' },
  };
  const event = {
    id: 'e',
    accountId: 'a',
    accountEmail: 'sender@example.com',
    from: ['to@example.com'],
    to: ['sender@example.com'],
    subject: 'Re: Original',
    text: 'Response\nfull text',
    date: '2026-09-19T00:00:00Z',
    type: 'reply',
    confidence: 'message-id',
    links: [{ campaignId: 'c', recipientId: 'r', email: recipient.email }],
    handled: false,
    messageId: '<reply>',
  };
  return {
    events: [event],
    campaigns: [
      {
        id: 'c',
        name: 'Campaign',
        accountId: 'a',
        subject: '{{email_subject}}',
        body: '{{email_content}}',
        recipients: [recipient],
      },
    ],
    lists: [
      {
        id: 'source',
        name: 'Original import',
        createdAt: '2026-09-17T01:00:00Z',
        contacts: [{ id: 'original', email: recipient.email, fields }],
      },
    ],
    accounts: [
      { id: 'a', name: 'Sender', from: 'sender@example.com', password: 'never-export-secret' },
    ],
  };
}
test('exports original fields, exact message content and separate handling and reply status', () => {
  const data = fixture();
  const row = followupExportRows(data)[0];
  assert.equal(row['原始录入批次'], 'Original import');
  assert.equal(row['发送时间（北京时间）'], '2026-09-18 19:00:00');
  assert.equal(row['回复时间（北京时间）'], '2026-09-19 08:00:00');
  assert.equal(row['原邮件正文'], data.lists[0].contacts[0].fields.email_content);
  assert.equal(row['频道名称'], '创作者');
  assert.deepEqual(Object.keys(row), [
    '频道名称',
    '频道链接',
    '对方邮箱',
    '发送时间（北京时间）',
    '对方回复内容',
    '我方回复内容',
    '回复时间（北京时间）',
    '回复类型',
    '处理状态',
    '发件账号',
    '原始录入批次',
    '原邮件标题',
    '原邮件正文',
    '导入任务',
    '会话回复状态',
  ]);
  assert.ok(!Object.hasOwn(row, '备注'));
  assert.equal(row['处理状态'], '待处理');
  assert.equal(row['回复类型'], '外部回复');
  assert.ok(!JSON.stringify(row).includes('never-export-secret'));
});
test('channel ID fallback and recovered provenance survive missing original lists', () => {
  const data = fixture();
  data.lists = [];
  const r = data.campaigns[0].recipients[0];
  delete r.fields.channel_url;
  r.fields.channel_id = 'UCtYe2zSP5vEnwHFhR3ZDsIA';
  r.channelRecovery = { file: 'verified-original.xlsx', sheet: 'Sheet1', row: 2 };
  const row = followupExportRows(data)[0];
  assert.equal(row['频道链接'], 'https://www.youtube.com/channel/UCtYe2zSP5vEnwHFhR3ZDsIA');
  assert.equal(row['原始录入批次'], 'verified-original.xlsx');
  data.events[0].confidence = 'address-subject';
  assert.equal(followupExportRows(data)[0]['频道链接'], '');
  assert.equal(followupExportRows(data)[0]['原始录入批次'], '');
});
test('empty source metadata does not erase the sent snapshot and mismatched source emails are rejected', () => {
  const data = fixture();
  data.lists[0].contacts[0].fields = { channel_name: '', channel_url: '' };
  assert.equal(followupExportRows(data)[0]['频道名称'], '创作者');
  data.lists[0].contacts[0].email = 'different@example.com';
  data.lists[0].contacts[0].fields.channel_name = 'Wrong channel';
  assert.equal(followupExportRows(data)[0]['频道名称'], '创作者');
  assert.equal(followupExportRows(data)[0]['原始录入批次'], '');
});
test('different channel IDs do not combine one channel name with another channel link', () => {
  const data = fixture();
  data.campaigns[0].recipients[0].fields.channel_id = 'UCtYe2zSP5vEnwHFhR3ZDsIA';
  data.lists[0].contacts[0].fields = { channel_id: 'UCN0M7S4sZ5HSAT3ZSnKKJ2w' };
  const row = followupExportRows(data)[0];
  assert.equal(row['频道名称'], '');
  assert.equal(row['频道链接'], 'https://www.youtube.com/channel/UCN0M7S4sZ5HSAT3ZSnKKJ2w');
});
test('shared filters preserve all matching records beyond the UI display limit', () => {
  const data = fixture();
  data.events = Array.from({ length: 250 }, (_, i) => ({ ...data.events[0], id: 'e' + i }));
  data.events.push({ ...data.events[0], id: 'other', handled: true, type: 'auto_reply' });
  const filters = {
    account: 'a',
    campaign: 'c',
    kind: 'reply',
    handled: 'pending',
    query: 'FULL TEXT',
  };
  assert.equal(filterFollowup(data.events, filters).length, 250);
  assert.equal(followupExportRows(data, filters).length, 250);
  assert.equal(followupExportRows(data).length, 251);
  assert.equal(
    followupExportRows(data, { kind: 'auto_reply', handled: 'done' })[0]['回复类型'],
    '自动回复',
  );
});
test('ambiguous, missing and cross-account links never guess original content', () => {
  for (const mode of ['multi', 'missing', 'account', 'weak']) {
    const data = fixture();
    if (mode === 'multi') data.events[0].links.push({ campaignId: 'other', recipientId: 'other' });
    if (mode === 'missing') data.campaigns = [];
    if (mode === 'account') data.campaigns[0].accountId = 'other';
    if (mode === 'weak') data.events[0].confidence = 'address-subject';
    const row = followupExportRows(data)[0];

    assert.equal(row['原邮件正文'], '');
    assert.equal(row['频道名称'], '');
    assert.equal(row['对方回复内容'], 'Response\nfull text');
  }
});
test('deleted sources retain original field snapshots and legacy content matching requires uniqueness', () => {
  const data = fixture();
  data.lists = [];
  let row = followupExportRows(data)[0];
  assert.equal(row['频道名称'], '创作者');
  assert.equal(row['原始录入批次'], '');

  const legacy = fixture();
  delete legacy.campaigns[0].recipients[0].fields.source_list_id;
  assert.equal(followupExportRows(legacy)[0]['原始录入批次'], 'Original import');
  legacy.lists.push({ ...legacy.lists[0], id: 'duplicate' });
  assert.equal(followupExportRows(legacy)[0]['原始录入批次'], '');
});
test('xlsx roundtrip preserves multiline text, literal formulas, full long content and empty exports', async () => {
  const data = fixture();
  data.events[0].text = 'a' + '😀'.repeat(20000) + '\nlast';
  const workbook = await followupWorkbook(data);
  const buffer = await followupXlsx(data);
  const decoded = new ExcelJS.Workbook();
  await decoded.xlsx.load(buffer);
  const sheet = decoded.getWorksheet('回复与跟进');
  const headers = sheet.getRow(1).values;
  const value = (h) => sheet.getRow(2).getCell(headers.indexOf(h)).value;
  const zip = await JSZip.loadAsync(buffer);
  const parsed = new XMLParser({
    parseTagValue: false,
    trimValues: false,
    ignoreAttributes: false,
  }).parse(await zip.file('xl/worksheets/sheet1.xml').async('string'));
  const cells = parsed.worksheet.sheetData.row[1].c;
  const texts = cells.map((c) => c.is?.t?.['#text'] ?? c.is?.t ?? '');
  const first = workbook.worksheets[0].getRow(2).getCell(headers.indexOf('对方回复内容')).value;
  const second = workbook.worksheets[0]
    .getRow(2)
    .getCell(headers.indexOf('对方回复内容（续2）')).value;
  const decodedTexts = texts.map((t) =>
    typeof t === 'string' ? t.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))) : t,
  );
  assert.ok(decodedTexts.includes(first) && decodedTexts.includes(second));
  assert.equal(value('对方回复内容') + value('对方回复内容（续2）'), data.events[0].text);
  assert.ok(first + second === data.events[0].text);
  assert.ok(!/[\uD800-\uDBFF]$/.test(first));
  assert.equal(value('频道链接'), 'https://youtube.com/@creator');
  assert.equal(value('原邮件正文'), data.lists[0].contacts[0].fields.email_content);
  assert.equal(sheet.views[0].ySplit, 1);
  const empty = await followupWorkbook(data, { account: 'none' });
  assert.equal(empty.getWorksheet('回复与跟进').rowCount, 1);
  assert.equal(empty.getWorksheet('回复与跟进').columnCount, 15);
});

test('unlinked historical records with missing metadata still export', () => {
  const data = { events: [{ id: 'orphan', text: 'kept' }], campaigns: [], lists: [], accounts: [] };
  assert.equal(followupExportRows(data)[0]['原邮件正文'], '');
});

test('exports sent replies across sources and reference chains without duplicates or unrelated content', async () => {
  const data = fixture();
  const reply = {
    accountId: 'a',
    messageId: '<ours>',
    inReplyTo: '<reply>',
    references: ['<reply>'],
    to: 'to@example.com',
    body: 'First reply',
    status: 'sent',
    sentAt: '2026-09-19T01:00:00Z',
  };
  data.replies = [
    reply,
    { ...reply, messageId: '<draft>', status: 'draft', body: 'DRAFT' },
    { ...reply, messageId: '<failed>', status: 'failed', body: 'FAILED' },
    { ...reply, messageId: '<uncertain>', status: 'uncertain', body: 'UNCERTAIN' },
    { ...reply, messageId: '<wrong-account>', accountId: 'other', body: 'OTHER' },
    { ...reply, messageId: '<internal>', to: 'mtong@example.com', body: 'INTERNAL' },
    { ...reply, messageId: '<old>', sentAt: '2026-09-18T00:00:00Z', body: 'OLD' },
  ];
  data.messages = [
    {
      ...reply,
      to: [reply.to],
      date: reply.sentAt,
      text: 'Synced copy',
      remote: true,
      outgoing: true,
      folders: ['sent'],
    },
    {
      accountId: 'a',
      messageId: '<remote>',
      inReplyTo: '<later-incoming>',
      references: ['<reply>'],
      to: ['to@example.com'],
      date: '2026-09-19T02:00:00Z',
      text: 'Later reply',
      remote: true,
      outgoing: true,
      folders: ['sent'],
    },
    {
      accountId: 'a',
      messageId: '<unrelated>',
      to: ['to@example.com'],
      subject: 'Re: Original',
      date: reply.sentAt,
      text: 'SAME SUBJECT',
      remote: true,
      outgoing: true,
      folders: ['sent'],
    },
  ];
  const expected = '[2026-09-19 09:00:00]\nFirst reply\n\n[2026-09-19 10:00:00]\nLater reply';
  assert.equal(followupExportRows(data)[0]['我方回复内容'], expected);
  const workbook = await followupWorkbook(data, { kind: 'reply' });
  const sheet = workbook.worksheets[0];
  assert.equal(
    sheet.getRow(2).getCell(sheet.getRow(1).values.indexOf('我方回复内容')).value,
    expected,
  );
  data.events[0].type = 'auto_reply';
  assert.equal(followupExportRows(data)[0]['我方回复内容'], '');
});

test('explicit source account links a cross-account reply to the original follow-up export', () => {
  const data = fixture();
  data.replies = [
    {
      accountId: 'manual',
      sourceAccountId: 'a',
      messageId: '<cross>',
      inReplyTo: '<reply>',
      to: 'to@example.com',
      body: 'Manual account response',
      status: 'sent',
      sentAt: '2026-09-19T01:00:00Z',
    },
  ];
  assert.match(followupExportRows(data)[0]['我方回复内容'], /Manual account response/);
  delete data.replies[0].sourceAccountId;
  assert.equal(followupExportRows(data)[0]['我方回复内容'], '');
  data.replies[0].referenceLinks = [{ accountId: 'a', messageId: '<reply>' }];
  assert.match(followupExportRows(data)[0]['我方回复内容'], /Manual account response/);
});
