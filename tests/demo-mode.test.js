import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// README documents `POSTLANE_MODE=verify DATA_DIR=$(mktemp -d) npm start`, so an empty
// directory has to work and must stay empty: the demo is read-only, including on disk.
process.env.POSTLANE_MODE = 'verify';
const dir = mkdtempSync(join(tmpdir(), 'postlane-demo-'));
process.env.DATA_DIR = dir;
const { all, verificationMode } = await import('../server/store.js').then(async (store) => ({
  ...store,
  verificationMode: (await import('../server/runtime-policy.js')).verificationMode,
}));

test('演示模式：空数据目录也能启动，且不写任何文件', () => {
  assert.equal(verificationMode, true);
  assert.deepEqual(all('account'), []);
  assert.deepEqual(all('campaign'), []);
  assert.deepEqual(
    readdirSync(dir),
    [],
    '演示模式必须只读：目录里不该出现 secret.key / postlane.sqlite / server.lock',
  );
});
