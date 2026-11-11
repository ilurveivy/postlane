import test from 'node:test';
import assert from 'node:assert/strict';
import { bindHost } from '../server/runtime-policy.js';

test('监听地址：默认只绑回环，容器场景由 BIND_HOST 显式放开', () => {
  // 桌面安装：不监听外网。
  assert.equal(bindHost(false, undefined), '127.0.0.1');
  assert.equal(bindHost(false, ''), '127.0.0.1');
  assert.equal(bindHost(false, '   '), '127.0.0.1');
  // LAN_ACCESS=true 是「我确实要开放」，此时才默认绑全地址。
  assert.equal(bindHost(true, undefined), '0.0.0.0');
  // 显式取值优先，镜像里就靠这条在容器内绑 0.0.0.0。
  assert.equal(bindHost(false, '0.0.0.0'), '0.0.0.0');
  assert.equal(bindHost(true, '100.64.0.5'), '100.64.0.5');
});
