# ΟΔΥΣΣΕΙΑ

完全搬离 Discord 的类脑式 AIRP 社区论坛。NodeBB（骨架）+ Centrifugo（实时聊天流）+ Meilisearch（全文搜索）缝合，单机 64G 一把梭。

```
odysseia/
├── docker-compose.yml        # 七服务编排（caddy/nodebb/centrifugo/meili/mongo/redis/bff）
├── docker-compose.dev.yml    # 本地演示叠加层（弱口令/免TLS，须手动 -f 加载，生产不自动叠加）
├── .env.example              # 密钥清单模板
├── caddy/Caddyfile           # 反向代理路由表（WS 升级 / 管理界面 / BFF / NodeBB）
├── centrifugo/config.json    # 四 namespace：topic / chat / typing / user
├── nodebb/Dockerfile         # 官方 NodeBB 4 + 两个自研插件
├── plugins/
│   ├── nodebb-plugin-odysseia-bridge/   # 桥接：hooks→Centrifugo 广播 + Meili 同步 + 内部鉴权 API + 身分组装饰
│   │   ├── library.js         #   频道命名：topic:{tid} / chat:{roomId} / user:{uid}；装饰 hook 接线
│   │   ├── lib/centrifugo.js  #   HTTP API 客户端（fire-and-forget，失败不阻塞发帖）
│   │   ├── lib/search.js      #   Meilisearch 索引同步（增删改幂等）
│   │   ├── lib/internal.js    #   can-read / can-chat（X-Internal-Token）
│   │   ├── lib/decor.js       #   装饰引擎（纯库零 hook：值消毒 / 批量成员判定 / 组快照缓存）
│   │   ├── static/lib/        #   chat.js 聊天室呈现 + decor.js/css 前端渲染器（三端同源）
│   │   └── acpTemplates/      #   ACP 装饰规则配置面（渐变/图标/头衔特效/自定义出口）
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

本地演示（弱口令、免 TLS、缩量）需显式叠加 dev 层：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
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

消息负载格式（`message.new` / `message.edit` / `message.delete` / `chat.new` 等）见 `plugins/nodebb-plugin-odysseia-bridge/library.js` 的各 hook 实现；`message.new` 附带 `username` / `picture` / `decor`（身分组装饰，字段结构见「身分组装饰」一节）身份快照，前端免逐消息查 API。

## 身分组装饰（ACP 可视化配置）

身分组不再只认原生 badge 的展示位——同一用户的装饰在**楼层（首屏/增量）、profile、聊天室（实时/历史）**三端五路同源同款。ACP → 插件 → ΟΔΥΣΣΕΙΑ 装饰即可配置。

### 规则

每条规则 = `组名 + 优先级 + 徽章样式 + 用户名特效 + 自定义出口`：

- **徽章 pill**：渐变底 / 单色底（自动对比度算文字色）/ 图标（FontAwesome）/ 光晕 / 自定义 class
- **用户名特效**：渐变文字 / 单色 / 加粗 / 光晕 / 自定义 class
- **custom 出口**：最多 10 组 `string→string`，渲染为 `data-ody-*` 属性，管理员 CSS/JS 自由取用（值服务端已消毒）

同组命中多条规则时按优先级降序全量展示；ody pill 展示的组自动隐藏同 slug 的原生 badge（可逆 class，不删除）。

### 数据流

```
lib/decor.js（纯库零 hook，可独立单测）
  ├─ 楼层 SSR/API   ← filter:posts.getUserInfoForPosts → user.odyDecor
  ├─ profile        ← filter:helpers.getUserDataByUserSlug → userData.odyDecor
  └─ 聊天室实时     ← onPostSave 广播 message.decor 字段
static/lib/decor.js（前端渲染器）
  ├─ 首屏（冷加载/ajaxify）← ajaxify.data.posts 收割 + DOM 扫描注入
  ├─ 增量（新回复/无限滚动）← action:posts.loaded
  └─ 聊天气泡     ← window.odyDecor 渲染原语（chat.js 消费）
```

### 性能与安全护栏

- 值消毒：颜色/类名/渐变/图标全过白名单正则，渲染纯 `style` 属性赋值零 innerHTML，无 XSS 面
- 查询次数 = 规则组数（`Groups.isMembers` 批量），与页面楼层人数无关
- 组元数据快照 TTL 5min + settings/group 变更双失效通道
- 零动画零 transition（管理员可经 custom/className 自行叠加动画）
- 装饰失败全链路静默降级，绝不阻断发帖/渲染

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
- [x] 装饰配置全字段消毒（颜色/类名/渐变白名单正则，custom 值截断，零 innerHTML 渲染）
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
