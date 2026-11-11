# 配置项全集

所有配置都通过环境变量提供，没有配置文件。Docker 部署时对应 `.env` 里的同名项。

## 服务与存储

| 变量                  | 默认                 | 说明                                                        |
| --------------------- | -------------------- | ----------------------------------------------------------- |
| `PORT`                | `4173`               | HTTP 端口                                                   |
| `DATA_DIR`            | `./data`             | SQLite 数据库、`secret.key`、留档文件的目录。**必须持久化** |
| `STATIC_DIR`          | `dist`               | 前端静态资源目录                                            |
| `POSTLANE_CONFIG_DIR` | `~/.config/Postlane` | 备份/恢复状态文件、备份统计文件所在目录                     |
| `POSTLANE_BACKUP_DIR` | `~/Postlane-backups` | 备份包默认输出目录                                          |

`DATA_DIR` 里会出现：

| 文件              | 作用                                             |
| ----------------- | ------------------------------------------------ |
| `postlane.sqlite` | 主数据库（`documents` 表，按 `kind` 存各类文档） |
| `secret.key`      | 账号密码等敏感字段的加密密钥                     |
| `server.lock`     | 单实例锁，防止两个进程同时发信                   |
| `outputs/`        | 留档副本等产物                                   |

> ⚠️ `secret.key` 丢了 = 数据库里已保存的邮箱密码全部无法解密。换机器请把整个 `DATA_DIR` 一起搬。

## 访问控制

| 变量                            | 默认    | 说明                                                                         |
| ------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `POSTLANE_ACCESS_MODE`          | `basic` | `basic` = Basic 认证；`off` = 不鉴权                                         |
| `POSTLANE_ACCESS_PASSWORD`      | 空      | 密码，**至少 32 字符**。留空 = 不鉴权                                        |
| `POSTLANE_ACCESS_PASSWORD_FILE` | 空      | 从私有文件读密码（POSIX 上要求 `600`），与上一项二选一                       |
| `POSTLANE_PUBLIC_ORIGIN`        | 空      | 反向代理后的 HTTPS 源，如 `https://mail.example.com`；同时用于 CSRF 来源校验 |
| `LAN_ACCESS`                    | `false` | `true` 时允许本机以外的局域网设备访问；来源地址必须属于私网                  |

行为说明：

- 设置密码后，浏览器会弹 HTTP Basic 登录框，**用户名固定为 `postlane`**，密码是你配的值。
- `LAN_ACCESS=false`：只接受 `localhost` / `127.0.0.1` / `[::1]`。
- `LAN_ACCESS=true`：额外接受本机网卡上的私网 IPv4（`10/8`、`172.16/12`、`192.168/16`、`127/8`），
  并且请求来源也必须是私网地址。公网来源一律 403。
- 想让公网访问，正确做法是反向代理（Nginx/Caddy）终止 TLS，再配 `POSTLANE_PUBLIC_ORIGIN`；
  不要直接把端口暴露出去。
- 没有设置密码时服务是**完全开放**的，只应在自己的机器上这么跑。

## 运行模式与后台任务

| 变量                        | 默认    | 说明                                                                        |
| --------------------------- | ------- | --------------------------------------------------------------------------- |
| `POSTLANE_MODE`             | `live`  | `live` = 正常；`verify` = 只读演示（拒绝写操作、发信、IMAP 同步、外部请求） |
| `DISABLE_MAIL_SYNC`         | `false` | `true` 关掉 IMAP 收信轮询                                                   |
| `DISABLE_BATCH_REPORTS`     | `false` | `true` 关掉批次报表生成                                                     |
| `DISABLE_BACKUP`            | `false` | `true` 关掉每日备份调度                                                     |
| `DISABLE_DELIVERY_RECOVERY` | `false` | `true` 关掉重启后的投递状态恢复                                             |
| `DISABLE_SLEEP_GUARD`       | `false` | `true` 关掉 macOS 防休眠（`caffeinate`）                                    |

`POSTLANE_MODE=verify` 是进程级不可变开关，切换必须重启。它适合：

- 给别人演示界面而不想碰到任何真实账号；
- 排查问题时只读查看；
- 从备份恢复后先看一眼数据（恢复出来的副本禁止直接用于发信）。

`DISABLE_SLEEP_GUARD`：macOS 上发信/同步进行时会拉起 `caffeinate` 防止睡眠；Linux 与 Windows 上这个开关无效果。

## 发送

| 变量                       | 默认 | 说明                                                                 |
| -------------------------- | ---- | -------------------------------------------------------------------- |
| `SEND_ACCOUNT_CONCURRENCY` | `3`  | 同时进行的账号数上限。**单账号内部始终串行**                         |
| `SMTP_PROXY`               | 空   | SMTP 出网代理，如 `http://user:pass@host:port`。要求固定出口 IP 时用 |
| `PREFLIGHT_DNS`            | 空   | 填 `disabled` 关闭地址预检的 DNS 查询                                |

关于节奏：

- 同一账号的多个任务共享一把串行锁，不会重叠发送；账号之间并行，上限由 `SEND_ACCOUNT_CONCURRENCY` 控制。
- 账号内每封之间是随机间隔（30–120 秒），不是固定值。
- 提高并发不解决「发得慢」，只会更容易被收件方限流。真要提速应该加账号。

## 报告与留档收件人

Postlane 会给自己发两种内部邮件：批次**执行报告**和 12 小时**核查报告**；发出批次时还可以选择给某几个地址发**留档副本**。
这些收件人不在源码里写死，全部来自环境变量：

| 变量                           | 说明                                                          |
| ------------------------------ | ------------------------------------------------------------- |
| `POSTLANE_REPORT_TO`           | 基础收件人列表，多个用逗号分隔                                |
| `POSTLANE_EXECUTION_REPORT_TO` | 只覆盖执行报告；不填则用基础列表                              |
| `POSTLANE_AUDIT_REPORT_TO`     | 只覆盖 12 小时核查报告；不填则用基础列表                      |
| `POSTLANE_ARCHIVE_RECIPIENTS`  | 留档副本的默认可选项（界面上最多能勾 2 个）；不填则用基础列表 |
| `POSTLANE_INTERNAL_RECIPIENTS` | 属于你自己的其它地址，统计回复率时会被排除                    |

全部留空时的行为：

- 报告照常生成，在「批次报表」页能看，但**不发邮件**；
- 留档副本不勾选就不发；
- 回复率统计不排除任何地址。如果你用主账号给自己发过测试信，可能被算成「回复」——
  这种情况把那个地址填进 `POSTLANE_INTERNAL_RECIPIENTS`。

单个地址也可以直接写一条，例如 `POSTLANE_REPORT_TO=me@example.com`。

## 备份

| 变量                         | 默认    | 说明                                                                                      |
| ---------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `POSTLANE_BACKUP_ENABLED`    | `false` | `true` 打开每日自动备份；也可以在 `POSTLANE_CONFIG_DIR` 放一个 `backup.json` 达到同样效果 |
| `POSTLANE_BACKUP_REMOTE_DIR` | 空      | 额外把备份包复制到这个目录（NFS/SMB/rclone 挂载点），复制后读回校验 SHA-256               |
| `POSTLANE_ADMIN_EMAIL`       | 空      | 备份失败时的告警收件人。留空只写日志、不发信                                              |
| `POSTLANE_TAR`               | `tar`   | 备份脚本调用的 tar 可执行文件，Windows/Git Bash 环境可显式指定                            |

详见 [备份与恢复](backups.md)。

## 示例

只在本机试用：

```bash
DATA_DIR=./data npm start
```

内网部署、有密码、走反向代理：

```bash
POSTLANE_ACCESS_PASSWORD="$(openssl rand -base64 32)" \
POSTLANE_PUBLIC_ORIGIN=https://mail.example.com \
LAN_ACCESS=true \
DATA_DIR=/var/lib/postlane \
SEND_ACCOUNT_CONCURRENCY=3 \
POSTLANE_BACKUP_ENABLED=true \
npm start
```
