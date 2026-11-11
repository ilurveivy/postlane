import { auditReportTo, executionReportTo } from './report-recipients.js';

// Report recipients come from the environment, never from source: see report-recipients.js.
export const reportRecipients = (kind) =>
  kind === 'audit' ? auditReportTo() : executionReportTo();
export const AUDIT_DELAY = 12 * 3600000;
export function executionStart(campaigns) {
  const starts = campaigns
    .filter((c) => !['draft', 'scheduled'].includes(c.status))
    .map((c) => {
      const attempts = c.recipients
        .flatMap((r) => [
          ...(r.attempts || []).map((a) => Date.parse(a.startedAt)),
          Date.parse(r.sentAt),
        ])
        .filter(Number.isFinite);
      if (attempts.length) return Math.min(...attempts);
      if (c.status === 'cancelled') return null;
      return Math.max(Date.parse(c.startedAt) || 0, Date.parse(c.scheduledAt) || 0);
    })
    .filter((t) => t > 0);
  return starts.length ? Math.min(...starts) : null;
}
export const progressProblems = (campaigns) =>
  campaigns.some(
    (c) =>
      ['paused', 'attention'].includes(c.status) ||
      c.recipients.some(
        (r) => ['failed', 'needs_review', 'uncertain'].includes(r.status) && !r.resolvedBy,
      ),
  );
export const cancelledBeforeSending = (campaigns) =>
  campaigns.length > 0 &&
  campaigns.every(
    (c) =>
      c.status === 'cancelled' &&
      c.recipients.every(
        (r) =>
          !r.sentAt &&
          !r.messageId &&
          !r.attempts?.length &&
          !['sent', 'sending', 'uncertain', 'needs_review', 'retry_wait'].includes(r.status),
      ),
  );
export const terminalBatch = (campaigns) =>
  campaigns.length > 0 &&
  campaigns.every(
    (c) =>
      ['completed', 'completed_errors', 'cancelled'].includes(c.status) &&
      !c.recipients.some(
        (r) =>
          ['pending', 'sending', 'retry_wait', 'uncertain', 'needs_review'].includes(r.status) &&
          !r.resolvedBy,
      ),
  );
const archive = (r) => /留档|副本/.test(r.fields?.recipient_type || '');
const percent = (n, d) => (d ? `${((100 * n) / d).toFixed(2)}%` : '不适用');
const at = (s) =>
  s ? new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '无';
export function explicitOptOut(text = '') {
  const fresh = text
    .split(/\r?\n(?:On .+|.*wrote:|.*写道：)/)[0]
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
  return /(?:^|\n)\s*(?:please\s+)?(?:unsubscribe me|unsubscribe|remove me from (?:your|the) (?:mailing )?list|stop (?:emailing|contacting) me|do not (?:email|contact) me|请(?:停止联系|不要再发|退订)|退订)[.!。！\s]*$/im.test(
    fresh,
  );
}
export function reportModel(batch, campaigns, events = [], coverage = []) {
  const ids = new Set(campaigns.map((c) => c.id));
  const rows = new Map();
  for (const c of campaigns)
    for (const r of c.recipients) {
      const key = r.logicalRecipientId
        ? `${r.logicalCampaignId}:${r.logicalRecipientId}`
        : r.id
          ? `${c.id}:${r.id}`
          : `${c.accountId}:${r.email}:${archive(r)}`;
      const old = rows.get(key);
      const value = {
        ...r,
        accountId: c.accountId,
        sender: c.senderEmail,
        email: r.email,
        archive: archive(r),
        campaignId: c.id,
      };
      if (!old || r.status === 'sent') rows.set(key, value);
    }
  const relevant = events.filter((e) => e.links?.some((l) => ids.has(l.campaignId)));
  const ambiguous = relevant.filter((e) => e.links.some((l) => !ids.has(l.campaignId)));
  const valid = relevant.filter((e) => !ambiguous.includes(e));
  const members = [...rows.values()];
  for (const r of members) {
    const ev = valid.filter(
      (e) =>
        e.accountId === r.accountId &&
        e.links.some((l) => ids.has(l.campaignId) && l.email === r.email),
    );
    r.replies = ev.filter((e) => e.type === 'reply');
    r.bounced = ev.some((e) => e.type === 'bounce');
    r.optOut = r.replies.some((e) => explicitOptOut(e.text));
  }
  const ext = members.filter((r) => !r.archive);
  const accepted = ext.filter((r) => r.status === 'sent').length;
  const stats = {
    planned: ext.length,
    accepted,
    failed: ext.filter((r) => r.status === 'failed').length,
    uncertain: ext.filter((r) => r.status === 'uncertain').length,
    cancelled: ext.filter((r) => r.status === 'cancelled').length,
    other: ext.filter((r) => !['sent', 'failed', 'uncertain', 'cancelled'].includes(r.status))
      .length,
    bounced: ext.filter((r) => r.bounced).length,
    replied: ext.filter((r) => r.replies.length).length,
    optOut: ext.filter((r) => r.optOut).length,
    retrying: ext.filter((r) => r.status === 'retry_wait').length,
    reviewing: ext.filter((r) => r.status === 'needs_review').length,
    pending: ext.filter((r) => ['pending', 'sending'].includes(r.status)).length,
    archivePlanned: members.filter((r) => r.archive).length,
    archiveSent: members.filter((r) => r.archive && r.status === 'sent').length,
  };
  return {
    batch,
    executionStartedAt: executionStart(campaigns),
    hasProblems: progressProblems(campaigns),
    members,
    stats,
    coverage,
    ambiguous,
    replies: valid.filter(
      (e) =>
        e.type === 'reply' &&
        e.links.some((l) => ext.some((r) => r.accountId === e.accountId && r.email === l.email)),
    ),
  };
}
export function reportText(kind, model) {
  const { batch, members, stats: s, coverage, replies, ambiguous } = model;
  const complete = coverage.length > 0 && coverage.every((c) => c.ok);
  const start = model.executionStartedAt;
  const lines = [
    `Postlane · ${batch.correctionOf ? '核查更正报告（截至指定时间）' : kind === 'progress' ? (model.hasProblems ? '批次异常通知' : '批次进度通知') : kind === 'execution' ? '批次执行报告' : batch.sample ? '历史批次核查报告（样例）' : '批次完成12小时核查报告'}`,
    ...(batch.correctionOf
      ? [
          `更正原报告：${batch.correctionOf}`,
          batch.correctionNote || '以本报告中的批次与统计截止时间为准。',
        ]
      : []),
    `批次：${batch.name}`,
    `批次ID：${batch.id}`,
    `预约提交/启动：${at(batch.startedAt)}`,
    `实际执行开始：${start ? at(new Date(start).toISOString()) : '无'}`,
    `结束：${at(batch.completedAt)}`,
    `执行耗时（不含预约等待）：${start ? Math.max(0, Math.round(((Date.parse(batch.completedAt) || Date.now()) - start) / 1000)) + ' 秒' : '无'}`,
    `生成：${at(new Date().toISOString())}`,
    '',
    `外部计划：${s.planned}；SMTP已接受：${s.accepted}；提交成功率：${percent(s.accepted, s.planned)}`,
    `失败：${s.failed}；状态不明：${s.uncertain}；取消：${s.cancelled}；其他未提交：${s.other}；留档已接受：${s.archiveSent}`,
    `等待重试：${s.retrying}；等待人工确认：${s.reviewing}；待发送/提交中：${s.pending}`,
    '成功率仅指SMTP提交，不能证明进入收件箱。',
  ];
  if (kind === 'audit') {
    lines.push(
      '',
      `统计截止：${at(batch.auditDueAt)}`,
      `收信覆盖：${complete ? '完整' : '不完整，以下计数仅为已观察到的数据，整体回复率和退订率不可确认'}`,
      `已观察退信人数：${s.bounced}；回复收件人数：${s.replied}；明确退订请求人数：${s.optOut}`,
      `回复率：${complete ? percent(s.replied, s.accepted) : '无法确认'}；明确退订请求率：${complete ? percent(s.optOut, s.accepted) : '无法确认'}`,
      `退信率：${complete ? percent(s.bounced, s.accepted) : '无法确认'}`,
      '回复率分母为已提交正式收件任务数；同一任务的补发归并，排除留档、自动回复、退信。退订仅识别回复新正文中明确的停止联系要求，复杂表达可能需要人工复核；没有退订点击率数据。',
      '回复按收件任务去重，重复回信不重复计人；未标记为自动回复的来信仍可能是模板回复，不代表合作意向。',
      `跨批次归属待确认：${ambiguous.length}`,
      ...coverage.map(
        (c) =>
          `${c.email}：${c.ok ? '读取成功' + (c.checkedAt ? '，最后同步：' + at(c.checkedAt) : '') : '不可确认：' + c.reason}`,
      ),
    );
  }
  lines.push('', '账号明细');
  for (const accountId of new Set(members.map((r) => r.accountId))) {
    const r = members.filter((r) => r.accountId === accountId && !r.archive);
    lines.push(
      `${r[0]?.sender || accountId}：外发 ${r.filter((r) => r.status === 'sent').length}/${r.length}，失败 ${r.filter((r) => r.status === 'failed').length}，状态不明 ${r.filter((r) => r.status === 'uncertain').length}，回复 ${r.filter((r) => r.replies.length).length}，退订请求 ${r.filter((r) => r.optOut).length}`,
    );
  }
  lines.push(
    '',
    '逐条明细（平台发件账号 → 收件人 | 状态 | 原因）',
    ...members.map(
      (r) =>
        `${r.sender} → ${r.email}${r.archive ? ' [留档]' : ''} | ${r.status} | ${r.error || ''}${r.bounced ? '；已退信' : ''}`,
    ),
  );
  if (kind === 'audit')
    for (const e of replies)
      lines.push(
        '',
        '════════ 回复邮件原文 ════════',
        `平台发件账号（原From）：${e.accountEmail}`,
        `原收件人（原To）：${[...new Set(e.links.map((l) => l.email))].join(', ')}`,
        `回复From：${(e.from || []).join(', ')}`,
        `回复To：${(e.to || []).join(', ')}`,
        `时间：${at(e.date)}`,
        `标题：${e.subject}`,
        `Message-ID：${e.messageId || ''}`,
        '正文（保留已提取的纯文本，可能包含引用历史；不是完整MIME/附件）：',
        e.text || '[纯文本正文不可用，请在邮箱查看原文]',
      );
  return lines.join('\n');
}
