import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountQueue } from '../server/account-queue.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function harness(rows, limit = 3) {
  const calls = [],
    releases = new Map(),
    errors = [],
    cooldown = new Map();
  let time = 100;
  const queue = createAccountQueue({
    list: () => rows.filter((r) => !r.done && !r.paused),
    key: (r) => r.account,
    readyAt: (r, key) => Math.max(r.nextAt || 0, cooldown.get(key) || 0),
    now: () => time,
    limit,
    run: (r) => {
      calls.push(r.id);
      return new Promise((resolve, reject) =>
        releases.set(r.id, {
          resolve: () => {
            r.done = true;
            resolve();
          },
          reject,
        }),
      );
    },
    onError: (e, r, key) => {
      errors.push(e.message);
      rows
        .filter((row) => row.account === key)
        .forEach((row) => {
          row.paused = true;
        });
    },
  });
  return {
    queue,
    calls,
    releases,
    errors,
    cooldown,
    time: (value) => {
      time = value;
    },
  };
}

test('same account stays serial across tasks and repeated ticks, distinct accounts run concurrently', async () => {
  const h = harness([
    { id: 'a1', account: 'a' },
    { id: 'a2', account: 'a' },
    { id: 'b1', account: 'b' },
  ]);
  h.queue.tick();
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['a1', 'b1']);
  h.releases.get('a1').resolve();
  await flush();
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['a1', 'b1', 'a2']);
});

test('concurrency cap is enforced and available slots continue without waiting for slow accounts', async () => {
  const h = harness(
    ['a', 'b', 'c'].map((account) => ({ id: account, account })),
    2,
  );
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['a', 'b']);
  h.releases.get('b').resolve();
  await flush();
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['a', 'b', 'c']);
  assert.equal(h.queue.active.size, 2);
});

test('account cooldown crosses task boundaries and does not block other accounts', async () => {
  const h = harness([
    { id: 'a1', account: 'a' },
    { id: 'a2', account: 'a' },
    { id: 'b', account: 'b' },
  ]);
  h.queue.tick();
  await flush();
  h.cooldown.set('a', 300);
  h.releases.get('a1').resolve();
  await flush();
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['a1', 'b']);
  h.time(300);
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['a1', 'b', 'a2']);
});

test('one account rejection pauses its siblings, releases lock and leaves other accounts running', async () => {
  const h = harness(
    [
      { id: 'a1', account: 'a' },
      { id: 'a2', account: 'a' },
      { id: 'b', account: 'b' },
      { id: 'c', account: 'c' },
    ],
    2,
  );
  h.queue.tick();
  await flush();
  h.releases.get('a1').reject(new Error('connection lost'));
  await flush();
  h.queue.tick();
  await flush();
  assert.deepEqual(h.errors, ['connection lost']);
  assert.deepEqual(h.calls, ['a1', 'b', 'c']);
  assert.equal(h.queue.active.has('a'), false);
});

test('restored cooldown prevents a new queue from sending early', async () => {
  const h = harness([
    { id: 'a', account: 'a' },
    { id: 'b', account: 'b' },
  ]);
  h.cooldown.set('a', 500);
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['b']);
  h.time(499);
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['b']);
  h.time(500);
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['b', 'a']);
});

test('a delayed campaign does not hide an eligible sibling on the same account', async () => {
  const h = harness([
    { id: 'later', account: 'a', nextAt: 500 },
    { id: 'ready', account: 'a' },
    { id: 'other', account: 'b' },
  ]);
  h.queue.tick();
  await flush();
  assert.deepEqual(h.calls, ['ready', 'other']);
});
