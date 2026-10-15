# 成员关系修复与原生通知验证（2026-10-15）

## 成员关系修复

原压测按房间数组下标推算成员，实际数据库存在 3 条不一致关系：uid 21 / room 4、uid 20 / room 5、uid 19 / room 2。这些请求被服务器正确拒绝，不能通过放宽权限来“修复”。

`seed.js` 和新增的 `refresh-seed.js` 现在通过 NodeBB 数据库接口读取 `chat:room:{id}:uids`，导出真实 `roomsByUserIdx`。预热和正式压测共用 `memberships.mjs`，没有旧公式回退；缺失或不完整的快照立即报错。刷新仅修改本地种子输出，不改数据库成员或权限。

本轮刷新后仍覆盖 60 个账号、4000 个房间、8000 条真实成员关系。三条错误关系均已从发送/订阅选择中排除。测试期间撤权仍可能产生正确拒绝，每轮开始前必须刷新快照。

修复后的短测（500 WS、100 msg/s、30 read/s，20 秒 ramp + 60 秒 hold，原生通知关闭）：6000/6000 次发送成功，发送失败、订阅拒绝、丢弃迭代均为 0；聊天端到端 P95 156.70 ms、分类读取 P95 20.90 ms。摘要：`results/membership-fixed-summary.json`。这证明短测中的错配已消除，不代表完整目标容量已通过。

## 原生通知首次完整规模测试

开启 `ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY=0`，重建容器后预热，运行同一完整规格：3 万讨论帖、4000 房间、2500 Centrifugo WS、100 msg/s、30 read/s，120 秒 ramp + 300 秒 hold。12 个 NodeBB worker，384 MiB old-space / 8 MiB semi-space，WS 使用 60 个账号；其余限制沿用 `MINIMAL-CHANGES-2026-10-15.md`。

**本轮未达标**，不能沿用关闭原生通知时的成绩：

| 指标 | 原生通知开启，adapter 原配置 |
|---|---:|
| 聊天端到端 P95 | 41.31 s |
| 分类读取 P95 | 5.40 s |
| 发送成功/尝试 | 15601/16652 |
| 发送失败率 | 6.31% |
| 丢弃迭代（含读写） | 13824 |
| 订阅拒绝/错误响应计数 | 662 |
| WS 错误 | 1 |

大量发送因 30 秒请求超时失败，不能将其解释成成员错配复发；本轮成功响应数除以 hold 时长约为 52.0/s，且包含收尾完成的请求，未达到持续 100 msg/s。

24 次资源采样中，NodeBB memory usage 峰值 3.832 GiB、CPU 1073.84%、swap 峰值 1221.75 MiB；无 OOM，VM memory pressure some avg10 峰值 26.38。日志汇总有 1989 行 `fetchSockets` 超时相关文本及 576 行通知发送失败；前者包含堆栈重复文本，不等于独立失败请求数。证据分别为 `native-enabled-summary.json`、`native-enabled-resources.jsonl`、`native-enabled-errors.json`。

## 最小通知补丁

NodeBB 的 Redis adapter 初始化未开启 `publishOnSpecificResponseChannel`，查询响应会广播给所有 worker。已安装 adapter 同时订阅公共和自身专用响应频道，支持该选项。补丁只在 `src/database/redis.js` 的初始化选项中增加 `publishOnSpecificResponseChannel: true`，让响应回到发起查询的 worker。

请求仍跨 worker 查询，返回数据仍实时读取；不缓存成员权限、不跳过原生通知、不修改协议消息。源码检查显示它减少了无关 worker 接收响应的工作量，但不能仅凭这一点宣布容量问题已解决，须看复测。

## 补丁复测结果

保持原生通知开启，重新构建、重启、预热后运行相同完整规格。预热 HTTP 错误和 dropped iterations 均为 0。运行镜像为 `sha256:46c1afcf56707064451c12d6f755b21aaaa39e2b3ad30ff43ee24f50b2014735`，容器内 `redis.js` SHA-256 与工作区一致：`2deb94f9723d2b0deda478b4cca90aac5ceb61c578f2449a2259207a0b8701bb`。

| 指标 | adapter 原配置 | 定向响应补丁 |
|---|---:|---:|
| 聊天端到端 P95 | 41.316 s | 16.840 s（仍未达标） |
| 分类读取 P95 | 5408.68 ms | 231.97 ms |
| 发送成功/尝试 | 15601/16652 | 22605/22605 |
| 发送失败率 | 6.31% | 0% |
| 丢弃迭代（含读写） | 13824 | 7439 |
| 订阅拒绝/错误响应计数 | 662 | 120 |
| WS 错误 | 1 | 3 |
| fetchSockets 超时相关日志行 | 1989 | 0 |
| 通知发送失败日志行 | 576 | 0 |

本轮已发出的请求全部成功，但发送数仅为计划 30000 次的约 75.4%，不能把 0% 请求失败等同于达成 100 msg/s。聊天延迟、丢弃迭代、订阅错误仍不满足目标。定向响应减少了不必要的广播，实测通知查询超时消失，但**原生通知全功能容量尚未通过**；后续需分析原生通知开启时的 CPU 和内存工作集，而不是扩大权限缓存或隐藏失败。

复测 23 条有效资源样本中 NodeBB CPU 峰值 971.72%、memory usage 峰值 3.797 GiB、swap 峰值 1184.57 MiB；无 OOM，VM memory pressure some avg10 峰值 10.80。原始文件共 24 条，最后一条与压测结束后的容器恢复重叠且容器统计缺失，未用于上述峰值。摘要、资源、错误汇总见 `results/native-fixed-{summary.json,resources.jsonl,errors.json}`。

## 功能与提交检查

- `node --test tools/tests/hot-paths.test.cjs tools/tests/memberships.test.mjs`：10/10 通过。
- `adapter-smoke.js`：跨实例房间查询返回正确成员，离开房间后立即查询为空，无成员缓存。
- `native-chat-smoke.js`：登录后订阅房间，4568 worker 写入的消息由 4567 worker 的 Socket.IO 客户端接收；压测前、压测后各一次均通过。
- 自有 JS 类型检查、语法检查、Compose 配置检查及 diff 空白检查通过。
- 恢复配置后执行 `scripts/smoke.ps1`：20/20 通过，覆盖登录、发帖、搜索索引、限速及删除恢复链路。
- 原生通知测试结束后恢复现有配置 `ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY=1`；没有把本地 `.env` 改为永久开启。
- 冒烟脚本的管理员密码改从 `.env` 读取；提交排除 `.env`、用户令牌种子、大型明细和原始 CPU profile，并对暂存文件扫描本地真实凭据。

## 结果边界

- 2500 个连接是 Centrifugo 连接，原生通知后台流程同时开启；不是 2500 个原生 Socket.IO 客户端的容量认证。
- 原生 Socket.IO 跨 worker 消息和 Redis adapter 跨实例查询另外做功能验证；邮件、Web Push 和 ActivityPub 外部投递不在本次容量验收范围内。
- 当前本地 Web Push 插件启动时存在 VAPID subject 配置错误（旧 localhost URL），不能把聊天测试当作该插件已可用的证明。
- 本机先后顺序测试受缓存、换页和共享 VM 资源影响；失败结果保留，不能只引用最佳成绩，也没有进行同环境 Fluxer 对测。
- 分类响应缓存的权限变更失效机制仍需独立完善，本次成员快照修复不解决该问题。
