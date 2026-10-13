'use strict';

/**
 * 身份组自动晋升 —— node-cron 定期扫描 postCount 达标用户
 *
 * 设计（架构决策 D6）：
 *   - 晋升只做加法（groups.join），永不自动降级——避免删帖引发身份回收的社区矛盾
 *   - 数据源走 users:postcount sorted set（score 即发帖数），范围查询直达达标人群，
 *     不做全表扫描
 *   - 分页批处理，单轮晋升人数无上限，但每批 500 控制内存
 *   - 进程启动 60s 后先跑一轮（此时依赖已就绪），之后每小时整点巡检
 */

const cron = require('node-cron');

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

const POSTCOUNT_KEY = 'users:postcount';
const BATCH_SIZE = 500;

let running = false;
let started = false;

// ---------- 单轮巡检 ----------

async function runOnce(getSettings) {
	if (running || !db || !Groups) return;
	running = true;
	try {
		const settings = await getSettings();
		const ladder = Array.isArray(settings.ladder) ? settings.ladder : [];
		const bufferMs = Math.max(0, Number(settings.bufferHours) || 0) * 3600e3;
		const now = Date.now();

		for (const { group, minPosts } of ladder) {
			if (!group || !(Number(minPosts) > 0)) continue;

			const exists = await Groups.exists(String(group));
			if (!exists) {
				console.warn(`[odysseia-rules] 晋升跳过：身份组 ${group} 不存在（请在 ACP 中创建）`);
				continue;
			}

			let promoted = 0;
			let start = 0;
			// 分页拉取 postCount ≥ minPosts 的 uid
			for (;;) {
				const uids = await db.getSortedSetRangeByScore(
					POSTCOUNT_KEY, start, BATCH_SIZE, Number(minPosts), '+inf'
				);
				if (!uids || !uids.length) break;

				// 注意复数 API：isMembers(uids, group) -> boolean[]（单数 isMember 只接受单个 uid）
			const members = await Groups.isMembers(uids, String(group));
			let toJoin = uids.filter((uid, i) => !members[i] && Number(uid) > 0);

			// 双条件：postCount 达标之外，还须过 120h 新人缓冲区（joindate + buffer <= now），
			// 否则机器人注册当天刷帖即跳级，缓冲区形同虚设
			if (toJoin.length && bufferMs > 0) {
				const joins = await db.sortedSetScores('users:joindate', toJoin);
				toJoin = toJoin.filter((uid, i) => Number(joins[i]) > 0 && Number(joins[i]) + bufferMs <= now);
			}

				for (const uid of toJoin) {
					try {
						await Groups.join(String(group), uid);
						promoted += 1;
					} catch (err) {
						console.error(`[odysseia-rules] 晋升失败 uid=${uid} group=${group}`, err.message);
					}
				}

				if (uids.length < BATCH_SIZE) break;
				start += BATCH_SIZE;
			}

			if (promoted > 0) {
				console.log(`[odysseia-rules] 晋升：${promoted} 名用户已加入 ${group}（门槛 ${minPosts} 帖）`);
			}
		}
	} catch (err) {
		console.error('[odysseia-rules] 晋升巡检异常', err.message);
	} finally {
		running = false;
	}
}

// ---------- 启动 ----------

function start(getSettings) {
	if (started) return; // 幂等守卫：static:app.load 多次触发时防 cron/setTimeout 重复注册
	started = true;

	// 启动后延迟 60s 先跑一轮（等 DB / Redis 完全就绪）
	setTimeout(() => {
		runOnce(getSettings).catch(() => {});
	}, 60 * 1000);

	// 每小时整点巡检
	cron.schedule('0 * * * *', () => {
		runOnce(getSettings).catch(() => {});
	});

	console.log('[odysseia-rules] 身份组晋升 cron 已启动（每小时整点）');
}

module.exports = { start, runOnce };
