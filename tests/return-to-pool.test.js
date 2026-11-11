import test from 'node:test';
import assert from 'node:assert/strict';
import { returnToPool } from '../server/return-to-pool.js';
test('return to pool releases only safe pending rows and preserves submission evidence', () => {
  const states = [
    'pending',
    'retry_wait',
    'sent',
    'uncertain',
    'sending',
    'needs_review',
    'failed',
  ];
  const original = {
    status: 'scheduled',
    recipients: states.map((status) => ({ status, messageId: status })),
  };
  const result = returnToPool(original, 'disabled');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.returnedToPool, true);
  assert.deepEqual(
    result.recipients.map((r) => r.status),
    ['cancelled', 'cancelled', ...states.slice(2)],
  );
  assert.deepEqual(
    original.recipients.map((r) => r.status),
    states,
  );
});
