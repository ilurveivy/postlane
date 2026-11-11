import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendDelay,
  normalizeList,
  render,
  variables,
  validateCampaign,
  emailHtml,
  csv,
  emailValid,
} from '../server/domain.js';

test('名单清洗：去空格、邮箱大小写去重、无效地址排除、保留个性化字段', () => {
  const list = normalizeList(
    '客户',
    [
      { 邮箱: ' A@EXAMPLE.COM ', 姓名: ' 小满 ' },
      { 邮箱: 'a@example.com', 姓名: '重复' },
      { 邮箱: 'invalid' },
      { 邮箱: 'b@example.com', 姓名: '一舟' },
    ],
    '邮箱',
  );
  assert.equal(list.contacts.length, 2);
  assert.equal(list.issues.length, 2);
  assert.equal(list.contacts[0].fields.姓名, '小满');
  assert.equal(list.contacts[0].email, 'a@example.com');
  assert.equal(list.issues[0].reason, '重复邮箱');
  assert.equal(list.issues[1].row, 4);
});
test('变量检查覆盖所有收件人，缺失字段不能静默发送', () => {
  assert.deepEqual(variables('{{ 姓名 }}，{{公司}}，{{姓名}}'), ['姓名', '公司']);
  assert.equal(render('你好 {{ 姓名 }}', { 姓名: '<小满>' }), '你好 <小满>');
  assert.throws(
    () =>
      validateCampaign({
        subject: '{{姓名}}',
        body: '你好',
        recipients: [{ email: 'a@example.com', fields: {} }],
      }),
    /缺少变量/,
  );
  assert.throws(() => validateCampaign({ subject: ' ', body: '你好', recipients: [] }), /主题/);
  assert.throws(
    () =>
      validateCampaign({
        subject: '{{toString}}',
        body: '你好',
        recipients: [{ email: 'a@example.com', fields: {} }],
      }),
    /缺少变量/,
  );
});
test('邮件和 CSV 转义，避免 HTML 注入及表格公式注入', () => {
  assert.ok(emailHtml('<img src=x onerror=alert(1)>', '<script>').includes('&lt;img'));
  assert.ok(!emailHtml('<script>', 'a').includes('<script>'));
  const output = csv([['=1+1', '  @SUM(A1)', 'hello"world', '普通内容']]);
  assert.ok(output.includes("'=1+1"));
  assert.ok(output.includes("'  @SUM"));
  assert.ok(output.includes('hello""world'));
  assert.equal(emailValid('a@example.com,b@example.com'), false);
});

test('随机发送间隔范围、兼容固定速度及演练加速', () => {
  const delays = Array.from({ length: 200 }, () => sendDelay({ mode: 'live', rate: 1 }));
  assert(delays.every((d) => Number.isInteger(d) && d >= 30000 && d <= 120000));
  assert(new Set(delays).size > 1);
  assert.equal(sendDelay({ mode: 'live', randomInterval: false, rate: 1 }), 60000);
  assert.equal(sendDelay({ mode: 'simulation', randomInterval: true }), 250);
});
