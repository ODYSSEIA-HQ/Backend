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

/**
 * @param {any} router NodeBB static:app.load 传入的 express Router
 * @param {object} [_middleware] 保留参数（同源传入，暂未用）
 */
function mount(router, _middleware) {
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

	// 私聊消息 mid → 房间内定位三元组（BFF cursor 分页换算用）
	// 一次回源替代原先的「拉最新页 + 二分逼近」探测法（最多 14 次回源）。
	//
	// 坐标系说明（对照 NodeBB src/messaging/index.js getMessages 与 src/api/chats.js listMessages）：
	//   rank           = chat:room:{roomId}:mids 的升序 rank（0=最旧，随 purge 自动正确）
	//   card           = mids 当前总数（sortedSetCard，随 purge 递减——与 messageCount 不同！）
	//   messageCount   = chat:room:{roomId} 对象字段（purgeMessage 不减它，历史房间会虚高）
	//
	// BFF 的正确换算（绕开 messageCount 虚高）：
	//   revOffset = card - 1 - rank        ← 目标消息的「从新往旧」0-based 序号
	//   NodeBB start 参数（direction 模式）= revOffset
	// 不存在返回 rank: null（BFF 翻译成 404 message not found）。
	router.get('/api/v3/plugins/odysseia/chat-index/:roomId/:mid', requireInternalToken, async (req, res) => {
		try {
			const db = loadModule('./src/database');
			if (!db) return res.status(500).json({ error: 'database 模块不可用' });
			const roomId = Number(req.params.roomId);
			const mid = Number(req.params.mid);
			const exists = await db.isSortedSetMember(`chat:room:${roomId}:mids`, mid);
			if (!exists) return res.json({ rank: null, card: null, messageCount: null });
			const [rank, card, messageCount] = await Promise.all([
				db.sortedSetRank(`chat:room:${roomId}:mids`, mid),
				db.sortedSetCard(`chat:room:${roomId}:mids`),
				db.getObjectField(`chat:room:${roomId}`, 'messageCount'),
			]);
			res.json({ rank, card, messageCount: Number(messageCount) || 0 });
		} catch (err) {
			console.error('[odysseia-bridge] chat-index 查询失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});

	// 私聊消息分页取数（BFF cursor 分页的数据源）
	// 不走公共 /api/v3/chats/*/messages（该路由 count 硬编码 50、direction 模式有
	// messageCount 虚高换算坑）；直接 Messaging.getMessages：
	//   - start/count 语义 = RevRange 偏移（0=最新），返回升序数组
	//   - 非公开房间自动只返回用户加入时间之后的消息（getSortedSetRevRangeByScore +inf..join）
	// count 上限 100 与 BFF limit clamp 对齐，防内部滥用。
	router.get('/api/v3/plugins/odysseia/chat-messages/:roomId/:uid/:start/:count', requireInternalToken, async (req, res) => {
		try {
			if (!Messaging) return res.status(500).json({ error: 'messaging 模块不可用' });
			const uid = Number(req.params.uid);
			const roomId = Number(req.params.roomId);
			const start = Math.max(0, Number(req.params.start) || 0);
			const count = Math.min(100, Math.max(1, Number(req.params.count) || 50));
			const messages = await Messaging.getMessages({ callerUid: uid, uid, roomId, start, count });
			res.json({ messages: messages || [] });
		} catch (err) {
			console.error('[odysseia-bridge] chat-messages 取数失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});
}

module.exports = { mount };
