// Where Postlane sends its own report mail, and which addresses count as "ours".
//
// Nothing is hardcoded on purpose: a fresh install sends no internal report mail until
// the operator configures recipients. Every getter reads the environment on each call so
// tests and long-running processes can adjust it without a restart.
//
//   POSTLANE_REPORT_TO               audit + execution report recipients (base list)
//   POSTLANE_EXECUTION_REPORT_TO     execution reports only   (falls back to the base list)
//   POSTLANE_AUDIT_REPORT_TO         12-hour audit reports only (falls back to the base list)
//   POSTLANE_ARCHIVE_RECIPIENTS      default留档副本 recipients (falls back to the base list)
//   POSTLANE_INTERNAL_RECIPIENTS     extra addresses that belong to the operator; they are
//                                    excluded from reply statistics

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => EMAIL.test(s));
}

export function reportTo(env = process.env) {
  return emailList(env.POSTLANE_REPORT_TO);
}

export function executionReportTo(env = process.env) {
  const own = emailList(env.POSTLANE_EXECUTION_REPORT_TO);
  return own.length ? own : reportTo(env);
}

export function auditReportTo(env = process.env) {
  const own = emailList(env.POSTLANE_AUDIT_REPORT_TO);
  return own.length ? own : reportTo(env);
}

export function archiveRecipients(env = process.env) {
  const own = emailList(env.POSTLANE_ARCHIVE_RECIPIENTS);
  return own.length ? own : reportTo(env);
}

/** Addresses that belong to the operator rather than to a recipient. */
export function internalRecipients(env = process.env) {
  return new Set([
    ...reportTo(env),
    ...executionReportTo(env),
    ...auditReportTo(env),
    ...archiveRecipients(env),
    ...emailList(env.POSTLANE_INTERNAL_RECIPIENTS),
  ]);
}
