# ΟΔΥΣΣΕΙΑ

完全搬离 Discord 的类脑式 AIRP 社区论坛。NodeBB 4（骨架）+ Centrifugo v6（实时聊天流）+ Meilisearch（全文搜索）+ MongoDB/Redis + 无状态 BFF，单机 64G 一把梭，全容器化。

**本文面向开发者**：架构数据流、模块职责、接口契约、开发纪律。运维部署清单见 `scripts/` 内注释，照「快速开始」走即可。

## 架构总览

```
浏览器                     Caddy（TLS / 路由）                内网服务
───────                    ──────────────────                ────────
SSR / REST API ─────────►  其余路径 ──────────────────────►  NodeBB :4567 ─┬─ MongoDB（主库）
WS 实时通道   ─────────►  /connection/* ──────────────────►  Centrifugo :8000
token/上传/SDK/分页 ────►  /bff/{token,upload,vendor,healthz,chat} ► BFF :3000（Rust，无状态）
admin UI      ─────────►  （不走公网；宿主机 127.0.0.1:4000，ssh 端口转发访问）

内网回调（公网不可达）：
  Centrifugo ──subscribe proxy（带 x-odysseia-proxy 共享密钥头）──► BFF /centrifugo/subscribe
  BFF ──x-internal-token──► NodeBB /api/v3/plugins/odysseia/*（权威鉴权，fail-closed）

事件流（NodeBB 插件 bridge）：
  action:post.* / messaging.notify ─► Centrifugo HTTP API（广播，fire-and-forget）
                                    └► Meilisearch（索引同步，幂等增删改）
```

关键架构决策（改代码前先读）：

- **独立项目**：NodeBB 4 为骨架但全仓库归我们所有，核心与插件层均可按需改动。
- **D8 BFF 刻意小**：只做「鉴权 + 发证 + 预签名 + 分页适配」，消息流不经过它；无状态、可随时重启。Rust（axum）实现，零 AWS SDK（SigV4 手写签名），镜像 ~15MB。
- **Fluxer 移植纪律**：语义独立重写（read-states/reactions/typing/限频/slowmode/分页契约），代码仅作参考；许可证兼容注意 AGPL 文件级保留。
- **实时层双通道**：首屏走 NodeBB SSR/REST（SEO + 游客），增量走 Centrifugo WS（仅登录用户）。
- **fail-closed 全网**：任何鉴权环节异常/超时/缺密钥 → 拒绝，而非放行。

## 仓库地图

```
odysseia/
├── docker-compose.yml        # 七服务编排 + 监控栈（caddy/nodebb/centrifugo/meili/mongo/redis/bff + prometheus/grafana/cadvisor/exporters）
├── docker-compose.dev.yml    # 本地演示叠加层（弱口令/免TLS，须手动 -f 加载，生产不自动叠加）
├── tsconfig.json             # JSDoc 类型检查（tsc --checkJs，零构建链；.tscheck/ 本地工具链不入库）
├── .env.example              # 全部密钥清单（含生成命令注释）
├── caddy/Caddyfile           # 路由表；/bff/centrifugo/* 故意不出公网（防越权 oracle）
│   └── upstream/caddy/       #   Caddy 源码 vendor（master @ 7328273，缝合件基线）
├── centrifugo/config.json    # 四 namespace + subscribe proxy（static_headers 注共享密钥）
│   └── upstream/centrifugo/  #   Centrifugo 源码 vendor（v6.9.7 @ a2e0896，缝合件基线）
├── nodebb/Dockerfile         # 官方 NodeBB 4 + 两个自研插件
├── nodebb/upstream/NodeBB/   # NodeBB 本体源码（vendor 基线：上游 v4.16.2 @ 18f2a2ee）
│                             # 独立项目：改核心直接在此改（注意与构建镜像 ghcr.io/nodebb/nodebb:4.x 的差异同步）
├── bff/                     # Rust 版 BFF（axum）：契约与旧 Node 版逐字节对齐
│   ├── Cargo.toml           # 依赖：axum/tokio/reqwest/jsonwebtoken/hmac+sha2（无 AWS SDK）
│   ├── src/main.rs          # 五端点：/token、/centrifugo/subscribe、/upload/presign、/chat/:roomId/messages、/vendor/centrifuge.js
│   ├── Dockerfile           # multi-stage 构建，产物 ~15MB
│   ├── vendor/centrifuge.js # SDK 静态托管（构建期 COPY，替代 node_modules）
│   ├── upstream/             #   centrifuge-js（master @ e69b1d8）+ meilisearch-js（v0.44.0）SDK 源码 vendor
│   └── server.js            # 旧 Node 版（契约参考实现，已被 Rust 版替代）
├── monitoring/              # 可观测性（全内网）
│   ├── prometheus.yml        # 抓取配置：centrifugo/meili/mongo/redis/cadvisor/nodebb
│   └── grafana-datasources.yml  # 数据源自动置备
├── plugins/
│   ├── nodebb-plugin-odysseia-bridge/    # 桥接：事件→Centrifugo 广播 + Meili 同步 + 内部鉴权 API + 装饰
│   │   ├── library.js        #   14 个 hook 接线；消息负载构造（见「消息契约」）
│   │   ├── lib/centrifugo.js #   publish 客户端（AbortSignal 3s，失败不阻塞发帖）
│   │   ├── lib/search.js     #   Meili 索引同步（indexPost/deletePost 幂等）
│   │   ├── lib/internal.js   #   can-read / can-chat / chat-index / chat-messages 内部 API（X-Internal-Token）
│   │   ├── lib/decor.js      #   装饰引擎：纯库零 hook（消毒/批量成员判定/组快照缓存），可独立单测
│   │   ├── static/lib/       #   chat.js（WS 连接管理）+ decor.js/css（三端渲染器）
│   │   └── acpTemplates/     #   ACP 装饰规则配置面
│   └── nodebb-plugin-odysseia-rules/     # 制度：答题准入 / 120h 缓冲 / 身份组晋升
│       ├── library.js        #   filter:register.check 强制 + action:user.create 自动入新人组
│       └── lib/              #   quiz（题库+一次性token）/ promote（cron晋升）/ profile（缓冲区API）
└── scripts/
    ├── bootstrap.sh          # 首装后激活插件 + build + 重启，打印 ACP 手动步骤
    ├── backup.sh             # mongodump + uploads + nodebb_config → age 加密 → R2（含 30d 保留策略）
    └── contract-diff.js     # BFF 契约对拍（新旧并排跑，diff 三套契约：429/JWT/错误）
```

## 核心契约

### Centrifugo 频道命名空间（`centrifugo/config.json`）

| 频道 | 用途 | history | 鉴权规则（BFF subscribe proxy 裁决） |
|---|---|---|---|
| `topic:{tid}` | 帖内聊天室（消息=楼层） | 1000 条 / 1h | `privileges.topics.can('topics:read')`，R18 无权者拒订 |
| `chat:{roomId}` | 私聊/群聊 | 200 条 / 1h | `Messaging.isUserInRoom` |
| `typing:topic/chat:*` | 正在输入（presence 不落库） | 无 | 同对应父频道；订阅者可 publish |
| `user:{uid}` | 用户通知/多端同步 | 50 条 / 24h | **仅本人**（`uid === channel 后缀`） |
| 未知前缀 | — | — | 一律拒绝（fail-closed） |

**订阅必经 subscribe proxy**：四个 namespace 全部 `subscribe_proxy_enabled`，客户端无法绕过 BFF 直订。

### 鉴权四层防线（自上而下）

1. **连接**：浏览器 `GET /bff/token`（带 NodeBB 会话 cookie）→ BFF 验会话后签 Centrifugo JWT（`sub=uid`，TTL 2h，前端 `getToken` 回调自动续期）。
2. **订阅**：Centrifugo 收到 subscribe → proxy 回调 BFF，`config.json` 的 `static_headers` 自动注入 `x-odysseia-proxy` 共享密钥；BFF 首行校验密钥（缺失 fail-closed），uid 仅取 `body.user`（Centrifugo 服务端从 JWT 注入，可信），**不回退任何客户端可伪造的头**。
3. **裁决**：BFF 调 NodeBB 内部 API（`x-internal-token`，仅 compose 内网可达）做权威权限判断。
4. **公网面**：Caddy 只放行 `/bff/token|upload|vendor|healthz`；`/bff/centrifugo/*` 不出公网（否则成越权探测 oracle）。

### 消息负载（bridge 插件广播，前端消费）

`topic:{tid}` 频道：

| type | 负载 | 触发 hook |
|---|---|---|
| `message.new` | `{ pid, tid, uid, username, picture, decor, content, timestamp, index }` | `action:post.save` |
| `message.edit` | `{ pid, tid, uid, content, timestamp }` | `action:post.edit` |
| `message.delete` / `message.restore` | `{ pid }` | `action:post.delete` / `restore` |
| `message.purge` | `{ pid }` | `action:posts.purge`（复数，v4.x 真名） |
| `topic.purge` | `{ tid }` | `action:topics.purge`（v4.9.0+） |

`chat:{roomId}`：`chat.new { pid, roomId, uid, content, timestamp }`（源自 `filter:messaging.notify`）。
`user:{uid}`：`chat.sent { roomId, messageId }`（发送者多端同步）。

`message.new` 附带 `username`/`picture`/`decor` 身份快照——前端缓存 uid→身份，**免逐消息查 API**。

### 内部 API（NodeBB 插件挂载，全部需 `X-Internal-Token`）

| 端点 | 提供者 | 用途 |
|---|---|---|
| `GET /api/v3/plugins/odysseia/can-read/:tid/:uid` | bridge | 帖子读权限（BFF 订阅裁决 + R18 预签名） |
| `GET /api/v3/plugins/odysseia/can-chat/:roomId/:uid` | bridge | 聊天室成员判定 |
| `GET /api/v3/plugins/odysseia/profile/:uid` · `GET .../profiles` | rules | 新人缓冲区剩余时间（单个/批量） |
| `GET/PUT /api/v3/plugins/odysseia/quiz/bank` | rules | 题库管理 |

公开端点（无需 token）：`GET .../quiz`（抽题，不含答案）、`POST .../quiz/verify`（答对换一次性注册 token，按 IP 限频 10 次/10 分钟）。

### BFF 端点（公网）

| 端点 | 说明 |
|---|---|
| `GET /bff/token` | cookie 换 Centrifugo JWT（401=未登录）；双层限频 20 req/10s/IP + 60 req/10min/uid |
| `POST /bff/upload/presign` | R2 预签名直传；`kind=media` 普通桶 / `kind=r18`（需传 `tid` 且有读权限）R18 桶；限频 30 req/10min/IP + 10 req/10min/uid；TTL 15min；SigV4 手写签名（无 AWS SDK） |
| `GET /bff/chat/{roomId}/messages` | 私聊 cursor 分页（before/after/around，limit 1..100 默认 50），限频 30 req/10s/IP |
| `GET /bff/vendor/centrifuge.js` | 托管 centrifuge SDK（免 CDN） |
| `GET /bff/healthz` | 健康检查 |

429 契约（全部公网端点）：`Retry-After` 头（整秒 ceil）+ body `{code:"RATE_LIMITED", message, retry_after}`（秒级小数）+ `X-RateLimit-Scope: ip|user`。

上传 key 格式：`u{uid}/{yyyyMM}/{16字节hex}.{ext}`，白名单 MIME：png/jpeg/gif/webp/avif/mp4。

## 自研插件详解

### bridge（`nodebb-plugin-odysseia-bridge`）

14 个 hook，三类职责：事件广播、搜索同步、装饰注入。hook 全表见 `plugin.json`，要点：

- **广播失败不阻塞发帖**：`lib/centrifugo.js` 的 publish 是 fire-and-forget（3s AbortSignal 超时），Centrifugo 挂了只丢实时增量，帖子本体已落 Mongo。
- **索引生命周期完整**：save/edit→`indexPost`，delete→`deletePost`（软删即摘索引，防 R18 全文残留被搜出），restore→`indexPost`，purge→`deletePost`。
- **装饰注入两条路**：`filter:posts.getUserInfoForPosts`（楼层批量，查询次数=规则组数，与人数无关）+ `filter:helpers.getUserDataByUserSlug`（profile）；聊天室实时路由由 `message.new` 的 `decor` 字段承载。
- **filter hook 铁律**：必须原样 `return data`，返回 falsy 会掐断 NodeBB 原生流程。

### rules（`nodebb-plugin-odysseia-rules`）

类脑制度三件套，配置存 `meta.settings.get('odysseia-rules')`（默认值见 `library.js` DEFAULTS）：

1. **答题准入**：注册页抽题（公开 API 不泄答案）→ verify 换一次性 token（Mongo 条件 `deleteOne` 原子消费，防并发复用）→ `filter:register.check` 服务端强制校验。题库为空时放行（冷启动期不拦注册）。
2. **120h 缓冲区**：注册即 `action:user.create` 自动入 `odysseia-newcomer` 组（组不存在则 warn 跳过）；缓冲区权益（限速/禁发 R18 等）由组权限承载；profile API 供前端展示剩余时间。
3. **身份组晋升**：node-cron 每小时跑，postCount 达阶梯 + **joindate 已过 120h 缓冲**双条件才晋升（`sortedSetScores('users:joindate')` 批量查）；`start()` 幂等防重复 cron。

### 前端 chat.js（bridge `static/lib/chat.js`）

WS 连接状态机，三个易踩的坑都已修：

- **SDK 加载失败**：`loadSDK` 走 errCb → `done()` 复位 `connecting` 并冲刷 `pendingCbs` 队列（否则 connecting 永真，连接永久卡死）。
- **token 续期**：`new Centrifuge(endpoint, { getToken: fetchToken })`，SDK 首连与临期自动回调取新 token，与 2h TTL 配套。
- **并发回调**：`connecting` 期间所有 `ensureConnection` 回调入 `pendingCbs`，连接成功/失败统一冲刷；回调内需自行判空 `state.centrifuge`。

## 身分组装饰（ACP 可视化配置）

身分组不再只认原生 badge——同一用户的装饰在**楼层（首屏/增量）、profile、聊天室（实时/历史）**三端五路同源同款。ACP → 插件 → ΟΔΥΣΣΕΙΑ 装饰配置。

每条规则 = `组名 + 优先级 + 徽章样式 + 用户名特效 + 自定义出口`：徽章 pill（渐变/单色自动对比度/图标/光晕/自定义 class）、用户名特效（渐变/单色/加粗/光晕）、custom 出口（最多 10 组 `string→string` 渲染为 `data-ody-*` 属性，值已服务端消毒）。同组多规则按优先级降序全量展示；ody pill 展示的组自动隐藏同 slug 原生 badge（可逆 class）。

数据流：

```
lib/decor.js（纯库零 hook，可独立单测）
  ├─ 楼层 SSR/API   ← filter:posts.getUserInfoForPosts → user.odyDecor
  ├─ profile        ← filter:helpers.getUserDataByUserSlug → userData.odyDecor
  └─ 聊天室实时     ← message.new 的 decor 字段
static/lib/decor.js（前端渲染器）
  ├─ 首屏/增量      ← ajaxify.data 收割 + DOM 扫描注入 / action:posts.loaded
  └─ 聊天气泡       ← window.odyDecor 渲染原语（chat.js 消费）
```

护栏：值全字段白名单正则消毒 + 渲染零 innerHTML（无 XSS 面）；组快照 TTL 5min + settings/group 变更双失效通道；零动画（管理员可经 custom 自加）；装饰失败全链路静默降级，绝不阻断发帖/渲染。

## 快速开始

```bash
cp .env.example .env   # 全部 changeme 按注释命令生成（openssl rand -hex 32 等）
docker compose up -d --build
# 浏览器访问 https://<域名> 完成 NodeBB 首装向导，然后：
bash scripts/bootstrap.sh   # 激活插件 + build + 重启，末尾打印 ACP 手动步骤
```

本地演示（弱口令/免 TLS/缩量）显式叠加 dev 层：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

### 开发常用

```bash
docker compose logs -f nodebb        # 插件 console.log/warn/error 都在这里
docker compose restart nodebb        # 改插件服务端代码后
docker compose exec nodebb ./nodebb build   # 改 static/ 前端资源后
curl https://<域名>/bff/healthz
curl https://<域名>/api/v3/plugins/odysseia/can-read/1/1   # 应 403（未带 token）
```

前端接入实时层（自研主题时）：

```js
const { token } = await fetch('/bff/token').then(r => r.json());
const centrifuge = new Centrifuge('/connection/websocket', { getToken: () => fetch('/bff/token').then(r => r.json()).then(d => d.token) });
const sub = centrifuge.newSubscription(`topic:${tid}`);  // 订阅即触发 BFF→NodeBB 鉴权
sub.on('publication', ctx => appendMessage(ctx.data));
sub.subscribe();
```

## 开发纪律（改代码前必读）

1. **不改 NodeBB 核心**，只写插件 hook；hook payload 结构以 v4.x 源码为准（`library.js` 注释里有各 payload 的源码出处）。
2. **fail-closed**：鉴权链路任何一环异常都拒绝，不允许「出错放行」。
3. **filter hook 必须 return data**；action hook 里抛错会阻断主流程——非关键路径（广播/索引/装饰）一律 try/catch 静默降级。
4. **广播/索引 fire-and-forget**：不 await 结果阻塞发帖；所有外发 fetch 必须带 `AbortSignal` 超时（bff 1.5s < proxy 2s；publish 3s）。
5. **新增 Centrifugo 频道前缀** = 改三处：`config.json` namespace、bridge 广播点、bff subscribe 鉴权分支（未知前缀默认拒绝，所以不加第三处就是拒订）。
6. **共享密钥三件套**：`ODYSSEIA_PROXY_SECRET`（Centrifugo→BFF）、`ODYSSEIA_INTERNAL_TOKEN`（BFF→NodeBB）、`CENTRIFUGO_HTTP_API_KEY`（NodeBB→Centrifugo），轮换时 compose 三处同步。
7. **PRR 修复记录**：订阅 proxy 全量开启、共享密钥双保险、quiz token 原子消费、三处限频（quiz verify / presign）、软删索引同步等——见 git log `fix(security)` / `fix:` 两枚 commit，改动理由都在提交信息里。

## 备份与恢复

```bash
bash scripts/backup.sh   # mongodump + uploads + nodebb_config → age 加密 → R2，rclone 30d 保留
# crontab：15 4 * * * bash /opt/odysseia/scripts/backup.sh >> /var/log/odysseia-backup.log 2>&1
# 恢复：age -d -i key.txt odysseia-xxxx.tar.age > bundle.tar && tar xf bundle.tar（三件套：dump.gz / uploads.tar.gz / config.tar.gz）
```

## 安全清单（落地情况）

- [x] 全链路 TLS（Caddy 自动签）+ 源站 IP 隐藏（Cloudflare 小灰云）
- [x] R18 无权者 404 语义：Centrifugo 拒订 + category 组权限 + 软删摘索引三重
- [x] 订阅鉴权 proxy 化 + 共享密钥头 + uid 仅取服务端注入字段（防伪造）
- [x] 内部 API 全部 X-Internal-Token（timingSafeEqual 比对），仅 compose 内网可达
- [x] quiz token 一次性原子消费；verify / presign 滑动窗口限频
- [x] 全局限频：bridge plugin 挂 `/api/*` IP 60 req/10s；BFF `/token` IP 20/10s + uid 60/10min；`/upload/presign` IP 30/10min + uid 10/10min——429 契约统一 `code/message/retry_after` + `Retry-After` 头（仿 Fluxer/Discord）
- [x] 装饰配置全字段消毒，渲染零 innerHTML
- [x] 上传 R2 预签名直传，服务器零中转带宽；连接 JWT TTL 2h 自动续期
- [x] 备份 age 公钥加密私钥离线；Caddy 关闭访问日志
- [ ] EXIF 剥离：接入 Cloudflare Image Resizing 时开 `metadata=keep` 关闭项
- [ ] IP 轮转：NodeBB 默认存 IP，按需开匿名化插件/ACP 设置
- [ ] `X-Robots-Tag: noindex` 全站：社区私密期在 Caddyfile 加一行

## 内存预算（64G 宿主机）

Mongo 12G（wiredTiger cache）+ Meili 12G（上限，索引期峰值 4G）+ NodeBB 8G + Centrifugo 4G + Redis 2G（noeviction）+ BFF 512M（Rust 实测 ~5MB RSS）+ 监控栈 ~5G（prometheus 2G / grafana 1G / cadvisor 1G / exporters ~1G）+ 系统/页缓存 ~20G，已固化在 compose。

## 可观测性

Prometheus（30d 保留）+ Grafana + cAdvisor + mongo/redis exporter，全内网抓取（[monitoring/prometheus.yml](monitoring/prometheus.yml)）：

| 抓取目标 | 指标 |
|---|---|
| Centrifugo `/metrics` | WS 连接数/节点内存/广播延迟 |
| Meilisearch `/metrics`（Bearer） | 索引队列/搜索延迟 |
| mongo-exporter | opcounters/连接数/复制延迟 |
| redis-exporter | 内存/命中率 |
| cAdvisor | 全容器 CPU/内存/网络 |

Grafana 面板：宿主机 `127.0.0.1:3100`（ssh 端口转发，admin 密码在 .env `GRAFANA_ADMIN_PASSWORD`，匿名只读 Viewer）。

## 类型检查（零构建链）

自有 JS（插件 + BFF 参考实现）用 JSDoc + `tsc --checkJs` 静态检查，不引入编译产物、不改运行时语义：

```bash
cd .tscheck && npm i typescript @types/node --ignore-scripts   # 一次性
node node_modules/typescript/lib/tsc.js -p ../tsconfig.json
```

## 许可证

本项目整体以 [GPL-3.0](LICENSE) 发布（NodeBB 插件同进程链接 NodeBB 必须 GPL 兼容；BFF 一并 GPL 保持仓库单一许可证）。

上游组件均为官方镜像原样运行（源码未修改、不入本仓库），仅致谢：

| 组件 | 用途 | 许可证 |
|---|---|---|
| [NodeBB](https://github.com/NodeBB/NodeBB) | 论坛骨架 | GPL-3.0 |
| [Caddy](https://github.com/caddyserver/caddy) | 反向代理 / TLS | Apache-2.0 |
| [Centrifugo](https://github.com/centrifugal/centrifugo) | 实时消息网关 | Apache-2.0 |
| [Meilisearch](https://github.com/meilisearch/meilisearch) | 全文搜索 | MIT |
| [centrifuge-js](https://github.com/centrifugal/centrifuge-js) | 前端实时 SDK | MIT |
| [meilisearch-js](https://github.com/meilisearch/meilisearch-js) | 搜索客户端 | MIT |
