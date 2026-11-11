import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.POSTLANE_MODE = 'live';
process.env.DISABLE_BACKUP = 'true';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'postlane-unsub-'));

const { all, get, put } = await import('../server/store.js');
const {
  applyUnsubscribe,
  confirmPage,
  emailFromToken,
  finishedPage,
  notFoundPage,
  unsubscribeToken,
} = await import('../server/unsubscribe.js');
const { unsubscribeHeaders } = await import('../server/send-policy.js');

test('退订令牌：能还原地址，改一个字符就失效', () => {
  const token = unsubscribeToken('Lead@Prospect.dev');
  assert.equal(emailFromToken(token), 'lead@prospect.dev', '令牌里的地址统一小写');
  assert.notEqual(unsubscribeToken('a@b.co'), unsubscribeToken('c@b.co'));

  const [payload, signature] = token.split('.');
  assert.equal(emailFromToken(`${payload}.${signature.slice(0, -2)}xx`), '', '签名被改过就不认');
  assert.equal(emailFromToken(`${payload}x.${signature}`), '', '地址被改过就不认');
  // 把别人的令牌套到自己的地址上：签名对不上，必须拒绝。
  assert.equal(emailFromToken(unsubscribeToken('a@b.co').replace(/^[^.]+/, payload)), '');
  assert.equal(emailFromToken(''), '');
  assert.equal(emailFromToken('garbage'), '');
  assert.equal(emailFromToken('a.b.c'), '');
});

test('退订：写进压制名单，并清掉未发的跟进', () => {
  put('campaign', {
    id: 'c-unsub',
    mode: 'live',
    status: 'completed',
    recipients: [
      {
        id: 'r1',
        email: 'Lead@Prospect.dev',
        status: 'sent',
        stage: 1,
        sentAt: new Date().toISOString(),
        nextFollowUpAt: Date.now() + 5 * 86400000,
        followUps: [{ subject: '', body: 'x', afterDays: 5 }],
      },
      { id: 'r2', email: 'other@prospect.dev', status: 'sent', stage: 1, nextFollowUpAt: 0 },
    ],
  });

  const result = applyUnsubscribe('lead@prospect.dev');
  assert.equal(result.email, 'lead@prospect.dev');
  assert.equal(result.already, false);
  assert.equal(result.campaigns, 1);

  const suppressed = get('suppression', 'lead@prospect.dev');
  assert.ok(suppressed, '退订必须进压制名单，否则下一批还会发');
  assert.match(suppressed.reason, /退订/);

  const row = get('campaign', 'c-unsub').recipients[0];
  assert.ok(row.optedOutAt, '收件人行要留下退订时间');
  assert.equal(row.nextFollowUpAt, 0, '排队中的跟进要立刻取消');
  assert.match(row.followUpsStopped, /退订/);
  assert.equal(row.sentAt && get('campaign', 'c-unsub').recipients[1].optedOutAt, undefined);

  // 重复退订是可重入的：不报错，也不覆盖第一次的时间。
  const again = applyUnsubscribe('LEAD@prospect.dev');
  assert.equal(again.already, true);
  assert.equal(get('suppression', 'lead@prospect.dev').createdAt, suppressed.createdAt);
});

test('退订页面：默认页只是确认，不产生副作用', () => {
  const token = unsubscribeToken('lead@prospect.dev');
  const page = confirmPage('lead@prospect.dev', token);
  assert.match(page, /form method="post"/, '必须 POST 才真的退订');
  assert.match(page, new RegExp(`/u/${token.replace(/\./g, '\\.')}`));
  assert.match(page, /noindex/);
  // 地址必须转义，避免退订链接变成注入点。
  assert.doesNotMatch(confirmPage('<script>x</script>@a.co', token), /<script>x/);
  assert.match(finishedPage('lead@prospect.dev', false), /已退订/);
  assert.match(finishedPage('lead@prospect.dev', true), /此前就已经在名单里/);
  assert.match(notFoundPage(), /链接无效/);
});

test('退订邮件头：有公开地址时带一键退订，没有时退回 mailto', () => {
  const oneClick = unsubscribeHeaders('brian@sender.dev', 'https://postlane.example.com/u/abc');
  assert.equal(
    oneClick['List-Unsubscribe'],
    '<https://postlane.example.com/u/abc>, <mailto:brian@sender.dev?subject=unsubscribe>',
  );
  assert.equal(oneClick['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const mailtoOnly = unsubscribeHeaders('brian@sender.dev');
  assert.equal(mailtoOnly['List-Unsubscribe'], '<mailto:brian@sender.dev?subject=unsubscribe>');
  assert.equal(mailtoOnly['List-Unsubscribe-Post'], undefined, '没有一键地址时不能声明 One-Click');
  assert.deepEqual(unsubscribeHeaders(''), {});
});

test('退订：只有真正存在的任务行才会被改动', () => {
  const before = all('campaign').length;
  const result = applyUnsubscribe('nobody@prospect.dev');
  assert.equal(result.campaigns, 0);
  assert.ok(get('suppression', 'nobody@prospect.dev'), '陌生人退订也要记下来');
  assert.equal(all('campaign').length, before);
});
