# 备份与恢复

备份是这套系统里**唯一不能省**的东西：`DATA_DIR/secret.key` 一旦丢失，数据库里保存的邮箱密码就永久解不开；
SQLite 单文件数据库一旦损坏，没有备份就只能重来。

## 备份包里有什么

```
manifest.json          # 版本、日期、各 kind 文档计数、每个文件的 SHA-256、git 版本
data/postlane.sqlite   # 用 SQLite 在线备份 API 生成的一致性快照（不是直接复制主库）
data/secret.key        # 字段加密密钥
data/…                 # DATA_DIR 中除数据库和进程锁以外的其它文件
outputs/…              # 留档副本等产物（存在才打）
```

流程故意做成「生成 → 自检 → 加密 → 校验」四段，任何一步失败都不会把备份状态标成成功：

1. `better-sqlite3` 的在线备份接口生成快照，避免复制正在写入的数据库；
2. 对快照跑 `PRAGMA integrity_check`，不是 `ok` 就中止；
3. 打包成 `tar.gz`，同时写下每个文件的 SHA-256 清单；
4. 用 AES-256-GCM 加密成 `.tar.gz.enc`（前 9 字节 magic `POSTLANE2` + 12 字节 IV + 密文 + 16 字节 auth tag）；
5. 解一遍密、逐文件比对哈希、再对恢复出来的数据库做一次 `integrity_check`；
6. 如果配了 `POSTLANE_BACKUP_REMOTE_DIR`，复制过去后**读回来再算一次 SHA-256** 才认为远端完成。

## 打开自动备份

```bash
# 方式一：环境变量
POSTLANE_BACKUP_ENABLED=true npm start

# 方式二：在配置目录放一个标记文件（内容随意，存在即可）
mkdir -p ~/.config/Postlane && touch ~/.config/Postlane/backup.json
```

服务启动后每 60 秒检查一次：今天是否已经成功备份过；没成功就跑一次
`node scripts/backup.mjs`。失败会保留上一份备份，15 分钟后重试。

手动跑一次：

```bash
npm run backup            # 或 node scripts/backup.mjs
node scripts/backup.mjs --force   # 今天已经成功过也强制再来一次
```

产物默认落在 `POSTLANE_BACKUP_DIR`（默认 `~/Postlane-backups`），文件名形如
`2026-11-02T02-15-33-123Z.tar.gz.enc`。

## 密钥保管

加密密钥是 `POSTLANE_CONFIG_DIR/backup-recovery.key`（首次备份时自动生成，32 字节，权限 `600`）。

**它必须和备份包分开存放。** 备份包放在对象存储/网盘上，密钥放在密码管理器或另一台机器的私密目录里。
丢了密钥，备份包就是一堆随机字节。

> ⚠️ 这是两把不同的钥匙，别混：
>
> - `backup-recovery.key` 加密**备份包**；
> - `DATA_DIR/secret.key` 加密**数据库里的账号密码**。
>   后者被打进备份包里，所以恢复备份时两把都会回来。

## 恢复

```bash
node scripts/restore-backup.mjs <备份包> <密钥文件> <一个新目录>
```

例：

```bash
node scripts/restore-backup.mjs \
  ~/Postlane-backups/2026-11-02T02-15-33-123Z.tar.gz.enc \
  ~/.config/Postlane/backup-recovery.key \
  /tmp/postlane-restore-20261102
```

设计上的约束，别绕过：

- **目标目录必须不存在。** 脚本拒绝覆盖现有数据 —— 恢复永远落到新目录，确认无误后再切换 `DATA_DIR`。
- 解密后逐文件比对 `manifest.json` 里的哈希，再对数据库做 `integrity_check`，任何一项不过就报错退出。
- 恢复出来的副本**不要直接用来发信**。先以只读方式看一眼：

```bash
POSTLANE_MODE=verify DATA_DIR=/tmp/postlane-restore-20261102 npm start
```

确认数据对得上，再停掉正式实例、把 `DATA_DIR` 指过去。

## 恢复演练建议

至少做一次这样的演练，并把结果记下来：

1. 在干净目录恢复一份上周的备份；
2. `verify` 模式启动，检查账号数量、某个批次的发送记录、跟进里最近的回复；
3. 确认 `secret.key` 对得上（账号能解密出密码、能点「测试连接」但不发送）。

没有演练过的备份，等于没有备份。

## 备份失败会怎样

- 备份状态写入 `POSTLANE_CONFIG_DIR/backup-status.json`，界面「批次报表」页会显示最近一次备份时间。
- 失败时上一份成功备份不会被删除。
- 设置了 `POSTLANE_ADMIN_EMAIL` 且系统里有一个可用的 SMTP 账号时，会生成一条告警投递给该地址；
  没设置就只写日志，不发任何邮件。
