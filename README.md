# Postlane 邮序

**自托管的个性化冷邮件工作台。** 把一份 Excel 变成几百封各自不同的邮件，按发件账号均匀分配、按节奏预约发出，再把回信统一收进来跟进。

> Self-hosted personalized cold-email workbench: import a spreadsheet, render one email per row, spread the batch across your sender accounts, schedule it, then handle replies in one inbox. Node.js + React + SQLite, single-host deployment, no SaaS dependency.

- 前端 React 19 + Vite，后端 Express 5，本地 SQLite 单文件数据库
- 每行一封独立邮件（`{{变量}}` 逐行渲染，收件人之间互不可见）
- 多账号轮转 + 同账号串行 + 随机间隔，降低触发限流的概率
- SMTP 发信、IMAP 收信，回复与退信自动归类
- 结果不明（uncertain）的邮件**不会自动重发**，必须先核对证据

本仓库不含任何真实业务数据、账号或密钥。第一次启动就是一个空的本地工作台。

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/ilurveivy/postlane.git
cd postlane

cp .env.example .env
# 打开 .env，至少设置一个访问密码：
#   POSTLANE_ACCESS_PASSWORD=$(openssl rand -base64 32)

docker compose up -d --build
```

打开 http://localhost:4173 。

### 方式二：本机 Node

需要 Node.js **22.12+**。

```bash
npm ci
npm run build
npm start          # http://localhost:4173
```

> 如果 `npm ci` 在 `better-sqlite3` 上报 `gyp ERR! find VS`（Windows 上没装 Visual Studio 的典型症状）：
> 这个包自带各平台预编译产物，不需要本地编译，用 `npm ci --ignore-scripts` 即可。

### 方式三：只读演示模式（不连任何邮箱）

```bash
POSTLANE_MODE=verify DATA_DIR=$(mktemp -d) npm start
```

`verify` 模式下所有写操作、发信、IMAP 同步和外部请求都被拒绝，适合先看界面。
空目录会用一个内存库展示空界面，**不会在磁盘上留下任何文件**；指向已有数据目录时则只读展示真实数据。

---

## 第一次使用

1. **发件设置** —— 添加一个 SMTP 账号并点「测试连接」。Gmail 要用**应用专用密码**，不是登录密码。
   只用来收信回复的账号可以勾「仅回复」，它不参与批量分配。
   测试连接会顺带检查发件域名的 SPF/DKIM/DMARC，缺记录会给出提示（不阻断保存）。
2. **导入批量任务** —— 上传 `.xlsx` / `.csv`。第一行是表头，必须有 `business_email`、`email_subject`、`email_content` 三列，其余列会变成可用的 `{{变量}}`。
   导入会去重并校验邮箱格式，也可以先跑一次地址预检（DNS/MX），见 [docs/address-preflight.md](docs/address-preflight.md)。

   没数据先试：[examples/sample-leads.xlsx](examples/sample-leads.xlsx)（全是 `example.com` 假地址，发不出去）。

3. **安排发送** —— 选任务、选账号、看预览（就是收件人真实看到的内容）、设节奏、发送时间窗口、是否加退订说明，然后保存草稿 / 立即发送 / 加入预约。
   每个账号每天有上限（新账号 20 封起步，硬顶 200 封），窗口外自动挂起 —— 见 [docs/sending-policy.md](docs/sending-policy.md)。
4. **邮箱与回复跟进** —— IMAP 拉回回信，按「需要回复 / 已处理 / 退信」分类处理，可导出跟进表。
5. **批次报表** —— 每个批次的实际投递结果、失败原因、重试历史，与留档副本彼此独立。

完整操作说明：[docs/operations.md](docs/operations.md)。

配置直接写在项目根目录的 `.env` 里，`npm start` / `npm run dev` 会自动读取
（用的是 Node ≥ 22.9 的 `--env-file-if-exists=.env`，已存在的环境变量优先，不会被文件覆盖）。
Docker 方式读的也是同一个文件。

---

## 配置

所有配置都走环境变量，完整清单见 [docs/configuration.md](docs/configuration.md)。最常用的几个：

| 变量                       | 默认     | 说明                                                           |
| -------------------------- | -------- | -------------------------------------------------------------- |
| `PORT`                     | `4173`   | 监听端口                                                       |
| `BIND_HOST`                | 见说明   | 监听地址；容器/反向代理部署要设 `0.0.0.0`（镜像里已默认设好）  |
| `DATA_DIR`                 | `./data` | SQLite 数据库、`secret.key`、留档文件所在目录，**必须持久化**  |
| `POSTLANE_ACCESS_PASSWORD` | 空       | 设置后启用 HTTP Basic 认证（用户名 `postlane`），至少 32 字符  |
| `POSTLANE_PUBLIC_ORIGIN`   | 空       | 走反向代理时填 `https://mail.example.com`，用于 CSRF 来源校验  |
| `LAN_ACCESS`               | `false`  | `true` 允许局域网设备访问（仍然只接受私网地址）                |
| `POSTLANE_MODE`            | `live`   | `verify` = 只读演示模式                                        |
| `POSTLANE_REPORT_TO`       | 空       | 执行报告 / 核查报告 / 留档副本的收件人；留空则不发这些内部邮件 |
| `POSTLANE_BACKUP_ENABLED`  | `false`  | 打开每日加密备份                                               |

---

## 发送纪律

平台默认就会替你守住这几条，不需要记着配置：

- **每个账号每天有上限**，新账号按 20 → 30 → 50 → 100 → 200 封爬坡，硬顶 200 封；
- **只在指定时段发送**，默认工作日 09:00–18:00（新加坡时间），窗口外挂起不静默丢弃；
- **发送前筛地址**：占位符（`your.email@…`、`example.com`）、退信地址（`noreply@`、`postmaster@`）直接排除，
  角色邮箱（`info@`、`sales@`）只标记；跨任务重复的地址自动跳过；
- **退订说明可开关**，打开时同时带 `List-Unsubscribe` 邮件头；
- **一键急停**：顶栏「全部停发」同时停掉活动任务、回复草稿和报表投递，恢复后从当前收件人继续。

细节和 Message-ID 为什么改成用你自己的域名：[docs/sending-policy.md](docs/sending-policy.md)。

---

## 安全须知

- **默认不鉴权。** 没有设置 `POSTLANE_ACCESS_PASSWORD` 时，任何能访问端口的人都能操作。
  只在本机跑没问题；一旦要对内网或公网开放，先设密码，或者用反向代理再加一层认证。
- `LAN_ACCESS=false` 时只接受本机连接；`LAN_ACCESS=true` 也只接受私网来源地址。
- 账号密码在数据库里用 `DATA_DIR/secret.key` 加密存储。**换机器必须连 `secret.key` 一起搬**，
  否则已保存的账号密码无法解密 —— 不要为了绕开报错重新生成密钥。
- 备份包默认 AES-256-GCM 加密，密钥独立于备份包保存。
- 冷邮件的合规责任在使用者：只用自己有权联系的名单，遵守收件人所在地的反垃圾邮件法规。

---

## 目录结构

| 路径                                      | 用途                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| `src/`                                    | React 页面与共享领域逻辑（`server/` 也会 import 其中两个文件） |
| `server/index.js`                         | HTTP 入口、路由、发送调度                                      |
| `server/store.js`                         | SQLite 存储层与字段加密                                        |
| `server/mailer.js`                        | SMTP 发信、账号并发与间隔控制                                  |
| `server/followup*.js`, `server/inbox*.js` | IMAP 收信、会话聚合、跟进状态机                                |
| `server/batch-report*.js`                 | 批次投递结果与留档                                             |
| `scripts/`                                | 备份、恢复、历史数据修复等运维脚本                             |
| `tests/`                                  | `node --test` 单元与集成测试                                   |
| `docs/`                                   | 操作、配置、开发与排障文档                                     |

---

## 换一台电脑继续用

代码在 GitHub 上，**数据不在**。这两件事要分开准备：

| 在仓库里（跟代码走）     | 只在你本机（不跟代码走）                |
| ------------------------ | --------------------------------------- |
| 程序代码、文档、示例文件 | `data/`：数据库、`secret.key`、留档文件 |
| `.env.example`（模板）   | `.env`：你的访问密码、报告收件人        |

所以换机器是三件事：

1. **拉代码**：`git clone`（或下载 zip）→ `npm ci --ignore-scripts` → `npm run build`。
2. **搬数据**：把旧机器的整个 `data/` 目录复制过来。
   ⚠️ `secret.key` 必须一起复制 —— 它是加密已存邮箱密码的钥匙，丢了就解不开，那些账号得重新输密码。
3. **重建 `.env`**：`cp .env.example .env` 再填值，至少要填 `POSTLANE_REPORT_TO`，
   对外提供服务时还要填 `POSTLANE_ACCESS_PASSWORD`。

不想手动复制就用备份：旧机器 `npm run backup`，把归档和 `backup-recovery.key` 带到新机器，
然后 `node scripts/restore-backup.mjs <归档> <密钥> ./data`。详见 [docs/backups.md](docs/backups.md)。

## 开发

```bash
npm ci
npm run dev            # 开发模式，默认 4173
npm run build          # 生产构建
npm test               # node --test tests/*.test.js
npm run format:check   # prettier 校验
```

开发提示：

- 开发和测试只用虚构数据与本地 SMTP 测试服（`smtp-server`），**不要连真实邮箱**。
- `DATA_DIR` 指向临时目录，避免动到自己的真实数据。
- Windows 上跑 `tests/integration.test.js` 需要 `openssl` 与 `tar` 在 `PATH` 里
  （Git for Windows 自带的在 `C:\Program Files\Git\usr\bin`）。

贡献约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，内部机制见 [docs/development.md](docs/development.md)。

---

## 文档

- [日常操作](docs/operations.md)
- [配置项全集](docs/configuration.md)
- [备份与恢复](docs/backups.md)
- [排障手册](docs/troubleshooting.md)
- [开发指南](docs/development.md)
- [发送纪律](docs/sending-policy.md)（每日上限 / 时间段 / 退订 / 急停）
- [地址预检](docs/address-preflight.md) · [渠道元数据修复](docs/channel-recovery.md)

---

## License

[MIT](LICENSE)
