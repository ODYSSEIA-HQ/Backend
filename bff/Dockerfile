# syntax=docker/dockerfile:1
# ΟΔΥΣΣΕΙΑ BFF（Rust 版）——multi-stage 构建
# 产物：~10MB 镜像（对比 Node 版 ~200MB node_modules 镜像）

# ---------- stage 1：编译 ----------
FROM rust:1-slim AS builder

WORKDIR /build

# 先拷依赖清单，利用 Docker 层缓存（源码改动不重编译依赖）
COPY Cargo.toml ./
# 声明 src/main.rs 占位，让 cargo 只解析依赖
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && cargo build --release 2>/dev/null || true
COPY src ./src
RUN touch src/main.rs && cargo build --release

# ---------- stage 2：运行时 ----------
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/odysseia-bff /usr/local/bin/odysseia-bff
# centrifuge SDK 静态托管（Node 版 express.static 的等价物，只有这一个文件）
COPY vendor /app/vendor

EXPOSE 3000

CMD ["odysseia-bff"]