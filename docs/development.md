# 开发指南

## 环境

- Node.js **22.12+**（原生模块按 Node ABI 走，升级 Node 后要重装 `node_modules`）
- `npm ci --ignore-scripts`：跳过原生模块编译（`better-sqlite3` 自带预编译产物）
- Windows 跑集成测试需要 `openssl` 和 `tar` 在 `PATH` 里
  （Git for Windows 自带在 `C:\Program Files\Git\usr\bin`）

```bash
npm ci --ignore-scripts
npm run build          # vite 构建前端到 dist/
npm run dev            # node server/index.js，默认 4173
npm test               # node --test tests/*.test.js
npm run format:check   # prettier
```

开发时把数据放进临时目录，别动自己真实的数据：

```bash
DATA_DIR="$(mktemp -d)" DISABLE_MAIL_SYNC=true DISABLE_BATCH_REPORTS=true DISABLE_BACKUP=true npm run dev
```

这些开关只是关掉后台任务，**不是禁止发信的安全沙箱**。开发调试只用虚构数据和本地
SMTP 测试服（devDependency `smtp-server`），不要连真实邮箱。

## 代码结构

```
server/
  index.js              HTTP 入口：路由、静态资源、发送调度、进程生命周期
  store.js              SQLite 存储层（documents 表）+ 字段加密
  domain.js             领域纯函数：名单规范化、邮箱校验、campaign 校验
  mailer.js             SMTP transport、sendOne、账号并发与串行控制
  account-queue.js      账号级串行锁
  import-batch.js       导入 → 校验 → 分配 → 建任务
  import-task-store.js  导入任务（来源快照）与执行子任务的关联
  import-worker.js      导入解析跑在 worker_threads 里，避免阻塞事件循环
  campaign-builder*.js  任务编排：来源、预览、创建
  delivery-policy.js    失败分类与重试准备
  delivery-recovery.js  进程启动时的投递状态恢复
  followup*.js          IMAP 收信、会话聚合、跟进状态机、导出
  inbox*.js             邮箱页数据视图
  batch-report*.js      批次报表、留档副本、审核
  runtime-policy.js     运行模式、优雅停止、活动计数
  access-guard.js       HTTP Basic 鉴权与公开源校验
src/
  main.jsx              页面骨架与工作概览
  CampaignBuilder.jsx   编排向导
  ImportTasks.jsx       导入任务列表
  Followup.jsx          回复与跟进
  Inbox.jsx             邮箱
  BatchReports.jsx      批次报表
  Unscheduled.jsx       未排期列表
  unscheduled.js        （被 server 复用的纯逻辑）
  followup-filter.js    （被 server 复用的纯逻辑）
scripts/                备份、恢复、历史修复脚本
tests/                  node:test 用例
```

`server/` 有两个文件会 `import '../src/*.js'`（`unscheduled.js`、`followup-filter.js`），
所以 Docker 镜像里必须带上 `src/*.js`。改这两个文件等于同时改前后端。

## 数据模型

单表 `documents`：

| 列                | 说明                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `kind`            | 文档类型：`account`、`list`、`campaign`、`reply-draft`、`inbox-message`、`report-batch`、`batch-report`、`import-task` 等 |
| `document_id`     | 业务主键                                                                                                                  |
| `payload`         | JSON 原文                                                                                                                 |
| `revision`        | 乐观并发控制版本号                                                                                                        |
| `id`              | 自增序列                                                                                                                  |
| `ctime` / `mtime` | 时间戳                                                                                                                    |

读改写必须走 `revision`：读到 `revision`，写回时带上，不匹配就失败重来。
不要用「读一次 → 改内存 → 整份覆盖」的写法，那会丢掉并发期间别人的写入。

字段级加密只用于凭据（邮箱密码等），密钥来自 `DATA_DIR/secret.key`。

## 不能破坏的不变量

改这块代码前先读这几条，它们对应真实事故：

1. **结果不明不重发。** SMTP 交互中断后状态是 `uncertain`，只能人工核对。
   任何「超时就重试」的改动都会造成重复投递。
2. **幂等。** 创建任务带 `requestId`；同一次提交重复请求不能产生两个任务。
3. **预览不落库。** 预览阶段不能写 campaign、不能分配账号、不能碰待发送计数。
4. **预览指纹。** 提交时校验来源数据没变；变了要求重新预览。
5. **单实例发信。** 一个 `DATA_DIR` 只有一个进程能发信（`server.lock`）。
6. **优雅停止。** `draining` 期间不再领新任务，正在进行的请求要跑完。
7. **网络调用在事务外。** 不要在 SQLite 写事务里做 SMTP/IMAP。
8. **系统生成的邮件（退信、告警）不算业务回复**，统计时要分开。

## 加一个功能：怎么下手

| 需求               | 先看                                                             |
| ------------------ | ---------------------------------------------------------------- |
| 批量预览/分配      | `src/CampaignBuilder.jsx`、`server/campaign-builder-core.js`     |
| 重复/失败/状态不明 | `server/mailer.js`、`delivery-policy.js`、`delivery-recovery.js` |
| 收信/回复          | `server/followup.js`、`followup-imap.js`、`inbox.js`             |
| 报表/留档          | `server/batch-reports.js`、`batch-report-view.js`                |
| 存储/加密          | `server/store.js`、`server/domain.js`                            |

流程建议：

1. 先复现，写清「实际行为 vs 预期行为」，别把猜测当根因；
2. 找到属于哪一层（页面 / 路由 / 领域计算 / 存储 / SMTP-IMAP）；
3. 纯逻辑优先抽到 `server/*-core.js` 或 `src/*.js` 这类可直接单测的文件；
4. 补一条能复现问题的测试，再改代码让它变绿；
5. 跑 `npm run build` + `npm test`，报告里写清跳过的用例。

## 测试

```bash
npm test                              # 全部本地用例
node --test tests/delivery-recovery.test.js   # 单个文件
```

约定：

- 用 `node:test` + `node:assert/strict`，不引第三方测试框架。
- 发信相关的用例用 `smtp-server` 起本地假服务器，**不允许连真实 SMTP**。
- 涉及数据库的用例用 `DATA_DIR=$(mktemp -d)` 的独立目录，跑完删掉。
- 断言值要来自真实语义（比如 `1.2K` 就是 1200），不要照着当前实现的输出倒推。

## 提交

- 一个小改动一个提交，信息写清「为什么」而不只是「改了什么」。
- 不要顺手重排无关文件（prettier 全量格式化会淹没真正的 diff）。
- 提交前跑 `npm run format:check`。
- 不要提交 `data/`、`dist/`、`node_modules/`、`.env`、任何真实邮箱或密码。
