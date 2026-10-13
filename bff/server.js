'use strict';

/**
 * ΟΔΥΣΣΕΙΑ BFF 聚合层
 *
 * 职责（架构决策 D8，刻意保持小）：
 *   1. GET  /token            —— NodeBB 会话 cookie 换 Centrifugo 连接 JWT（仅登录用户）
 *   2. POST /centrifugo/subscribe —— Centrifugo subscribe proxy 回调，按频道前缀
 *                                    调 NodeBB 内部 API 做权威鉴权（fail-closed）
 *   3. POST /upload/presign   —— R2 预签名直传（普通桶 / R18 桶按帖子权限分流）
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

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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
	const uid = await resolveUid(req);
	if (!uid) return res.status(401).json({ error: 'login required' });

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

// 预签名限频：per-uid 内存滑动窗口（10 次/10 分钟），防 R2 key 喷洒与签名成本放大。
// 单实例内存即可——BFF 无状态单副本部署，重启清零可接受
const PRESIGN_WINDOW_MS = 10 * 60 * 1000;
const PRESIGN_MAX = 10;
const presignHits = new Map(); // uid -> number[]（窗口内时间戳）

function presignAllowed(uid) {
	const now = Date.now();
	const hits = (presignHits.get(uid) || []).filter(t => now - t < PRESIGN_WINDOW_MS);
	if (hits.length >= PRESIGN_MAX) {
		presignHits.set(uid, hits);
		return false;
	}
	hits.push(now);
	presignHits.set(uid, hits);
	if (presignHits.size > 10000) presignHits.clear(); // 防内存膨胀，限频精度可牺牲
	return true;
}

app.post('/upload/presign', async (req, res) => {
	const uid = await resolveUid(req);
	if (!uid) return res.status(401).json({ error: 'login required' });
	if (!presignAllowed(uid)) return res.status(429).json({ error: 'too many requests' });

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

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
	console.log(`[bff] ΟΔΥΣΣΕΙΑ BFF 已启动 :${PORT}（token / subscribe-proxy / presign）`);
});
