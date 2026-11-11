// Multi-step follow-ups.
//
// A row in the sheet may carry 【第二封跟进】 and 【第三封跟进】. They are optional: an empty
// cell means the sequence stops there. Timing is relative, not absolute — the second email
// goes out N days after the first *if the prospect has not replied*, and the third M days
// after the second. Absolute dates would be wrong the moment a batch slips a day.
//
// `stage` on a recipient counts how many emails of the sequence have been accepted by the
// SMTP server, so `stage === 0` means "first email not sent yet" and
// `followUps[stage - 1]` is the email currently being delivered.

export const DEFAULT_FOLLOW_UP_DELAYS = [5, 10];
export const MAX_FOLLOW_UP_DELAY_DAYS = 90;
export const DAY_MS = 86400000;
const MAX_BODY = 30000;
const MAX_SUBJECT = 300;

// Accepted header spellings. The Chinese pair is what the import template documents; the
// ASCII aliases exist so a spreadsheet exported by an English tool still works.
const COLUMN_ALIASES = [
  [
    '第二封跟进',
    '第2封跟进',
    '跟进2',
    '跟进二',
    '第二封',
    'follow_up_2',
    'followup_2',
    'second_follow_up',
  ],
  [
    '第三封跟进',
    '第3封跟进',
    '跟进3',
    '跟进三',
    '第三封',
    'follow_up_3',
    'followup_3',
    'third_follow_up',
  ],
];

// `Follow Up 3`, `follow_up_3` and `followup3` are the same header; strip separators so the
// alias list stays short.
const normalizeHeader = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

/** Column names from the sheet, in the order 第二封 / 第三封, or '' when absent. */
export function detectFollowUpColumns(columns = []) {
  const byHeader = new Map(columns.map((c) => [normalizeHeader(c), c]));
  return COLUMN_ALIASES.map(
    (aliases) => aliases.map((a) => byHeader.get(normalizeHeader(a))).find(Boolean) || '',
  );
}

/**
 * One cell → `{ subject, body }`. The subject is optional: when the cell starts with
 * `主题：` / `标题：` / `Subject:` that line is the subject, otherwise the whole cell is the
 * body and the sender replies in the existing thread (`Re: <first subject>`).
 */
export function parseFollowUpCell(cell) {
  const text = String(cell ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return null;
  const match = /^(?:主题|标题|subject)\s*[：:]\s*([^\n]*)\n([\s\S]*)$/i.exec(text);
  if (match && match[2].trim()) return { subject: match[1].trim(), body: match[2].trim() };
  return { subject: '', body: text };
}

/**
 * Builds the sequence for one row: `{ subject, body, afterDays }[]`, index 0 = 第二封.
 * `delays[i]` is how long to wait after the email before it.
 */
export function buildFollowUpPlan(row, columns, delays = DEFAULT_FOLLOW_UP_DELAYS) {
  const [second, third] = [].concat(columns || []);
  const cells = [second ? row?.[second] : '', third ? row?.[third] : ''];
  const plan = [];
  for (let i = 0; i < cells.length; i++) {
    const parsed = parseFollowUpCell(cells[i]);
    if (!parsed) break; // a gap ends the sequence: no 第二封 means no 第三封 either
    plan.push({
      subject: parsed.subject,
      body: parsed.body,
      afterDays: delays[i] ?? DEFAULT_FOLLOW_UP_DELAYS[i],
    });
  }
  return plan;
}

export function validateFollowUpPlan(plan, email = '') {
  for (const step of plan || []) {
    const body = String(step.body ?? '').trim();
    const subject = String(step.subject ?? '').trim();
    if (!body) throw Error(`${email} 的跟进正文不能为空`);
    if (body.length > MAX_BODY) throw Error(`${email} 的跟进正文超过长度限制`);
    if (subject.length > MAX_SUBJECT) throw Error(`${email} 的跟进主题超过长度限制`);
    if (!Number.isInteger(step.afterDays) || step.afterDays < 1)
      throw Error(`${email} 的跟进间隔必须是 1 天以上的整数`);
    if (step.afterDays > MAX_FOLLOW_UP_DELAY_DAYS)
      throw Error(`${email} 的跟进间隔不能超过 ${MAX_FOLLOW_UP_DELAY_DAYS} 天`);
  }
  return plan;
}

/** How many emails of the sequence the server has accepted for this recipient. */
export const stageOf = (r) => (Number.isInteger(r?.stage) ? r.stage : r?.status === 'sent' ? 1 : 0);

/**
 * Whether another email in this sequence is still owed to the recipient.
 *
 * Deliberately conservative: a follow-up only goes out when the previous email is confirmed
 * sent. An `uncertain` first email might never have left, and "just following up" on a
 * message that never arrived is indistinguishable from a cold, confusing email.
 */
export function hasOpenFollowUp(r) {
  if (!r || !r.followUps?.length) return false;
  if (r.status !== 'sent') return false;
  if (r.lastReplyAt || r.optedOutAt || r.followUpsStopped) return false;
  if (r.deliveryStatus === 'bounced') return false;
  // `stage` counts accepted emails; the sequence is the first email plus every follow-up.
  return stageOf(r) < r.followUps.length + 1;
}

export const dueFollowUp = (r, now = Date.now()) =>
  hasOpenFollowUp(r) && (r.nextFollowUpAt || 0) <= now;

/**
 * Whether the queue has to keep this campaign around for a follow-up.
 *
 * The queue polls every 350ms, so the cheap `followUpEnabled` flag is checked first: without
 * it every campaign would be scanned recipient by recipient forever.
 */
export const campaignHasOpenFollowUps = (c) =>
  Boolean(c?.followUpEnabled) && (c.recipients || []).some(hasOpenFollowUp);

export function earliestFollowUpAt(c) {
  let earliest = 0;
  for (const r of c?.recipients || []) {
    if (!hasOpenFollowUp(r)) continue;
    const at = r.nextFollowUpAt || 0;
    if (!earliest || at < earliest) earliest = at;
  }
  return earliest;
}

/** Absolute time of the next email for this recipient, given the plan and a finish time. */
export function scheduleNextFollowUp(recipient, finishedAt = Date.now()) {
  // `followUps[i]` is the (i+2)-th email, so after `stage` emails the next one is
  // `followUps[stage - 1]`; using `followUps[stage]` would skip a step of the sequence.
  const next = recipient?.followUps?.[stageOf(recipient) - 1];
  recipient.nextFollowUpAt = next ? finishedAt + next.afterDays * DAY_MS : 0;
  return recipient.nextFollowUpAt;
}
