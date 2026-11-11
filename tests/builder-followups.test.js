import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.POSTLANE_MODE = 'live';
process.env.DISABLE_BACKUP = 'true';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-builder-'));

const { all, db, encrypt, get, put } = await import('../server/store.js');
const { eligibleAccounts } = await import('../server/import-batch.js');
const { createCampaignBuilder } = await import('../server/campaign-builder-core.js');

put('account', {
  id: 'acct-1',
  name: 'Brian',
  from: 'brian@sender.dev',
  email: 'brian@sender.dev',
  user: 'brian@sender.dev',
  password: encrypt('secret'),
  server: '127.0.0.1',
  port: 2525,
  secure: false,
  createdAt: new Date('2020-01-01T00:00:00Z').toISOString(),
  verifiedAt: new Date('2020-01-01T00:00:00Z').toISOString(),
});

const { previewBuilder, createBuilder } = createCampaignBuilder({
  attachImportTask: (value) => value,
  all,
  get,
  put,
  transaction: (callback) => db.transaction(callback),
  eligibleAccounts,
  createBatch: (name, ids) => ({ id: 'batch-1', name, campaignIds: ids }),
});

const rows = [
  {
    business_email: 'lead1@prospect.dev',
    邮件标题: '关于排期',
    邮件正文: '第一封给 {{公司}}',
    公司: '甲乙丙',
    第二封跟进: '第二封，还是想确认一下 {{公司}} 这边',
    第三封跟进: '主题：最后一问\n第三封收个尾',
  },
  {
    business_email: 'lead2@prospect.dev',
    邮件标题: '只发一封',
    邮件正文: '没有跟进的人',
    公司: '丁戊己',
    第二封跟进: '',
    第三封跟进: '',
  },
];

const input = (extra = {}) => ({
  name: '跟进任务',
  accountIds: ['acct-1'],
  listIds: [],
  imported: {
    name: '导入表',
    description: '',
    sourceFileName: 'leads.xlsx',
    sheetName: 'Sheet1',
    rows,
    emailColumn: 'business_email',
    subjectColumn: '邮件标题',
    bodyColumn: '邮件正文',
  },
  archiveTo: [],
  mode: 'simulation',
  randomInterval: false,
  unsubscribe: false,
  ...extra,
});

test('建任务：跟进列按「5 天 / 再 10 天」进入每个收件人的计划', () => {
  const preview = previewBuilder(input(), []);
  assert.equal(preview.formal, 2);
  assert.deepEqual(preview.followUps, { second: 1, third: 1, delays: [5, 10] });
  // 没有跟进列的人不会被硬塞跟进。
  assert.equal(preview.samples.length > 0, true);
});

test('建任务：收件人带上解析好的跟进内容与初始 stage', () => {
  const payload = input({ mode: 'simulation' });
  const preview = previewBuilder(payload, []);
  const result = createBuilder(
    { ...payload, requestId: 'req-00000001', fingerprint: preview.fingerprint, action: 'start' },
    [],
  );
  assert.equal(result.campaignIds.length, 1);
  const campaign = get('campaign', result.campaignIds[0]);
  assert.deepEqual(campaign.followUpDelays, [5, 10]);
  const [withFollowUps, without] = campaign.recipients;
  assert.equal(withFollowUps.stage, 0);
  assert.deepEqual(
    withFollowUps.followUps.map((s) => [s.subject, s.body, s.afterDays]),
    [
      // 变量在发送时才渲染，计划里存的是原始模板。
      ['', '第二封，还是想确认一下 {{公司}} 这边', 5],
      ['最后一问', '第三封收个尾', 10],
    ],
  );
  assert.deepEqual(without.followUps, [], '空单元格就是没有跟进');
});

test('建任务：间隔可以自定义，非法值会被拒', () => {
  const preview = previewBuilder(input({ followUpDelays: [3, 14] }), []);
  assert.deepEqual(preview.followUps.delays, [3, 14]);
  assert.throws(() => previewBuilder(input({ followUpDelays: [0] }), []));
  assert.throws(() => previewBuilder(input({ followUpDelays: [5, 10, 20] }), []));
});

test('建任务：跟进用到首封没有的变量时要报错，不能悄悄留空', () => {
  const broken = input();
  broken.imported.rows = [
    {
      business_email: 'lead3@prospect.dev',
      邮件标题: '主题',
      邮件正文: '正文',
      第二封跟进: '你好 {{不存在的变量}}',
    },
  ];
  assert.throws(() => previewBuilder(broken, []), /跟进缺少变量/);
});
