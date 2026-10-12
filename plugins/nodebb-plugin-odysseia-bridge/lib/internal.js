'use strict';

/**
 * 内部鉴权 API —— BFF 的 Centrifugo subscribe proxy 回调到这里
 *
 * 设计（架构决策 D8/D10）：
 *   - 鉴权跑在 NodeBB 进程内，直接调用 NodeBB privileges —— 权威、零额外查询成本
 *   - 分级内容（R18/R18G）的可见性 = category 级 group 权限，
 *     privileges.topics.can 天然涵盖，无权者直接拒订（前端 404，不暴露存在性）
 *   - 全部路由要求 header: X-Internal-Token（与 BFF 共享，.env 中 ODYSSEIA_INTERNAL_TOKEN）
 */

const INTERNAL_TOKEN = process.env.ODYSSEIA_INTERNAL_TOKEN || '';

function loadModule(...paths) {
	for (const p of paths) {
		try {
			return require.main.require(p);
		} catch (e) {
			/* 尝试下一个路径 */
		}
	}
	return null;
}

const privileges = loadModule('./src/privileges');
const Messaging = loadModule('./src/messaging', './src/messaging/index');

function requireInternalToken(req, res, next) {
	if (!INTERNAL_TOKEN || req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
		return res.status(403).json({ error: 'forbidden' });
	}
	next();
}

function mount(router /* , middleware */) {
	// 帖内聊天室订阅鉴权：用户能否读该帖
	router.get('/api/v3/plugins/odysseia/can-read/:tid/:uid', requireInternalToken, async (req, res) => {
		try {
			if (!privileges) return res.status(500).json({ error: 'privileges 模块不可用' });
			const canRead = await privileges.topics.can('topics:read', Number(req.params.tid), Number(req.params.uid));
			res.json({ canRead: !!canRead });
		} catch (err) {
			console.error('[odysseia-bridge] can-read 校验失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});

	// 私聊/群聊订阅鉴权：用户是否房间成员
	router.get('/api/v3/plugins/odysseia/can-chat/:roomId/:uid', requireInternalToken, async (req, res) => {
		try {
			if (!Messaging) return res.status(500).json({ error: 'messaging 模块不可用' });
			// NodeBB 4.x 签名 isUserInRoom(uid, roomId)，防御式兼容旧签名
			const uid = Number(req.params.uid);
			const roomId = Number(req.params.roomId);
			const inRoom = await Messaging.isUserInRoom(uid, roomId);
			res.json({ canRead: !!inRoom });
		} catch (err) {
			console.error('[odysseia-bridge] can-chat 校验失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});
}

module.exports = { mount };
