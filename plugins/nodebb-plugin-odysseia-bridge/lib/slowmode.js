'use strict';

/**
 * Slowmode —— category 级 per-user 发帖冷却
 *
 * 设计（仿 Fluxer slowmode，语义独立重写）：
 *   - 配置：category.slowmodeSeconds（0 = 关闭，>0 = per-user per-category 冷却秒数）
 *   - 校验：filter:topic.reply / filter:topic.post 钩子内查最近发帖时间，
 *           冷却未过则 throw Error，错误信息带 retryAfterMs 供前端倒计时
 *   - 粒度：category 级（topic 继承 category，chat 场景由前端输入框节流兜底，
 *           服务端私聊消息量远小于楼层，不额外加锁）
 *   - 豁免：moderate 权限以上（管理员/版主）不受限——活动帖运营需要
 *   - 存储：NodeBB 自带 postDelay 是全局级，本模块是 category 级补充，
 *           两者并存（全局 postDelay 兜底，category slowmode 精细）
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
const categories = loadModule('./src/categories');
const privileges = loadModule('./src/privileges');
const user = loadModule('./src/user');

const SLOWMODE_FIELD = 'slowmodeSeconds';

/**
 * 读取 category 的 slowmode 配置（秒）
 * @param {number} cid
 * @returns {Promise<number>} 0 = 关闭
 */
async function getSlowmodeSeconds(cid) {
	if (!categories || !cid) return 0;
	try {
		const val = await categories.getCategoryField(cid, SLOWMODE_FIELD);
		const seconds = Number(val);
		return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	} catch (e) {
		return 0;
	}
}

/**
 * 写入 category 的 slowmode 配置
 * @param {number} cid
 * @param {number} seconds
 */
async function setSlowmodeSeconds(cid, seconds) {
	if (!db || !cid) return;
	const val = Math.max(0, Math.floor(Number(seconds) || 0));
	await db.setObjectField(`category:${cid}`, SLOWMODE_FIELD, val);
}

/**
 * 检查用户是否受 slowmode 限制
 * @param {number} uid
 * @param {number} cid
 * @returns {Promise<{allowed: boolean, retryAfterMs?: number}>}
 */
async function checkSlowmode(uid, cid) {
	if (!uid || !cid) return { allowed: true };

	const seconds = await getSlowmodeSeconds(cid);
	if (!seconds) return { allowed: true };

	// 管理员/版主豁免（moderate 权限）
	try {
		const isMod = await privileges.categories.can('moderate', cid, uid);
		if (isMod) return { allowed: true };
	} catch (e) {
		/* 权限查询失败时保守放行，不阻断正常用户 */
	}

	// 查该用户在本 category 的最近发帖时间
	if (!db) return { allowed: true };
	const lastPostTime = await getLastPostTimeInCategory(uid, cid);
	if (!lastPostTime) return { allowed: true };

	const now = Date.now();
	const cooldownMs = seconds * 1000;
	const elapsed = now - lastPostTime;
	if (elapsed >= cooldownMs) return { allowed: true };

	return {
		allowed: false,
		retryAfterMs: cooldownMs - elapsed,
	};
}

/**
 * 查询用户在某 category 的最近发帖时间
 * 策略：从 cid:{cid}:tids 和 cid:{cid}:pids 倒序扫，找到 uid 匹配的第一条。
 * 比查 uid:{uid}:topics/posts 再过滤 cid 更准（不会漏判跨 category 发帖）。
 * @param {number} uid
 * @param {number} cid
 * @returns {Promise<number>} 0 = 无记录
 */
async function getLastPostTimeInCategory(uid, cid) {
	if (!db) return 0;
	try {
		const targetUid = Number(uid);
		const targetCid = Number(cid);

		// 扫 topic：cid:{cid}:tids 按 timestamp 倒序，逐条查 uid
		const recentTids = await db.getSortedSetRevRange(`cid:${targetCid}:tids`, 0, 50);
		if (recentTids && recentTids.length) {
			const topicDocs = await db.getObjects(
				recentTids.map(tid => `topic:${tid}`),
				['uid', 'timestamp']
			);
			for (const t of topicDocs) {
				if (t && Number(t.uid) === targetUid) {
					return Number(t.timestamp) || 0;
				}
			}
		}

		// 扫 post：cid:{cid}:pids 按 timestamp 倒序，逐条查 uid
		const recentPids = await db.getSortedSetRevRange(`cid:${targetCid}:pids`, 0, 50);
		if (recentPids && recentPids.length) {
			const postDocs = await db.getObjects(
				recentPids.map(pid => `post:${pid}`),
				['uid', 'timestamp']
			);
			for (const p of postDocs) {
				if (p && Number(p.uid) === targetUid) {
					return Number(p.timestamp) || 0;
				}
			}
		}

		return 0;
	} catch (e) {
		return 0;
	}
}

/**
 * 生成 slowmode 错误对象（供 filter 钩子 throw）
 * @param {number} retryAfterMs
 * @returns {any} Error 实例，附 code/retryAfterMs 附加属性
 */
function slowmodeError(retryAfterMs) {
	const seconds = Math.ceil(retryAfterMs / 1000);
	/** @type {any} */
	const err = new Error(`发帖过于频繁，请 ${seconds} 秒后再试`);
	err.code = 'SLOWMODE_RATE_LIMITED';
	err.retryAfterMs = retryAfterMs;
	return err;
}

module.exports = {
	getSlowmodeSeconds,
	setSlowmodeSeconds,
	checkSlowmode,
	slowmodeError,
	SLOWMODE_FIELD,
};
