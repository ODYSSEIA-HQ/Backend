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

// 冷却键条目保留期：超出即被清理（须 >= 管理员可设的最大冷却秒数）
const COOLDOWN_RETENTION_MS = 30 * 24 * 3600 * 1000;

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
 * 检查用户是否受 slowmode 限制（通过即占位，fail-closed）
 *
 * 存储：zset `slowmode:category:{cid}`，member = uid，score = 上次放行时刻。
 * 不扫 posts/topics 集合——旧实现倒序扫各 50 条找 uid 有盲区（活跃板块
 * 上一次发帖跌出窗口即漏判），且软删帖移出 cid:{cid}:pids 后等同"没发过"
 * （删帖刷冷却）。冷却键与帖子存废解耦，一次 zscore 直查。
 *
 * 占位发生在校验时刻而非帖子落库后：NodeBB db 抽象层无 setNX 原语，
 * zscore→zadd 之间理论上有毫秒级 TOCTOU 窗口；本模块语义是防连点，
 * 不是安全边界（那是 BFF 限频的职责），可接受。
 *
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

	if (!db) return { allowed: true };
	const key = `slowmode:category:${Number(cid)}`;
	const member = String(Number(uid));
	const now = Date.now();
	const cooldownMs = seconds * 1000;

	// O(1) 直查该用户冷却键
	const lastAllowedAt = await db.sortedSetScore(key, member);
	if (lastAllowedAt && now - Number(lastAllowedAt) < cooldownMs) {
		return {
			allowed: false,
			retryAfterMs: cooldownMs - (now - Number(lastAllowedAt)),
		};
	}

	// 通过即占位；顺手清过期条目防 zset 无界膨胀（score 传字符串数字，
	// 与 mongo/redis 后端 parseFloat 兼容，同 quiz.js 范式）
	await db.sortedSetAdd(key, now, member);
	await db.sortedSetsRemoveRangeByScore([key], '-inf', String(now - COOLDOWN_RETENTION_MS));
	return { allowed: true };
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
