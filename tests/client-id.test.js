import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { clientId } from '../src/client-id.js';

test('HTTP-compatible IDs use random bytes with UUID v4 version and variant', () => {
  const insecureCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const ids = Array.from({ length: 100 }, () => clientId(insecureCrypto));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids)
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('secure contexts retain the native UUID implementation', () => {
  assert.equal(clientId({ randomUUID: () => 'native-uuid' }), 'native-uuid');
});
