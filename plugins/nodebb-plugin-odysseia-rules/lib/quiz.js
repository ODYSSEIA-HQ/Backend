'use strict';

/**
 * 答题准入 —— 题库管理 / 公开答题 API / 一次性准入 token
 *
 * 设计（架构决策 D5）：
 *   - 题库为空时整体放行（新站冷启动不设门槛，运营上再开启）
 *   - 公开 API 只下发题面与选项文本，绝不下发答案
 *   - verify 按选项【文本】比对而非索引——前端可以随意洗牌选项顺序防背题位
 *   - 通过后签发一次性 token（24h 有效，sorted set 存储过期时间），注册时消费
 *   - 题库管理走 X-Internal-Token（BFF / 运维脚本调用）
 *
 * 存储键（NodeBB db）：
 *   odysseia:quiz:bank   —— object { questions: [...] }
 *   odysseia:quiz:tokens —— sorted set，member=token，score=过期时间戳
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

const BANK_KEY = 'odysseia:quiz:bank';
const TOKENS_KEY = 'odysseia:quiz:tokens';
const TOKEN_TTL_MS = 24 * 3600 * 1000;

const INTERNAL_TOKEN = process.env.ODYSSEIA_INTERNAL_TOKEN || '';
if (!INTERNAL_TOKEN) {
	console.warn('[odysseia-rules] ODYSSEIA_INTERNAL_TOKEN 未配置，内部 API 将全部拒绝（fail-closed）');
}

// ---------- 题库读写 ----------

async function getBank() {
	if (!db) return { questions: [] };
	const bank = await db.getObject(BANK_KEY);
	return bank && Array.isArray(bank.questions) ? bank : { questions: [] };
}

async function setBank(questions) {
	if (!db) throw new Error('database 模块不可用');
	await db.setObject(BANK_KEY, { questions });
}

async function hasQuestions() {
	const bank = await getBank();
	return bank.questions.length > 0;
}

// ---------- 一次性 token ----------

async function issueToken() {
	const token = crypto.randomBytes(32).toString('hex');
	await db.sortedSetAdd(TOKENS_KEY, Date.now() + TOKEN_TTL_MS, token);
	return token;
}

async function consumeToken(token) {
	if (!token || !db) return false;
	// 原子消费：NodeBB v4.16.2 mongo 驱动的 db.sortedSetRemove 内部 deleteMany 无返回值
	// （上游 src/database/mongo/sorted/remove.js 实证），先读分后删除存在 TOCTOU——
	// 并发注册可复用同一 token 绕过"一次性"。改用 db.client 条件删除：
	// 单操作完成"存在且未过期→删除"，deletedCount 即消费权裁决。
	if (db.client && typeof db.client.collection === 'function') {
		const r = await db.client.collection('objects').deleteOne({
			_key: TOKENS_KEY,
			value: String(token),
			score: { $gt: Date.now() },
		});
		return r.deletedCount === 1;
	}
	// 非 mongo 后端（如 redis）回退读分+删除；竞态窗口由注册流天然低并发兜底
	const expiresAt = await db.getSortedSetScore(TOKENS_KEY, token);
	if (!expiresAt || Number(expiresAt) < Date.now()) return false;
	// 消费即焚：从 set 中移除，同一 token 无法重复注册
	await db.sortedSetRemove(TOKENS_KEY, token);
	return true;
}

// 顺手清理过期 token（在每次签发时执行，无需独立 cron）
async function sweepExpiredTokens() {
	try {
		if (db && typeof db.sortedSetRemoveRangeByScore === 'function') {
			await db.sortedSetRemoveRangeByScore(TOKENS_KEY, '-inf', Date.now());
		}
	} catch (e) {
		/* 清理失败不影响主流程 */
	}
}

// ---------- 公开路由（注册页答题，未登录可访问） ----------

// verify 限频：按 IP 内存滑动窗口（10 次/10 分钟）。
// 不限频则 verify 是在线爆破答案的免费 oracle（每题仅 ~4 选项，全对即发票）
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const VERIFY_MAX = 10;
const verifyHits = new Map(); // ip -> number[]（窗口内时间戳）

function verifyAllowed(ip) {
	const now = Date.now();
	const hits = (verifyHits.get(ip) || []).filter(t => now - t < VERIFY_WINDOW_MS);
	if (hits.length >= VERIFY_MAX) {
		verifyHits.set(ip, hits);
		return false;
	}
	hits.push(now);
	verifyHits.set(ip, hits);
	if (verifyHits.size > 10000) verifyHits.clear(); // 防内存膨胀，限频精度可牺牲
	return true;
}

function mountPublic(router) {
	// 拉取题库（无答案）：[{id, question, options: ['..', ...]}]
	router.get('/api/v3/plugins/odysseia/quiz', async (req, res) => {
		try {
			const bank = await getBank();
			res.json({
				enabled: bank.questions.length > 0,
				questions: bank.questions.map(q => ({
					id: q.id,
					question: q.question,
					options: q.options,
				})),
			});
		} catch (err) {
			console.error('[odysseia-rules] 拉取题库失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});

	// 提交答卷：answers = { [题id]: '选项文本' }，全对发一次性 token
	router.post('/api/v3/plugins/odysseia/quiz/verify', async (req, res) => {
		try {
			if (!verifyAllowed(req.ip || 'unknown')) {
				return res.status(429).json({ passed: false, error: 'too many requests' });
			}

			const bank = await getBank();
			const answers = (req.body && req.body.answers) || {};

			const allCorrect = bank.questions.every(q => answers[q.id] === q.answer);
			if (!allCorrect) {
				// 不指明哪题错了——筛选机制的本意，防止逐题爆破
				return res.status(200).json({ passed: false });
			}

			await sweepExpiredTokens();
			const token = await issueToken();
			res.json({ passed: true, quizToken: token, expiresInMs: TOKEN_TTL_MS });
		} catch (err) {
			console.error('[odysseia-rules] verify 失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});
}

// ---------- 内部路由（题库管理，X-Internal-Token） ----------

function requireInternalToken(req, res, next) {
	// 等长比较防时序侧信道；token 未配置时 fail-closed（启动期已告警）
	const given = Buffer.from(String(req.headers['x-internal-token'] || ''));
	const expect = Buffer.from(INTERNAL_TOKEN);
	if (!expect.length || given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) {
		return res.status(403).json({ error: 'forbidden' });
	}
	next();
}

function mountInternal(router) {
	// 查看题库（含答案，运维用）
	router.get('/api/v3/plugins/odysseia/quiz/bank', requireInternalToken, async (req, res) => {
		res.json(await getBank());
	});

	// 全量替换题库：questions = [{question, options: [..≥2..], answer: '必须在 options 内'}]
	router.put('/api/v3/plugins/odysseia/quiz/bank', requireInternalToken, async (req, res) => {
		try {
			const questions = req.body && req.body.questions;
			if (!Array.isArray(questions)) {
				return res.status(400).json({ error: 'questions 必须为数组' });
			}
			for (const [i, q] of questions.entries()) {
				if (!q || typeof q.question !== 'string' || !q.question.trim()) {
					return res.status(400).json({ error: `第 ${i + 1} 题缺少 question` });
				}
				if (!Array.isArray(q.options) || q.options.length < 2) {
					return res.status(400).json({ error: `第 ${i + 1} 题至少需要 2 个选项` });
				}
				if (!q.options.includes(q.answer)) {
					return res.status(400).json({ error: `第 ${i + 1} 题 answer 必须是 options 之一` });
				}
			}
			// 重写 id，避免外部指定
			await setBank(questions.map((q, i) => ({
				id: `q${i + 1}`,
				question: q.question.trim(),
				options: q.options.map(o => String(o)),
				answer: String(q.answer),
			})));
			res.json({ ok: true, count: questions.length });
		} catch (err) {
			console.error('[odysseia-rules] 更新题库失败', err.message);
			res.status(500).json({ error: 'internal' });
		}
	});
}

module.exports = { mountPublic, mountInternal, consumeToken, hasQuestions };
