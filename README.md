# ΟΔΥΣΣΕΙΑ

完全搬离 Discord 的类脑式 AIRP 社区论坛。NodeBB（骨架）+ Centrifugo（实时聊天流）+ Meilisearch（全文搜索）缝合，单机 64G 一把梭。

```
odysseia/
├── docker-compose.yml        # 七服务编排（caddy/nodebb/centrifugo/meili/mongo/redis/bff）
├── .env.example              # 密钥清单模板
├── caddy/Caddyfile           # 反向代理路由表（WS 升级 / 管理界面 / BFF / NodeBB）
├── centrifugo/config.json    # 四 namespace：topic / chat / typing / user
├── nodebb/Dockerfile         # 官方 NodeBB 4 + 两个自研插件
├── plugins/
│   ├── nodebb-plugin-odysseia-bridge/   # 桥接：hooks→Centrifugo 广播 + Meili 同步 + 内部鉴权 API
│   │   ├── library.js        #   频道命名：topic:{tid} / chat:{roomId} / user:{uid}
│   │   ├── lib/centrifugo.js #   HTTP API 客户端（fire-and-forget，失败不阻塞发帖）
│   │   ├── lib/search.js     #   Meilisearch 索引同步（增删改幂等）
│   │   └── lib/internal.js   #   can-read / can-chat（X-Internal-Token）
│   └── nodebb-plugin-odysseia-rules/    # 制度：答题准入 / 120h 缓冲 / 身份组晋升
│       ├── library.js        #   filter:register.check 服务端强制
│       └── lib/              #   quiz（题库+一次性token） / promote（cron晋升） / profile（缓冲区API）
├── bff/                      # BFF 聚合层（无状态，可随时重启）
│   └── server.js             #   /token 签发 / /centrifugo/subscribe 鉴权回调 / /upload/presign R2直传
└── scripts/
    ├── bootstrap.sh          # 首次部署：激活插件 + build + 重启 + ACP 手动步骤清单
    └── backup.sh             # 每日备份：mongodump + uploads → age 加密 → R2
```

## 部署

### 0. 前置

- Docker + Docker Compose v2
- 域名 DNS 已指向服务器（Cloudflare 代理模式开小灰云，隐藏源站 IP）
- 宿主机安装 `age` 和 `rclone`（仅备份脚本用）

### 1. 生成密钥

```bash
cp .env.example .env

# 全部 changeme 替换为：
openssl rand -hex 32    # CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY / CENTRIFUGO_HTTP_API_KEY / ODYSSEIA_INTERNAL_TOKEN（NodeBB secret 由 setup 自动生成，无需配置）
openssl rand -base64 24 # MONGO / REDIS / MEILI / CENTRIFUGO_ADMIN_PASSWORD 密码

# R2：Cloudflare 控制台创建三个桶 + API Token，填入 R2_* 变量
# age：age-keygen -o key.txt，公钥填 BACKUP_AGE_PUBLIC_KEY，私钥离线保存
```

### 2. 启动

```bash
docker compose up -d --build
```

浏览器访问 `https://<域名>` 完成 NodeBB 首次安装（管理员账号、数据库配置已在容器注入，按向导走即可）。

### 3. 激活自研插件

```bash
bash scripts/bootstrap.sh
```

脚本会自动：写 config.json 激活列表 → `./nodebb build` → 重启。末尾打印 ACP 手动步骤（创建身份组、版块权限、上传题库），照做即可。

### 4. 验证

```bash
# Centrifugo 管理界面（建议加 IP 白名单）
https://<域名>/centrifugo/

# BFF 健康
curl https://<域名>/bff/healthz

# 内部鉴权 API（应返回 403，未带 token）
curl https://<域名>/api/v3/plugins/odysseia/can-read/1/1
```

## 路由表（Caddy）

| 路径 | 去向 | 说明 |
|---|---|---|
| `/connection/*` | Centrifugo | WS 实时通道（前端 SDK 连这里） |
| `/centrifugo/*` | Centrifugo | 管理界面 |
| `/bff/*` | BFF :3000 | token / presign（剥前缀） |
| 其余 | NodeBB :4567 | SSR 页面 + REST API |

## 前端接入实时聊天流（自研主题时）

```js
import { Centrifuge } from 'centrifuge';

const { token } = await fetch('/bff/token').then(r => r.json());
const centrifuge = new Centrifuge('/connection/websocket', { token });

// 帖内聊天室：订阅即触发 BFF→NodeBB 鉴权，无权（R18 等）直接拒订
const sub = centrifuge.newSubscription(`topic:${tid}`);
sub.on('publication', ctx => appendMessage(ctx.data));  // bridge 插件广播的帖子消息
sub.subscribe();
```

消息负载格式（`message.new` / `message.edit` / `message.delete` / `chat.new` 等）见 `plugins/nodebb-plugin-odysseia-bridge/library.js` 的各 hook 实现。

## 备份

```bash
# 手动
bash scripts/backup.sh

# crontab（每日 04:15 UTC+8 建议）
15 4 * * * bash /opt/odysseia/scripts/backup.sh >> /var/log/odysseia-backup.log 2>&1

# 恢复（离线机持有 age 私钥时）
age -d -i key.txt odysseia-2026xxxx.tar.age > bundle.tar
tar xf bundle.tar   # 得到 dump.gz + uploads.tar.gz
# mongorestore --archive --gzip 恢复数据库
```

## 安全清单（落地情况）

- [x] 全链路 TLS（Caddy 自动签）
- [x] 源站 IP 隐藏（Cloudflare 代理 + Caddy 仅响应域名请求）
- [x] R18 无权者 404 语义：Centrifugo 拒订 + category 组权限双保险
- [x] 内部 API 全部 X-Internal-Token，仅 compose 内网可达
- [x] 上传走 R2 预签名直传，服务器零中转带宽
- [x] 备份 age 公钥加密，私钥离线
- [x] Caddy 关闭访问日志（隐私优先）
- [ ] EXIF 剥离：接入 Cloudflare Image Resizing 时开启 `metadata=keep` 关闭项
- [ ] IP 轮转：NodeBB 默认存 IP，`nodebb-plugin-anonymous` 类插件或 ACP 设置按需开启
- [ ] `X-Robots-Tag: noindex` 全站：Caddyfile 加一行 `header X-Robots-Tag "noindex"`（社区私密期再开，防搜索引擎收录）

## 内存预算（64G 宿主机）

Mongo 12G（wiredTiger cache）+ Meili 8G + NodeBB ~4G + Centrifugo ~2G + Redis 2G + 系统/页缓存 ~30G。已全部在 compose 中固化。

## 许可证

本项目整体以 [GPL-3.0](LICENSE) 发布（NodeBB 插件因同进程链接 NodeBB，必须 GPL 兼容；BFF 虽为独立进程，一并 GPL 以保持仓库单一许可证）。

上游组件均为官方镜像原样运行（源码未修改、不入本仓库），仅致谢如下：

| 组件 | 用途 | 许可证 |
|---|---|---|
| [NodeBB](https://github.com/NodeBB/NodeBB) | 论坛骨架 | GPL-3.0 |
| [Caddy](https://github.com/caddyserver/caddy) | 反向代理 / TLS | Apache-2.0 |
| [Centrifugo](https://github.com/centrifugal/centrifugo) | 实时消息网关 | Apache-2.0 |
| [Meilisearch](https://github.com/meilisearch/meilisearch) | 全文搜索 | MIT |
| [centrifuge-js](https://github.com/centrifugal/centrifuge-js) | 前端实时 SDK | MIT |
| [meilisearch-js](https://github.com/meilisearch/meilisearch-js) | 搜索客户端 | MIT |
