// Sending policy: per-account daily limits (with warm-up ramp) and the per-campaign
// sending window. All wall-clock decisions are made in Singapore time (UTC+8), which is
// the business timezone this product targets.
//
// Nothing here touches storage directly: callers pass campaigns in. That keeps the
// arithmetic unit-testable without a database.

export const TIME_ZONE = 'Asia/Singapore';
// Hard ceiling for any single sender account, regardless of ramp or explicit setting.
export const MAX_DAILY_CAP = 200;
// Warm-up ramp: a brand new sender looks exactly like a spammer if it goes straight to
// a few hundred messages, so the allowance grows over the first month.
export const RAMP = [
  { untilDay: 3, cap: 20 },
  { untilDay: 7, cap: 30 },
  { untilDay: 14, cap: 50 },
  { untilDay: 30, cap: 100 },
];
export const DEFAULT_WINDOW = {
  enabled: true,
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '18:00',
};
const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const DAY_MS = 86400000;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Singapore calendar date, weekday (1=Mon..7=Sun) and minutes since local midnight. */
export function localParts(now = Date.now()) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(now)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAY_INDEX[parts.weekday] || 1,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function minutesOf(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]),
    minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Normalised window, or null when the campaign sends around the clock. */
export function windowConfig(campaign) {
  const raw = campaign?.sendWindow;
  if (!raw || raw.enabled === false) return null;
  const days = (Array.isArray(raw.days) ? raw.days : DEFAULT_WINDOW.days)
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  const start = minutesOf(raw.start ?? DEFAULT_WINDOW.start);
  const end = minutesOf(raw.end ?? DEFAULT_WINDOW.end);
  if (!days.length || start === null || end === null || start >= end) return null;
  return { days: new Set(days), start, end };
}

export function windowOpen(campaign, now = Date.now()) {
  const window = windowConfig(campaign);
  if (!window) return true;
  const local = localParts(now);
  return (
    window.days.has(local.weekday) && local.minutes >= window.start && local.minutes < window.end
  );
}

/**
 * Next moment the window opens (or `now` when it is already open).
 * Singapore observes no daylight saving, so stepping whole days preserves the clock time.
 */
export function nextWindowOpenAt(campaign, now = Date.now()) {
  const window = windowConfig(campaign);
  if (!window) return now;
  if (windowOpen(campaign, now)) return now;
  for (let day = 0; day <= 8; day += 1) {
    const probe = now + day * DAY_MS;
    const local = localParts(probe);
    if (!window.days.has(local.weekday)) continue;
    if (day === 0 && local.minutes >= window.end) continue;
    const opening = probe - (local.minutes - window.start) * 60000;
    if (opening > now) return opening;
  }
  return now + 3600000;
}

/** 1-based Singapore calendar day number of `iso` relative to `now`. */
export function dayNumber(iso, now = Date.now()) {
  const parsed = Date.parse(iso ?? '');
  if (!Number.isFinite(parsed)) return null;
  const from = Date.parse(localParts(parsed).date),
    to = Date.parse(localParts(now).date);
  return Math.max(1, Math.round((to - from) / DAY_MS) + 1);
}

export function rampCap(day) {
  for (const step of RAMP) if (day <= step.untilDay) return step.cap;
  return MAX_DAILY_CAP;
}

/**
 * Daily send allowance for one sender account.
 * An explicit `dailyCap` always wins (still capped at MAX_DAILY_CAP); otherwise the
 * warm-up ramp applies. Accounts without any date (legacy data) are treated as mature.
 */
export function dailyCapFor(account, now = Date.now()) {
  const explicit = Number(account?.dailyCap);
  if (Number.isInteger(explicit) && explicit >= 1) return Math.min(explicit, MAX_DAILY_CAP);
  const day = dayNumber(account?.createdAt ?? account?.verifiedAt, now);
  if (day === null) return MAX_DAILY_CAP;
  return Math.min(rampCap(day), MAX_DAILY_CAP);
}

export function rampFor(account, now = Date.now()) {
  const day = dayNumber(account?.createdAt ?? account?.verifiedAt, now);
  if (day === null) return null;
  return { day, cap: rampCap(day) };
}

const COUNTED = new Set(['sent', 'uncertain']);

/** Live messages already accepted (or possibly accepted) for these accounts on `date`. */
export function sentOnDate(campaigns, accountIds, date) {
  const wanted = new Set([].concat(accountIds).filter(Boolean));
  let total = 0;
  for (const campaign of campaigns || []) {
    if (campaign.mode !== 'live' || !wanted.has(campaign.accountId)) continue;
    for (const recipient of campaign.recipients || []) {
      if (!COUNTED.has(recipient.status)) continue;
      const at = recipient.sentAt || recipient.attempts?.at(-1)?.startedAt;
      if (at && localParts(Date.parse(at)).date === date) total += 1;
    }
  }
  return total;
}

export function sentToday(campaigns, accountIds, now = Date.now()) {
  return sentOnDate(campaigns, accountIds, localParts(now).date);
}

/** Whether the message still carries the operator's own opt-out wording. */
export const hasOptOutWording = (body) => /退订|取消订阅|unsubscribe/i.test(String(body || ''));

/** Opt-out wording appended to the text body when a campaign enables it. */
export function unsubscribeFooter(from) {
  const reply = String(from || '').trim() || '本邮件';
  return `\n\n——\n如果这类邮件对你没有帮助，直接回复「退订」即可，我会立即停止发送，不会再打扰（${reply}）。`;
}

/** `List-Unsubscribe` lets the mail client offer an opt-out button. */
export function unsubscribeHeaders(from) {
  const address = String(from || '').trim();
  return address ? { 'List-Unsubscribe': `<mailto:${address}?subject=unsubscribe>` } : {};
}
