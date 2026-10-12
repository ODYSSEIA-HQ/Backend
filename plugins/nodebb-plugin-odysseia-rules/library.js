'use strict';

/**
 * ΟΔΥΣΣΕΙΑ 制度插件主逻辑
 *
 * 类脑制度三件套的服务端实现：
 *   1. 答题准入 —— filter:register.check 服务端强制（前端体验层走公开 quiz API）
 *   2. 120h 新人缓冲区 —— 内部 profile API 提供剩余时间计算
 *   3. 身份组自动晋升 —— node-cron 按 postCount 定期晋升
 *
 * 题库 / 晋升阶梯通过内部 API 管理（BFF 或运维脚本持 X-Internal-Token 调用）
 */

const db = loadModule('./src/database');
const meta = loadModule('./src/meta');

const quiz = require('./lib/quiz');
const promote = require('./lib/promote');
const profileApi = require('./lib/profile');

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

const plugin = {};

// ---------- 默认制度配置（可被 meta.settings 覆盖） ----------
const DEFAULTS = {
	// 答题准入：默认关（题库为空时放行），配置题库后自动生效
	quizEnabled: true,
	// 120h 缓冲区（毫秒）
	bufferHours: 120,
	// 身份组晋升阶梯：达到 postCount 自动加入 group
	ladder: [
		{ group: 'odysseia-trusted', minPosts: 10 },
		{ group: 'odysseia-veteran', minPosts: 200 },
		{ group: 'odysseia-elder', minPosts: 1000 },
	],
};

async function getSettings() {
	const saved = (meta && (await meta.settings.get('odysseia-rules'))) || {};
	return Object.assign({}, DEFAULTS, saved);
}

// ---------- 生命周期 ----------

plugin.init = async function (params) {
	const { router } = params;

	// 公开路由（注册页答题用，无 answer 泄漏）
	quiz.mountPublic(router);

	// 内部路由（profile / 题库管理，X-Internal-Token 鉴权）
	profileApi.mount(router, getSettings);
	quiz.mountInternal(router);

	// 身份组晋升 cron：每小时
	promote.start(getSettings);

	console.log('[odysseia-rules] 制度插件已加载（quiz / profile / promote cron）');
};

// ---------- 注册拦截（服务端强制，答题无 token 或过期则拒绝） ----------

plugin.onRegisterCheck = async function (payload) {
	const settings = await getSettings();
	if (!settings.quizEnabled) return payload;
	if (!(await quiz.hasQuestions())) return payload; // 题库为空时放行（冷启动期）

	const token = payload && payload.userData && payload.userData.quizToken;
	if (await quiz.consumeToken(token)) return payload;

	payload.errors = payload.errors || [];
	payload.errors.push('[[error:odysseia-quiz-not-passed]] 请先完成准入答题');
	return payload;
};

module.exports = plugin;
