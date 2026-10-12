#!/usr/bin/env bash
# ΟΔΥΣΣΕΙΑ 全量备份：MongoDB + uploads 卷 → age 加密 → R2 备份桶
# 宿主机依赖：docker、age（加密）、rclone（上传）
#   age-keygen 生成的公钥填 .env 的 BACKUP_AGE_PUBLIC_KEY，私钥离线保存！
# 建议宿主机 crontab：15 4 * * * bash /opt/odysseia/scripts/backup.sh >> /var/log/odysseia-backup.log 2>&1

set -euo pipefail
cd "$(dirname "$0")/.."

# 从 .env 读取（只取需要的变量，避免污染环境）
# shellcheck disable=SC1091
set -a; source .env; set +a

: "${MONGO_INITDB_ROOT_USERNAME:?missing in .env}"
: "${MONGO_INITDB_ROOT_PASSWORD:?missing in .env}"
: "${MONGO_INITDB_DATABASE:?missing in .env}"
: "${R2_ENDPOINT:?missing in .env}"
: "${R2_ACCESS_KEY_ID:?missing in .env}"
: "${R2_SECRET_ACCESS_KEY:?missing in .env}"
: "${R2_BUCKET_BACKUP:?missing in .env}"
: "${BACKUP_AGE_PUBLIC_KEY:?missing in .env}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

NETWORK="odysseia_default"   # compose 项目名 odysseia 的默认网络
TOOLS_IMAGE="mongodb/mongodb-database-tools:100.10.0"

echo "==> 1/4 mongodump（数据库：${MONGO_INITDB_DATABASE}）"
docker run --rm --network "$NETWORK" -v "${TMP}:/backup" "$TOOLS_IMAGE" \
  mongodump \
  --host mongo \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --db "$MONGO_INITDB_DATABASE" \
  --archive=/backup/dump.gz --gzip

echo "==> 2/4 打包 uploads 卷"
docker run --rm -v odysseia_nodebb_uploads:/data:ro -v "${TMP}:/backup" alpine \
  tar czf /backup/uploads.tar.gz -C /data .

echo "==> 3/4 age 加密（公钥加密，私钥离线）"
tar cf "${TMP}/bundle.tar" -C "${TMP}" dump.gz uploads.tar.gz
age -r "$BACKUP_AGE_PUBLIC_KEY" -o "${TMP}/odysseia-${STAMP}.tar.age" "${TMP}/bundle.tar"

echo "==> 4/4 上传 R2 备份桶"
RCLONE_CONFIG_R2_TYPE=s3 \
RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT" \
RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
rclone copy "${TMP}/odysseia-${STAMP}.tar.age" "r2:${R2_BUCKET_BACKUP}/" \
  --s3-no-check-bucket

# 附：保留策略（可选，去掉注释启用）
# RCLONE_CONFIG_R2_TYPE=s3 ... rclone delete "r2:${R2_BUCKET_BACKUP}" --min-age 30d

echo "✔ 备份完成：odysseia-${STAMP}.tar.age → ${R2_BUCKET_BACKUP}"
