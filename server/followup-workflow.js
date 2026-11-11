import { filterFollowup, effectiveHandled } from '../src/followup-filter.js';
// Restrict bulk changes to the user's displayed snapshot as well as current filters.
// New mail arriving after the click is deliberately not swept into the operation.
export function pendingSelection(events, filters, ids) {
  const selected = new Set(ids);
  return filterFollowup(events, filters).filter((e) => selected.has(e.id) && !effectiveHandled(e));
}
export function markHandled(event, at) {
  return {
    ...event,
    handled: true,
    handledAt: at,
    handlingSource: 'manual',
  };
}
