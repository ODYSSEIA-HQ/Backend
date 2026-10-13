# NodeBB + 自研插件镜像（源码构建版）
# 构建源 = nodebb/upstream/NodeBB/（vendor 入库基线：上游 v4.16.2 @ 18f2a2ee）
# —— 对着这份源码改核心，重建镜像即生效，不再依赖官方 ghcr.io/nodebb/nodebb。
# 配方照搬上游 nodebb/upstream/NodeBB/Dockerfile（两段式 node:lts → node:lts-slim），
# 仅两处差异：
#   ① COPY 源带 vendor 路径前缀（build context 是项目根目录，docker-compose.yml: nodebb.build.context: .）
#   ② final 段追加两个自研插件的落盘安装（沿用旧官方镜像方案的验证结论）
# 健康检查（compose 定义）用 node -e fetch，node:lts-slim 自带 node，无 curl 依赖。

# ---------- stage 1：装 NodeBB 生产依赖 ----------
FROM node:lts AS build

ENV NODE_ENV=production \
    DAEMON=false \
    SILENT=false \
    USER=nodebb \
    UID=1001 \
    GID=1001

WORKDIR /usr/src/app/

COPY nodebb/upstream/NodeBB/ /usr/src/app/

# Install corepack to allow usage of other package managers
RUN corepack enable

# Removing unnecessary files for us
RUN find . -mindepth 1 -maxdepth 1 -name '.*' ! -name '.' ! -name '..' -exec bash -c 'echo "Deleting {}"; rm -rf {}' \;

# Prepage package.json
RUN cp /usr/src/app/install/package.json /usr/src/app/

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive \
    apt-get -y --no-install-recommends install \
        tini

RUN groupadd --gid ${GID} ${USER} \
    && useradd --uid ${UID} --gid ${GID} --home-dir /usr/src/app/ --shell /bin/bash ${USER} \
    && chown -R ${USER}:${USER} /usr/src/app/

USER ${USER}

RUN npm install --omit=dev \
    && rm -rf .npm

# ---------- stage 2：瘦身运行时 + 自研插件 ----------
FROM node:lts-slim AS final

ENV NODE_ENV=production \
    DAEMON=false \
    SILENT=false \
    USER=nodebb \
    UID=1001 \
    GID=1001

WORKDIR /usr/src/app/

RUN corepack enable \
    && groupadd --gid ${GID} ${USER} \
    && useradd --uid ${UID} --gid ${GID} --home-dir /usr/src/app/ --shell /bin/bash ${USER} \
    && mkdir -p /usr/src/app/logs/ /opt/config/ \
    && chown -R ${USER}:${USER} /usr/src/app/ /opt/config/

COPY --from=build --chown=${USER}:${USER} /usr/src/app/ /usr/src/app/install/docker/setup.json /usr/src/app/
COPY --from=build --chown=${USER}:${USER} /usr/bin/tini /usr/src/app/install/docker/entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/entrypoint.sh \
    && chmod +x /usr/local/bin/tini

USER ${USER}

# 装入两个自研插件（不走 npm registry）
# 关键：落盘到 /opt/odysseia-plugins/（VOLUME 之外），由 entrypoint 每次启动 symlink 进
# node_modules。直接 COPY 进 node_modules 会踩 VOLUME 遮蔽坑——node_modules 是匿名卷，
# 首次容器创建时从当时的镜像初始化，之后重建镜像旧卷不刷新，插件永远进不了运行容器。
# 放卷外后插件随镜像走：升级 = 换镜像 + 重启容器，无需删卷。
COPY --chown=${USER}:${USER} plugins/nodebb-plugin-odysseia-bridge /opt/odysseia-plugins/nodebb-plugin-odysseia-bridge
COPY --chown=${USER}:${USER} plugins/nodebb-plugin-odysseia-rules  /opt/odysseia-plugins/nodebb-plugin-odysseia-rules

# 插件自身的 npm 依赖（meilisearch / node-cron）
RUN cd /opt/odysseia-plugins/nodebb-plugin-odysseia-bridge && npm install --omit=dev \
 && cd /opt/odysseia-plugins/nodebb-plugin-odysseia-rules && npm install --omit=dev

EXPOSE 4567

# VOLUME 须放在全部写盘步骤之后：声明之后再写这些路径的构建产物会被丢弃（上游同序）
VOLUME ["/usr/src/app/node_modules", "/usr/src/app/build", "/usr/src/app/public/uploads", "/opt/config/"]

# tini 作为容器内 init：回收僵尸进程 + 转发信号（机制注释见上游 Dockerfile）
ENTRYPOINT ["tini", "--", "entrypoint.sh"]
