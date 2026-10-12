# NodeBB + 自研插件镜像
# 官方镜像 WORKDIR = /usr/src/app/（NodeBB 本体直接位于此；/usr/src/app/nodebb 是 CLI 脚本，不是目录）
# 实证依据：nodebb/upstream/NodeBB/Dockerfile L48 + install/docker/entrypoint.sh
FROM ghcr.io/nodebb/nodebb:4.x

# 装入两个自研插件（不走 npm registry，直接落盘进 node_modules）
# 安全性：entrypoint 每次启动对 /usr/src/app 跑 npm install，但 npm 不会删除
# node_modules 中未在 package.json 登记的目录，COPY 进来的插件可安全共存
COPY plugins/nodebb-plugin-odysseia-bridge /usr/src/app/node_modules/nodebb-plugin-odysseia-bridge
COPY plugins/nodebb-plugin-odysseia-rules  /usr/src/app/node_modules/nodebb-plugin-odysseia-rules

# 插件自身的 npm 依赖（meilisearch / node-cron）
RUN cd /usr/src/app/node_modules/nodebb-plugin-odysseia-bridge && npm install --omit=dev \
 && cd /usr/src/app/node_modules/nodebb-plugin-odysseia-rules && npm install --omit=dev
