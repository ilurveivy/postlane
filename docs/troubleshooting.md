# 排障手册

按症状查。每条都写了**先确认什么**，不要跳过证据直接改数据。

## 启动失败

### `gyp ERR! find VS ... Could not find any Visual Studio installation`

`better-sqlite3` 触发了本地编译。它其实自带各平台预编译二进制，不需要编译：

```bash
npm ci --ignore-scripts
```

Windows 上最常见。Linux/macOS 上装好 `python3 make g++` 也能编译，但没必要。

### `The module ... was compiled against a different Node.js version`（NODE_MODULE_VERSION）

Node 版本换了，原生模块 ABI 不匹配。重装依赖：

```bash
rm -rf node_modules && npm ci --ignore-scripts
```

确认 `node -v` 满足 `>=22.12`。

### `EADDRINUSE`

端口被占用。换端口：`PORT=4174 npm start`；或者先找到占用的进程停掉。

### `Access password file must not be readable by other users (chmod 600)`

用了 `POSTLANE_ACCESS_PASSWORD_FILE`，但文件权限太宽：

```bash
chmod 600 /path/to/password-file
```

Windows 上不做这个检查。

### `POSTLANE_ACCESS_PASSWORD must have at least 32 characters`

密码太短会被拒绝启动。生成一个：`openssl rand -base64 32`。

## 访问问题

### 浏览器 403「仅允许本机或已开放的局域网访问」

- 从别的机器访问：需要 `LAN_ACCESS=true`，并且通过私网 IP 访问（`10/8`、`172.16/12`、`192.168/16`）。
- 走域名/反向代理：设置 `POSTLANE_PUBLIC_ORIGIN=https://你的域名`，否则 Host 校验过不去。

### 一直弹 HTTP Basic 登录框 / 登不进去

- 用户名必须是 `postlane`，不是邮箱。
- 密码就是 `POSTLANE_ACCESS_PASSWORD` 的原值，不要加引号或空格。
- 改完环境变量必须**重启**进程。

### 页面能开，但操作报「页面会话已过期，请刷新页面」

CSRF token 对不上，通常发生在：

- 页面开着的时候服务重启了 → 刷新页面；
- 反向代理改写了 `Origin` 头 → 配置 `POSTLANE_PUBLIC_ORIGIN`。

## 发信

### 535 / `Invalid login` 认证失败

- Gmail / Outlook 必须用**应用专用密码**（网页登录密码一定失败）。
- 开了两步验证但没生成应用密码，是最常见的原因。
- 有些服务商要求「SMTP 用户名」和「发件地址」完全一致。

### 421 / 450 / 451 / `Try again later`

对方限流或临时拒绝。系统会按退避自动重试，**不要手动狂点**。
持续发生就降并发（`SEND_ACCOUNT_CONCURRENCY=1`）、加账号，而不是把间隔调成 0。

### 状态一直是「待核对」

SMTP 交互中断（超时、连接重置、返回 5xx 但没有明确拒绝）。含义是**结果不明**，不是失败。

核对手册：

1. 去发信账号的「已发送」里按 `Message-ID` 搜（报表里能看到）；
2. 搜到 → 其实已经发出去了，标记为已发送，**不要再发**；
3. 确定没发出 → 手动重试。

系统故意不自动重试这类邮件，因为补发会让对方收到两封。

### 明明点了发送，队列却不动

按顺序查：

1. 「发送任务」里任务是不是「未排期」/「已预约」但时间没到；
2. 账号是不是被标成「不可用」；
3. 有没有别的进程占着同一个 `DATA_DIR`（`server.lock`）—— 一套 `DATA_DIR` 只允许一个发信进程；
4. 日志里有没有 `ESHUTDOWN`（服务正在优雅停止）。

## 收信 / 跟进

### 邮箱页一直没有新邮件

- `DISABLE_MAIL_SYNC=true` 会彻底关掉 IMAP 轮询；
- 该账号勾了「仅回复」仍然会收信，只是不参与批量发送 —— 两者不冲突；
- IMAP 也要用应用专用密码；端口通常是 `993`（SSL）；
- Gmail 需要在设置里启用 IMAP。

### 一条回复被算成「需要回复」但其实已经回过了

「已处理」是人工标记，系统不会替你判断。在跟进页把那条标成已处理即可；
标记后不会被后续同步覆盖。

### 退信被当成回复

退信（`mailer-daemon` / DSN）会单独归类并默认视为已处理。如果某封退信看起来像正常回复，
说明对方用了非标准格式 —— 手动标记即可，导出时仍然可见。

## 数据

### 账号密码全部解不开 / 提示解密失败

`DATA_DIR/secret.key` 变了或丢了。**不要重新生成密钥**（那会永久丢掉现有密码）。
从备份里找回原来的 `secret.key`：

```bash
node scripts/restore-backup.mjs <备份包> <backup-recovery.key> <新目录>
```

### 备份一直是 `not_started`

备份默认是关的。打开方式见 [backups.md](backups.md)：
`POSTLANE_BACKUP_ENABLED=true`，或在 `POSTLANE_CONFIG_DIR` 放 `backup.json`。

### 备份报 `tar` 相关错误

容器里没有 `tar`（官方镜像已经装了）。本机 Windows 上若 `tar` 不在 `PATH`：

```bash
POSTLANE_TAR="C:\Windows\System32\tar.exe" npm run backup
```

## 排查纪律

- **先看证据再动手。** 报表、日志、`Message-ID`、账号的已发送文件夹，优先于任何猜测。
- **不要为了让报错消失而改数据。** 把 `待核对` 批量改成 `待发送` 会造成重复发送。
- **改数据库前先备份。** 至少 `npm run backup` 一次。
- 需要重新生成密钥、清库、批量改状态这类操作，宁可停下来问清楚再动。
