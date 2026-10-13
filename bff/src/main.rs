// ΟΔΥΣΣΕΙΑ BFF 聚合层（Rust 版）
//
// 职责（与 Node 版契约对齐，架构决策 D8）：
//   1. GET  /token                 —— NodeBB 会话 cookie 换 Centrifugo 连接 JWT（仅登录用户）
//   2. POST /centrifugo/subscribe  —— Centrifugo subscribe proxy 回调，按频道前缀
//                                       调 NodeBB 内部 API 做权威鉴权（fail-closed）
//   3. POST /upload/presign        —— R2 预签名直传（SigV4 手写签名，零 AWS SDK）
//   4. GET  /chat/{roomId}/messages —— 私聊 cursor 分页（before/after/around）
//   5. GET  /vendor/centrifuge.js  —— 静态托管 centrifuge 客户端 SDK
//   6. 全局限频                      —— 内存滑动窗口双层（IP 暴刷层 + uid 配额层），
//                                       429 契约：Retry-After 头 + body {code, message, retry_after}
//
// 不做的事：消息流代理——首屏走 NodeBB SSR/REST，实时增量走 Centrifugo，
// BFF 只做"鉴权 + 发证"，无状态、可随时重启。
//
// 频道鉴权矩阵（与 Node 版一致）：
//   topic:{tid} / typing:topic:{tid}   → privileges.topics.can('topics:read')
//   chat:{roomId} / typing:chat:{roomId} → Messaging.isUserInRoom
//   user:{uid}                          → 仅本人

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use hmac::{Hmac, Mac};
use jsonwebtoken::{encode, EncodingKey, Header as JwtHeader};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tracing::{error, info};

type HmacSha256 = Hmac<Sha256>;

// ==================================================================
// 配置（环境变量，与 Node 版同名）
// ==================================================================

struct Config {
	nodebb_url: String,
	token_secret: String,
	internal_token: String,
	proxy_secret: String,
	r2_endpoint: String,
	r2_access_key_id: String,
	r2_secret_access_key: String,
	r2_bucket_media: String,
	r2_bucket_r18: String,
}

impl Config {
	fn from_env() -> Self {
		let val = |name: &str| std::env::var(name).unwrap_or_default();
		Self {
			nodebb_url: val("NODEBB_URL"),
			token_secret: val("CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY"),
			internal_token: val("ODYSSEIA_INTERNAL_TOKEN"),
			proxy_secret: val("ODYSSEIA_PROXY_SECRET"),
			r2_endpoint: val("R2_ENDPOINT"),
			r2_access_key_id: val("R2_ACCESS_KEY_ID"),
			r2_secret_access_key: val("R2_SECRET_ACCESS_KEY"),
			r2_bucket_media: val("R2_BUCKET_MEDIA"),
			r2_bucket_r18: val("R2_BUCKET_R18"),
		}
	}
}

const PORT: u16 = 3000;
/// 短 TTL + 前端 getToken 自动续期（见 chat.js），泄露窗口从 24h 压到 2h
const TOKEN_TTL_SECS: i64 = 2 * 60 * 60;
const PRESIGN_TTL_SECS: i64 = 900; // 15 分钟

// ==================================================================
// 通用内存滑动窗口限频器
// ==================================================================
// 单实例内存即可——BFF 无状态单副本部署，重启清零可接受（将来多副本再换 Redis 原子计数）

#[derive(Default)]
struct RateLimiter {
	/// key -> 窗口内时间戳（毫秒单调钟）
	hits: Mutex<HashMap<String, Vec<u64>>>,
}

impl RateLimiter {
	/// 防内存膨胀：键数超阈值全清（限频精度可牺牲，与 Node 版一致）
	const MAX_KEYS: usize = 50_000;

	/// 命中返回 Some(retry_after_ms)，否则记录本次命中并返回 None
	async fn check(&self, key: &str, window_ms: u64, max: usize) -> Option<u64> {
		let now_ms = now_millis();
		let mut map = self.hits.lock().await;
		if map.len() > Self::MAX_KEYS {
			map.clear();
		}
		let hits = map.entry(key.to_string()).or_default();
		hits.retain(|&t| now_ms.saturating_sub(t) < window_ms);
		if hits.len() >= max {
			let oldest = hits[0];
			return Some((oldest + window_ms).saturating_sub(now_ms).max(1));
		}
		hits.push(now_ms);
		None
	}
}

fn now_millis() -> u64 {
	// 用 Instant 单调钟（防系统时钟回拨），启动起点作 epoch
	use std::sync::OnceLock;
	static EPOCH: OnceLock<Instant> = OnceLock::new();
	let epoch = *EPOCH.get_or_init(Instant::now);
	epoch.elapsed().as_millis() as u64
}

// ==================================================================
// 429 契约（与 Node 版逐字段一致）
// ==================================================================

fn send_429(retry_after_ms: u64, scope: &str) -> Response {
	let sec = retry_after_ms as f64 / 1000.0;
	let mut resp = Json(serde_json::json!({
		"code": "RATE_LIMITED",
		"message": "请求过于频繁，请稍后再试",
		"retry_after": sec, // 秒级小数，客户端直接 setTimeout 即可
	}))
	.into_response();
	*resp.status_mut() = StatusCode::TOO_MANY_REQUESTS;
	let headers = resp.headers_mut();
	// Retry-After 整秒向上取整（与 Node 版 Math.ceil 一致）
	let retry_secs = retry_after_ms.div_ceil(1000).to_string();
	headers.insert("Retry-After", HeaderValue::from_str(&retry_secs).unwrap());
	headers.insert("X-RateLimit-Scope", HeaderValue::from_str(scope).unwrap());
	resp
}

fn client_ip(headers: &HeaderMap, addr: &SocketAddr) -> String {
	// Caddy 只签可信代理层；上游头可伪造时退化为 socket 地址（fail-safe）
	headers
		.get("x-forwarded-for")
		.and_then(|v| v.to_str().ok())
		.and_then(|v| v.split(',').next())
		.map(|s| s.trim().to_string())
		.filter(|s| !s.is_empty())
		.unwrap_or_else(|| addr.ip().to_string())
}

fn err_json(status: StatusCode, body: serde_json::Value) -> Response {
	let mut resp = Json(body).into_response();
	*resp.status_mut() = status;
	resp
}

// ==================================================================
// 应用状态
// ==================================================================

#[derive(Clone)]
struct AppState {
	cfg: Arc<Config>,
	http: reqwest::Client,
	limiter: Arc<RateLimiter>,
	encoding_key: Arc<EncodingKey>,
}

// ==================================================================
// NodeBB 会话解析：cookie → uid（游客为 0）
// ==================================================================

async fn resolve_uid(state: &AppState, cookie: Option<&HeaderValue>) -> u64 {
	let Some(cookie) = cookie else { return 0 };
	let Ok(res) = state
		.http
		.get(format!("{}/api/me", state.cfg.nodebb_url))
		.header(header::COOKIE, cookie)
		.timeout(Duration::from_millis(1500)) // 必须 < Centrifugo proxy timeout（2s）
		.send()
		.await
	else {
		return 0;
	};
	if !res.status().is_success() {
		return 0;
	}
	let Ok(data) = res.json::<serde_json::Value>().await else {
		return 0;
	};
	data.get("uid")
		.and_then(|v| v.as_u64())
		.or_else(|| data.get("_uid").and_then(|v| v.as_u64()))
		.unwrap_or(0)
}

// ==================================================================
// NodeBB 内部 API（X-Internal-Token，fail-closed）
// ==================================================================

async fn call_nodebb(state: &AppState, path: &str) -> Option<serde_json::Value> {
	let res = state
		.http
		.get(format!("{}{}", state.cfg.nodebb_url, path))
		.header("x-internal-token", &state.cfg.internal_token)
		.timeout(Duration::from_millis(1500))
		.send()
		.await;
	match res {
		Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
		Ok(r) => {
			error!("[bff] NodeBB 内部 API 非 2xx {} -> {}", path, r.status());
			None
		}
		Err(e) => {
			error!("[bff] NodeBB 内部 API 调用失败 {} {}", path, e);
			None
		}
	}
}

async fn can_read_topic(state: &AppState, tid: u64, uid: u64) -> bool {
	let Some(r) = call_nodebb(state, &format!("/api/v3/plugins/odysseia/can-read/{}/{}", tid, uid)).await else {
		return false;
	};
	r.get("canRead").and_then(|v| v.as_bool()).unwrap_or(false)
}

async fn can_chat_room(state: &AppState, room_id: u64, uid: u64) -> bool {
	let Some(r) = call_nodebb(state, &format!("/api/v3/plugins/odysseia/can-chat/{}/{}", room_id, uid)).await else {
		return false;
	};
	r.get("canRead").and_then(|v| v.as_bool()).unwrap_or(false)
}

// ==================================================================
// 1. Centrifugo 连接 token
// ==================================================================

#[derive(Serialize)]
struct TokenClaims {
	/// Centrifugo v6 连接 token 要求：sub = uid 字符串
	sub: String,
	iss: String,
	/// 秒级 Unix 时间戳（与 Node jsonwebtoken 默认输出对齐）
	iat: i64,
	exp: i64,
}

async fn get_token(State(state): State<AppState>, headers: HeaderMap, ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
	// 第一层：IP 暴刷防护——未解析 uid 就拦住，防 /api/me 放大打 NodeBB
	// 每个 token 请求 = 一次 NodeBB /api/me 回源，20 次/10s/IP 足以淹没论坛
	let ip = client_ip(&headers, &addr);
	if let Some(retry) = state.limiter.check(&format!("token:ip:{}", ip), 10_000, 20).await {
		return send_429(retry, "ip");
	}

	let uid = resolve_uid(&state, headers.get(header::COOKIE)).await;
	if uid == 0 {
		return err_json(StatusCode::UNAUTHORIZED, serde_json::json!({ "error": "login required" }));
	}

	// 第二层：uid 配额——正常多端 + 自动续期远达不到 60/10min，超限即为脚本滥用
	if let Some(retry) = state.limiter.check(&format!("token:uid:{}", uid), 10 * 60_000, 60).await {
		return send_429(retry, "user");
	}

	// 游客不连 WS：未登录浏览走 NodeBB SSR/REST，实时通道只服务注册成员
	let now = Utc::now().timestamp();
	let claims = TokenClaims {
		sub: uid.to_string(),
		iss: "odysseia-bff".to_string(),
		iat: now,
		exp: now + TOKEN_TTL_SECS,
	};
	let Ok(token) = encode(&JwtHeader::default(), &claims, &state.encoding_key) else {
		return err_json(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": "token sign failed" }));
	};

	Json(serde_json::json!({
		"token": token,
		"protocol": "centrifuge",
		"endpoint": "/connection/websocket",
		"expiresIn": "2h",
	}))
	.into_response()
}

// ==================================================================
// 2. Centrifugo subscribe proxy 回调（内网：centrifugo → bff:3000）
// ==================================================================

#[derive(Deserialize)]
struct SubscribeBody {
	channel: String,
	/// Centrifugo 从连接 token 的 sub 服务端注入的连接用户（可信）
	#[serde(default)]
	user: serde_json::Value,
}

/// Centrifugo proxy 协议：拒绝时返回 200 + error 对象（code 103 = permission denied）
fn proxy_deny() -> Response {
	Json(serde_json::json!({ "error": { "code": 103, "message": "not authorized" } })).into_response()
}

async fn post_subscribe(
	State(state): State<AppState>,
	headers: HeaderMap,
	Json(body): Json<SubscribeBody>,
) -> Response {
	// 第一道防线：Caddy 已不路由 /bff/centrifugo/* 到公网；
	// 第二道防线（本校验）：仅 Centrifugo proxy 携带 config.json static_headers 注入的
	// 共享密钥才可调。密钥缺失时 fail-closed（拒绝一切），防内网横向伪造。
	let header_secret = headers.get("x-odysseia-proxy").and_then(|v| v.to_str().ok()).unwrap_or("");
	if state.cfg.proxy_secret.is_empty() || header_secret != state.cfg.proxy_secret {
		return err_json(StatusCode::FORBIDDEN, serde_json::json!({ "error": "forbidden" }));
	}

	// 连接用户身份：仅取代理请求体 user 字段（Centrifugo 从连接 token 的 sub 服务端注入，可信）；
	// 不回退 x-centrifugo-user 头——该头可被直连方伪造
	let uid = body.user.as_u64().unwrap_or(0);
	if uid == 0 {
		return proxy_deny();
	}

	let channel = body.channel.as_str();
	let authorized = if let Some(rest) = channel
		.strip_prefix("typing:topic:")
		.or_else(|| channel.strip_prefix("topic:"))
	{
		// 帖内聊天室与 typing 频道同权限（presence 不落库，鉴权同帖子）
		match rest.parse::<u64>() {
			Ok(t) => can_read_topic(&state, t, uid).await,
			Err(_) => false,
		}
	} else if let Some(rest) = channel
		.strip_prefix("typing:chat:")
		.or_else(|| channel.strip_prefix("chat:"))
	{
		match rest.parse::<u64>() {
			Ok(r) => can_chat_room(&state, r, uid).await,
			Err(_) => false,
		}
	} else if let Some(target) = channel.strip_prefix("user:") {
		// 多端同步频道：仅本人可订
		target.parse::<u64>().map(|u| u == uid).unwrap_or(false)
	} else {
		// 未知前缀一律拒绝（fail-closed）
		false
	};

	if authorized {
		Json(serde_json::json!({ "result": {} })).into_response()
	} else {
		proxy_deny()
	}
}

// ==================================================================
// 3. R2 预签名直传（SigV4 手写签名，零 AWS SDK）
// ==================================================================

const ALLOWED_TYPES: &[(&str, &str)] = &[
	("image/png", "png"),
	("image/jpeg", "jpg"),
	("image/gif", "gif"),
	("image/webp", "webp"),
	("image/avif", "avif"),
	("video/mp4", "mp4"),
];

#[derive(Deserialize)]
struct PresignBody {
	#[serde(default)]
	kind: Option<String>,
	#[serde(default)]
	tid: Option<serde_json::Value>,
	#[serde(rename = "contentType", default)]
	content_type: Option<String>,
}

const PRESIGN_WINDOW_MS: u64 = 10 * 60 * 1000;
const PRESIGN_MAX: usize = 10;

async fn post_presign(
	State(state): State<AppState>,
	headers: HeaderMap,
	ConnectInfo(addr): ConnectInfo<SocketAddr>,
	Json(body): Json<PresignBody>,
) -> Response {
	// IP 暴刷层：与 /token 同源，防匿名打 R2 签名成本
	let ip = client_ip(&headers, &addr);
	if let Some(retry) = state.limiter.check(&format!("presign:ip:{}", ip), PRESIGN_WINDOW_MS, 30).await {
		return send_429(retry, "ip");
	}

	let uid = resolve_uid(&state, headers.get(header::COOKIE)).await;
	if uid == 0 {
		return err_json(StatusCode::UNAUTHORIZED, serde_json::json!({ "error": "login required" }));
	}

	if let Some(retry) = state.limiter.check(&format!("presign:uid:{}", uid), PRESIGN_WINDOW_MS, PRESIGN_MAX).await {
		return send_429(retry, "user");
	}

	let content_type = body.content_type.unwrap_or_default();
	let Some((_, ext)) = ALLOWED_TYPES.iter().find(|(ct, _)| *ct == content_type) else {
		return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "unsupported content type" }));
	};

	let bucket = match body.kind.as_deref() {
		Some("r18") => {
			// R18 桶：必须挂在具体帖子下，且用户对该帖有读权限（无权者 403，不暴露桶存在）
			let tid = body.tid.as_ref().and_then(|v| v.as_u64()).unwrap_or(0);
			if tid == 0 {
				return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "tid required" }));
			}
			if !can_read_topic(&state, tid, uid).await {
				return err_json(StatusCode::FORBIDDEN, serde_json::json!({ "error": "not authorized" }));
			}
			state.cfg.r2_bucket_r18.clone()
		}
		Some("media") | None => state.cfg.r2_bucket_media.clone(),
		Some(_) => {
			return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "invalid kind" }));
		}
	};

	// object key：u{uid}/{yyyymm}/{32hex}.{ext}（与 Node 版 crypto.randomBytes(16) 一致）
	let now = Utc::now();
	let ym = format!("{}{}", now.format("%Y"), now.format("%m"));
	let mut rnd = [0u8; 16];
	rand::thread_rng().fill_bytes(&mut rnd);
	let hex: String = rnd.iter().map(|b| format!("{:02x}", b)).collect();
	let key = format!("u{}/{}/{}.{}", uid, ym, hex, ext);

	let url = match sign_presigned_put(&state.cfg, &bucket, &key, &content_type, PRESIGN_TTL_SECS) {
		Ok(u) => u,
		Err(e) => {
			error!("[bff] presign 签名失败 {}", e);
			return err_json(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": "sign failed" }));
		}
	};

	// 注意：上传完成后 EXIF 剥离由 Cloudflare Image Resizing / R2 生命周期处理（架构 D10），
	// 此处不做服务端中转——直传的意义就是零中转带宽
	Json(serde_json::json!({
		"url": url,
		"key": key,
		"bucket": bucket,
		"expiresIn": PRESIGN_TTL_SECS,
	}))
	.into_response()
}

/// 手写 SigV4 query 预签名 PUT URL（R2 兼容，零 SDK）
///
/// 实现依据 AWS SigV4 presign 规范（query-string authentication），
/// 语义与 @aws-sdk/s3-request-presigner 等价：Content-Type 与 host 一起进 SignedHeaders
/// （SDK 对带 ContentType 的 PutObjectCommand 的默认行为），浏览器裸 PUT 该 URL 即可上传。
///
/// R2 特殊性：region 固定 "auto"；virtual-host style 由 endpoint 域名承载。
fn sign_presigned_put(
	cfg: &Config,
	bucket: &str,
	key: &str,
	content_type: &str,
	ttl_secs: i64,
) -> Result<String, String> {
	let endpoint = cfg.r2_endpoint.trim_end_matches('/').to_string();
	if !endpoint.starts_with("http") {
		return Err("R2_ENDPOINT 必须以 http(s):// 开头".to_string());
	}
	let host = endpoint
		.trim_start_matches("https://")
		.trim_start_matches("http://")
		.to_string();

	let now = Utc::now();
	let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
	let date_stamp = now.format("%Y%m%d").to_string();
	let credential_scope = format!("{}/auto/s3/aws4_request", date_stamp);
	let credential = format!("{}/{}", cfg.r2_access_key_id, credential_scope);
	let signed_headers = "content-type;host";

	// canonical request（PUT，presigned payload hash = UNSIGNED-PAYLOAD）
	let canonical_uri = format!("/{}/{}", bucket, encode_uri_path(key));
	let mut query_pairs: Vec<(String, String)> = [
		("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
		("X-Amz-Credential", credential.as_str()),
		("X-Amz-Date", amz_date.as_str()),
		("X-Amz-Expires", "900"), // ttl 进查询串需常量字符串，PRESIGN_TTL_SECS 即 900
		("X-Amz-SignedHeaders", signed_headers),
	]
	.iter()
	.map(|(k, v)| (percent_encode(k), percent_encode(v)))
	.collect();
	query_pairs.sort();
	let canonical_query_str: String = query_pairs
		.iter()
		.map(|(k, v)| format!("{}={}", k, v))
		.collect::<Vec<_>>()
		.join("&");

	// ttl 校验（X-Amz-Expires 上限 604800s；上面查询串写死 900，这里防呆一致性）
	if ttl_secs != PRESIGN_TTL_SECS {
		return Err("presign TTL 与查询串常量不一致".to_string());
	}

	let canonical_request = format!(
		"PUT\n{uri}\n{query}\ncontent-type:{ct}\nhost:{host}\n\n{signed}\n{payload_hash}",
		uri = canonical_uri,
		query = canonical_query_str,
		ct = content_type,
		host = host,
		signed = signed_headers,
		payload_hash = "UNSIGNED-PAYLOAD",
	);

	let string_to_sign = format!(
		"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{hash}",
		amz_date = amz_date,
		scope = credential_scope,
		hash = hex_sha256(canonical_request.as_bytes()),
	);

	// signing key 派生链（SigV4 规范：HMAC 链式派生）
	let k_date = {
		let mut mac = <HmacSha256 as Mac>::new_from_slice(format!("AWS4{}", cfg.r2_secret_access_key).as_bytes())
			.map_err(|e| e.to_string())?;
		mac.update(date_stamp.as_bytes());
		mac.finalize().into_bytes().to_vec()
	};
	let k_region = {
		let mut mac = <HmacSha256 as Mac>::new_from_slice(&k_date).map_err(|e| e.to_string())?;
		mac.update(b"auto");
		mac.finalize().into_bytes().to_vec()
	};
	let k_service = {
		let mut mac = <HmacSha256 as Mac>::new_from_slice(&k_region).map_err(|e| e.to_string())?;
		mac.update(b"s3");
		mac.finalize().into_bytes().to_vec()
	};
	let k_signing = {
		let mut mac = <HmacSha256 as Mac>::new_from_slice(&k_service).map_err(|e| e.to_string())?;
		mac.update(b"aws4_request");
		mac.finalize().into_bytes().to_vec()
	};
	let signature = {
		let mut mac = <HmacSha256 as Mac>::new_from_slice(&k_signing).map_err(|e| e.to_string())?;
		mac.update(string_to_sign.as_bytes());
		hex(&mac.finalize().into_bytes())
	};

	Ok(format!(
		"{endpoint}{uri}?{query}&X-Amz-Signature={signature}",
		endpoint = endpoint,
		uri = canonical_uri,
		query = canonical_query_str,
	))
}

/// SigV4 规范的 URI 编码（路径段：保留 /，其余 RFC3986 unreserved 外全部转义）
fn encode_uri_path(s: &str) -> String {
	let mut out = String::new();
	for b in s.bytes() {
		match b {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
				out.push(b as char)
			}
			_ => out.push_str(&format!("%{:02X}", b)),
		}
	}
	out
}

/// 查询参数键值的 percent-encode（RFC3986 unreserved 之外全部转义，含 / 和 ;）
fn percent_encode(s: &str) -> String {
	let mut out = String::new();
	for b in s.bytes() {
		match b {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
			_ => out.push_str(&format!("%{:02X}", b)),
		}
	}
	out
}

fn hex_sha256(data: &[u8]) -> String {
	let mut hasher = Sha256::new();
	hasher.update(data);
	hex(&hasher.finalize())
}

fn hex(data: &[u8]) -> String {
	data.iter().map(|b| format!("{:02x}", b)).collect()
}

// ==================================================================
// 4. 私聊消息 cursor 分页（before/after/around 契约）
// ==================================================================

#[derive(Deserialize)]
struct ChatMessagesQuery {
	before: Option<String>,
	after: Option<String>,
	around: Option<String>,
	limit: Option<String>,
}

/// 定位消息在房间内的 revOffset（从新往旧 0-based：0=最新消息）
/// 走 NodeBB 插件内部 API（bridge lib/internal.js）一次回源拿到 rank/card，
/// 换算 revOffset = card - 1 - rank。
/// 用 card（sortedSetCard，随 purge 递减）而非房间对象 messageCount（purge 不减、虚高），
/// 彻底绕开 NodeBB direction 模式的 msgCount - start 换算坑。
/// 返回 None = 消息不存在（或 NodeBB 不可达，fail-closed 404）。
async fn locate_message_rev_offset(state: &AppState, room_id: u64, target_mid: u64) -> Option<u64> {
	let r = call_nodebb(
		state,
		&format!("/api/v3/plugins/odysseia/chat-index/{}/{}", room_id, target_mid),
	)
	.await?;
	let rank = r.get("rank").and_then(|v| v.as_u64())?;
	let card = r.get("card").and_then(|v| v.as_u64())?;
	if rank >= card {
		return None; // 数据异常防御
	}
	Some(card - 1 - rank)
}

async fn get_chat_messages(
	State(state): State<AppState>,
	headers: HeaderMap,
	ConnectInfo(addr): ConnectInfo<SocketAddr>,
	Path(room_id): Path<u64>,
	Query(q): Query<ChatMessagesQuery>,
) -> Response {
	let uid = resolve_uid(&state, headers.get(header::COOKIE)).await;
	if uid == 0 {
		return err_json(StatusCode::UNAUTHORIZED, serde_json::json!({ "error": "login required" }));
	}

	if room_id == 0 {
		return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "roomId required" }));
	}

	// 鉴权：必须是房间成员（复用内部 API）
	if !can_chat_room(&state, room_id, uid).await {
		return err_json(StatusCode::FORBIDDEN, serde_json::json!({ "error": "not authorized" }));
	}

	// 限频：私聊消息拉取比发帖轻，但防脚本全量爬历史
	let ip = client_ip(&headers, &addr);
	if let Some(retry) = state.limiter.check(&format!("chatmsg:ip:{}", ip), 10_000, 30).await {
		return send_429(retry, "ip");
	}

	let limit: usize = q
		.limit
		.as_deref()
		.and_then(|s| s.parse::<usize>().ok())
		.unwrap_or(50)
		.clamp(1, 100);

	// ---- cursor → NodeBB 原始 start/stop 翻译 ----
	// NodeBB listMessages 有两种模式：
	//   A. direction 模式：start 经 msgCount - start 换算（purge 后 messageCount 虚高 → 错位，弃用）
	//   B. 原始模式（无 direction）：getMessages(start, stop) = RevRange(start..stop) + reverse → 升序返回
	// 我们统一走 B：start/stop 都是「从新往旧」的 0-based RevRange 偏移（0=最新），
	// 拿到升序数组后在本端反转为降序。绕开 direction 模式的全部换算坑。
	let mut start: i64 = 0; // RevRange offset（0 = 最新）
	let mut stop: i64 = (limit as i64) - 1;

	if let Some(before) = q.before.as_deref() {
		let Some(target) = before.parse::<u64>().ok() else {
			return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "invalid before" }));
		};
		match locate_message_rev_offset(&state, room_id, target).await {
			Some(rev) => {
				// before=目标：拉比目标更旧的一页 → RevRange(rev+1 .. rev+limit)
				start = (rev as i64) + 1;
				stop = (rev as i64) + (limit as i64);
			}
			None => return err_json(StatusCode::NOT_FOUND, serde_json::json!({ "error": "message not found" })),
		}
	} else if let Some(after) = q.after.as_deref() {
		let Some(target) = after.parse::<u64>().ok() else {
			return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "invalid after" }));
		};
		match locate_message_rev_offset(&state, room_id, target).await {
			Some(rev) => {
				// after=目标：拉比目标更新的 limit 条 → RevRange(rev-limit .. rev-1)
				start = (rev as i64) - (limit as i64);
				stop = (rev as i64) - 1;
			}
			None => return err_json(StatusCode::NOT_FOUND, serde_json::json!({ "error": "message not found" })),
		}
	} else if let Some(around) = q.around.as_deref() {
		// around：跳到某消息前后各半
		let Some(target) = around.parse::<u64>().ok() else {
			return err_json(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "invalid around" }));
		};
		match locate_message_rev_offset(&state, room_id, target).await {
			Some(rev) => {
				let half = (limit / 2) as i64;
				start = (rev as i64) - half;
				stop = (rev as i64) + (limit as i64 - 1 - half);
			}
			None => return err_json(StatusCode::NOT_FOUND, serde_json::json!({ "error": "message not found" })),
		}
	}
	if start < 0 {
		// 目标太靠新（前页不足 limit）：clamp 到 0，stop 平移保窗口宽
		stop += start;
		start = 0;
	}
	if stop < start {
		// after 目标就是最新消息（rev=0）：没有更新的消息，返回空页
		return Json(serde_json::json!({
			"messages": [],
			"cursor": { "oldest": null, "newest": null },
		}))
		.into_response();
	}

	// 走插件内部 chat-messages 端点（Messaging.getMessages 直调）：
	// start/count = RevRange 偏移（0=最新），升序返回，非公开房间自动含加入时间隐私边界
	let count = (stop - start + 1) as u64;
	let data = call_nodebb(
		&state,
		&format!("/api/v3/plugins/odysseia/chat-messages/{}/{}/{}/{}", room_id, uid, start, count),
	)
	.await;
	let Some(data) = data else {
		return err_json(StatusCode::BAD_GATEWAY, serde_json::json!({ "error": "upstream unavailable" }));
	};
	let Some(mut messages) = data.get("messages").and_then(|v| v.as_array()).cloned() else {
		return err_json(StatusCode::BAD_GATEWAY, serde_json::json!({ "error": "upstream unavailable" }));
	};

	// 统一降序返回（内部端点给的是升序，反转一次；cursor 越界时不足 limit 属正常）
	messages.reverse();

	let oldest = messages
		.last()
		.and_then(|m| m.get("messageId").or_else(|| m.get("mid")))
		.cloned();
	let newest = messages
		.first()
		.and_then(|m| m.get("messageId").or_else(|| m.get("mid")))
		.cloned();

	Json(serde_json::json!({
		"messages": messages.iter().take(limit).collect::<Vec<_>>(),
		// 游标推进：本页最旧/最新的 messageId，供下一页 before/after 使用
		"cursor": { "oldest": oldest, "newest": newest },
	}))
	.into_response()
}

// ==================================================================
// 5. 静态托管 centrifuge SDK
// ==================================================================
// 浏览器经 Caddy /bff/vendor/centrifuge.js 引入（剥前缀后到达 /vendor/centrifuge.js）。
// Node 版 express.static 目录托管；Rust 版只有一个文件，构建期 COPY 进镜像直接读。

async fn get_vendor_centrifuge() -> Response {
	match tokio::fs::read_to_string("/app/vendor/centrifuge.js").await {
		Ok(js) => (
			[
				(header::CONTENT_TYPE, "application/javascript"),
				(header::CACHE_CONTROL, "public, max-age=86400"),
			],
			js,
		)
			.into_response(),
		Err(_) => err_json(StatusCode::NOT_FOUND, serde_json::json!({ "error": "not found" })),
	}
}

// ==================================================================
// 启动
// ==================================================================

#[tokio::main]
async fn main() {
	tracing_subscriber::fmt()
		.with_env_filter(
			tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
		)
		.init();

	// docker healthcheck 模式：自连 /healthz 后退出（slim 镜像无 curl/wget）
	if std::env::args().any(|a| a == "--healthcheck") {
		let client = reqwest::Client::new();
		let ok = client
			.get(format!("http://127.0.0.1:{}/healthz", PORT))
			.timeout(Duration::from_secs(4))
			.send()
			.await
			.map(|r| r.status().is_success())
			.unwrap_or(false);
		std::process::exit(if ok { 0 } else { 1 });
	}

	let cfg = Arc::new(Config::from_env());
	for (name, value) in [
		("NODEBB_URL", &cfg.nodebb_url),
		("CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY", &cfg.token_secret),
		("ODYSSEIA_INTERNAL_TOKEN", &cfg.internal_token),
		("ODYSSEIA_PROXY_SECRET", &cfg.proxy_secret),
		("R2_ENDPOINT", &cfg.r2_endpoint),
		("R2_ACCESS_KEY_ID", &cfg.r2_access_key_id),
		("R2_SECRET_ACCESS_KEY", &cfg.r2_secret_access_key),
		("R2_BUCKET_MEDIA", &cfg.r2_bucket_media),
		("R2_BUCKET_R18", &cfg.r2_bucket_r18),
	] {
		if value.is_empty() {
			error!("[bff] 缺少环境变量 {}，拒绝启动（fail-closed）", name);
			std::process::exit(1);
		}
	}

	let encoding_key = Arc::new(EncodingKey::from_secret(cfg.token_secret.as_bytes()));

	let state = AppState {
		cfg,
		http: reqwest::Client::new(),
		limiter: Arc::new(RateLimiter::default()),
		encoding_key,
	};

	let app = Router::new()
		.route("/token", get(get_token))
		.route("/centrifugo/subscribe", post(post_subscribe))
		.route("/upload/presign", post(post_presign))
		.route("/chat/:room_id/messages", get(get_chat_messages))
		.route("/vendor/centrifuge.js", get(get_vendor_centrifuge))
		.route("/healthz", get(|| async { Json(serde_json::json!({ "ok": true })) }))
		// 与 Node 版 express.json({ limit: '64kb' }) 对齐
		.layer(DefaultBodyLimit::max(64 * 1024))
		.with_state(state);

	let addr = SocketAddr::from(([0, 0, 0, 0], PORT));
	let listener = tokio::net::TcpListener::bind(addr).await.expect("端口绑定失败");
	info!("[bff] ΟΔΥΣΣΕΙΑ BFF(Rust) 已启动 :{}（token / subscribe-proxy / presign / chat 分页）", PORT);
	// into_make_service_with_connect_info：让 handler 能拿 ConnectInfo<SocketAddr>（client_ip 兜底用）
	let service = app.into_make_service_with_connect_info::<SocketAddr>();
	if let Err(e) = axum::serve(listener, service).await {
		error!("[bff] 服务异常退出 {}", e);
	}
}