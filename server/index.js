import { campaignExportCsv } from './campaign-export.js';
import { auditReportTo, executionReportTo } from './report-recipients.js';
import {
  verificationMode,
  runtimeMode,
  draining,
  beginDrain,
  bindHost,
  waitForActivities,
  accessGuard,
} from './runtime-policy.js';
import { returnToPool } from './return-to-pool.js';
import { preflightAddresses, applyPreflight } from './address-preflight.js';
import { pendingSelection, markHandled } from './followup-workflow.js';
import { taskWorkspace, attachImportTask, renameImportTask } from './import-tasks.js';
import { followupXlsx } from './followup-export.js';
import { backupState } from './backup-status.js';
import { linkLegacyRetries } from './batch-link.js';
import './delivery-recovery.js';
import { prepareRetry } from './delivery-policy.js';
import {
  inboxState,
  getThread,
  threadForFollowup,
  syncInbox,
  setThreadRead,
  saveDraft,
  queueDraft,
  deleteDraft,
  generateSuggestion,
  replyPreset,
  saveReplyPreset,
} from './inbox.js';
import { eligibleAccounts, importBatch, startBatch } from './import-batch.js';
import { builderSources, previewBuilder, createBuilder } from './campaign-builder.js';
import { awakeState } from './awake.js';
import { createBatch, ensureBatch, batches, retryReport, sampleReports } from './batch-reports.js';
import {
  marketingClient,
  marketingAudiences,
  marketingGroups,
  syncMarketing,
  marketingTest,
} from './marketing.js';
import { followupState, syncMail, setTracking, tracking } from './followup.js';
import express from 'express';
import { allowedHosts, privateAddress } from './access.js';
const lanAccess = process.env.LAN_ACCESS === 'true';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { all, get, put, remove, encrypt, decrypt, db } from './store.js';
import { normalizeList, validateCampaign, csv, emailValid } from './domain.js';
import { settings, transport, sendOne, verifyAccount, accountConcurrency } from './mailer.js';
import { haltState, setHalt } from './send-halt.js';
import { dailyCapFor, sentToday, localParts, TIME_ZONE } from './send-policy.js';
import { checkSenderDomain } from './sender-domain.js';
const app = express(),
  port = Number(process.env.PORT || 4173),
  csrf = randomBytes(32).toString('hex');
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
// These probes expose no account or application data and work behind Caster's probe host.
app.get('/health_check', (_, res) => res.json({ ok: true }));
app.get('/ready', (_, res) =>
  res.status(draining ? 503 : 200).json({ ready: !draining, mode: runtimeMode }),
);
app.use((req, res, next) => (draining ? res.status(503).json({ error: '平台正在停止' }) : next()));
app.use((req, res, next) => {
  const host = req.hostname;
  if (
    !(
      allowedHosts(lanAccess).includes(host) ||
      (accessGuard.publicHost && host === accessGuard.publicHost)
    ) ||
    (lanAccess && !privateAddress(req.socket.remoteAddress))
  )
    return res.status(403).json({ error: '仅允许本机或已开放的局域网访问' });
  res.setHeader('Cache-Control', 'no-store');
  if (!accessGuard.authenticate(req.headers.authorization)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Postlane", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (verificationMode)
      return res.status(403).json({ error: '演示核验模式：仅允许读取', code: 'EVERIFICATION' });
    const token = String(req.headers['x-postlane-token'] || '');
    if (token.length !== csrf.length || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf)))
      return res.status(403).json({ error: '页面会话已过期，请刷新页面' });
    if (
      req.headers.origin &&
      req.headers.origin !== (accessGuard.publicOrigin || `http://${req.headers.host}`)
    )
      return res.status(403).json({ error: '来源无效' });
  }
  next();
});
app.use(express.json({ limit: '12mb' }));
const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
// Accounts added before the warm-up ramp existed have no start date. Backfill once so the
// daily allowance has a baseline instead of jumping straight to the ceiling.
if (!verificationMode)
  for (const account of all('account'))
    if (!account.createdAt)
      put('account', { ...account, createdAt: account.verifiedAt || new Date().toISOString() });
function required(kind, id) {
  const value = get(kind, id);
  if (!value) {
    const e = new Error('记录不存在');
    e.status = 404;
    throw e;
  }
  return value;
}
function safeSettings(s = settings()) {
  if (!s) return null;
  const { password, ...rest } = s;
  return { ...rest, hasPassword: !!password };
}
function summary(c) {
  const { recipients, ...rest } = c;
  return {
    ...rest,
    total: recipients.length,
    counts: recipients.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}),
  };
}
app.get(
  '/api/import-tasks',
  wrap((req, res) => {
    const w = taskWorkspace();
    res.json({ items: w.items, campaignSlices: w.campaignSlices, at: w.at });
  }),
);
app.get(
  '/api/import-tasks/:id',
  wrap((req, res) => {
    const w = taskWorkspace(),
      task = w.items.find((t) => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: '导入任务不存在' });
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const records = [...w.groups.get(task.id).records.values()].filter(
      (r) =>
        !req.query.status ||
        (req.query.status === 'failed'
          ? r.deliveryFailed
          : req.query.status === 'scheduled'
            ? r.scheduled
            : r.status === req.query.status),
    );
    res.json({
      task,
      records: records.slice(offset, offset + 100),
      total: records.length,
      at: w.at,
    });
  }),
);
app.patch(
  '/api/import-tasks/:id',
  wrap((req, res) => {
    const d = z
      .object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(500).default(''),
      })
      .parse(req.body);
    res.json(renameImportTask(req.params.id, d));
  }),
);
app.get('/api/state', (req, res) =>
  res.json({
    token: csrf,
    runtimeMode,
    awake: awakeState(),
    backup: backupState(),
    halt: haltState(),
    timeZone: TIME_ZONE,
    accountConcurrency,
    reportRecipients: { execution: executionReportTo(), audit: auditReportTo() },
    settings: safeSettings(),
    accounts: all('account').map((a) => {
      const safe = safeSettings(a);
      return {
        ...safe,
        dailyCap: dailyCapFor(a),
        sentToday: sentToday(all('campaign'), a.id),
        sentDate: localParts().date,
      };
    }),
    lists: all('list').map(({ contacts, issues, ...l }) => ({
      ...l,
      count: contacts.length,
      issueCount: issues.length,
    })),
    campaigns: all('campaign').map(summary),
    templates: all('template'),
    followup: followupState(),
  }),
);
app.post(
  '/api/send-halt',
  wrap((req, res) => {
    const input = z
      .object({ halted: z.boolean(), reason: z.string().trim().max(200).optional() })
      .parse(req.body || {});
    res.json({ ...setHalt(input.halted, input.reason), campaigns: all('campaign').length });
  }),
);
app.get('/api/followup', (req, res) => {
  const events = taskWorkspace().events.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  res.json({ ...followupState(), events, suppressions: all('suppression') });
});
app.post(
  '/api/followup/sync',
  wrap((req, res) => {
    const { accountId } = z.object({ accountId: z.string().optional() }).parse(req.body || {});
    if (accountId) required('account', accountId);
    void syncMail({ force: true, accountId }).catch(() => {});
    res.json({ ok: true, running: true });
  }),
);
app.post(
  '/api/followup/mark-handled',
  wrap((req, res) => {
    const { ids, filters } = z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(10000),
        filters: z
          .object({
            account: z.string().optional(),
            campaign: z.string().optional(),
            importTaskId: z.string().optional(),
            query: z.string().optional(),
            from: z.string().optional(),
            to: z.string().optional(),
            handled: z.enum(['all', 'pending', 'done']).optional(),
            kind: z
              .enum([
                'all',
                'actionable',
                'reply',
                'archive_reply',
                'auto_reply',
                'bounce',
                'delivery_notice',
                'folder',
              ])
              .optional(),
          })
          .strict(),
      })
      .strict()
      .parse(req.body);
    const result = db.transaction(() => {
      const matches = pendingSelection(taskWorkspace().events, filters, ids);
      const at = new Date().toISOString();
      for (const match of matches)
        put('mail-event', markHandled(required('mail-event', match.id), at));
      return { updated: matches.length, skipped: new Set(ids).size - matches.length };
    })();
    res.json(result);
  }),
);
app.patch(
  '/api/followup/events/:id',
  wrap((req, res) => {
    const { handled, disposition } = z
      .object({ handled: z.boolean(), disposition: z.enum(['no_reply', 'pending']).optional() })
      .parse(req.body);
    res.json(
      put('mail-event', {
        ...required('mail-event', req.params.id),
        handled,
        handlingSource: 'manual',
        ...(disposition
          ? { followupDisposition: disposition === 'no_reply' ? 'no_reply' : null }
          : {}),
        handledAt: handled ? new Date().toISOString() : null,
      }),
    );
  }),
);
app.put(
  '/api/campaigns/:id/tracking',
  wrap((req, res) => {
    const c = required('campaign', req.params.id);
    const d = z
      .object({ enabled: z.boolean(), days: z.number().int().min(1).max(90).optional() })
      .parse(req.body);
    res.json(
      setTracking(c, {
        enabled: d.enabled,
        ...(d.days ? { until: new Date(Date.now() + d.days * 86400000).toISOString() } : {}),
      }),
    );
  }),
);
app.get(
  '/api/followup/export',
  wrap(async (req, res) => {
    const filters = z
      .object({
        importTaskId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        account: z.string().optional(),
        campaign: z.string().optional(),
        handled: z.enum(['all', 'pending', 'done']).optional(),
        kind: z
          .enum([
            'all',
            'actionable',
            'reply',
            'archive_reply',
            'auto_reply',
            'bounce',
            'delivery_notice',
            'folder',
          ])
          .optional(),
        query: z.string().optional(),
      })
      .parse(req.query);
    const buffer = await followupXlsx(
      {
        events: taskWorkspace().events,
        replies: all('reply-draft'),
        messages: all('inbox-message'),
        campaigns: all('campaign'),
        lists: all('list'),
        accounts: all('account'),
      },
      filters,
    );
    res
      .attachment('postlane-followup.xlsx')
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(buffer);
  }),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});
let importing = false;
app.post(
  '/api/import',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new Error('请选择表格文件');
    if (!/\.(xlsx|csv)$/i.test(req.file.originalname))
      throw new Error('支持 .xlsx 和 UTF-8 .csv；旧版 .xls 请另存为 .xlsx');
    if (importing) throw new Error('正在解析另一份表格，请稍后重试');
    importing = true;
    try {
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./import-worker.js', import.meta.url), {
          workerData: { buffer: req.file.buffer, csv: /\.csv$/i.test(req.file.originalname) },
          resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 },
        });
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('表格解析超时，请缩小文件后重试'));
        }, 15000);
        worker.once('message', (r) => {
          clearTimeout(timeout);
          worker.terminate();
          r.error ? reject(new Error(r.error)) : resolve(r);
        });
        worker.once('error', () => {
          clearTimeout(timeout);
          reject(new Error('文件过大或损坏，请检查后重新导入'));
        });
        worker.once('exit', (code) => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error('解析中断，请缩小表格后重试'));
        });
      });
      res.json({ ...result, sourceFileName: req.file.originalname });
    } finally {
      importing = false;
    }
  }),
);
const listSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  sourceFileName: z.string().max(300).optional(),
  sheetName: z.string().max(100).optional(),
  requestId: z.string().max(100).optional(),
  emailColumn: z.string().min(1).max(100),
  rows: z
    .array(z.record(z.string().max(100), z.string().max(5000)))
    .min(1)
    .max(10000),
});
async function preflightInput(input, { domainRules = true } = {}) {
  const parsed = listSchema.parse(input);
  return preflightAddresses(
    parsed.rows.map((r) => r[parsed.emailColumn]),
    {
      lookupSuppression: (email) => get('suppression', email),
      domainRules,
    },
  );
}
async function builderPreflight(input) {
  if (input.imported) return preflightInput(input.imported);
  const ids = z
    .array(z.string())
    .max(500)
    .parse(input.listIds || []);
  const emails = ids.flatMap((id) => (get('list', id)?.contacts || []).map((r) => r.email));
  if (emails.length > 50000) throw Error('请减少本次选择的来源名单');
  return preflightAddresses(emails, { lookupSuppression: (email) => get('suppression', email) });
}
app.post(
  '/api/address-preflight',
  wrap(async (req, res) => {
    const results = await preflightInput(req.body);
    res.json({
      results,
      counts: Object.fromEntries(
        ['invalid', 'warning', 'clear'].map((s) => [
          s,
          results.filter((r) => r.status === s).length,
        ]),
      ),
    });
  }),
);
app.post(
  '/api/lists',
  wrap(async (req, res) => {
    const input = listSchema.parse(req.body);
    const { name, rows, emailColumn } = input;
    if (input.requestId) {
      const old = get('list-import-request', input.requestId);
      if (old) {
        if (old.input !== JSON.stringify(input)) throw Error('导入内容已变化，请重新确认');
        return res.json(old.result);
      }
    }
    if (!Object.hasOwn(rows[0], emailColumn)) throw new Error('请选择正确的邮箱列');
    // Import only drops rows that can never be delivered (format, duplicates, suppression);
    // placeholder/role judgements belong to the send-time review, where they are visible.
    const review = await preflightInput(input, { domainRules: false });
    const list = applyPreflight(normalizeList(name, rows, emailColumn), review);
    list.contacts = list.contacts.filter((r) => {
      const blocked = get('suppression', r.email);
      if (!blocked) return true;
      list.issues.push({
        row:
          rows.findIndex(
            (v) =>
              String(v[emailColumn] || '')
                .trim()
                .toLowerCase() === r.email,
          ) + 2,
        email: r.email,
        reason: blocked.reason,
      });
      return false;
    });
    if (!list.contacts.length) throw new Error('没有可用邮箱，请检查邮箱列和表格内容');
    const result = db.transaction(() => {
      const prior = input.requestId && get('list-import-request', input.requestId);
      if (prior) {
        if (prior.input !== JSON.stringify(input)) throw Error('导入内容已变化，请重新确认');
        return prior.result;
      }
      const saved = put('list', attachImportTask(list, input));
      if (input.requestId)
        put('list-import-request', {
          id: input.requestId,
          input: JSON.stringify(input),
          result: saved,
        });
      return saved;
    })();
    res.json(result);
  }),
);
app.get(
  '/api/lists/:id',
  wrap((req, res) => res.json(required('list', req.params.id))),
);
app.delete(
  '/api/lists/:id',
  wrap((req, res) => {
    required('list', req.params.id);
    remove('list', req.params.id);
    res.json({ ok: true });
  }),
);
app.get(
  '/api/lists/:id/issues',
  wrap((req, res) => {
    const l = required('list', req.params.id);
    res
      .attachment('import-issues.csv')
      .type('text/csv')
      .send(
        csv([
          ['原表行号（忽略全空行）', '邮箱', '原因'],
          ...l.issues.map((r) => [r.row, r.email, r.reason]),
        ]),
      );
  }),
);
app.get('/api/sample', (_, res) =>
  res
    .attachment('postlane-batch-tasks.csv')
    .type('text/csv')
    .send(
      csv([
        ['邮箱', '标题', '正文'],
        ['lin@example.com', '合作沟通', '你好！\n\n希望与你交流合作的可能，期待你的回复。'],
        ['chen@example.com', '活动邀请', '你好！\n\n邀请你参加我们的交流活动，欢迎回复了解详情。'],
        ['zhou@example.com', '交流跟进', '你好！\n\n感谢此前的交流，如有新的想法，欢迎随时联系。'],
      ]),
    ),
);
const campaignSchema = z.object({
  name: z.string().trim().min(1).max(100),
  subject: z.string().max(300),
  body: z.string().max(30000),
  listId: z.string(),
  mode: z.enum(['simulation', 'live']),
  rate: z.number().int().min(1).max(60),
  randomInterval: z.boolean().default(true),
  marketingImportConsent: z.boolean().default(false),
  plainOnly: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
  accountId: z.string().optional(),
  senderEmail: z.string().refine(emailValid).optional(),
  scheduledAt: z.string().nullable().optional(),
});
function campaignData(data) {
  const d = campaignSchema.parse(data),
    list = d.listId ? required('list', d.listId) : null;
  if (settings(d.accountId)?.replyOnly) throw Error('该账号只做回复用，不能用于批量发送');
  if (d.scheduledAt && !Number.isFinite(Date.parse(d.scheduledAt))) throw new Error('预约时间无效');
  return {
    ...d,
    listName: list?.name || '',
    recipients: list
      ? list.contacts.map((r) => ({
          ...r,
          fields: {
            ...r.fields,
            source_list_id: r.fields?.source_list_id || list.id,
            source_recipient_id: r.fields?.source_recipient_id || r.id,
          },
          status: 'pending',
          error: '',
        }))
      : [],
  };
}
app.post(
  '/api/campaigns',
  wrap((req, res) =>
    res.json(
      put('campaign', {
        ...campaignData(req.body),
        id: randomUUID(),
        status: 'draft',
        createdAt: new Date().toISOString(),
      }),
    ),
  ),
);
app.put(
  '/api/campaigns/:id',
  wrap((req, res) => {
    const c = required('campaign', req.params.id);
    if (c.status !== 'draft') throw new Error('只有草稿可以编辑');
    res.json(put('campaign', { ...c, ...campaignData(req.body) }));
  }),
);
app.get(
  '/api/campaigns/:id',
  wrap((req, res) => {
    const c = required('campaign', req.params.id);
    res.json({ ...c, tracking: tracking(c) });
  }),
);
app.post(
  '/api/campaigns/:id/action',
  wrap((req, res) => {
    const c = required('campaign', req.params.id),
      action = req.body.action;
    if (['start', 'resume', 'retry'].includes(action)) {
      if (action === 'start' && c.status !== 'draft') throw new Error('任务已经启动，请勿重复提交');
      if (action === 'resume' && c.status !== 'paused') throw new Error('此任务未暂停');
      if (action === 'retry' && !['completed_errors', 'completed', 'cancelled'].includes(c.status))
        throw new Error('请等待任务结束后重试');
      if (c.mode === 'live' && req.body.confirmLive !== true) throw new Error('请确认真实发送');
      validateCampaign(c);
      if (settings(c.accountId)?.replyOnly) throw Error('该账号只做回复用，不能用于批量发送');
      if (c.mode === 'live') {
        const account = c.accountId ? required('account', c.accountId) : settings();
        if (account?.disabled) throw new Error('发件账号已停用');
        if (!account?.password) throw new Error('请先配置发件账号');
        if (c.senderEmail && c.senderEmail !== account.from) throw new Error('任务发件账号不匹配');
        if (!c.accountId) {
          c.accountId = randomUUID();
          put('account', { ...account, id: c.accountId });
        }
        c.senderEmail = account.from;
        if (account.provider === 'mailchimp-marketing') {
          if (!account.audienceId) throw new Error('请先在发件设置中选择 Mailchimp Audience');
          if (req.body.marketingFooterAccepted !== true)
            throw new Error('请确认 Marketing 邮件包含退订和受众地址页脚');
          marketingGroups(c);
          c.provider = 'mailchimp-marketing';
          if (action === 'retry' && c.marketing)
            c.marketing.groups.push(
              ...marketingGroups({
                ...c,
                recipients: c.recipients.filter((r) => r.status === 'failed'),
              }),
            );
        }
      }
      if (action === 'retry') {
        if (!c.recipients.some((r) => r.status === 'failed'))
          throw new Error('没有可重试的失败收件人');
        c.recipients.forEach((r) => {
          if (r.status === 'failed') prepareRetry(r);
        });
      }
      c.recoveryVersion = 2;
      c.completedAt = undefined;
      c.status =
        action === 'start' && c.scheduledAt && Date.parse(c.scheduledAt) > Date.now()
          ? 'scheduled'
          : 'running';
      c.startedAt ||= new Date().toISOString();
      c.nextAt = 0;
    } else if (action === 'pause') {
      if (!['running', 'scheduled'].includes(c.status)) throw new Error('此任务当前无法暂停');
      Object.assign(c, returnToPool(c));
    } else if (action === 'cancel' || action === 'return_pool') {
      if (
        ![
          'running',
          'scheduled',
          'paused',
          'draft',
          'attention',
          ...(action === 'return_pool' ? ['cancelled'] : []),
        ].includes(c.status)
      )
        throw new Error('此任务已经结束');
      if (action === 'return_pool') c.returnedToPool = true;
      c.status = 'cancelled';
      c.completedAt = new Date().toISOString();
      c.recipients.forEach((r) => {
        if (['pending', 'retry_wait'].includes(r.status)) r.status = 'cancelled';
      });
    } else throw new Error('未知操作');
    put('campaign', c);
    if (['start', 'resume'].includes(action)) ensureBatch(c);
    res.json(c);
  }),
);
app.post(
  '/api/campaigns/:id/recipients/:recipientId/retry',
  wrap((req, res) => {
    const c = required('campaign', req.params.id);
    if (req.body.confirmLive !== true) throw Error('请确认发送');
    const row = c.recipients.find((r) => r.id === req.params.recipientId);
    if (!row) throw Error('收件任务不存在');
    prepareRetry(row, req.body.confirmUncertain === true);
    c.recoveryVersion = 2;
    c.status = 'running';
    c.completedAt = undefined;
    put('campaign', c);
    ensureBatch(c);
    res.json(c);
  }),
);
app.get(
  '/api/campaigns/:id/export',
  wrap((req, res) =>
    res
      .attachment('postlane-results.csv')
      .type('text/csv')
      .send(campaignExportCsv(required('campaign', req.params.id))),
  ),
);
const smtpSchema = z.object({
  provider: z.literal('smtp').default('smtp'),
  name: z.string().trim().min(1).max(80),
  from: z.string().refine(emailValid, '发件邮箱格式不正确'),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(254),
  password: z.string().max(1000).optional(),
  // Optional override for the warm-up ramp; still capped at 200/day by send-policy.
  dailyCap: z.number().int().min(1).max(200).optional(),
});

const accountSchema = z.union([
  z.object({
    provider: z.literal('mailchimp-marketing'),
    name: z.string().trim().min(1).max(80),
    from: z.string().trim().refine(emailValid, '发件邮箱格式不正确'),
    password: z.string().trim().max(1000).optional(),
    server: z.string().regex(/^us\d{1,4}$/, '服务器前缀格式应为 us21'),
    audienceId: z
      .string()
      .regex(/^[a-zA-Z0-9]*$/)
      .max(100)
      .default(''),
  }),
  smtpSchema,
  z.object({
    provider: z.literal('mailchimp'),
    name: z.string().trim().min(1).max(80),
    from: z.string().trim().refine(emailValid, '发件邮箱格式不正确'),
    password: z.string().trim().max(1000).optional(),
  }),
]);

app.post(
  '/api/accounts',
  wrap((req, res) => {
    const d = accountSchema.parse(req.body);
    if (!d.password)
      throw new Error(
        d.provider === 'mailchimp-marketing'
          ? '请输入 Marketing API Key'
          : d.provider === 'mailchimp'
            ? '请输入 Transactional API Key'
            : '请输入应用密码',
      );
    if (
      all('account').some(
        (a) =>
          a.from.toLowerCase() === d.from.toLowerCase() && (a.provider || 'smtp') === d.provider,
      )
    )
      throw new Error('该邮箱已添加，请编辑已有账号');
    res.json(
      safeSettings(
        put('account', {
          ...d,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          password: encrypt(d.password),
        }),
      ),
    );
  }),
);
app.put(
  '/api/accounts/:id',
  wrap((req, res) => {
    const old = required('account', req.params.id),
      d = accountSchema.parse(req.body);
    if (
      all('campaign').some(
        (c) => c.accountId === old.id && ['running', 'paused', 'scheduled'].includes(c.status),
      )
    )
      throw new Error('该账号有未结束的任务，请先结束任务');
    if (d.provider !== (old.provider || 'smtp')) throw new Error('更换发送渠道请新增账号');
    if (d.from.toLowerCase() !== old.from.toLowerCase()) throw new Error('更换邮箱请新增账号');
    res.json(
      safeSettings(
        put('account', {
          ...old,
          ...d,
          id: old.id,
          password: d.password ? encrypt(d.password) : old.password,
        }),
      ),
    );
  }),
);
app.patch(
  '/api/accounts/:id/usage',
  wrap((req, res) => {
    const account = required('account', req.params.id);
    const usage = z
      .object({ replyOnly: z.boolean(), defaultManualSender: z.boolean() })
      .parse(req.body);
    if (
      all('campaign').some(
        (c) => c.accountId === account.id && ['running', 'scheduled', 'paused'].includes(c.status),
      )
    )
      throw Error('账号有未结束的发送任务，请先结束任务');
    const saved = db.transaction(() => {
      if (usage.defaultManualSender)
        for (const a of all('account').filter((a) => a.id !== account.id && a.defaultManualSender))
          put('account', { ...a, defaultManualSender: false });
      return put('account', { ...account, ...usage });
    })();
    res.json(safeSettings(saved));
  }),
);
app.patch(
  '/api/accounts/:id/availability',
  wrap((req, res) => {
    const old = required('account', req.params.id);
    const input = z
      .object({ disabled: z.boolean(), reason: z.string().max(500).optional() })
      .parse(req.body);
    if (
      input.disabled &&
      (all('campaign').some(
        (c) => c.accountId === old.id && c.recipients.some((r) => r.status === 'sending'),
      ) ||
        all('reply-draft').some((d) => d.accountId === old.id && d.status === 'sending') ||
        all('batch-report').some(
          (r) => r.accountId === old.id && r.deliveries.some((d) => d.status === 'sending'),
        ))
    )
      throw Error('账号正在发送，请等待当前邮件完成后停用');
    const result = db.transaction(() => {
      const account = put('account', {
        ...old,
        disabled: input.disabled,
        disabledReason: input.disabled ? input.reason || '手动停用' : '',
        availabilityUpdatedAt: new Date().toISOString(),
      });
      if (input.disabled) {
        for (const c of all('campaign').filter(
          (c) =>
            c.accountId === old.id &&
            c.mode === 'live' &&
            ['running', 'scheduled'].includes(c.status),
        ))
          put('campaign', returnToPool(c, '发件账号已停用，未发送邮件退回未排期'));
        for (const d of all('reply-draft').filter(
          (d) => d.accountId === old.id && d.status === 'queued',
        ))
          put('reply-draft', {
            ...d,
            status: 'failed',
            error: '发件账号已停用',
            updatedAt: new Date().toISOString(),
          });
        for (const r of all('batch-report').filter((r) => r.accountId === old.id)) {
          if (!r.deliveries.some((d) => d.status === 'pending')) continue;
          put('batch-report', {
            ...r,
            deliveries: r.deliveries.map((d) =>
              d.status === 'pending' ? { ...d, status: 'failed', error: '发件账号已停用' } : d,
            ),
          });
        }
      }
      return account;
    })();
    res.json(safeSettings(result));
  }),
);
app.post(
  '/api/accounts/:id/verify',
  wrap(async (req, res) => {
    const account = required('account', req.params.id);
    await verifyAccount(account);
    // SPF/DKIM/DMARC are advisory: a missing record never blocks adding a sender, but the
    // operator should see it before spending the account's reputation.
    const domainCheck = await checkSenderDomain(account.from);
    put('account', {
      ...account,
      verifiedAt: new Date().toISOString(),
      createdAt: account.createdAt || new Date().toISOString(),
      domainCheck,
    });
    res.json({ ok: true, domainCheck, warnings: domainCheck.warnings });
  }),
);
app.get(
  '/api/accounts/:id/audiences',
  wrap(async (req, res) => {
    const account = required('account', req.params.id);
    if (account.provider !== 'mailchimp-marketing') throw new Error('此账号不是 Marketing 渠道');
    res.json(await marketingAudiences(marketingClient(decrypt(account.password), account.server)));
  }),
);
app.post(
  '/api/campaigns/:id/marketing-sync',
  wrap(async (req, res) => {
    const c = required('campaign', req.params.id);
    if (['running', 'scheduled'].includes(c.status)) throw new Error('请待提交结束或暂停后同步');
    const before = JSON.stringify(c);
    const account = required('account', c.accountId);
    if (account.provider !== 'mailchimp-marketing') throw new Error('此任务不是 Marketing 渠道');
    await syncMarketing(marketingClient(decrypt(account.password), account.server), c);
    if (JSON.stringify(required('campaign', c.id)) !== before)
      throw new Error('任务已发生变化，请重新同步');
    res.json(put('campaign', c));
  }),
);
app.put(
  '/api/settings',
  wrap((req, res) => {
    if (
      all('campaign').some(
        (c) => ['running', 'scheduled', 'paused'].includes(c.status) && c.mode === 'live',
      )
    )
      throw new Error('请先完成或取消进行中的真实发送任务，再更换发件账号');
    const s = smtpSchema.parse(req.body),
      old = settings();
    if (!s.password && !old?.password) throw new Error('请输入邮箱授权码或应用密码');
    put('settings', {
      ...s,
      id: 'smtp',
      password: s.password ? encrypt(s.password) : old.password,
    });
    res.json(safeSettings());
  }),
);
app.post(
  '/api/settings/verify',
  wrap(async (_, res) => {
    const t = transport();
    try {
      await t.verify();
      res.json({ ok: true });
    } finally {
      t.close();
    }
  }),
);
app.post(
  '/api/test-email',
  wrap(async (req, res) => {
    const d = z
      .object({
        accountId: z.string().optional(),
        to: z.string().refine(emailValid),
        subject: z.string().min(1).max(300),
        body: z.string().min(1).max(30000),
      })
      .parse(req.body);
    const account = d.accountId ? required('account', d.accountId) : settings();
    if (account?.disabled) throw Error('发件账号已停用');
    if (account?.provider === 'mailchimp-marketing' && !account.audienceId)
      throw new Error('请先选择 Mailchimp Audience');
    const result =
      account?.provider === 'mailchimp-marketing'
        ? await marketingTest(
            marketingClient(decrypt(account.password), account.server),
            account,
            d.to,
            d.subject,
            d.body,
          )
        : await sendOne(account, d.to, d.subject, d.body);
    if (!result.accepted?.length) throw new Error('发送服务未接受测试邮件');
    res.json({ ok: true });
  }),
);
app.post(
  '/api/templates',
  wrap((req, res) => {
    const d = z
      .object({
        name: z.string().trim().min(1).max(100),
        subject: z.string().trim().min(1).max(300),
        body: z.string().trim().min(1).max(30000),
      })
      .parse(req.body);
    res.json(put('template', { ...d, id: randomUUID() }));
  }),
);
app.delete(
  '/api/templates/:id',
  wrap((req, res) => {
    remove('template', req.params.id);
    res.json({ ok: true });
  }),
);
app.get('/api/import-accounts', (req, res) => res.json(eligibleAccounts()));
app.get(
  '/api/campaign-builder/sources',
  wrap((req, res) => res.json(builderSources())),
);
app.post(
  '/api/campaign-builder/preview',
  wrap(async (req, res) => res.json(previewBuilder(req.body, await builderPreflight(req.body)))),
);
app.post(
  '/api/campaign-builder',
  wrap(async (req, res) => res.json(createBuilder(req.body, await builderPreflight(req.body)))),
);
app.post(
  '/api/import-batch',
  wrap(async (req, res) => res.json(importBatch(req.body, await preflightInput(req.body)))),
);
app.post(
  '/api/report-batches/:id/start',
  wrap((req, res) => {
    if (req.body.confirmLive !== true) throw Error('请确认批次真实发送');
    res.json(startBatch(req.params.id));
  }),
);
app.post(
  '/api/batch-reports/sample',
  wrap((req, res) => res.json(sampleReports(req.body))),
);
app.post(
  '/api/report-batches/link-retries',
  wrap((req, res) => res.json(linkLegacyRetries(req.body.links))),
);
app.get('/api/report-batches', (req, res) => res.json(batches()));
app.post(
  '/api/report-batches',
  wrap((req, res) => res.json(createBatch(req.body.name, req.body.campaignIds))),
);
app.get(
  '/api/batch-reports/:id',
  wrap((req, res) => {
    const r = required('batch-report', req.params.id);
    res.type('text/plain').send(r.text);
  }),
);
app.post(
  '/api/batch-reports/:id/retry',
  wrap((req, res) => res.json(retryReport(req.params.id, req.body.confirmUncertain === true))),
);

app.get(
  '/api/inbox',
  wrap((req, res) => res.json(inboxState(req.query))),
);
app.get(
  '/api/inbox/threads/:id',
  wrap((req, res) => res.json(getThread(req.params.id))),
);
app.get(
  '/api/followup/events/:id/thread',
  wrap((req, res) => res.json(threadForFollowup(req.params.id))),
);
app.post(
  '/api/inbox/sync',
  wrap((req, res) => {
    const { accountId } = z.object({ accountId: z.string().optional() }).parse(req.body || {});
    if (accountId) required('account', accountId);
    void syncInbox(accountId).catch(() => {});
    res.json({ ok: true });
  }),
);
app.patch(
  '/api/inbox/threads/:id/read',
  wrap(async (req, res) => {
    const { seen } = z.object({ seen: z.boolean() }).parse(req.body);
    res.json(await setThreadRead(req.params.id, seen));
  }),
);
const draftInput = z.object({
  id: z.string().optional(),
  version: z.number().int().optional(),
  accountId: z.string().optional(),
  threadId: z.string().nullable().optional(),
  replyMessageId: z.string().nullable().optional(),
  contextVersion: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(100000),
});
app.post(
  '/api/inbox/drafts',
  wrap((req, res) => res.json(saveDraft(draftInput.parse(req.body)))),
);
app.post(
  '/api/inbox/drafts/:id/send',
  wrap((req, res) =>
    res.json(
      queueDraft(
        req.params.id,
        z.object({ confirm: z.boolean(), version: z.number().int() }).parse(req.body),
      ),
    ),
  ),
);
app.delete(
  '/api/inbox/drafts/:id',
  wrap((req, res) => res.json(deleteDraft(req.params.id))),
);
app.get('/api/inbox/reply-preset', (req, res) => res.json(replyPreset()));
app.put(
  '/api/inbox/reply-preset',
  wrap((req, res) => {
    const { rules } = z.object({ rules: z.string().max(15000) }).parse(req.body);
    res.json(saveReplyPreset(rules));
  }),
);
app.post(
  '/api/inbox/drafts/:id/suggest',
  wrap(async (req, res) => res.json(await generateSuggestion(req.params.id))),
);

app.use('/api', (_, res) => res.status(404).json({ error: '接口不存在' }));
app.use((e, req, res, next) => {
  if (res.headersSent) return next(e);
  const message =
    e instanceof z.ZodError
      ? '请检查输入内容：' + e.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')
      : e.code === 'LIMIT_FILE_SIZE'
        ? '文件不能超过 5 MB'
        : e.message || '操作失败';
  res.status(e.status || 400).json({ error: message });
});
if (process.argv.includes('--production')) {
  const staticDir = path.resolve(process.env.STATIC_DIR || 'dist');
  app.use(express.static(staticDir));
  app.get('/{*path}', (_, res) => res.sendFile(path.join(staticDir, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true, ws: { port: 24679 } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}
const listeningOn = bindHost(lanAccess);
const httpServer = app.listen(port, listeningOn, () =>
  console.log(
    `Postlane ready: http://${listeningOn === '0.0.0.0' ? 'localhost' : listeningOn}:${port}` +
      `${lanAccess ? ' (LAN enabled)' : ''}${listeningOn === '0.0.0.0' && !lanAccess ? ' (container bind)' : ''}`,
  ),
);
let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  beginDrain();
  // Caster's grace period must exceed this deadline. A forced exit retains
  // in-flight markers so restart recovery marks them uncertain, never retries blindly.
  const deadline = setTimeout(() => process.exit(1), 45000);
  await Promise.all([new Promise((resolve) => httpServer.close(resolve)), waitForActivities()]);
  clearTimeout(deadline);
  db.close();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
