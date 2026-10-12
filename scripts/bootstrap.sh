#!/usr/bin/env bash
# ΟΔΥΣΣΕΙΑ 首次部署引导：激活自研插件 → 构建 → 重启
# 前置：docker compose up -d 已执行，NodeBB 已完成自动首装
#       （entrypoint 检测到 NODEBB_* env + config.json 缺失时全自动 install，无需浏览器）
# 用法：bash scripts/bootstrap.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PLUGINS=(
  "nodebb-plugin-odysseia-bridge"
  "nodebb-plugin-odysseia-rules"
)

echo "==> 1/4 检查 NodeBB 容器状态"
docker compose ps nodebb
if ! docker compose ps --status running nodebb | grep -q nodebb; then
  echo "!! NodeBB 未运行：请先 docker compose up -d（首装由 entrypoint 全自动完成）" >&2
  exit 1
fi

echo "==> 2/4 写入插件激活列表（config.json 的 plugins.active）"
# 官方 entrypoint 契约：config.json 真身在 CONFIG_DIR=/opt/config（持久卷），
# CLI 不带 --config 时只找 /usr/src/app/config.json（不存在），必须显式传路径
docker compose exec -T nodebb node -e '
const fs = require("fs");
const p = "/opt/config/config.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
c.plugins = c.plugins || {};
c.plugins.active = [
  "nodebb-plugin-odysseia-bridge",
  "nodebb-plugin-odysseia-rules"
];
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log("plugins.active =", JSON.stringify(c.plugins.active));
'

echo "==> 3/4 重新构建前端资产（插件生效需要 build）"
docker compose exec -T nodebb ./nodebb build --config=/opt/config/config.json

echo "==> 4/4 重启 NodeBB"
docker compose restart nodebb

echo ""
echo "✔ 完成。剩余 ACP 手动步骤（浏览器管理员操作）："
echo "   1. 创建身份组：odysseia-newcomer（新人缓冲组，默认授予）/ odysseia-trusted / odysseia-veteran / odysseia-elder"
echo "   2. 将 odysseia-newcomer 设为注册用户默认组，并限制其只在缓冲区版块发帖"
echo "   3. R18 / R18G 版块权限：仅授予对应身份组（无权者 404 语义由此实现）"
echo "   4. 上传答题题库（可选）："
echo "      curl -X PUT https://<域名>/api/v3/plugins/odysseia/quiz/bank \\"
echo "        -H 'X-Internal-Token: <ODYSSEIA_INTERNAL_TOKEN>' \\"
echo "        -H 'Content-Type: application/json' \\"
echo "        -d '{\"questions\":[{\"question\":\"…\",\"options\":[\"A\",\"B\"],\"answer\":\"A\"}]}'"
