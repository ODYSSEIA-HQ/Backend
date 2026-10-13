'use strict';

/**
 * ΟΔΥΣΣΕΙΑ BFF 聚合层
 *
 * 职责（架构决策 D8，刻意保持小）：
 *   1. GET  /token            —— NodeBB 会话 cookie 换 Centrifugo 连接 JWT（仅登录用户）
 *   2. POST /centrifugo/subscribe —— Centrifugo subscribe proxy 回调，按频道前缀
 *                                    调 NodeBB 内部 API 做权威鉴权（fail-closed）
 *   3. POST /upload/presign   —— R2 预签名直传（普通桶 / R18 桶按帖子权限分流）
 *   4. 全局限频               —— 内存滑动窗口双层（IP 暴刷层 + uid 配额层），
 *                                  429 契约仿 Fluxer/Discord：X-RateLimit-* 头 + retry_after 秒级精度
 *
 * 不做的事：消息流代理——首屏走 NodeBB SSR/REST，实时增量走 Centrifugo，
 * BFF 只做"鉴权 + 发证"，无状态、可随时重启。
 *
 * 频道鉴权矩阵：
 *   topic:{tid}        → privileges.topics.can('topics:read')   （R18 无权者直接拒订，前端 404 语义）
 *   typing:topic:{tid} → 同上（presence 不落库，鉴权同帖子）
 *   chat:{roomId}      → Messaging.isUserInRoom
 *   user:{uid}         → 仅本人（多端同步）
 */

// 本文件是旧 Node 版 BFF（Rust 版 src/main.rs 已替代），保留作契约参考实现。
// 类型检查环境（.tscheck）不装运行时依赖，运行时模块按 any 处理：
/** @type {any} */ const express = require('express');
const path = require('path');
/** @type {any} */ const jwt = require('jsonwebtoken');
const crypto = require('crypto');
/** @type {any} */ const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
/** @type {any} */ const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
	NODEBB_URL,
	CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY: TOKEN_SECRET,
	ODYSSEIA_INTERNAL_TOKEN: INTERNAL_TOKEN,
	ODYSSEIA_PROXY_SECRET: PROXY_SECRET,
	R2_ENDPOINT,
	R2_ACCESS_KEY_ID,
	R2_SECRET_ACCESS_KEY,
	R2_BUCKET_MEDIA,
	R2_BUCKET_R18,
} = process.env;

const PORT = Number(process.env.PORT || 3000);
const TOKEN_TTL = '2h'; // 短 TTL + 前端 getToken 自动续期（见 chat.js），泄露窗口从 24h 压到 2h
const PRESIGN_TTL = 900; // 15 分钟

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---------- 静态托管 centrifuge 客户端 SDK ----------
// 浏览器经 Caddy /bff/vendor/centrifuge.js 引入（剥前缀后到达 /vendor/centrifuge.js），
// 无需 CDN / npm —— 演示与生产同一路径
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'centrifuge', 'dist'), {
	maxAge: '1d',
	index: false,
}));

// ---------- 通用内存滑动窗口限频器 ----------
// 单实例内存即可——BFF 无状态单副本部署，重启清零可接受（将来多副本再换 Redis 原子计数）
// 命中返回 { retryAfterMs }，否则 null
const rateHits = new Map(); // key -> number[]（窗口内时间戳）

function rateCheck(key, windowMs, max) {
	const now = Date.now();
	const hits = (rateHits.get(key) || []).filter(t => now - t < windowMs);
	if (hits.length >= max) {
		rateHits.set(key, hits);
		return { retryAfterMs: Math.max(1, hits[0] + windowMs - now) };
	}
	hits.push(now);
	rateHits.set(key, hits);
	if (rateHits.size > 50000) rateHits.clear(); // 防内存膨胀，限频精度可牺牲
	return null;
}

function clientIp(req) {
	// Caddy 只签可信代理层；上游头可伪造时退化为 socket 地址（fail-safe）
	return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function send429(res, retryAfterMs, scope) {
	const sec = retryAfterMs / 1000;
	res.set({
		'Retry-After': String(Math.ceil(sec)),
		'X-RateLimit-Scope': scope,
	}).status(429).json({
		code: 'RATE_LIMITED',
		message: '请求过于频繁，请稍后再试',
		retry_after: sec, // 秒级小数，客户端直接 setTimeout 即可
	});
}

// ---------- NodeBB 会话解析：cookie → uid（游客为 0） ----------

async function resolveUid(req) {
	try {
		const res = await fetch(`${NODEBB_URL}/api/me`, {
			headers: { cookie: req.headers.cookie || '' },
			signal: AbortSignal.timeout(1500), // 必须 < Centrifugo proxy timeout（2s），否则订阅回调整体超时
		});
		if (!res.ok) return 0;
		const data = await res.json().catch(() => null);
		const uid = Number(data && (data.uid !== undefined ? data.uid : data._uid));
		return uid > 0 ? uid : 0;
	} catch (err) {
		console.error('[bff] NodeBB 会话解析失败', err.message);
		return 0;
	}
}

// ---------- NodeBB 内部 API（X-Internal-Token，fail-closed） ----------

async function callNodeBB(path) {
	try {
		const res = await fetch(`${NODEBB_URL}${path}`, {
			headers: { 'x-internal-token': INTERNAL_TOKEN },
			signal: AbortSignal.timeout(1500),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch (err) {
		console.error('[bff] NodeBB 内部 API 调用失败', path, err.message);
		return null;
	}
}

const canReadTopic = (tid, uid) =>
	callNodeBB(`/api/v3/plugins/odysseia/can-read/${tid}/${uid}`).then(r => !!(r && r.canRead));
const canChatRoom = (roomId, uid) =>
	callNodeBB(`/api/v3/plugins/odysseia/can-chat/${roomId}/${uid}`).then(r => !!(r && r.canRead));

// ==================================================================
// 1. Centrifugo 连接 token
// ==================================================================

app.get('/token', async (req, res) => {
	// 第一层：IP 暴刷防护——未解析 uid 就拦住，防 /api/me 放大打 NodeBB
	// 每个 token 请求 = 一次 NodeBB /api/me 回源，20 次/10s/IP 足以淹没论坛
	const ipHit = rateCheck(`token:ip:${clientIp(req)}`, 10_000, 20);
	if (ipHit) return send429(res, ipHit.retryAfterMs, 'ip');

	const uid = await resolveUid(req);
	if (!uid) return res.status(401).json({ error: 'login required' });

	// 第二层：uid 配额——正常多端 + 自动续期远达不到 60/10min，超限即为脚本滥用
	const uidHit = rateCheck(`token:uid:${uid}`, 10 * 60_000, 60);
	if (uidHit) return send429(res, uidHit.retryAfterMs, 'user');

	// 游客不连 WS：未登录浏览走 NodeBB SSR/REST，实时通道只服务注册成员
	const token = jwt.sign({ sub: String(uid), iss: 'odysseia-bff' }, TOKEN_SECRET, {
		expiresIn: TOKEN_TTL,
	});
	res.json({ token, protocol: 'centrifuge', endpoint: '/connection/websocket', expiresIn: TOKEN_TTL });
});

// ==================================================================
// 2. Centrifugo subscribe proxy 回调（内网：centrifugo → bff:3000）
// ==================================================================

app.post('/centrifugo/subscribe', async (req, res) => {
	// 第一道防线：Caddy 已不路由 /bff/centrifugo/* 到公网；
	// 第二道防线（本校验）：仅 Centrifugo proxy 携带 config.json static_headers 注入的
	// 共享密钥才可调。密钥缺失时 fail-closed（拒绝一切），防内网横向伪造。
	if (!PROXY_SECRET || req.headers['x-odysseia-proxy'] !== PROXY_SECRET) {
		return res.status(403).json({ error: 'forbidden' });
	}

	const body = req.body || {};
	const channel = String(body.channel || '');
	// 连接用户身份：仅取代理请求体 user 字段（Centrifugo 从连接 token 的 sub 服务端注入，可信）；
	// 不再回退 x-centrifugo-user 头——该头可被直连方伪造
	const uid = Number(body.user || 0);

	if (!uid) return res.json({ error: { code: 103, message: 'not authorized' } });

	try {
		let authorized = false;

		if (channel.startsWith('topic:')) {
			authorized = await canReadTopic(Number(channel.slice(6)), uid);
		} else if (channel.startsWith('typing:topic:')) {
			authorized = await canReadTopic(Number(channel.slice('typing:topic:'.length)), uid);
		} else if (channel.startsWith('chat:')) {
			authorized = await canChatRoom(Number(channel.slice(5)), uid);
		} else if (channel.startsWith('typing:chat:')) {
			authorized = await canChatRoom(Number(channel.slice('typing:chat:'.length)), uid);
		} else if (channel.startsWith('user:')) {
			// 多端同步频道：仅本人可订
			authorized = uid === Number(channel.slice(5));
		}
		// 未知前缀一律拒绝（fail-closed）

		// Centrifugo proxy 协议：拒绝时返回 200 + error 对象（code 103 = permission denied）
		if (!authorized) return res.json({ error: { code: 103, message: 'not authorized' } });
		return res.json({ result: {} });
	} catch (err) {
		console.error('[bff] 订阅鉴权异常', channel, err.message);
		return res.status(500).json({ error: 'internal' });
	}
});

// ==================================================================
// 3. R2 预签名直传
// ==================================================================

const s3 = new S3Client({
	region: 'auto',
	endpoint: R2_ENDPOINT,
	credentials: {
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
	},
});

const ALLOWED_TYPES = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/avif': 'avif',
	'video/mp4': 'mp4',
};

// 预签名限频：uid 配额层（10 次/10 分钟），防 R2 key 喷洒与签名成本放大
const PRESIGN_WINDOW_MS = 10 * 60 * 1000;
const PRESIGN_MAX = 10;

app.post('/upload/presign', async (req, res) => {
	// IP 暴刷层：与 /token 同源，防匿名打 R2 签名成本
	const ipHit = rateCheck(`presign:ip:${clientIp(req)}`, PRESIGN_WINDOW_MS, 30);
	if (ipHit) return send429(res, ipHit.retryAfterMs, 'ip');

	const uid = await resolveUid(req);
	if (!uid) return res.status(401).json({ error: 'login required' });

	const uidHit = rateCheck(`presign:uid:${uid}`, PRESIGN_WINDOW_MS, PRESIGN_MAX);
	if (uidHit) return send429(res, uidHit.retryAfterMs, 'user');

	const { kind, tid, contentType } = req.body || {};
	const ext = ALLOWED_TYPES[contentType];
	if (!ext) return res.status(400).json({ error: 'unsupported content type' });

	let bucket = R2_BUCKET_MEDIA;

	if (kind === 'r18') {
		// R18 桶：必须挂在具体帖子下，且用户对该帖有读权限（无权者 403，不暴露桶存在）
		const tidNum = Number(tid);
		if (!(tidNum > 0)) return res.status(400).json({ error: 'tid required' });
		const r = await callNodeBB(`/api/v3/plugins/odysseia/can-read/${tidNum}/${uid}`);
		if (!r || !r.canRead) return res.status(403).json({ error: 'not authorized' });
		bucket = R2_BUCKET_R18;
	} else if (kind && kind !== 'media') {
		return res.status(400).json({ error: 'invalid kind' });
	}

	const now = new Date();
	const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	const key = `u${uid}/${ym}/${crypto.randomBytes(16).toString('hex')}.${ext}`;

	const url = await getSignedUrl(
		s3,
		new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
		{ expiresIn: PRESIGN_TTL }
	);

	// 注意：上传完成后 EXIF 剥离由 Cloudflare Image Resizing / R2 生命周期处理（架构 D10），
	// 此处不做服务端中转——直传的意义就是零中转带宽
	res.json({ url, key, bucket, expiresIn: PRESIGN_TTL });
});

// ==================================================================
// 4. 私聊消息 cursor 分页（before/after 契约，优化无限滚动体验）
// ==================================================================

/**
 * NodeBB 原生私聊消息 API 是 offset + 固定 50 条 + direction 语义，
 * 前端无限滚动用「向上拉更早」时 direction=-1 换算别扭，且无法精确锚定某条消息。
 * 此处加一层 BFF 适配，对外暴露 before/after cursor 契约（仿 Fluxer/Discord），
 * 内部翻译成 NodeBB 的 start + direction 参数。
 *
 * 契约：
 *   GET /bff/chat/{roomId}/messages?before=<messageId>&after=<messageId>&limit=1..100(默认50)
 *   before: 拉比该消息更早的一页（向上滚动）→ NodeBB start=index+1, direction=-1
 *   after:  拉比该消息更晚的一页（向下滚动/实时补漏）→ NodeBB start=index-1, direction=1
 *   无 cursor: 拉最新一页（首屏）→ NodeBB start=0, direction=-1
 *
 * 响应统一降序（新→旧），前端 prepend/append 按 cursor 判断。
 */

/**
 * 定位消息在房间内的 revOffset（从新往旧 0-based：0=最新消息）
 * 走 NodeBB 插件内部 API（bridge lib/internal.js）一次回源拿到 rank/card，
 * 换算 revOffset = card - 1 - rank。用 card（sortedSetCard）而非房间对象
 * messageCount（purgeMessage 不减它、历史房间虚高），绕开 NodeBB direction
 * 模式 msgCount - start 换算坑。
 * @param {number} roomId
 * @param {number} targetMid
 * @returns {Promise<number|null>} revOffset 或 null（消息不存在）
 */
async function locateMessageRevOffset(roomId, targetMid) {
	const r = await callNodeBB(`/api/v3/plugins/odysseia/chat-index/${roomId}/${targetMid}`);
	if (!r || typeof r.rank !== 'number' || typeof r.card !== 'number' || r.rank >= r.card) return null;
	return r.card - 1 - r.rank;
}

app.get('/chat/:roomId/messages', async (req, res) => {
	const uid = await resolveUid(req);
	if (!uid) return res.status(401).json({ error: 'login required' });

	const roomId = Number(req.params.roomId);
	if (!roomId) return res.status(400).json({ error: 'roomId required' });

	// 鉴权：必须是房间成员（复用内部 API）
	const inRoom = await callNodeBB(`/api/v3/plugins/odysseia/can-chat/${roomId}/${uid}`);
	if (!inRoom || !inRoom.canRead) return res.status(403).json({ error: 'not authorized' });

	// 限频：私聊消息拉取比发帖轻，但防脚本全量爬历史
	const ipHit = rateCheck(`chatmsg:ip:${clientIp(req)}`, 10_000, 30);
	if (ipHit) return send429(res, ipHit.retryAfterMs, 'ip');

	const { before, after, limit: rawLimit } = req.query;
	const limit = Math.min(100, Math.max(1, Number(rawLimit) || 50));

	// ---- cursor → NodeBB 原始 start/count 翻译 ----
	// start/count = RevRange 偏移（0=最新），走插件内部 chat-messages 端点
	// （Messaging.getMessages 直调：升序返回 + 非公开房间自动含加入时间隐私边界）
	let start = 0;
	let count = limit;

	if (before) {
		const rev = await locateMessageRevOffset(roomId, before);
		if (rev === null) return res.status(404).json({ error: 'message not found' });
		// before=目标：拉比目标更旧的一页 → RevRange(rev+1 起，limit 条)
		start = rev + 1;
		count = limit;
	} else if (after) {
		const rev = await locateMessageRevOffset(roomId, after);
		if (rev === null) return res.status(404).json({ error: 'message not found' });
		// after=目标：拉比目标更新的 limit 条 → RevRange(rev-limit 起，至 rev-1)
		count = Math.min(limit, rev);
		start = rev - count;
	} else if (req.query.around) {
		const rev = await locateMessageRevOffset(roomId, req.query.around);
		if (rev === null) return res.status(404).json({ error: 'message not found' });
		// around：目标居中（前半=更新的，后半=更旧的）
		const half = Math.floor(limit / 2);
		start = Math.max(0, rev - half);
		const stop = rev + (limit - 1 - half);
		count = stop - start + 1;
	}

	if (count <= 0) {
		// after 目标就是最新消息（rev=0）：没有更新的消息，空页
		return res.json({ messages: [], cursor: { oldest: null, newest: null } });
	}

	const data = await callNodeBB(
		`/api/v3/plugins/odysseia/chat-messages/${roomId}/${uid}/${start}/${count}`
	);
	if (!data || !Array.isArray(data.messages)) {
		return res.status(502).json({ error: 'upstream unavailable' });
	}

	// 统一降序返回（内部端点给的是升序，反转一次）
	const messages = data.messages.slice(0, limit).reverse();

	res.json({
		messages,
		// 游标推进：本页最旧/最新的 messageId，供下一页 before/after 使用
		cursor: {
			oldest: messages.length ? (messages[messages.length - 1].messageId || messages[messages.length - 1].mid) : null,
			newest: messages.length ? (messages[0].messageId || messages[0].mid) : null,
		},
	});
});

// ==================================================================

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
	console.log(`[bff] ΟΔΥΣΣΕΙΑ BFF 已启动 :${PORT}（token / subscribe-proxy / presign）`);
});
