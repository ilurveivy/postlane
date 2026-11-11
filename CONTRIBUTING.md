# 贡献指南

欢迎 PR。这个项目是单机自托管应用，改动请围绕「更可靠地发一封正确的信」这个目标。

## 开始

```bash
git clone https://github.com/ilurveivy/postlane.git
cd postlane
npm ci --ignore-scripts     # 跳过 better-sqlite3 的原生编译
npm run build
npm test
```

Node.js 22.12+。Windows 上跑集成测试需要 `openssl` 和 `tar` 在 `PATH` 里。

## 分支与提交

- 从 `main` 切功能分支，一个 PR 一件事。
- 提交信息说清**为什么**改，而不只是改了什么：

  ```
  fix: 停止服务时不再派发新邮件

  之前 draining 只挡住新请求，已在排队的账号队列仍会继续取任务，
  导致 SIGTERM 之后还有邮件发出。现在 beginDrain() 同时清空领取资格。
  ```

- 提交前跑 `npm run build` 和 `npm test`，PR 里写明结果和跳过项。
- 不要顺手重排无关文件，review 会很难看。

## PR 检查清单

- [ ] 有能复现问题的测试（bug 修复）或覆盖新行为的测试（新功能）
- [ ] `npm run build` 通过
- [ ] `npm test` 通过
- [ ] 没有新增对真实邮箱、真实 SMTP、真实数据的依赖
- [ ] 没有提交 `data/`、`dist/`、`node_modules/`、`.env`、密钥或真实地址
- [ ] 行为变化同步更新了 `docs/`

## 绝对不要做的事

这些不是风格偏好，每一条都对应过真实事故：

- **不要**把「结果不明」的邮件改成自动重试 —— 会造成对方收到两封。
- **不要**用「读一次 → 整份写回」的方式更新共享文档 —— 会丢并发写入，请走 `revision`。
- **不要**在测试里连真实 SMTP 或真实邮箱账号。
- **不要**为了消除解密报错而重新生成 `secret.key` —— 那会永久丢掉已保存的凭据。
- **不要**提高并发来解决发送慢 —— 先看是不是被对方限流。

## 报告问题

用 issue 模板，附上：

- 版本（`package.json` 里的 version）与 Node 版本；
- 操作系统与部署方式（Docker / 本机 Node）；
- 复现步骤、预期结果、实际结果；
- 相关状态的脱敏描述（**不要贴真实邮箱、密码、完整邮件正文**）。
