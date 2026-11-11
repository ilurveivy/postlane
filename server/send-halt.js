// Emergency stop. While halted, every outbound message (campaign mail, replies, report
// deliveries) is held instead of sent; already-accepted messages are untouched and
// nothing is marked as failed. Resuming continues exactly where sending stopped.
import { get, put } from './store.js';

const ID = 'send-halt';

export function haltState() {
  const value = get('setting', ID);
  return {
    id: ID,
    halted: value?.halted === true,
    reason: value?.reason || '',
    at: value?.at || null,
  };
}

export const sendingHalted = () => haltState().halted;

export function setHalt(halted, reason = '') {
  const value = {
    id: ID,
    halted: halted === true,
    reason: halted
      ? String(reason || '')
          .trim()
          .slice(0, 200)
      : '',
    at: new Date().toISOString(),
  };
  put('setting', value);
  return value;
}
