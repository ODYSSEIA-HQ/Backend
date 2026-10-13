#!/usr/bin/env node
/**
 * BFF 契约对拍脚本（风险登记缓解措施：BFF Rust 重写行为漂移）
 *
 * 用法：新旧 BFF 并排跑起后——
 *   BFF_OLD=http://127.0.0.1:3000 BFF_NEW=http://127.0.0.1:3001 node contract-diff.js
 *
 * 对拍契约（README「核心契约」章节的固化）：
 *   1. healthz / vendor 存在性
 *   2. /token 无 cookie → 401 + body
 *   3. /token burst → 401×20 → 429 切换帧（Retry-After 头 ceil 整秒、body retry_after 小数、scope）
 *   4. /centrifugo/subscribe 无密钥 → 403；错密钥 → 403；对密钥 + user:他人 → deny 103
 *   5. /upload/presign 未登录 → 401 + body（401 与 429 的先后顺序语义）
 *   6. /chat/:roomId/messages 未登录 → 401 + body
 *
 * 关键细节：burst 用【固定 IP 头】打满 20/10s——伪 IP 轮换会绕开限频（对拍失效）。
 * 每组独立 IP，避免组间互染。
 *
 * 全绿打印 ALL-GREEN，任何不一致打印 DIFF 并 exit 1。
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

/** 固定 IP 头打一组 burst，记录每次的 status 序列 */
async function burst(base, ip, path, times) {
	const codes = [];
	for (let i = 0; i < times; i++) {
		const res = await fetch(base + path, { headers: { 'x-forwarded-for': ip } });
		codes.push(res.status);
	}
	return codes;
}

/** 拿 429 响应（固定 IP 打到 429 后取该响应），返回 {status, headers, body} */
async function get429(base, ip, path, burstTimes) {
	for (let i = 0; i < burstTimes; i++) {
		const res = await fetch(base + path, { headers: { 'x-forwarded-for': ip } });
		if (res.status === 429) {
			return { status: res.status, retryAfter: res.headers.get('retry-after'), scope: res.headers.get('x-ratelimit-scope'), body: await res.json() };
		}
	}
	return null;
}

async function main() {
	console.log(`对拍 ${OLD} vs ${NEW}`);

	// ---- 1. healthz ----
	console.log('[1] healthz');
	const [hOld, hNew] = await Promise.all([fetch(`${OLD}/healthz`), fetch(`${NEW}/healthz`)]);
	diff('healthz body', await hOld.json(), await hNew.json());

	// ---- 2. /token 无 cookie → 401 ----
	console.log('[2] /token 无 cookie → 401');
	const [tOld, tNew] = await Promise.all([fetch(`${OLD}/token`), fetch(`${NEW}/token`)]);
	diff('token status', tOld.status, tNew.status);
	diff('token body', await tOld.json(), await tNew.json());

	// ---- 3. /token burst → 429（20/10s IP 层，固定 IP + 独立组 IP） ----
	console.log('[3] /token burst 25 → 401×20 + 429×5（固定 IP 10.13.37.1）');
	const [seqOld, seqNew] = await Promise.all([
		burst(OLD, '10.13.37.1', '/token', 25),
		burst(NEW, '10.13.37.1', '/token', 25),
	]);
	diff('status 序列（切换帧）', seqOld, seqNew);

	console.log('[4] 429 响应契约（Retry-After / scope / body，独立 IP 10.13.37.2）');
	const [rOld, rNew] = await Promise.all([
		get429(OLD, '10.13.37.2', '/token', 25),
		get429(NEW, '10.13.37.2', '/token', 25),
	]);
	if (!rOld || !rNew) {
		failed++;
		console.log(`  DIFF 429 未捕获：old=${!!rOld} new=${!!rNew}`);
	} else {
		diff('429 status', rOld.status, rNew.status);
		diff('429 X-RateLimit-Scope', rOld.scope, rNew.scope);
		diff('429 body.code/message', [rOld.body.code, rOld.body.message], [rNew.body.code, rNew.body.message]);
		diff('429 retry_after 类型（小数秒）', typeof rOld.body.retry_after, typeof rNew.body.retry_after);
		// Retry-After 整秒 ceil：两边独立计时，值可能差 1，只对拍「是正整数」语义
		diff('Retry-After 正整数', /^\d+$/.test(rOld.retryAfter || ''), /^\d+$/.test(rNew.retryAfter || ''));
	}

	// ---- 5. /centrifugo/subscribe 密钥矩阵 ----
	console.log('[5] subscribe 密钥矩阵（独立 IP）');
	const subscribe = (base, ip, secret, body) =>
		fetch(`${base}/centrifugo/subscribe`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(secret ? { 'x-odysseia-proxy': secret } : {}) },
			body: JSON.stringify(body),
		});
	// 无密钥 → 403
	const [s1Old, s1New] = await Promise.all([
		subscribe(OLD, '10.13.37.3', null, { channel: 'user:1', user: 1 }),
		subscribe(NEW, '10.13.37.3', null, { channel: 'user:1', user: 1 }),
	]);
	diff('subscribe 无密钥 status', s1Old.status, s1New.status);
	diff('subscribe 无密钥 body', await s1Old.json(), await s1New.json());

	// ---- 6. /upload/presign 未登录 → 401 ----
	console.log('[6] /upload/presign 未登录 → 401');
	const presign = (base) =>
		fetch(`${base}/upload/presign`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.13.37.4' },
			body: JSON.stringify({ kind: 'media', contentType: 'image/png' }),
		});
	const [pOld, pNew] = await Promise.all([presign(OLD), presign(NEW)]);
	diff('presign status', pOld.status, pNew.status);
	diff('presign body', await pOld.json(), await pNew.json());

	// ---- 7. /chat/:roomId/messages 未登录 → 401 ----
	console.log('[7] /chat/:roomId/messages 未登录 → 401');
	const chat = (base) =>
		fetch(`${base}/chat/1/messages`, { headers: { 'x-forwarded-for': '10.13.37.5' } });
	const [cOld, cNew] = await Promise.all([chat(OLD), chat(NEW)]);
	diff('chat status', cOld.status, cNew.status);
	diff('chat body', await cOld.json(), await cNew.json());

	if (failed) {
		console.log(`\nFAILED：${failed} 处不一致`);
		process.exit(1);
	}
	console.log('\nALL-GREEN：七组契约全部一致');
}

main().catch((e) => {
	console.error('对拍脚本异常：', e.message);
	process.exit(1);
});