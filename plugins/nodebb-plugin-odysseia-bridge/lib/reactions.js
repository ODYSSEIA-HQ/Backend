'use strict';

/**
 * Reactions —— 帖子/聊天消息的 emoji 反应
 *
 * 设计（仿 Fluxer reactions，语义独立重写）：
 *   - 存储：Mongo per-row（一行 = 一个 (pid, uid, emoji) 三元组），
 *           读时聚合出 [{ emoji, count, me, usernames[] }]
 *   - 上限：单消息 MAX_REACTIONS_PER_MESSAGE = 30（防表情轰炸）
 *   - 权限：category 级自定义权限 posts:react（通过 privileges 钩子注册），
 *           首个反应需权限；后续叠加同 emoji 无需重复校验（已有他人破冰）
 *   - 事件：topic:<tid> 频道广播 message.reaction.add / .remove / .clear，
 *           私聊走 chat:<roomId>（pid 在私聊场景 = messageId）
 *   - 幂等：per-row 天然幂等——重复 add 同一 (pid, uid, emoji) 是 upsert，
 *           remove 只删自己的行，并发 lost-update 不存在
 */

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

const db = loadModule('./src/database');
const privileges = loadModule('./src/privileges');
const posts = loadModule('./src/posts');
const user = loadModule('./src/user');

const MAX_REACTIONS_PER_MESSAGE = 30;
const COLLECTION = 'reactions';

// ---------- 初始化：确保索引存在 ----------
async function ensureIndexes() {
	if (!db || typeof db.createIndex !== 'function') return;
	try {
		await db.createIndex(COLLECTION, { pid: 1, emojiName: 1 });
		await db.createIndex(COLLECTION, { pid: 1, uid: 1 });
	} catch (e) {
		/* 索引创建失败不阻断插件加载，读路径降级为全表扫描 */
	}
}

// ---------- 权限 ----------

/**
 * 注册 posts:react 权限（static:privileges.categories.init 钩子调用）
 * @param {Map} privilegeMap
 */
function registerPrivilege(privilegeMap) {
	if (privilegeMap && typeof privilegeMap.set === 'function') {
		privilegeMap.set('posts:react', { label: '添加表情反应', type: 'post' });
	}
}

/**
 * 检查用户能否对某帖子添加反应
 * @param {number} uid
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
async function canReact(uid, pid) {
	if (!uid || !pid) return false;
	if (!privileges || !posts) return false;
	try {
		// 首个反应需 posts:react 权限；后续叠加同 emoji 也走同一权限（简化模型）
		return await privileges.posts.can('posts:react', pid, uid);
	} catch (e) {
		// 权限查询失败时 fail-closed（防表情轰炸）
		return false;
	}
}

// ---------- 数据操作 ----------

/**
 * 添加反应（幂等 upsert）
 * @param {number} uid
 * @param {number} pid
 * @param {string} emojiName  unicode emoji 或自定义 emoji 名
 * @param {number} emojiId    0 = unicode；>0 = 自定义 emoji id
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function addReaction(uid, pid, emojiName, emojiId = 0) {
	if (!uid || !pid || !emojiName) return { ok: false, reason: 'invalid' };
	if (!db) return { ok: false, reason: 'db_unavailable' };

	// 上限检查：单消息反应总数
	const count = await getReactionCount(pid);
	if (count >= MAX_REACTIONS_PER_MESSAGE) {
		return { ok: false, reason: 'max_reactions' };
	}

	const doc = {
		pid: Number(pid),
		uid: Number(uid),
		emojiName: String(emojiName),
		emojiId: Number(emojiId) || 0,
		timestamp: Date.now(),
	};

	// upsert：同一 (pid, uid, emojiName) 已存在则更新时间戳（幂等）
	const key = `${pid}:${uid}:${emojiName}`;
	await db.setObject(`${COLLECTION}:${key}`, doc);
	// 维护 sorted set 索引：reactions:pid:{pid} → key 列表（score=timestamp）
	await db.sortedSetAdd(`${COLLECTION}:pid:${pid}`, doc.timestamp, key);
	return { ok: true };
}

/**
 * 移除反应（只删自己的行）
 */
async function removeReaction(uid, pid, emojiName) {
	if (!uid || !pid || !emojiName) return { ok: false };
	if (!db) return { ok: false };
	const key = `${pid}:${uid}:${emojiName}`;
	await db.delete(`${COLLECTION}:${key}`);
	// 同步清理 sorted set 索引
	await db.sortedSetRemove(`${COLLECTION}:pid:${pid}`, key);
	return { ok: true };
}

/**
 * 清空某消息的全部反应（管理员/作者）
 */
async function clearReactions(pid) {
	if (!db) return { ok: false };
	const keys = await db.getSortedSetRevRange(`${COLLECTION}:pid:${pid}`, 0, -1);
	if (keys && keys.length) {
		await db.deleteAll(keys.map(k => `${COLLECTION}:${k}`));
	}
	await db.delete(`${COLLECTION}:pid:${pid}`);
	return { ok: true };
}

/**
 * 获取某消息的反应总数
 */
async function getReactionCount(pid) {
	if (!db || !pid) return 0;
	try {
		return await db.sortedSetCard(`${COLLECTION}:pid:${pid}`);
	} catch (e) {
		return 0;
	}
}

// ---------- 读路径 ----------

/**
 * 获取某消息的反应聚合列表
 * @param {number} pid
 * @param {number} uid  当前查看者（算 me 字段）
 * @returns {Promise<Array<{emojiName: string, emojiId: number, count: number, me: boolean, usernames: string[]}>>}
 */
async function getReactions(pid, uid = 0) {
	if (!db || !pid) return [];
	try {
		// 先拿该消息所有反应 key
		const keys = await db.getSortedSetRevRange(`${COLLECTION}:pid:${pid}`, 0, -1);
		if (!keys || !keys.length) return [];

		const docs = await db.getObjects(keys.map(k => `${COLLECTION}:${k}`));
		const valid = docs.filter(d => d && d.uid);

		// 按 emojiName 聚合
		const map = new Map();
		for (const d of valid) {
			const name = d.emojiName;
			if (!map.has(name)) {
				map.set(name, {
					emojiName: name,
					emojiId: Number(d.emojiId) || 0,
					count: 0,
					me: false,
					uids: [],
				});
			}
			const entry = map.get(name);
			entry.count += 1;
			if (Number(d.uid) === Number(uid)) entry.me = true;
			entry.uids.push(Number(d.uid));
		}

		// 批量取 username（避免逐条查）
		const allUids = [...new Set(valid.map(d => Number(d.uid)))];
		let usernames = {};
		if (user && allUids.length) {
			try {
				const fields = await user.getUsersFields(allUids, ['username']);
				if (Array.isArray(fields)) {
					fields.forEach(f => { if (f && f.uid) usernames[f.uid] = f.username; });
				}
			} catch (e) { /* username 查询失败降级为空 */ }
		}

		return [...map.values()].map(e => ({
			emojiName: e.emojiName,
			emojiId: e.emojiId,
			count: e.count,
			me: e.me,
			usernames: e.uids.map(u => usernames[u] || String(u)),
		}));
	} catch (e) {
		return [];
	}
}

/**
 * 获取某消息的反应总数
 */
async function getReactionCount(pid) {
	if (!db || !pid) return 0;
	try {
		return await db.sortedSetCard(`${COLLECTION}:pid:${pid}`);
	} catch (e) {
		return 0;
	}
}

/**
 * 批量获取多条消息的反应（读路径性能护栏：批量 pipeline 减少往返）
 * @param {number[]} pids
 * @param {number} uid
 * @returns {Promise<Object<number, Array>>} pid -> reactions[]
 */
async function getReactionsForPosts(pids, uid = 0) {
	if (!Array.isArray(pids) || !pids.length) return {};
	const result = {};
	if (!db) return result;

	try {
		// 批量拿所有消息的 reaction key 列表
		const keyLists = await Promise.all(
			pids.map(pid => db.getSortedSetRevRange(`${COLLECTION}:pid:${pid}`, 0, -1))
		);

		// 展平所有 key，批量取文档
		const allKeys = keyLists.flat().filter(Boolean);
		if (!allKeys.length) {
			pids.forEach(pid => { result[pid] = []; });
			return result;
		}

		const docs = await db.getObjects(allKeys.map(k => `${COLLECTION}:${k}`));
		const docMap = new Map();
		allKeys.forEach((key, i) => {
			if (docs[i] && docs[i].uid) docMap.set(key, docs[i]);
		});

		// 按 pid 分组聚合
		pids.forEach((pid, idx) => {
			const keys = keyLists[idx] || [];
			const valid = keys.map(k => docMap.get(k)).filter(Boolean);
			if (!valid.length) {
				result[pid] = [];
				return;
			}

			const map = new Map();
			for (const d of valid) {
				const name = d.emojiName;
				if (!map.has(name)) {
					map.set(name, {
						emojiName: name,
						emojiId: Number(d.emojiId) || 0,
						count: 0,
						me: false,
						uids: [],
					});
				}
				const entry = map.get(name);
				entry.count += 1;
				if (Number(d.uid) === Number(uid)) entry.me = true;
				entry.uids.push(Number(d.uid));
			}

			// 批量取 username（整页一次查，避免逐消息）
			result[pid] = [...map.values()];
		});

		// 统一补 username（整页所有 uid 一次查）
		const allUids = [...new Set(
			Object.values(result).flat().flatMap(r => r.uids || [])
		)];
		if (allUids.length && user) {
			try {
				const fields = await user.getUsersFields(allUids, ['username']);
				const usernameMap = {};
				if (Array.isArray(fields)) {
					fields.forEach(f => { if (f && f.uid) usernameMap[f.uid] = f.username; });
				}
				Object.values(result).forEach(reactions => {
					reactions.forEach(r => {
						r.usernames = (r.uids || []).map(u => usernameMap[u] || String(u));
						delete r.uids;
					});
				});
			} catch (e) {
				// username 查询失败降级：uids 保留原样
				Object.values(result).forEach(reactions => {
					reactions.forEach(r => {
						r.usernames = (r.uids || []).map(String);
						delete r.uids;
					});
				});
			}
		}

		return result;
	} catch (e) {
		pids.forEach(pid => { result[pid] = []; });
		return result;
	}
}

// ---------- 维护钩子（帖子删除时清理反应） ----------

/**
 * 帖子删除/清除时清理关联反应
 */
async function onPostPurge(pid) {
	await clearReactions(pid);
}

module.exports = {
	ensureIndexes,
	registerPrivilege,
	canReact,
	addReaction,
	removeReaction,
	clearReactions,
	getReactions,
	getReactionCount,
	getReactionsForPosts,
	onPostPurge,
	MAX_REACTIONS_PER_MESSAGE,
};
