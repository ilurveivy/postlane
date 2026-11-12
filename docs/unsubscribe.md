# 一键退订：从「点了没反应」到真的不再发

冷邮件必须给一条明确的退出路径，否则既不合规，也会把一次投诉换成一次封号。
Postlane 现在有两条路，都会写进同一张压制名单：

1. **回信退订** —— 对方回「退订 / unsubscribe / please remove me」，
   IMAP 拉回时自动识别（多语言常见说法），写压制名单；
2. **一键退订链接** —— 邮件头里带 `List-Unsubscribe`，正文末尾带一个签名链接，
   点一下（或在 Gmail 里点「退订」按钮）就生效，**不需要回复、不需要登录**。

## 要打开什么

链接必须是一个真实可访问的公开地址，所以要先配：

```bash
# 反向代理后的 HTTPS 源（同时也是 CSRF 来源校验用的那个）
POSTLANE_PUBLIC_ORIGIN=https://mail.example.com
```

没配的话不会发出半截链接：邮件头只剩 `mailto:`（对方点「退订」会生成一封
以 `unsubscribe` 为主题的邮件，靠第 1 条路生效）。预览页会明确提示这件事。

## 没有公开地址？三条路

一键退订需要一个**外网能打开的 HTTPS 地址**，因为收件人点的是邮件客户端里的链接，
不是你的 localhost。挑一个：

### 路线 A：有域名 + 有机器（最正统）

把 `mail.example.com` 解析到跑 Postlane 的机器，前面挂一层反向代理终止 TLS：

```caddy
# Caddy：自动申请证书，两行就够
mail.example.com {
  reverse_proxy 127.0.0.1:4173
}
```

```nginx
# Nginx：证书自己申请（certbot / acme.sh）
server {
  listen 443 ssl http2;
  server_name mail.example.com;
  ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;
  location / { proxy_pass http://127.0.0.1:4173; proxy_set_header Host $host; }
}
```

然后 `.env` 里写 `POSTLANE_PUBLIC_ORIGIN=https://mail.example.com`，重启。
（顺便：这也是[对外访问](configuration.md)的正确方式，别直接把 4173 端口暴露出去。）

### 路线 B：没有域名 / 不想开端口（最快）

用一条隧道把本机端口映射成一个 HTTPS 地址，不用改路由器、不用证书：

```bash
# Cloudflare Tunnel：免费，本机跑起来就有一个 https 地址
cloudflared tunnel --url http://127.0.0.1:4173
# → https://random-words.trycloudflare.com   ← 把它填进 POSTLANE_PUBLIC_ORIGIN

# 或者 ngrok
ngrok http 4173
```

注意两点：

1. **临时隧道的域名每次重启都会变**，变了之后**旧邮件里的退订链接就失效了**
   （老链接指向的域名不再存在）。所以要么用固定域名（Cloudflare 的 named tunnel，
   绑一个自己的域名就能固定），要么接受「这一批信的链接只管这一阵」。
2. 隧道等于把后台暴露到公网 —— **务必先设 `POSTLANE_ACCESS_PASSWORD`**。
   `/u/<token>` 是唯一免登录的路径，其余照旧要密码。

### 路线 C：不配（当前选择，够用也合规）

> 这是本项目的默认方案：`.env` 里不写 `POSTLANE_PUBLIC_ORIGIN`，退订交给「回复退订」。

一键链接的价值主要在 Gmail / Yahoo 的「退订」按钮。如果你每天只发几十封、
正文里已经写明「回复『退订』即可」，那就够了：

- 邮件头仍然带 `mailto:` 兜底，对方点「退订」会生成一封退订邮件；
- IMAP 拉回时自动识别并写压制名单 —— 和点链接的效果完全一样。

代价是：对方要愿意回一句，而 Gmail 不会把「退订」按钮变成一键完成。
用冷邮件量小的话，这条完全可接受；量大（每天上百封）时一键按钮能显著降低投诉率。

### 换了公开地址会不会出问题

退订令牌里只有**地址和签名**，和域名无关，所以同一个数据库搬到新域名，令牌照样有效
—— 只要**旧域名还指向这个服务**，旧邮件里的链接也还能用。
一旦旧域名停了，旧邮件里的链接就点不开了，所以公开地址尽量一次定好。

退订说明仍然是**按任务开关**的：建任务第 2 步「退订说明」，默认关闭。
打开后每封邮件（包括第二、三封跟进）都会附带说明和邮件头。

## 邮件头长什么样

```
List-Unsubscribe: <https://mail.example.com/u/eyJ...==.abc123>, <mailto:you@yourdomain.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

- 第一个地址是**带签名的一次性链接**：签名是 HMAC-SHA256(地址)，
  服务端不用查库就能知道是谁点的，也**伪造不出别人的链接**；
- 第二个是通用兜底：任何客户端都能用它生成一封退订回信；
- `List-Unsubscribe-Post` 是 RFC 8058 的一键退订声明，Gmail / Yahoo 靠它把
  「退订」按钮做成点击即完成，不再要求用户跳到网页。

## 点下去发生什么

```
点链接 → GET  /u/<token>   只显示「确认退订」页面，不产生任何副作用
        → POST /u/<token>  写入压制名单 + 立刻清掉这个人的未发跟进 → 「已退订」
```

`GET` 不生效是故意的：邮件客户端和杀毒网关会**预取链接**，
如果 GET 就退订，扫描器一点就把人退订了，而对方根本没点。

`POST` 之后：

| 位置                    | 变化                                                          |
| ----------------------- | ------------------------------------------------------------- |
| 压制名单（suppression） | 新增/更新该地址，原因是「收件人通过退订链接退订」             |
| 所有任务里的这个人      | `optedOutAt` 打上时间；排队中的跟进取消；显示「已退订」       |
| 后续所有批次            | 发送前检查压制名单，直接跳过（`failed` + 明确原因，不会重试） |

重复点击是安全的：第二次只是同一条记录，`createdAt` 不会被覆盖。

## 为什么这个路由不需要密码

`/u/<token>` 注册在 Basic 鉴权**之前**。点链接的是收件人，不是运营者 ——
要求他输入你的后台密码既不可能也不合理，而「退订要登录」本身就是投诉理由。
安全性由签名保证：没有密钥算不出有效 token，改一个字符就 404。

`tests/unsubscribe-route.test.js` 专门守这条：开着密码时 `/api/state` 401、
`/u/xxx` 404 —— 如果哪天有人把路由挪到鉴权后面，这个测试会红。

## 自查

```bash
# 1) 配好 POSTLANE_PUBLIC_ORIGIN 后重启，预览页不应再出现「没有配置」的提示
# 2) 给自己发一封带退订说明的测试信，在邮件客户端点「退订」
# 3) 后台 → 设置 → 压制名单，应能看到自己的地址
# 4) 这个地址再加进任何一个批次，预览会把它标为已退订/不会发送
curl -sSI http://127.0.0.1:4173/u/not-a-token | head -1   # 期望 404
```

## 和「回信退订」的关系

两者写的是同一张表，所以不会出现「点了链接还收到下一批」的情况。
回信退订识别的是常见措辞（`unsubscribe` / `remove me from your list` /
`请停止联系` / `退订` 等），只判断**对方自己写的那部分**，引用的原文不算 ——
否则一封讨论「how to unsubscribe users」的正常回信会被误判成退订。
