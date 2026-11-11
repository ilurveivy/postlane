import { applyPreflight } from './address-preflight.js';
import { archiveRecipients } from './report-recipients.js';
import { DEFAULT_WINDOW, TIME_ZONE, dailyCapFor, minutesOf, sentToday } from './send-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeList, render, validateCampaign, variables } from './domain.js';
import {
  DEFAULT_FOLLOW_UP_DELAYS,
  MAX_FOLLOW_UP_DELAY_DAYS,
  buildFollowUpPlan,
  detectFollowUpColumns,
  validateFollowUpPlan,
} from './followups.js';
import { unsubscribeLinkAvailable } from './unsubscribe.js';
import { unscheduledLists } from '../src/unscheduled.js';

export { archiveRecipients };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  accountIds: z.array(z.string().min(1)).min(1).max(200),
  listIds: z.array(z.string().min(1)).max(500).default([]),
  imported: z
    .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().max(500).optional(),
      sourceFileName: z.string().max(300).optional(),
      sheetName: z.string().max(100).optional(),
      rows: z
        .array(z.record(z.string().max(100), z.string().max(5000)))
        .min(1)
        .max(10000),
      emailColumn: z.string().min(1),
      subjectColumn: z.string().min(1),
      bodyColumn: z.string().min(1),
      // 【第二封跟进】/【第三封跟进】. Detected from the header when not passed explicitly.
      followUpColumns: z.array(z.string().min(1)).max(2).default([]),
    })
    .optional(),
  limit: z.number().int().min(1).max(10000).optional(),
  archiveTo: z
    .array(
      z
        .string()
        .trim()
        .max(200)
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
    )
    .max(2)
    .default([]),
  mode: z.enum(['live', 'simulation']).default('simulation'),
  scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
  randomInterval: z.boolean().default(true),
  // Opt-out copy and the sending window are per task, because tone and allowed hours
  // differ between one-off outreach and a long nurture batch.
  unsubscribe: z.boolean().default(false),
  sendWindow: z
    .object({
      enabled: z.boolean().default(true),
      days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default(DEFAULT_WINDOW.days),
      start: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default(DEFAULT_WINDOW.start),
      end: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default(DEFAULT_WINDOW.end),
    })
    .default({ ...DEFAULT_WINDOW }),
  rate: z.number().int().min(1).max(60).default(1),
  // Days to wait before 第二封 / 第三封, counted from the email before it. A follow-up is
  // only sent when the previous email is confirmed delivered and no reply has arrived.
  followUpDelays: z
    .array(z.number().int().min(1).max(MAX_FOLLOW_UP_DELAY_DAYS))
    .min(1)
    .max(2)
    .default(DEFAULT_FOLLOW_UP_DELAYS),
});

export function createCampaignBuilder({
  all,
  get,
  put,
  transaction,
  eligibleAccounts,
  createBatch,
  attachImportTask,
}) {
  function builderSources() {
    const lists = all('list').sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return {
      lists: unscheduledLists(lists, all('campaign')).map((l) => ({
        id: l.id,
        name: l.name,
        importTaskName:
          all('import-task').find((t) => t.sourceListIds?.includes(l.id))?.name || l.name,
        createdAt: l.createdAt,
        count: l.contacts.length,
      })),
      archiveRecipients: archiveRecipients(),
      sendWindowDefaults: DEFAULT_WINDOW,
      timeZone: TIME_ZONE,
      accounts: eligibleAccounts().map((a) => ({
        ...a,
        dailyCap: dailyCapFor(get('account', a.id)),
        sentToday: sentToday(all('campaign'), a.id),
      })),
    };
  }

  function prepare(input, review = [], candidatesOnly = false) {
    const d = inputSchema.parse(input);
    const checks = new Map(review.map((r) => [r.email, r]));
    for (const values of [d.accountIds, d.listIds, d.archiveTo])
      if (new Set(values).size !== values.length) throw Error('账号、批次或副本收件人不能重复选择');
    if (!d.listIds.length === !d.imported) throw Error('请选择未排期批次，或导入一份表格');
    if (d.sendWindow.enabled && !(minutesOf(d.sendWindow.start) < minutesOf(d.sendWindow.end)))
      throw Error('发送时间段需要「开始」早于「结束」');
    if (d.scheduledAt && Date.parse(d.scheduledAt) <= Date.now())
      throw Error('请选择未来的预约时间');
    const eligible = eligibleAccounts();
    const accounts = d.accountIds.map((id) => {
      const a = eligible.find((a) => a.id === id);
      if (!a) throw Error('所选账号已不可用，请刷新后重新选择');
      return a;
    });
    // Multiple records for the same SMTP login must not be treated as distinct accounts.
    const logins = accounts.map((a) => {
      const full = get('account', a.id);
      return (full.user || full.from).trim().toLowerCase();
    });
    if (new Set(logins).size !== logins.length) throw Error('所选账号包含相同的 SMTP 登录邮箱');
    let sources,
      importedList,
      issues = [];
    if (d.imported) {
      const v = d.imported;
      const cols = [v.emailColumn, v.subjectColumn, v.bodyColumn];
      if (new Set(cols).size !== 3 || cols.some((c) => !Object.hasOwn(v.rows[0], c)))
        throw Error('请选择不同的邮箱、标题和正文列');
      // Canonical fields preserve the original title/body even when custom columns are used.
      importedList = normalizeList(
        v.name,
        v.rows.map((row) => ({
          ...row,
          email_subject: row[v.subjectColumn] ?? '',
          email_content: row[v.bodyColumn] ?? '',
        })),
        v.emailColumn,
      );
      importedList.followUpColumns = v.followUpColumns.length
        ? v.followUpColumns
        : detectFollowUpColumns(Object.keys(v.rows[0]));
      importedList.id = 'builder-import-' + hash(v);
      importedList.contacts = importedList.contacts.map((r) => ({
        ...r,
        id: 'builder-row-' + hash([importedList.id, r.email]),
      }));
      applyPreflight(importedList, review);
      issues = [...importedList.issues];
      sources = [importedList];
    } else {
      sources = all('list')
        .filter((l) => d.listIds.includes(l.id))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (sources.length !== d.listIds.length) throw Error('所选批次已被删除，请重新选择');
    }
    const campaigns = all('campaign');
    // One address must not receive the same cold email from two different tasks: a second
    // identical message is the fastest way to be reported as spam.
    const alreadyContacted = new Set();
    for (const other of campaigns)
      for (const r of other.recipients || [])
        if (['sent', 'uncertain', 'sending'].includes(r.status)) alreadyContacted.add(r.email);
    const available = unscheduledLists(sources, campaigns);
    const rows = available
      .flatMap((l) => {
        // An imported list remembers what the operator picked; a stored list is detected.
        const columns = l.followUpColumns?.length
          ? l.followUpColumns
          : detectFollowUpColumns(l.columns || Object.keys(l.contacts?.[0]?.fields || {}));
        return l.contacts.map((r) => ({
          ...r,
          followUps: buildFollowUpPlan(r.fields, columns, d.followUpDelays),
          fields: {
            ...r.fields,
            source_list_id: l.id,
            source_recipient_id: r.id,
            recipient_type: '外部收件人',
          },
          sourceListId: l.id,
        }));
      })
      .filter((r) => {
        const check = checks.get(r.email);
        if (check?.status === 'invalid') {
          issues.push({ email: r.email, reason: check.reason });
          return false;
        }
        if (alreadyContacted.has(r.email)) {
          issues.push({ email: r.email, reason: '这个地址在其它任务里已经发过信，本次跳过' });
          return false;
        }
        const suppression = get('suppression', r.email);
        if (suppression) {
          issues.push({ email: r.email, reason: suppression.reason });
          return false;
        }
        return true;
      });
    // Check all available candidates before applying limit: invalid addresses may
    // need replacement by a later row. Never recheck already allocated contacts.
    if (candidatesOnly) return rows.map((r) => r.email);
    const recipients = rows.slice(0, d.limit || rows.length);
    if (!recipients.length)
      // "Nothing to schedule" is useless when the real reason is that every address was
      // screened out; name the first few so the operator can fix the file.
      throw Error(
        issues.length
          ? `${issues.length} 个地址全部被排除：` +
              issues
                .slice(0, 3)
                .map((i) => `${i.email}（${i.reason}）`)
                .join('、') +
              '。修正后重新导入即可'
          : '所选来源中没有可安排的邮件',
      );
    if (recipients.length > 10000) throw Error('每次最多安排 10,000 封邮件，请填写本次数量');
    if (d.limit && recipients.length < d.limit)
      throw Error('可安排邮件不足指定数量，请刷新后重新核对');
    const content = (r) => {
      const f = r.fields;
      return [
        f.email_subject ?? f.postlane_subject ?? f['邮件标题'] ?? f['标题'],
        f.email_content ?? f.postlane_body ?? f['邮件话术'] ?? f['邮件正文'] ?? f['正文'],
      ];
    };
    for (const r of recipients) {
      const [subject, body] = content(r);
      if (!subject?.trim() || !body?.trim())
        throw Error(`${r.email} 缺少标题或正文，请补齐表格后导入`);
      if (subject.length > 300 || body.length > 30000)
        throw Error(`${r.email} 的标题或正文超过长度限制`);
      r.fields.email_subject = subject;
      r.fields.email_content = body;
      r.followUps ||= [];
      validateFollowUpPlan(r.followUps, r.email);
      // A follow-up may use variables the first email does not; a silently empty `{{公司}}`
      // in a follow-up is worse than refusing to schedule it.
      const followUpVars = variables(r.followUps.map((s) => `${s.subject}\n${s.body}`).join('\n'));
      const missing = followUpVars.filter(
        (k) => !Object.hasOwn(r.fields, k) || !String(r.fields[k] ?? '').trim(),
      );
      if (missing.length) throw Error(`${r.email} 的跟进缺少变量：${missing.join('、')}`);
    }
    let offset = 0;
    const groups = accounts.map((account, i) => {
      const count =
        Math.floor(recipients.length / accounts.length) +
        (i < recipients.length % accounts.length ? 1 : 0);
      const rows = recipients.slice(offset, offset + count);
      offset += count;
      return {
        account,
        rows,
        formal: count,
        copies: count ? d.archiveTo.length : 0,
        total: count ? count + d.archiveTo.length : 0,
      };
    });
    const fingerprint = hash({ d, recipients, senders: accounts.map((a) => [a.id, a.email]) });
    return {
      d,
      recipients,
      groups,
      importedList,
      issues,
      fingerprint,
      availableCount: rows.length,
    };
  }

  function previewBuilder(input, review = []) {
    const p = prepare(input, review);
    return {
      fingerprint: p.fingerprint,
      available: p.availableCount,
      formal: p.recipients.length,
      copies: p.groups.reduce((n, g) => n + g.copies, 0),
      total: p.groups.reduce((n, g) => n + g.total, 0),
      uniqueEmails: new Set(p.recipients.map((r) => r.email)).size,
      issues: p.issues,
      sendWindow: p.d.sendWindow,
      unsubscribe: p.d.unsubscribe,
      timeZone: TIME_ZONE,
      followUps: {
        second: p.recipients.filter((r) => r.followUps?.[0]).length,
        third: p.recipients.filter((r) => r.followUps?.[1]).length,
        delays: p.d.followUpDelays,
      },
      // Without a public origin the opt-out header can only offer `mailto:`.
      unsubscribeLinkAvailable: unsubscribeLinkAvailable(),
      limits: p.groups
        .filter((g) => g.formal)
        .map((g) => ({
          email: g.account.email,
          dailyCap: dailyCapFor(get('account', g.account.id)),
          sentToday: sentToday(all('campaign'), g.account.id),
        })),
      addressWarnings: review.filter((r) => r.status === 'warning'),
      groups: p.groups.map(({ rows, ...g }) => g),
      // Enough to review first/last content for every account without returning huge worksheets.
      samples: p.groups
        .filter((g) => g.formal)
        .map((g) => ({ account: g.account, first: g.rows[0], last: g.rows.at(-1) })),
    };
  }

  function createBuilder(input, review = []) {
    const meta = z
      .object({
        requestId: z.string().min(8).max(100),
        fingerprint: z.string().length(64),
        action: z.enum(['draft', 'start']),
        confirmLive: z.boolean().optional(),
      })
      .parse(input);
    const requestHash = hash(input);
    return transaction(() => {
      const prior = get('campaign-builder-request', meta.requestId);
      if (prior) {
        if (prior.hash !== requestHash) throw Error('请求内容已变化，请重新核对');
        return prior.result;
      }
      const p = prepare(input, review);
      if (p.fingerprint !== meta.fingerprint)
        throw Error('未排期邮件或账号发生变化，请重新预览再提交');
      if (meta.action === 'start' && p.d.mode === 'live' && !meta.confirmLive)
        throw Error('请确认真实发送');
      if (p.importedList && !get('list', p.importedList.id))
        put('list', attachImportTask(p.importedList, p.d.imported));
      const ids = [];
      for (const g of p.groups.filter((g) => g.formal)) {
        const name = `${p.d.name.slice(0, 70)} · ${ids.length + 1}/${p.groups.filter((g) => g.formal).length}`;
        const contacts = g.rows.map((r) => ({ ...r }));
        const last = contacts.at(-1);
        for (const email of p.d.archiveTo)
          contacts.push({
            id: randomUUID(),
            email,
            fields: { ...last.fields, recipient_type: '末封留档副本' },
          });
        const l = put('list', {
          id: randomUUID(),
          builderGenerated: true,
          name,
          createdAt: new Date().toISOString(),
          columns: Object.keys(contacts[0].fields),
          emailColumn: 'email',
          contacts,
          issues: [],
          sourceCount: contacts.length,
        });
        const c = {
          id: randomUUID(),
          name,
          listId: l.id,
          listName: l.name,
          subject: '{{email_subject}}',
          body: '{{email_content}}',
          accountId: g.account.id,
          senderEmail: g.account.email,
          mode: p.d.mode,
          emailReports: true,
          rate: p.d.rate,
          randomInterval: p.d.randomInterval,
          sendWindow: p.d.sendWindow,
          unsubscribe: p.d.unsubscribe,
          followUpDelays: p.d.followUpDelays,
          // Nothing in this batch has a follow-up when every cell was empty.
          followUpEnabled: contacts.some((r) => r.followUps?.length),
          plainOnly: true,
          stopOnError: false,
          scheduledAt: p.d.scheduledAt,
          status: 'draft',
          createdAt: new Date().toISOString(),
          recoveryVersion: 2,
          recipients: contacts.map((r) => ({ ...r, status: 'pending', error: '', stage: 0 })),
        };
        validateCampaign(c);
        // Ensure the templating layer is lossless for canonical per-row content.
        for (const r of c.recipients)
          if (
            render(c.subject, r.fields) !== r.fields.email_subject ||
            render(c.body, r.fields) !== r.fields.email_content
          )
            throw Error('邮件内容校验失败');
        put('campaign', c);
        ids.push(c.id);
      }
      let batchId = null;
      if (p.d.mode === 'live') {
        const b = createBatch(p.d.name, ids);
        batchId = b.id;
        // Report delivery is independent of optional last-message archive copies.
        put('report-batch', { ...b, emailReports: true });
      }
      if (meta.action === 'start') {
        const now = new Date().toISOString();
        for (const id of ids) {
          const c = get('campaign', id);
          put('campaign', {
            ...c,
            status: c.scheduledAt ? 'scheduled' : 'running',
            startedAt: now,
            nextAt: 0,
          });
        }
        if (batchId) put('report-batch', { ...get('report-batch', batchId), startedAt: now });
      }
      const result = {
        campaignIds: ids,
        batchId,
        formal: p.recipients.length,
        copies: p.groups.reduce((n, g) => n + g.copies, 0),
        status: meta.action === 'draft' ? 'draft' : p.d.scheduledAt ? 'scheduled' : 'running',
      };
      put('campaign-builder-request', { id: meta.requestId, hash: requestHash, result });
      return result;
    }).immediate();
  }

  return {
    builderSources,
    previewBuilder,
    createBuilder,
    preflightEmails: (input) => prepare(input, [], true),
  };
}
