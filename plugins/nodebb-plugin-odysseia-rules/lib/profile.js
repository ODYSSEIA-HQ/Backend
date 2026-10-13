'use strict';

/**
 * 用户档案内部 API —— 120h 新人缓冲区 / 身份组等级查询
 *
 * 用途（架构决策 D6）：
 *   - BFF 在聚合消息流 / 前端展示"新人"标识时调用，判断用户是否仍在缓冲区内
 *   - NodeBB 侧真正的缓冲区限权由"新人均在 odysseia-newcomer 组 + category 组权限"实现，
 *     这里只提供元信息（剩余时长、等级、发帖数），不做权限判断
 *
 * 全部路由要求 header: X-Internal-Token
 */

const crypto = require('crypto');

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
const Groups = loadModule('./src/groups');

const INTERNAL_TOKEN = process.env.ODYSSEIA_INTERNAL_TOKEN || '';

function requireInternalToken(req, res, next) {
	// 等长比较防时序侧信道；token 未配置时 fail-closed
	const given = Buffer.from(String(req.headers['x-internal-token'] || ''));
	const expect = Buffer.from(INTERNAL_TOKEN);
	if (!expect.length || given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) {
		return res.status(403).json({ error: 'forbidden' });
	}
	next();
}

// ---------- 档案计算 ----------

async function computeProfile(uid, bufferHours) {
	if (!db) throw new Error('database 模块不可用');

	const key = `user:${uid}`;
	const [joindate, postcount] = await Promise.all([
		db.getObjectField(key, 'joindate'),
		db.getObjectField(key, 'postcount'),
	]);

	const joinMs = Number(joindate) || 0;
	const bufferMs = Number(bufferHours) * 3600 * 1000;
	const remainingMs = Math.max(0, joinMs + bufferMs - Date.now());

	// 用户所在身份组（getUserGroups 接受 uid 数组，返回嵌套数组）
	let groups = [];
	if (Groups) {
		const nested = await Groups.getUserGroups([uid]);
		const list = Array.isArray(nested) ? (nested[0] || nested) : [];
		groups = (Array.isArray(list) ? list : []).map(g => g && g.name).filter(Boolean);
	}

	return {
		uid: Number(uid),
		joindate: joinMs,
		postCount: Number(postcount) || 0,
		bufferHours: Number(bufferHours),
		inBuffer: remainingMs > 0,
		bufferRemainingMs: remainingMs,
		groups,
	};
}

// ---------- 路由 ----------

function mount(router, getSettings) {
	// 查询用户档案（缓冲区状态 + 身份组 + 发帖数）
	router.get('/api/v3/plugins/odysseia/profile/:uid', requireInternalToken, async (req, res) => {
		try {
			const uid = Number(req.params.uid);
			if (!(uid > 0)) return res.status(400).json({ error: 'invalid uid' });

			const settings = await getSettings();
			res.json(await computeProfile(uid, settings.bufferHours));
		} catch (err) {
			console.error('[odysseia-rules] profile 查询失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});

	// 批量查询（BFF 聚合在线用户列表用）：?uids=1,2,3
	router.get('/api/v3/plugins/odysseia/profiles', requireInternalToken, async (req, res) => {
		try {
			const uids = String(req.query.uids || '')
				.split(',')
				.map(Number)
				.filter(u => u > 0)
				.slice(0, 200); // 单次上限，防拉爆

			const settings = await getSettings();
			const profiles = await Promise.all(
				uids.map(uid => computeProfile(uid, settings.bufferHours).catch(() => null))
			);
			res.json({ profiles: profiles.filter(Boolean) });
		} catch (err) {
			console.error('[odysseia-rules] 批量 profile 查询失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});
}

module.exports = { mount, computeProfile };
