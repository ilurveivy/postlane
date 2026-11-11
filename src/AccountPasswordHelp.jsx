import React, { useState, useRef, useEffect } from 'react';
import { ArrowUpRight, ArrowLeft, ArrowRight, Check, EnvelopeSimple } from '@phosphor-icons/react';

const steps = [
  {
    title: '登录邮箱',
    heading: '先登录要添加的 Gmail',
    desc: '准备好邮箱地址和登录密码，在 Google 页面完成登录。',
    items: [
      '输入完整 Gmail 地址，点击「下一步」。',
      '输入邮箱登录密码；已登录其他账号时，先切换到目标邮箱。',
    ],
    href: 'https://accounts.google.com/',
    action: '打开 Google 登录',
    note: '确认右上角显示的是你要添加的邮箱，后面的应用密码只对这个账号有效。',
  },
  {
    title: '两步验证',
    heading: '确认是你本人在操作',
    desc: '按照 Google 提示，用已绑定的验证方式完成身份验证。',
    items: [
      '使用 Google Authenticator 时，输入其中当前显示的 6 位验证码。',
      '没有看到验证码选项？点击「尝试其他方式」。',
    ],
    note: '6 位验证码只用于登录验证，不能作为 SMTP 应用密码。',
  },
  {
    title: '打开应用密码',
    heading: '进入应用密码管理',
    desc: '账号开启两步验证后，就可以尝试创建应用专用密码。',
    items: [
      '打开下方入口，再次核对当前登录的邮箱。',
      '如 Google 要求重新输入密码或验证码，按页面提示完成。',
    ],
    href: 'https://myaccount.google.com/apppasswords',
    action: '打开应用密码页面',
    note: '尚未开启两步验证？先到 Google 账号安全设置中开启，再返回这里。',
  },
  {
    title: '生成并复制',
    heading: '创建一份专用密码',
    desc: '应用名称只是备注，方便以后识别和管理。',
    items: [
      '名称填写「Postlane SMTP」，点击「创建」或「生成」。',
      '复制 Google 生成的 16 位应用密码，去掉分组空格并妥善保存。',
    ],
    note: '密码只显示一次。关闭后无法再次查看，遗失时需要重新生成。',
  },
  {
    title: '填回表单',
    heading: '把密码填回发件账号',
    desc: '关闭教程后，当前表单中已经填写的内容会保留。',
    items: [
      '在「邮箱授权码 / 应用密码」中粘贴刚生成的 16 位密码。',
      'SMTP 登录账号可留空，会使用发件邮箱；发件人名称留空时使用邮箱前缀。',
    ],
    note: '这里填写应用密码，不是邮箱登录密码，也不是 TOTP 密钥。',
  },
  {
    title: '验证连接',
    heading: '最后，测试一下连接',
    desc: '回到表单，点击「保存并测试连接」。',
    items: [
      '看到连接成功提示后，这个发件账号就配置好了。',
      '之后可向自己发送一封测试邮件，并检查收件箱和垃圾邮件。',
    ],
    note: '连接测试不会发送邮件。更改 Google 登录密码后，需重新生成并更新应用密码。',
  },
];
const External = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
    <ArrowUpRight size={15} />
  </a>
);

export default function AccountPasswordHelp({ onClose }) {
  const [index, setIndex] = useState(0);
  const content = useRef(null);
  const step = steps[index];
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [index]);
  return (
    <div className="password-walkthrough">
      <div className="password-walkthrough-body">
        <nav className="password-steps" aria-label="应用密码教程步骤">
          <div className="password-guide-type">
            <EnvelopeSimple size={19} />
            <span>Gmail 账号配置</span>
          </div>
          {steps.map((s, i) => (
            <button
              key={s.title}
              type="button"
              className={i === index ? 'selected' : ''}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => setIndex(i)}
            >
              <span className="password-step-number">{String(i + 1).padStart(2, '0')}</span>
              <span>{s.title}</span>
            </button>
          ))}
          <p>其他邮箱请使用服务商提供的 SMTP 授权码。</p>
        </nav>
        <section className="password-step-content" ref={content} aria-label={step.title}>
          <div className="password-step-eyebrow">第 {index + 1} 步 / 共 6 步</div>
          <h3>{step.heading}</h3>
          <p className="password-step-desc">{step.desc}</p>
          <ol className="password-instructions">
            {step.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          {step.href && (
            <div className="password-official-action">
              <External href={step.href}>{step.action}</External>
              <span>在新标签页中打开</span>
            </div>
          )}
          {index === 1 && (
            <details className="password-extra">
              <summary>只有 TOTP 密钥，怎么获取验证码？</summary>
              <p>
                在 Google Authenticator 点击「＋ → 输入设置密钥」。名称填邮箱，密钥填已有的 TOTP
                密钥，类型选「基于时间」。将生成的 6 位验证码填回 Google。
              </p>
              <p>已有手机提示等其他验证方式时，无需准备 TOTP。本平台也不需要你填写 TOTP 密钥。</p>
            </details>
          )}
          {index === 2 && (
            <div className="password-extra">
              <External href="https://myaccount.google.com/security">打开账号安全设置</External>
              <details>
                <summary>已开启两步验证，仍然没有入口？</summary>
                <p>组织账号策略、仅使用安全密钥的两步验证或高级保护计划可能限制应用密码。</p>
              </details>
            </div>
          )}
          {index === 3 && (
            <div className="password-example">
              <span>应用名称填写示意</span>
              <strong>Postlane SMTP</strong>
              <span>名称可以自定义，不是生成的密码。</span>
            </div>
          )}
          {index === 4 && (
            <dl className="password-config">
              <div>
                <dt>SMTP 服务器</dt>
                <dd>smtp.gmail.com</dd>
              </div>
              <div>
                <dt>端口 / 加密方式</dt>
                <dd>465 / SSL · TLS</dd>
              </div>
            </dl>
          )}
          {index === 5 && (
            <details className="password-extra">
              <summary>提示密码错误，怎么排查？</summary>
              <p>
                确认密码由当前邮箱生成，使用 16 位应用密码且没有空格或换行。不是登录密码或 6
                位验证码。仍失败时重新生成应用密码。
              </p>
            </details>
          )}
          <p className="password-step-note">{step.note}</p>
        </section>
      </div>
      <footer className="password-guide-footer">
        <External href="https://support.google.com/accounts/answer/185833?hl=zh-Hans">
          Google 官方说明
        </External>
        <div>
          <button
            type="button"
            className="button"
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
          >
            <ArrowLeft />
            上一步
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => (index === 5 ? onClose() : setIndex(index + 1))}
          >
            {index === 5 ? (
              <>
                <Check />
                返回填写账号
              </>
            ) : (
              <>
                下一步
                <ArrowRight />
              </>
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}
