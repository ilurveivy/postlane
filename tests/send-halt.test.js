import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The halt flag lives in the document store, so give this file its own data directory
// before anything imports the store.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-halt-'));
const { haltState, sendingHalted, setHalt } = await import('../server/send-halt.js');

test('急停：默认关闭，读取时不写脏数据', () => {
  assert.deepEqual(haltState(), { id: 'send-halt', halted: false, reason: '', at: null });
  assert.equal(sendingHalted(), false);
});

test('急停：开启后记录原因与时间，恢复后清空原因', () => {
  const on = setHalt(true, '  发现名单有问题  ');
  assert.equal(on.halted, true);
  assert.equal(on.reason, '发现名单有问题');
  assert.ok(Date.parse(on.at));
  assert.equal(sendingHalted(), true);
  assert.equal(haltState().halted, true);

  const off = setHalt(false);
  assert.equal(off.halted, false);
  assert.equal(off.reason, '');
  assert.equal(sendingHalted(), false);
  assert.equal(haltState().reason, '', '恢复后不应残留上一次的原因');
});

test('急停：只有明确的 true 才算停发', () => {
  setHalt('true', '字符串不算');
  assert.equal(sendingHalted(), false);
  setHalt(1);
  assert.equal(sendingHalted(), false);
  assert.equal(setHalt(true, 'x'.repeat(500)).reason.length, 200, '原因长度被截断');
  setHalt(false);
});
