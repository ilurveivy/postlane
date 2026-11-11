import test from 'node:test';
import assert from 'node:assert/strict';
import { addressBlocked, addressRule } from '../server/address-rules.js';

test('地址规则：表格模板里的占位符一律拦下', () => {
  for (const email of [
    'your.email@good.idea',
    'your.name@acme.dev',
    'yourname@gmail.com',
    'john.doe@company.com',
    'jane.doe@company.com',
    'first.last@acme.dev',
    'name@acme.dev',
    'email@acme.dev',
    'test@acme.dev',
    'demo@acme.dev',
    'user@acme.dev',
    'xxx@acme.dev',
  ]) {
    const rule = addressRule(email);
    assert.equal(rule?.status, 'invalid', `${email} 应被拒绝`);
    assert.equal(addressBlocked(email), true, `${email} 不应进入发送队列`);
  }
});

test('地址规则：示例域名视为占位符，导入阶段放行', () => {
  assert.equal(addressRule('someone@example.com')?.status, 'invalid');
  assert.equal(addressRule('someone@yourdomain.com')?.status, 'invalid');
  assert.equal(addressRule('someone@localhost')?.status, 'invalid');
  // 导入时只按本地部分判断，域名判断留给发送前预检 —— 导入不该悄悄改用户的文件。
  assert.equal(addressRule('alex@example.com', { checkDomain: false }), null);
  assert.equal(addressRule('your.email@example.com', { checkDomain: false })?.status, 'invalid');
});

test('地址规则：退信与自动回复地址直接拒绝', () => {
  for (const email of [
    'noreply@acme.dev',
    'no-reply@acme.dev',
    'no.reply@acme.dev',
    'donotreply@acme.dev',
    'mailer-daemon@acme.dev',
    'postmaster@acme.dev',
    'abuse@acme.dev',
    'bounces@acme.dev',
    'notifications@acme.dev',
    'noreply+bounce@acme.dev',
  ]) {
    assert.equal(addressRule(email)?.status, 'invalid', `${email} 应被拒绝`);
    assert.equal(addressBlocked(email), true);
  }
});

test('地址规则：角色邮箱只警告不拦截', () => {
  for (const email of [
    'info@acme.dev',
    'contact@acme.dev',
    'hello@acme.dev',
    'sales@acme.dev',
    'support@acme.dev',
  ]) {
    const rule = addressRule(email);
    assert.equal(rule?.status, 'warning', `${email} 应只警告`);
    assert.equal(addressBlocked(email), false, `${email} 不该被过滤`);
  }
  // 带名字的真实邮箱不受影响。
  for (const email of ['alex@acme.dev', 'mei.hua@acme.dev', 'alex+news@acme.dev', 'x@acme.dev']) {
    assert.equal(addressRule(email), null, `${email} 应交给 DNS 判定`);
  }
  // 判断只看第一个标签：info.alex@ 仍按 info 处理（宁可提醒，也不错杀）。
  assert.equal(addressRule('info.alex@acme.dev')?.status, 'warning');
});

test('地址规则：非法输入不抛错', () => {
  for (const email of ['', '   ', 'no-at-sign', '@acme.dev', 'alex@', null, undefined]) {
    assert.doesNotThrow(() => addressRule(email));
    assert.equal(addressRule(email), null);
  }
});
