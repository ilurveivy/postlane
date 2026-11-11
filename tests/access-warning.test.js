import test from 'node:test';
import assert from 'node:assert/strict';
import { accessWarning } from '../server/access-guard.js';

const password = 'x'.repeat(32);

test('鉴权告警：把「谁都能连」的组合说出来，其余保持沉默', () => {
  // 本机且没密码：允许（开发默认），但提醒一句。
  assert.match(accessWarning({}, { bindHost: '127.0.0.1', lan: false }), /unauthenticated/);
  assert.equal(
    accessWarning({ POSTLANE_ACCESS_PASSWORD: password }, { bindHost: '127.0.0.1' }),
    '',
  );

  // 对外监听却没密码 —— 唯一会让人损失真实邮箱账号的情况。
  for (const bindHost of ['0.0.0.0', '192.168.1.10']) {
    const warn = accessWarning({}, { bindHost });
    assert.match(warn, /every mail account/);
    assert.match(warn, /POSTLANE_ACCESS_PASSWORD/);
  }
  // 只开 LAN_ACCESS、绑回环也算对外（进程会绑 0.0.0.0）。
  assert.match(accessWarning({}, { bindHost: '127.0.0.1', lan: true }), /every mail account/);

  // 密码来自文件也算设置了。
  assert.equal(
    accessWarning({ POSTLANE_ACCESS_PASSWORD_FILE: '/run/secrets/p' }, { bindHost: '0.0.0.0' }),
    '',
  );

  // mode=off 会忽略已设置的密码，最容易被误以为「我设了密码」。
  assert.match(
    accessWarning(
      { POSTLANE_ACCESS_MODE: 'off', POSTLANE_ACCESS_PASSWORD: password },
      { bindHost: '0.0.0.0' },
    ),
    /ACCESS_MODE=off/,
  );

  // 告警必须是纯 ASCII：Windows 控制台不是 UTF-8 时中文会变成乱码。
  for (const env of [{}, { POSTLANE_ACCESS_MODE: 'off' }]) {
    const warn = accessWarning(env, { bindHost: '0.0.0.0' });
    assert.match(warn, /^[\x20-\x7e]+$/);
  }
});
