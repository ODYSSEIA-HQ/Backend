'use strict';

/**
 * ΟΔΥΣΣΕΙΑ 桥接插件主逻辑
 *
 * 职责：
 *   1. NodeBB 帖子/聊天事件 → Centrifugo 频道广播（帖内聊天室 / 私聊的实时层）
 *   2. 帖子事件 → Meilisearch 索引同步
 *   3. 内部鉴权 API（BFF 的 Centrifugo subscribe proxy 回调到这里做频道鉴权）
 *   4. 全局 /api/* 限频（IP 暴刷防护，与 BFF 双层限频互补）
 *
 * 频道命名约定：
 *   topic:{tid}    帖内聊天室（消息=楼层，聊天室语义由前端呈现）
 *   chat:{roomId}  私聊/群聊房间
 *   typing:topic:{tid} / typing:chat:{roomId}  正在输入（纯 presence，不落库）
 *   user:{uid}     用户通知（多端同步）
 *
 * 自定义纪律（架构决策 D4/D7）：只走插件 hook，不改 NodeBB 核心。
 */

const { publish } = require('./lib/centrifugo');
const search = require('./lib/search');
const internalApi = require('./lib/internal');
const decor = require('./lib/decor');
const slowmode = require('./lib/slowmode');
const reactions = require('./lib/reactions');

/** 防御式加载 NodeBB 内部模块（4.x 模块路径以 src/ 为准） */
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

const userModule = loadModule('./src/user');
const topicsModule = loadModule('./src/topics');
const categoriesModule = loadModule('./src/categories');
const privilegesModule = loadModule('./src/privileges');

const plugin = {};

// ---------- 生命周期 ----------

// ---------- 全局 API 限频（架构决策：fail-safe 内存滑动窗口） ----------
// NodeBB core 只管 postDelay，/api/* 整体裸奔。此处挂全局限频，
// 与 BFF /token 双层（IP+uid）同源——覆盖 SSR 渲染与 AJAX 之外的裸 HTTP 打面。
// 单实例内存即可（NodeBB 单进程部署）；豁免内部回调（BFF subscribe proxy 已用
// ODYSSEIA_INTERNAL_TOKEN 鉴权，不属于公网打面）。

const apiHits = new Map(); // key -> number[]

function apiRateCheck(key, windowMs, max) {
	const now = Date.now();
	const hits = (apiHits.get(key) || []).filter(t => now - t < windowMs);
	if (hits.length >= max) {
		apiHits.set(key, hits);
		return Math.max(1, hits[0] + windowMs - now);
	}
	hits.push(now);
	apiHits.set(key, hits);
	if (apiHits.size > 50000) apiHits.clear();
	return 0;
}

function apiRateLimitMiddleware(req, res, next) {
	// 内部回调豁免：BFF → /api/v3/plugins/odysseia/* 带 ODYSSEIA_INTERNAL_TOKEN，
	// 不属于公网打面（且内部 token 已鉴权，无需再限）
	if (req.path && req.path.startsWith('/api/v3/plugins/odysseia/')) return next();

	// 只限 /api 前缀——SSR 页面走 NodeBB 自有渲染路径，静态资源不经过 router
	if (!req.path || !req.path.startsWith('/api/')) return next();

	// 粒度：IP 层（暴刷）——登录用户再由下游路由/插件各自配额（postDelay 等已覆盖）
	const ip = (req.ip || (req.connection && req.connection.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
	const retryAfterMs = apiRateCheck(`api:ip:${ip}`, 10_000, 60); // 60 req/10s/IP —— 正常浏览远低于此，爬虫/脚本一击即中
	if (retryAfterMs > 0) {
		res.set({
			'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
			'X-RateLimit-Scope': 'ip',
		});
		return res.status(429).json({
			code: 'RATE_LIMITED',
			message: '请求过于频繁，请稍后再试',
			retry_after: retryAfterMs / 1000,
		});
	}
	next();
}

plugin.init = async function (params) {
	// static:app.load：挂载内部鉴权路由 + 全局 API 限频
	const { router, middleware } = params;
	router.use(apiRateLimitMiddleware);
	internalApi.mount(router, middleware);
	console.log('[odysseia-bridge] 已挂载内部鉴权 API (/api/v3/plugins/odysseia/*) + 全局 API 限频');
};

// ---------- Slowmode：category 级 per-user 发帖冷却 ----------

/** filter:topic.post：新主题（tid 尚未生成，但 cid 已确定） */
plugin.onTopicPost = async function (data) {
	if (!data || !data.cid || !data.uid) return data;
	const result = await slowmode.checkSlowmode(Number(data.uid), Number(data.cid));
	if (!result.allowed) throw slowmode.slowmodeError(result.retryAfterMs);
	return data;
};

/** filter:topic.reply：回帖（tid 已存在，取 cid 后校验） */
plugin.onTopicReply = async function (data) {
	if (!data || !data.tid || !data.uid) return data;
	const tid = Number(data.tid);
	// tid → cid：NodeBB 4 的 topics 模块有 getTopicField，防御式降级
	let cid = 0;
	if (topicsModule && typeof topicsModule.getTopicField === 'function') {
		try {
			cid = await topicsModule.getTopicField(tid, 'cid');
		} catch (e) { /* 取不到 cid 时放行，不阻断 */ }
	}
	if (cid) {
		const result = await slowmode.checkSlowmode(Number(data.uid), Number(cid));
		if (!result.allowed) throw slowmode.slowmodeError(result.retryAfterMs);
	}
	return data;
};

// ---------- Reactions：表情反应 ----------

/** static:privileges.categories.init：注册 posts:react 权限 */
plugin.onPrivilegesInit = async function (data) {
	if (data && data.privileges) {
		reactions.registerPrivilege(data.privileges);
	}
};

/** filter:topic.getPosts：读路径最终注入点——批量注入 reactions 聚合 */
plugin.onTopicGetPosts = async function (data) {
	if (!data || !Array.isArray(data.posts) || !data.posts.length) return data;
	try {
		const pids = data.posts.map(p => p && p.pid).filter(Boolean);
		const uid = data.uid || 0;
		const reactionsMap = await reactions.getReactionsForPosts(pids, uid);
		data.posts.forEach(p => {
			if (p && p.pid && reactionsMap[p.pid]) {
				p.reactions = reactionsMap[p.pid];
			}
		});
	} catch (e) {
		console.error('[odysseia-reactions] 注入失败', e.message); // 不阻断楼层渲染
	}
	return data;
};

/** filter:messaging.getMessages：私聊消息读路径注入 reactions */
plugin.onMessagingGetMessages = async function (data) {
	if (!data || !Array.isArray(data.messages) || !data.messages.length) return data;
	try {
		const pids = data.messages.map(m => m && (m.messageId || m.mid)).filter(Boolean);
		const uid = data.uid || 0;
		const reactionsMap = await reactions.getReactionsForPosts(pids, uid);
		data.messages.forEach(m => {
			const pid = m && (m.messageId || m.mid);
			if (pid && reactionsMap[pid]) {
				m.reactions = reactionsMap[pid];
			}
		});
	} catch (e) {
		console.error('[odysseia-reactions] 私聊注入失败', e.message);
	}
	return data;
};

// ---------- 帖子事件 → 聊天室广播 + 搜索索引 ----------

/** 索引前补齐主帖元数据：title 存 topic hash（post hash 没有），isMain 只有
 *  action:post.save 的 payload 自带（src/posts/create.js:83 实证）；
 *  edit / restore 从库取的 post 无标记，对拍 mainPid 判定。
 *  isMain === false（明确回复）短路，热路径零额外查询 */
async function withTopicMeta(post) {
	if (!post || !post.tid) return post;
	if (post.isMain === false) return post;
	if (post.isMain === true) {
		if (!post.title && topicsModule && typeof topicsModule.getTopicField === 'function') {
			try {
				post.title = await topicsModule.getTopicField(post.tid, 'title') || '';
			} catch (e) {
				/* 取不到标题按无标题索引（titles 搜索不命中，正文不受影响） */
			}
		}
		return post;
	}
	// isMain 未知：一次 getTopicFields 对拍（edit / restore 路径，频率远低于发帖）
	if (topicsModule && typeof topicsModule.getTopicFields === 'function' && post.pid) {
		try {
			const { mainPid, title } = await topicsModule.getTopicFields(post.tid, ['mainPid', 'title']);
			if (mainPid && Number(mainPid) === Number(post.pid)) {
				post.isMain = true;
				if (title) post.title = title;
			}
		} catch (e) {
			/* 判定失败按普通帖索引 */
		}
	}
	return post;
}

/** action:post.save：新消息（新楼层）。payload = { post, uid }（v4.x 源码 src/posts/create.js 实证） */
plugin.onPostSave = async function (params) {
	const postData = params && params.post;
	if (!postData || !postData.tid) return;
	// 聊天流呈现需要展示身份：附带 username/picture，前端缓存 uid→身份，免逐消息查 API
	let who = {};
	if (userModule && postData.uid) {
		try {
			const fields = await userModule.getUserFields(postData.uid, ['username', 'picture']);
			who = (Array.isArray(fields) ? fields[0] : fields) || {};
		} catch (e) {
			/* 身份补齐失败不影响广播主体 */
		}
	}
	// 身分组装饰实时同步：新消息气泡立刻带 pill/用户名特效（前端同时缓存 uid→decor 兜底离线补发）
	let decorData = null;
	if (postData.uid) {
		try {
			decorData = await decor.decorateOne(postData.uid);
		} catch (e) {
			/* 装饰失败降级为无 pill，不阻断广播 */
		}
	}
	await publish(`topic:${postData.tid}`, {
		type: 'message.new',
		message: {
			pid: postData.pid,
			tid: postData.tid,
			uid: postData.uid,
			username: who.username,
			picture: who.picture,
			decor: decorData,
			content: postData.content,
			timestamp: postData.timestamp,
			index: postData.index, // 楼层号，前端 "#1234" 定位用
		},
	});
	search.indexPost(await withTopicMeta(postData));
};

/** action:post.edit。payload = { post, ... }（src/posts/edit.js 实证） */
plugin.onPostEdit = async function (params) {
	const postData = params && params.post;
	if (!postData || !postData.tid) return;
	await publish(`topic:${postData.tid}`, {
		type: 'message.edit',
		message: {
			pid: postData.pid,
			tid: postData.tid,
			uid: postData.uid,
			content: postData.content,
			timestamp: postData.edited || postData.timestamp,
		},
	});
	// 编辑回帖不带 title：toDoc 的 merge 语义保留主帖已索引标题；编辑主帖则刷新
	search.indexPost(await withTopicMeta(postData));
};

/** action:post.delete / restore。payload = { post, uid }（src/posts/delete.js 实证） */
plugin.onPostDelete = async function (params) {
	const postData = params && params.post;
	if (!postData || !postData.tid) return;
	await publish(`topic:${postData.tid}`, { type: 'message.delete', pid: postData.pid });
	// 软删同步摘索引：否则 R18 帖全文残留 Meili 可被无权者搜到（onPostsPurge 同款范式）
	search.deletePost(postData.pid);
};

plugin.onPostRestore = async function (params) {
	const postData = params && params.post;
	if (!postData || !postData.tid) return;
	await publish(`topic:${postData.tid}`, { type: 'message.restore', pid: postData.pid });
	// 恢复后回索引（含主帖 title / isMain 回填——软删时文档已摘除，须全量重建该帖文档）
	search.indexPost(await withTopicMeta(postData));
};

/** action:posts.purge（注意复数，v4.x 真名）。payload = { posts: [...], uid }（src/posts/delete.js 实证） */
plugin.onPostsPurge = async function (params) {
	const posts = (params && params.posts) || [];
	for (const postData of posts) {
		if (!postData || !postData.pid) continue;
		if (postData.tid) {
			await publish(`topic:${postData.tid}`, { type: 'message.purge', pid: postData.pid });
		}
		search.deletePost(postData.pid);
	}
};

/** action:topics.purge（复数，v4.9.0+ 新名）。payload = { topics: [...], uid }（src/topics/delete.js 实证）
 *  索引不用在这里清：purgePostsAndTopic 会先逐帖 fire action:posts.purge，onPostsPurge 已删索引 */
plugin.onTopicsPurge = async function (params) {
	const topics = (params && params.topics) || [];
	for (const topicData of topics) {
		if (!topicData || !topicData.tid) continue;
		await publish(`topic:${topicData.tid}`, { type: 'topic.purge', tid: topicData.tid });
	}
};

/** action:topic.delete / restore。payload = { topic: topicData, uid }（src/topics/tools.js:58/60 实证，
 *  topic 含 tid / cid / mainPid / title）——软删/恢复整帖同步索引，堵「软删帖全文残留
 *  Meili 可被无权者搜到」与「恢复后搜不到」两个缺口 */
plugin.onTopicDelete = async function (params) {
	const topicData = params && params.topic;
	if (!topicData || !topicData.tid) return;
	await publish(`topic:${topicData.tid}`, { type: 'topic.delete', tid: topicData.tid });
	// Meili 按 tid filter 批删（软删不动 tid:{tid}:posts，不能依赖 zset）
	search.deleteTopic(topicData.tid);
};

plugin.onTopicRestore = async function (params) {
	const topicData = params && params.topic;
	if (!topicData || !topicData.tid) return;
	await publish(`topic:${topicData.tid}`, { type: 'topic.restore', tid: topicData.tid });
	// 回索引：zset tid:{tid}:posts 当前恰为活跃帖集合（单帖软删已移出）
	search.reindexTopic(topicData.tid, topicData);
};

/** action:topic.edit。payload = { topic: newTopicData, uid }（src/posts/edit.js:179 实证，
 *  newTopicData.oldTitle 为旧标题）——标题存 topic hash，改名须重刷主帖索引文档，
 *  否则 titles 搜索命中旧标题 */
plugin.onTopicEdit = function (params) {
	const topicData = params && params.topic;
	if (!topicData || !topicData.tid || !topicData.mainPid) return;
	if (topicData.title && topicData.title !== topicData.oldTitle) {
		search.reindexMainPost(topicData);
	}
};

// ---------- 搜索：filter:search.query → Meilisearch（权限过滤在先，vendor 二次兜底在后） ----------

/** filter:search.query。payload = { index: 'post'|'topic', content, matchWords, cid, uid, searchData, ids }（src/search.js 实证）
 *  权限模型（双防线）：Meili 侧按搜索者可读 cid 集过滤（第一道，防元数据泄露 /
 *  减 vendor 全量过滤负担），vendor 拿到 ids 后还有 privileges.posts.filter('topics:read') 兜底 */
plugin.onSearchQuery = async function (payload) {
	if (!payload || !payload.searchData) return payload;
	try {
		const uid = Number(payload.searchData.uid) || 0;
		const allowedCids = await readableCids(uid);
		payload.ids = (await search.searchQuery(payload, allowedCids)).ids;
	} catch (e) {
		console.error('[odysseia-bridge] meili 搜索失败', e.message);
		payload.ids = []; // fail-closed：引擎故障时宁可搜不到，不回退无过滤查询
	}
	return payload; // filter hook 契约：原样放行
};

/** uid → 可读板块集（read 权限 + 非 disabled；R18/R18G 对无权者自然出局） */
async function readableCids(uid) {
	if (!categoriesModule || !privilegesModule) return [];
	try {
		const allCids = await categoriesModule.getAllCidsFromSet('categories:cid');
		return await privilegesModule.categories.filterCids('read', allCids, uid);
	} catch (e) {
		return []; // 查询失败按零可读处理（fail-closed）
	}
}

// ---------- 私聊事件 → chat 频道广播 ----------
// filter:messaging.notify（v4.x 唯一形态，无 action 版；src/messaging/notifications.js 实证）
// payload = { roomId, fromUid, message: messageObj, public }
// 纪律：filter hook 必须 return data——返回 falsy 会掐断 NodeBB 原生通知流
plugin.onChatNotify = async function (data) {
	const roomId = data && data.roomId;
	const msg = (data && data.message) || {};
	if (roomId) {
		// fire-and-forget：publish 内部全 catch 绝不 reject。
		// 这里是 vendor await 串行的 filter 链，若 await，Centrifugo 宕机时
		// 每次 OCC 超时都会把整条通知流拖满超时
		publish(`chat:${roomId}`, {
			type: 'chat.new',
			message: {
				pid: msg.messageId || msg.mid,
				roomId,
				uid: msg.fromuid || msg.fromUid || (data && data.fromUid),
				content: msg.content,
				timestamp: msg.timestamp,
			},
		});
		// 发送者多端同步（user 频道）；接收方通知由前端订阅自己的 chat 频道实现
		const fromUid = msg.fromuid || msg.fromUid || (data && data.fromUid);
		if (fromUid) {
			publish(`user:${fromUid}`, {
				type: 'chat.sent',
				roomId,
				messageId: msg.messageId || msg.mid,
			});
		}
	}
	return data; // filter hook 契约：原样放行
};

// ---------- 身分组装饰接线（引擎 = lib/decor.js，纯库零 hook） ----------
// 解耦点：本文件只做「hook payload ↔ 引擎调用」的转发；装饰规则/消毒/缓存/批量查询
// 全部收敛在 lib/decor.js，与 NodeBB hook 体系互不感知（可独立单测、可整体卸除）

/** filter:posts.getUserInfoForPosts。payload = { users: [...] }（src/posts/user.js 实证）
 *  楼层 / 回 replies / 用户帖子页共用此路径：一次批量查询注入全页 user.odyDecor，
 *  查询次数 = 规则组数（与楼层人数无关，性能护栏） */
plugin.onUserInfoForPosts = async function (data) {
	if (!data || !Array.isArray(data.users) || !data.users.length) return data;
	try {
		const decorMap = await decor.decorateUsers(data.users.map(u => u && u.uid));
		data.users.forEach(u => {
			if (u && decorMap[u.uid]) u.odyDecor = decorMap[u.uid];
		});
	} catch (e) {
		console.error('[odysseia-decor] 楼层装饰注入失败', e.message); // 装饰失败不阻断楼层渲染
	}
	return data;
};

/** filter:helpers.getUserDataByUserSlug。payload = { userData, callerUID, query }（src/controllers/accounts/helpers.js 实证）
 *  profile 页注入 userData.odyDecor——与楼层同源同构，保证「同一用户处处同款」 */
plugin.onUserProfile = async function (data) {
	if (!data || !data.userData || !data.userData.uid) return data;
	try {
		const decorData = await decor.decorateOne(data.userData.uid);
		if (decorData) data.userData.odyDecor = decorData;
	} catch (e) {
		console.error('[odysseia-decor] profile 装饰注入失败', e.message);
	}
	return data;
};

/** 缓存失效通道①：组元数据（labelColor / icon / userTitle）变更 → 组快照重取 */
plugin.onGroupUpdate = function () {
	decor.invalidate();
};

/** 组改名 → 旧 groupName 规则自然失配（组不存在即不命中），失效后快照即自愈 */
plugin.onGroupRename = function () {
	decor.invalidate();
};

/** 缓存失效通道②：action:settings.set。payload = { plugin, settings, quiet }（src/meta/settings.js 实证）
 *  仅本插件配置变更时失效，避免无关插件保存触发重查询风暴 */
plugin.onSettingsSet = function (data) {
	if (data && data.plugin === 'odysseia-decor') {
		decor.invalidate();
	}
};

/** filter:admin.header.build。payload = { plugins: [], authentication: [] }（src/middleware/render.js 实证） */
plugin.onAdminHeader = function (data) {
	if (data && Array.isArray(data.plugins)) {
		data.plugins.push({
			route: '/plugins/odysseia-decor',
			icon: 'fa-paint-brush',
			name: 'ΟΔΥΣΣΕΙΑ 装饰',
		});
	}
	return data;
};

module.exports = plugin;
