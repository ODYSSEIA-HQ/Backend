'use strict';

/**
 * ΟΔΥΣΣΕΙΑ 桥接插件主逻辑
 *
 * 职责：
 *   1. NodeBB 帖子/聊天事件 → Centrifugo 频道广播（帖内聊天室 / 私聊的实时层）
 *   2. 帖子事件 → Meilisearch 索引同步
 *   3. 内部鉴权 API（BFF 的 Centrifugo subscribe proxy 回调到这里做频道鉴权）
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

const plugin = {};

// ---------- 生命周期 ----------

plugin.init = async function (params) {
	// static:app.load：挂载内部鉴权路由
	const { router, middleware } = params;
	internalApi.mount(router, middleware);
	console.log('[odysseia-bridge] 已挂载内部鉴权 API (/api/v3/plugins/odysseia/*)');
};

// ---------- 帖子事件 → 聊天室广播 + 搜索索引 ----------

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
	search.indexPost(postData);
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
	search.indexPost(postData);
};

/** action:post.delete / restore。payload = { post, uid }（src/posts/delete.js 实证） */
plugin.onPostDelete = async function (params) {
	const postData = params && params.post;
	if (!postData || !postData.tid) return;
	await publish(`topic:${postData.tid}`, { type: 'message.delete', pid: postData.pid });
};

plugin.onPostRestore = async function (params) {
	const postData = params && params.post;
	if (!postData || !postData.tid) return;
	await publish(`topic:${postData.tid}`, { type: 'message.restore', pid: postData.pid });
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

// ---------- 私聊事件 → chat 频道广播 ----------
// filter:messaging.notify（v4.x 唯一形态，无 action 版；src/messaging/notifications.js 实证）
// payload = { roomId, fromUid, message: messageObj, public }
// 纪律：filter hook 必须 return data——返回 falsy 会掐断 NodeBB 原生通知流
plugin.onChatNotify = async function (data) {
	const roomId = data && data.roomId;
	const msg = (data && data.message) || {};
	if (roomId) {
		await publish(`chat:${roomId}`, {
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
			await publish(`user:${fromUid}`, {
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
