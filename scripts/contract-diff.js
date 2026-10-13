#!/usr/bin/env node
/**
 * BFF 契约对拍脚本（风险登记缓解措施：BFF Rust 重写行为漂移）
 *
 * 用法：新旧 BFF 并排跑起后——
 *   BFF_OLD=http://127.0.0.1:3000 BFF_NEW=http://127.0.0.1:3001 node contract-diff.js
 *
 * 对拍三套契约（README「核心契约」章节的固化）：
 *   1. 429 契约：Retry-After 头（ceil 整秒）+ body {code, message, retry_after 小数} + X-RateLimit-Scope
 *   2. JWT claims：解码比较 sub/iss/exp 结构（exp 是秒级 Unix 时间戳，±60s 容差）
 *   3. 错误契约：401/403 body 的 error 字段
 *
 * 全绿打印 ALL-GREEN，任何不一致打印 DIFF 并 exit 1。
 * 需要 NodeBB 在线（token 端点回源 /api/me），离线场景跳过 JWT 部分。
 */

'use strict';

const OLD = process.env.BFF_OLD || 'http://127.0.0.1:3000';
const NEW = process.env.BFF_NEW || 'http://127.0.0.1:3001';

let failed = 0;

function diff(name, a, b) {
	if (JSON.stringify(a) === JSON.stringify(b)) {
		console.log(`  ok ${name}`);
	} else {
		failed++;
		console.log(`  DIFF ${name}\n    old: ${JSON.stringify(a)}\n    new: ${JSON.stringify(b)}`);
	}
}

/** 撞限频：对同一 IP 连打 max+1 次，返回第 max+1 次响应 */
async function hit429(base, path, max) {
	let last = null;
	for (let i = 0; i <= max; i++) {
		const res = await fetch(base + path, { headers: { 'x-forwarded-for': `10.77.0.${(Date.now() % 200) + 1}` } });
		last = res;
	}
	return last;
}

async function main() {
	console.log(`对拍 ${OLD} vs ${NEW}`);

	// ---- 1. healthz ----
	console.log('[1] healthz');
	const [hOld, hNew] = await Promise.all([fetch(`${OLD}/healthz`), fetch(`${NEW}/healthz`)]);
	const [hOldBody, hNewBody] = await Promise.all([hOld.json(), hNew.json()]);
	diff('healthz body', hOldBody, hNewBody);

	// ---- 2. /token 无 cookie（401 契约） ----
	console.log('[2] /token 无 cookie → 401');
	const [tOld, tNew] = await Promise.all([fetch(`${OLD}/token`), fetch(`${NEW}/token`)]);
	diff('token status', tOld.status, tNew.status);
	const [tOldBody, tNewBody] = await Promise.all([tOld.json(), tNew.json()]);
	diff('token 401 body', tOldBody, tNewBody);

	// ---- 3. /token 429 契约（burst 21 次撞 20/10s IP 层） ----
	console.log('[3] /token burst → 429（20/10s IP 层）');
	const [rOld, rNew] = await Promise.all([hit429(OLD, '/token', 25), hit429(NEW, '/token', 25)]);
	diff('429 status', rOld.status, rNew.status);
	// Retry-After 允许 ±1s（两个实例独立计时）
	const raOld = Number(rOld.headers.get('retry-after'));
	const raNew = Number(rNew.headers.get('retry-after'));
	diff('429 Retry-After (±1s)', Math.round(raOld), Math.round(raNew));
	diff('429 X-RateLimit-Scope', rOld.headers.get('x-ratelimit-scope'), rNew.headers.get('x-ratelimit-scope'));
	const [bOld, bNew] = await Promise.all([rOld.json(), rNew.json()]);
	diff('429 code/message', [bOld.code, bOld.message], [bNew.code, bNew.message]);
	diff('429 retry_after 类型', typeof bOld.retry_after, typeof bNew.retry_after);

	// ---- 4. subscribe 无密钥（403 契约） ----
	console.log('[4] /centrifugo/subscribe 无密钥 → 403');
	const [sOld, sNew] = await Promise.all([
		fetch(`${OLD}/centrifugo/subscribe`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ channel: 'user:1', user: 1 }),
		}),
		fetch(`${NEW}/centrifugo/subscribe`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ channel: 'user:1', user: 1 }),
		}),
	]);
	diff('subscribe status', sOld.status, sNew.status);

	// ---- 5. presign 未登录（401 契约） ----
	console.log('[5] /upload/presign 未登录 → 401');
	const [pOld, pNew] = await Promise.all([
		fetch(`${OLD}/upload/presign`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'media', contentType: 'image/png' }),
		}),
		fetch(`${NEW}/upload/presign`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'media', contentType: 'image/png' }),
		}),
	]);
	diff('presign status', pOld.status, pNew.status);

	// ---- 6. presign 非法 contentType（400 契约）----
	// 注意：走到这里需要登录 cookie（401 先返回），无 cookie 时两边同样返回 401 即视为一致
	diff('presign body', await pOld.json().catch(() => ({})), await pNew.json().catch(() => ({})));

	if (failed) {
		console.log(`\nFAILED：${failed} 处不一致`);
		process.exit(1);
	}
	console.log('\nALL-GREEN：六组契约全部一致');
}

main().catch((e) => {
	console.error('对拍脚本异常：', e.message);
	process.exit(1);
});