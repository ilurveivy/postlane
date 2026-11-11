# 安全说明

## 报告漏洞

请不要开公开 issue。通过 GitHub 的 **Security → Report a vulnerability**
（Private vulnerability reporting）提交，或者直接给维护者发私信说明复现步骤与影响范围。

会在确认后给出修复与披露时间线。请不要在修复前公开细节。

## 部署安全基线

Postlane 处理的是真实邮箱凭据，部署时请至少做到：

1. **设访问密码。** `POSTLANE_ACCESS_PASSWORD` 至少 32 字符（`openssl rand -base64 32`）。
   不设密码时任何能访问端口的人都能操作你的账号、看到邮件正文。
2. **不要直接把端口暴露到公网。** 用 Nginx/Caddy 终止 TLS，设置 `POSTLANE_PUBLIC_ORIGIN`，
   反代再叠一层认证（mTLS / OAuth proxy / IP 白名单）。
3. **`DATA_DIR` 权限收紧。** 里面是数据库和 `secret.key`，只给运行用户读写（`chmod 700`）。
4. **只用应用专用密码。** Gmail 等服务的应用密码可以单独撤销，泄露影响可控。
5. **备份加密且异地。** 备份包用 AES-256-GCM，密钥（`backup-recovery.key`）与备份包分开保存。
6. **不要多实例共享同一个 `DATA_DIR`。** 单实例锁只防误启动，不防多机共享文件系统。

## 凭据与日志

- 邮箱密码在数据库里用 `DATA_DIR/secret.key` 加密存储，明文只出现在内存中的 SMTP/IMAP 调用。
- 日志与错误信息不打印密码、不打印完整邮件正文、不打印 `secret.key`。
- 导出、报表、留档副本里出现的收件人地址属于你导入的数据，注意分发范围。

## 已知的边界

- 这是单机自托管应用：没有多租户、没有角色权限、没有审计日志。多个使用者共享同一个工作台。
- 不做发件域名的 SPF/DKIM/DMARC 配置，那属于邮件服务商的设置。
- 不做反垃圾邮件判断。名单的合法性和合规责任在使用者。
