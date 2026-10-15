# ODYSSEIA 全链路压测 Runbook

> 教训固化自历史压测及 2026-10-15 续跑。任何正式压测（full-scale）必须按本顺序执行，
> **跳步即判废**——full5 的死法就是容器重建后 2.5 分钟直接开压，冷启动状态全部计入指标。
>
> 压测宿主规格：16 核 / 物理 15.2GB / WSL VM 10GB（`.wslconfig` memory=10GB）。
> 压测期间宿主别开大内存应用（#4a 教训：VM 内存溢出进 swap → IO 抖动 → 指标全废）。

## 0. 前置检查（每轮）

- `.env` 齐备；压测豁免 `ODYSSEIA_API_RATE_MAX=6000`（生产部署日记得改回默认 60）
- 改过 bridge 插件 / nodebb 源码 → 必须 `--build` 重建（插件是 COPY 进镜像的，非挂载）。
  Caddyfile 是挂载文件，只需 `caddy validate` 后 `caddy reload`。
- `results/*detail*.json` 数百 MB **禁入 git**（.gitignore 已拦，提交前再看一眼）
- 写路径瘦身开关：默认禁用原生通知流（`ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY` 未设 = 禁用）；
  需恢复原生流（Socket.IO/站内通知铃铛/邮件）时在 `.env` 设 `ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY=0`，
  执行 `docker compose up -d --no-deps nodebb` 注入配置；两种模式的性能不能混用。

## 1. 起栈

```powershell
docker compose up -d --build
docker compose ps   # nodebb / caddy / bff 全部 healthy 才继续
```

**12 worker 验证**（config.json `port` 数组长度 = worker 数；漏一个端口 = LB 打空）：

```powershell
# 4567-4578 逐端口探活，12 个全 200 才算过
67..78 | ForEach-Object {
  $p = "45$_"
  $code = docker run --rm --network odysseia_app curlimages/curl -s -o /dev/null -w "%{http_code}" "http://nodebb:$p/sping"
  "$p -> $code"
}
```

（#2 教训：cluster 端口独占 + 上游只写 4567 → 全部流量钉死单 worker，指标无意义。
LB 两侧——公网 handle 块和内部 `:8090`——共用 `nodebb_cluster`，都要对齐 12 端口。
分类 `/api/category/*` 使用 `uri_hash`，其余路径仍 `round_robin`。
分类缓存是 per-worker 的：轮询时一次预热只能覆盖一个 worker，同一分类的
单 worker 重访间隔约为全站重访间隔的 12 倍，不能按全站访问频率计算 TTL。）

**内存水位**：12 worker 下 nodebb mem_limit 8g + k6 ~1.7G + 全家桶逼近 VM 10GB 上限，
`docker stats --no-stream` 先看一眼，nodebb 静息 > 6G 就先查再压。

12 worker 的 V8 堆也要显式预算，不能让每个 worker 都按容器总内存推导默认上限。
本机最终使用 `.env` 的 `NODEBB_NODE_OPTIONS="--max-old-space-size=384 --max-semi-space-size=8"`，
256MiB 轮仍未通过聊天 P95，384MiB 轮通过既定三项门槛。改变此项需重建容器以注入环境
（`up -d --no-deps --wait nodebb`），不必重建镜像。
以实际插件工作集和资源日志判断是否适用，不要把本机数值直接当作生产默认。

## 2. 造数据（幂等，重跑自动跳过）

```powershell
docker exec odysseia-nodebb-1 mkdir -p /tmp/lt
docker cp tools/loadtest/seed.js odysseia-nodebb-1:/usr/src/app/lt-seed.js
docker cp tools/loadtest/memberships.mjs odysseia-nodebb-1:/usr/src/app/memberships.mjs
docker exec -w /usr/src/app odysseia-nodebb-1 node lt-seed.js
docker cp odysseia-nodebb-1:/tmp/lt/seed-output.json tools/loadtest/seed-output.json
```

每轮测试前刷新真实成员快照（只读数据库，不补成员、不改权限）。此步骤也用于迁移已有种子：

```powershell
docker exec odysseia-nodebb-1 mkdir -p /tmp/lt
docker cp tools/loadtest/seed-output.json odysseia-nodebb-1:/tmp/lt/seed-output.json
docker cp tools/loadtest/memberships.mjs odysseia-nodebb-1:/usr/src/app/memberships.mjs
docker cp tools/loadtest/refresh-seed.js odysseia-nodebb-1:/usr/src/app/refresh-seed.js
docker exec -w /usr/src/app odysseia-nodebb-1 node refresh-seed.js
# 上一步非零退出时停止，不可继续压测。
docker cp odysseia-nodebb-1:/tmp/lt/seed-output.json tools/loadtest/seed-output.json
```

预热和正式测试共用 `memberships.mjs`，只使用实际成员列表；缺失快照、空账号房间列表、
重复/未知房间或未覆盖的房间会在加载脚本时失败，不再按房间下标推算。测试期间主动撤权导致的拒绝仍会计入错误。

## 3. 冒烟

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1
# 当前脚本面向 Windows PowerShell 5.1（ICertificatePolicy），20 项全 PASS 才继续。
```

原生聊天模式还需验证 Socket.IO 接收。先按 §0 开启原生通知，按 §2 刷新成员快照，
再运行以下命令；脚本使用两个实际同房间的种子账号，登录、订阅并检查写 API 消息的原生推送。
不要与正式压测同时执行，以免额外流量影响统计。

```powershell
docker cp tools/loadtest/native-chat-smoke.js odysseia-nodebb-1:/usr/src/app/native-chat-smoke.js
docker exec -w /usr/src/app odysseia-nodebb-1 node native-chat-smoke.js
docker cp tools/loadtest/adapter-smoke.js odysseia-nodebb-1:/usr/src/app/adapter-smoke.js
docker exec -w /usr/src/app odysseia-nodebb-1 node adapter-smoke.js
```

后一个脚本在临时 namespace 上检查跨实例查询以及离开房间后的即时结果，并关闭测试连接。
这些功能检查不代表邮件、Web Push 或大量 Socket.IO 客户端已通过容量测试。

## 4. 预热（full5 教训的核心固化——不可跳）

```powershell
$sec = ((Get-Content .env | Select-String '^CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY=(.+)$').Matches[0].Groups[1].Value)
docker run --rm --network odysseia_app -v "${PWD}\tools\loadtest:/loadtest" -e LT_HMAC_SECRET=$sec grafana/k6 run /loadtest/warmup.js
```

- 内容：3000 卡分类全量 + parent × 10 + 500 条 chat 写 + 100 WS 连接，总时长 ~110s
- 判据：`http_req_failed < 1%`、`warm_ws_connected ≈ 100`、无批量 5xx
- **时序硬约束：warmup 结束后 2 分钟内启动正式压测**——分类缓存 TTL 300s，且正式压测
  readers 在 ramp（120s）结束才开打，拖延预热即白做

secret 传递姿势（#1 作废教训：经 PowerShell 多段传参被截断 → WS 全 401）：
从 `.env` 读出后在**同一条命令内**展开给 `-e`，禁落独立命令行参数/文件。

## 5. 正式压测

三路并行观察（各开一个终端）：

```powershell
docker stats odysseia-nodebb-1 odysseia-mongo-1
docker exec odysseia-mongo-1 mongostat --quiet -u root -p <密码> --authenticationDatabase admin
```

压测本体（120s ramp + 300s hold + 30s 收尾 = 450s，另有最多 30s graceful stop，约 8 分钟）：

```powershell
$sec = ((Get-Content .env | Select-String '^CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY=(.+)$').Matches[0].Groups[1].Value)
docker run --rm --network odysseia_app -v "${PWD}\tools\loadtest:/loadtest" -e LT_HMAC_SECRET=$sec `
  grafana/k6 run --summary-export /loadtest/results/fullN-summary.json /loadtest/chat-baseline.js
```

明细流（可选，数百 MB）：加 `-o json=/loadtest/results/fullN-detail.json`。

## 6. 分析

```powershell
node tools/loadtest/full-analyze.js tools/loadtest/results/fullN-detail.json tools/loadtest/results/fullN-analysis.json
```

## 7. 判读要点（历史坑全表）

| 坑 | 正解 |
|---|---|
| k6 summary 速率是全时长平均（含 ramp） | 实际速率 = 完成数 ÷ hold 时长；probe100 曾把 70.8/s 读成 40.42/s |
| `chat_latency_ms` vs send 的 `http_req_duration` | 前者是端到端（send→WS receive），后者只是写 API 响应，别混 |
| 首轮 WS 全 401 | HMAC secret 被截断——见 §4 传递姿势 |
| 全部流量钉死单 worker | LB 上游列表与 config.json port 数组对齐——见 §1 验证 |
| k6 脚本直连 `nodebb:4567` 绕过 LB | full6 实翻：send 恒定 3s 地板 + CPU 仅 153%（12 worker 只用 1 个）。脚本默认值已改 `caddy:8090`，别改回直连；复核 `chat-baseline.js`/`warmup.js` 的 `HTTP_BASE` |
| 指标异常劣化但 CPU 反常低 | 检查 VM 的 memory/IO pressure、swap 和 cgroup memory.events；`OOMKilled=false` 不能排除换页拖慢 |
| 容器重建后立刻压 | 冷启动污染——§4 warmup 不可跳 |
| detail.json 提交进 git | `.gitignore` 已拦 `*detail*.json`，提交前复查 |
| 同一分类频繁冷加载 | 确认两侧入口都导入 `nodebb_cluster`，分类用 `uri_hash`；新 URL 首次 miss 后重复请求应连续 `hit-fresh` |
| seed-output.json 入库 | 文件含 Bearer token，已忽略；从本地 seed 步骤重建，禁止提交 |

## 8. 基线对照

| 轮 | 配置 | 状态 |
|---|---|---|
| full3 | 8 worker / TTL 60s / maxVUs 60 | 真实容量瓶颈：read p95 2.69s、send p95 6.62s |
| full5 | 8 worker / TTL 300s / maxVUs 120 | **作废**——方法论污染（未 warmup） |
| full8 | 12 worker / round_robin / maxVUs 300 | 未通过：chat P95 29.99s、read P95 25.47s、发送失败 5.78% |
| resume-baseline | 500 WS / 100 msg/s / 30 read/s / hold 60s / round_robin | chat P95 4374ms、read P95 1759ms、dropped 260 |
| resume-affinity | 同一短测规格，分类改 uri_hash | 三项门槛通过：chat P95 357ms、read P95 47.7ms、dropped 0；属于先后顺序测试，非隔离实验 |
| resume-full | 2500 WS / 未设堆预算 | 未通过：chat P95 9195ms、read P95 500.18ms；swap 峰值约 3GiB |
| resume-budget | 2500 WS / old-space 256MiB | 无 swap，但 chat P95 1260.5ms，未通过 |
| resume-384 | 2500 WS / old-space 384MiB | 三项门槛通过：chat P95 133ms、read P95 27.13ms、发送失败 0.117%；仍有 5 次订阅拒绝和 6 次 dropped |

完整目标续跑见 `REPORT-2026-10-15.md`。短测通过不能替代完整目标验收。

后续小补丁验证见 `MINIMAL-CHANGES-2026-10-15.md`：短测聊天 P95 157.85→49.30ms；
相同最终版本的两次完整规格分别为 585ms（失败）和 52ms（通过），运行状态敏感，不能只引用最佳成绩。
种子审计发现的 3 条成员错配已通过真实成员快照修复；后续结果及原生通知验证见
`MEMBERSHIP-NATIVE-2026-10-15.md`，保留此前失败记录供对照。
