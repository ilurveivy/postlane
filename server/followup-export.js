import ExcelJS from 'exceljs';
import { internalRecipients } from './report-recipients.js';
import { render } from './domain.js';
import { channelMetadata } from './channel-metadata.js';
import { filterFollowup, followupTypes, effectiveHandled } from '../src/followup-filter.js';
export const followupColumns = [
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
];
const stamp = (v) =>
  v && Number.isFinite(Date.parse(v))
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date(v))
    : '';
const key = (r) => {
  const f = r.fields || {};
  const s = f.email_subject ?? f.postlane_subject ?? f['邮件标题'] ?? f['标题'];
  const b = f.email_content ?? f.postlane_body ?? f['邮件话术'] ?? f['邮件正文'] ?? f['正文'];
  return s == null || b == null ? null : JSON.stringify([r.email?.toLowerCase(), s, b]);
};
export function followupExportRows(
  { events, campaigns, lists, accounts, replies = [], messages = [] },
  filters = {},
) {
  const outgoing = new Map();
  const internal = internalRecipients();
  for (const m of messages) {
    if (!m.messageId || !m.remote || !m.outgoing || !m.folders?.includes('sent')) continue;
    outgoing.set(JSON.stringify([m.accountId, m.messageId]), {
      ...m,
      body: (m.text || '') + (m.truncated ? '\n[同步正文不完整，请到原邮箱查看完整邮件]' : ''),
      sentAt: m.date,
    });
  }
  for (const r of replies) {
    if (r.status !== 'sent' || !r.messageId) continue;
    const key = JSON.stringify([r.accountId, r.messageId]);
    const remote = outgoing.get(key);
    outgoing.set(key, {
      ...r,
      to: [r.to],
      references: [...new Set([...(remote?.references || []), ...(r.references || [])])],
      inReplyTo: r.inReplyTo || remote?.inReplyTo,
    });
  }
  const byParent = new Map();
  for (const r of outgoing.values()) {
    if (!r.to?.length || r.to.every((to) => internal.has(to.trim().toLowerCase()))) continue;
    const parents = new Set([r.inReplyTo, ...(r.references || [])].filter(Boolean));
    const links = new Set(
      [...parents].flatMap((parent) =>
        [...new Set([r.sourceAccountId, r.accountId].filter(Boolean))].map((accountId) =>
          JSON.stringify([accountId, parent]),
        ),
      ),
    );
    for (const link of r.referenceLinks || [])
      if (parents.has(link.messageId)) links.add(JSON.stringify([link.accountId, link.messageId]));
    for (const key of links) {
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(r);
    }
  }
  const cs = new Map(campaigns.map((c) => [c.id, c]));
  const ls = new Map(lists.map((l) => [l.id, l]));
  const ac = new Map(accounts.map((a) => [a.id, a]));
  const originals = new Map();
  for (const l of lists.filter((l) => !l.builderGenerated))
    for (const r of l.contacts || []) {
      const k = key(r);
      if (k) originals.set(k, [...(originals.get(k) || []), { l, r }]);
    }
  return filterFollowup(events, filters)
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .map((e) => {
      const links = [
        ...new Map(
          (e.links || []).map((l) => [JSON.stringify([l.campaignId, l.recipientId]), l]),
        ).values(),
      ];
      const link = links.length === 1 ? links[0] : null;
      const c = link && cs.get(link.campaignId);
      const r =
        c && c.accountId === e.accountId
          ? c.recipients?.find(
              (r) =>
                r.id === link.recipientId &&
                (!link.email || r.email.toLowerCase() === link.email.toLowerCase()),
            )
          : null;
      const exact = !!r && e.confidence === 'message-id';
      let source;
      if (exact) {
        const sourceId = r.fields?.source_list_id || r.sourceListId;
        const l = ls.get(sourceId);
        const original = l?.contacts?.find((v) => v.id === (r.fields?.source_recipient_id || r.id));
        if (original && (original.email || '').toLowerCase() === r.email.toLowerCase())
          source = { l, r: original };
        else if (!sourceId) {
          const matches = originals.get(key(r)) || [];
          if (matches.length === 1) source = matches[0];
        }
      }
      const sentChannel = channelMetadata(exact ? r.fields : {});
      const sourceChannel = channelMetadata(source?.r.fields);
      const incompatible =
        sentChannel.channel_id &&
        sourceChannel.channel_id &&
        sentChannel.channel_id !== sourceChannel.channel_id;
      const channel = incompatible
        ? sourceChannel
        : Object.fromEntries(
            Object.keys(sentChannel).map((k) => [k, sourceChannel[k] || sentChannel[k]]),
          );
      return {
        频道名称: channel.channel_name,
        频道链接: channel.channel_url,
        对方邮箱: (e.from || []).join(', '),
        '发送时间（北京时间）': exact ? stamp(r.sentAt) : '',
        对方回复内容: e.text || '',
        我方回复内容:
          e.type === 'reply' && e.messageId
            ? (byParent.get(JSON.stringify([e.accountId, e.messageId])) || [])
                .filter((r) => Date.parse(r.sentAt) >= Date.parse(e.date))
                .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))
                .map((r) => `[${stamp(r.sentAt)}]\n${r.body}`)
                .join('\n\n')
            : '',
        '回复时间（北京时间）': stamp(e.date),
        回复类型: followupTypes[e.type] || e.type,
        处理状态: effectiveHandled(e) ? '已处理' : '待处理',
        发件账号: e.accountEmail || ac.get(e.accountId)?.from || '',
        原始录入批次: source?.l.name || (exact ? r.channelRecovery?.file : '') || '',
        原邮件标题: exact ? render(c.subject || '', r.fields || {}) : '',
        原邮件正文: exact ? render(c.body || '', r.fields || {}) : '',
        导入任务: (e.importTaskNames || []).join('、'),
        会话回复状态:
          { replied: '已回复最新来信', awaitingReply: '尚未回复最新来信', noReply: '无需回复' }[
            e.followupStatus
          ] || '',
      };
    });
}
export async function followupWorkbook(data, filters = {}) {
  const rows = followupExportRows(data, filters);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Postlane';
  const sheet = workbook.addWorksheet('回复与跟进', { views: [{ state: 'frozen', ySplit: 1 }] });
  const keys = followupColumns;
  // Excel limits cell text to 32,767 characters. Continue long content in adjacent columns.
  const split = (value) => {
    const text = String(value ?? '');
    const chunks = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 30000, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  };
  const chunks = rows.map((r) => Object.fromEntries(keys.map((k) => [k, split(r[k])])));
  const columns = keys.flatMap((k) => {
    const parts = chunks.reduce((max, r) => Math.max(max, r[k].length), 1);
    return Array.from({ length: parts }, (_, i) => ({
      key: k,
      part: i,
      header: i ? `${k}（续${i + 1}）` : k,
    }));
  });
  if (columns.length > 16384) throw Error('导出字段过多，请按任务筛选后分批导出');
  sheet.columns = columns.map((c) => ({
    header: c.header,
    width: /正文|回复内容/.test(c.key) ? 60 : 24,
  }));
  for (const r of chunks) sheet.addRow(columns.map((c) => r[c.key][c.part] || ''));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '244768' } };
  sheet.getRow(1).height = 32;
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: columns.length },
  };
  sheet.eachRow((row, n) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (n > 1) row.height = 60;
  });
  const notes = workbook.addWorksheet('导出说明');
  notes.getColumn(1).width = 110;
  [
    `导出时间（北京时间）：${stamp(new Date().toISOString())}`,
    `记录数：${rows.length}；筛选条件：${JSON.stringify(filters)}`,
    '每条回复记录一行；包含自动回复、退信等类型时请按回复类型区分。已处理不代表已人工回复。',
    '我方回复内容仅包含通过同一账号的邮件标识或引用链关联的已发送回复，同一行内按北京时间排列并去重；一封回复可能关联多条来信，不能按非空行数统计发送次数；排除发给内部留档邮箱的邮件。空白不代表未回复，尚未同步或无法明确关联的邮件不会填入。',
    '仅邮件标识精确且唯一关联时填入发送和原始信息；无法确认的关联信息留空，不按标题猜测。',
    '频道信息优先使用原始录入数据；找不到原始批次时使用发送时记录，原始批次留空。',
    '历史记录经原收件邮箱、标题和正文精确核实回填后，原始批次可显示核实所用的原始文件名；有效频道ID可补全频道链接。',
    '发送标题与正文按任务保存的模板及收件人字段还原；发送时间采用系统记录的SMTP提交成功时间，SMTP接受不代表进入收件箱。',
    '正文不截断；超过单元格长度限制时存入相邻的续列，按顺序拼接可恢复完整内容。仅有HTML且无纯文本的回复请到平台查看。',
  ].forEach((line) => notes.addRow([line]));
  notes.eachRow((r) => {
    r.alignment = { wrapText: true, vertical: 'top' };
    r.height = 36;
  });
  return workbook;
}

// ExcelJS can split surrogate pairs at its XML buffer boundary. Write string cells
// as inline XML from their original values so exported emoji remain lossless.
export async function followupXlsx(data, filters = {}) {
  const workbook = await followupWorkbook(data, filters);
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const escape = (text) =>
    String(text)
      .replace(/_x[0-9a-f]{4}_/gi, (v) => '_x005F_' + v.slice(1))
      .replace(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
        (v) => `_x${v.charCodeAt(0).toString(16).padStart(4, '0')}_`,
      )
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\r/g, '&#13;')
      .replace(/[\u{10000}-\u{10FFFF}]/gu, (v) => `&#${v.codePointAt(0)};`);
  for (const sheet of workbook.worksheets) {
    const file = `xl/worksheets/sheet${sheet.id}.xml`;
    const values = new Map();
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') values.set(cell.address, cell.value);
      }),
    );
    const xml = await zip.file(file).async('string');
    zip.file(
      file,
      xml.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (whole, attrs) => {
        const address = attrs.match(/\br="([^"]+)"/)?.[1];
        if (!values.has(address)) return whole;
        return `<c${attrs.replace(/\s+t="[^"]*"/g, '')} t="inlineStr"><is><t xml:space="preserve">${escape(values.get(address))}</t></is></c>`;
      }),
    );
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
