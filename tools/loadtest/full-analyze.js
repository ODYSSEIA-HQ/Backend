// full-scale k6 JSONL 明细流式分析器
// ============================================================
// 用法：node full-analyze.js <detail.json> <out.json>
// 产出：read 按 endpoint 分组统计 + 慢请求 top30 + 10s 时间线桶；
//       send/chat 直方图；失败计数；ws_msgs 总量。
// 注意：k6 JSONL 末尾聚合 summary 行无 data.value，须防御跳过。
'use strict';

const fs = require('fs');
const readline = require('readline');

const [,, inFile, outFile] = process.argv;
if (!inFile || !outFile) {
	console.error('用法: node full-analyze.js <detail.json> <out.json>');
	process.exit(1);
}

function pct(sorted, p) {
	if (!sorted.length) return 0;
	const i = (sorted.length - 1) * p / 100;
	const lo = Math.floor(i), hi = Math.ceil(i);
	return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const stats = (vals) => {
	const s = [...vals].sort((a, b) => a - b);
	return { n: s.length, med: +pct(s, 50).toFixed(1), p90: +pct(s, 90).toFixed(1), p95: +pct(s, 95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};
const bucket = (t) => Math.floor(t / 10) * 10;

const readBy = { parent: [], card: [], all: [] };
const sendDurs = [];
const chatDurs = [];
const slowRead = [], slowSend = [];
let sendFailed = 0, wsMsgs = 0, wsDenied = 0;
const tl = new Map(); // 10s 桶 → {readN,readSlow,readSum,sendN,sendSlow,sendSum}

const rl = readline.createInterface({ input: fs.createReadStream(inFile), crlfDelay: Infinity });
rl.on('line', (line) => {
	let m; try { m = JSON.parse(line); } catch (e) { return; }
	const d = m.data;
	if (!m || !d || d.value === undefined) return; // 聚合行防御

	if (m.metric === 'http_req_duration' && d.tags && d.tags.scenario) {
		const v = d.value, t = new Date(m.data.time).getTime() / 1000 || 0;
		const b = tl.get(bucket(t)) || { readN: 0, readSlow: 0, readSum: 0, sendN: 0, sendSlow: 0, sendSum: 0 };
		if (d.tags.scenario === 'read') {
			readBy.all.push(v); b.readN++; b.readSum += v; if (v >= 500) b.readSlow++;
			const ep = d.tags.endpoint;
			if (ep === 'category-parent') readBy.parent.push(v);
			else if (ep === 'category-card') readBy.card.push(v);
			if (v >= 500) slowRead.push({ ms: +v.toFixed(0), ep, cid: d.tags.name || '', t: m.data.time });
		} else if (d.tags.scenario === 'send') {
			sendDurs.push(v); b.sendN++; b.sendSum += v; if (v >= 500) b.sendSlow++;
			if (v >= 2000) slowSend.push({ ms: +v.toFixed(0), status: d.tags.status || '', t: m.data.time });
		}
		tl.set(bucket(t), b);
	} else if (m.metric === 'http_req_failed' && d.tags && d.tags.scenario === 'send' && d.value === 1) {
		sendFailed++;
	} else if (m.metric === 'chat_latency_ms') {
		chatDurs.push(d.value);
	} else if (m.metric === 'ws_msgs_received') {
		wsMsgs += d.value;
	} else if (m.metric === 'ws_subscribe_denied') {
		wsDenied += d.value;
	}
});

rl.on('close', () => {
	const hist = (vals, edges) => {
		const h = {}; const labels = edges.map((e, i) => (i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${e}`)).concat([`≥${edges[edges.length - 1]}`]);
		vals.forEach((v) => { let k = labels[labels.length - 1]; for (let i = 0; i < edges.length; i++) { if (v < edges[i]) { k = labels[i]; break; } } h[k] = (h[k] || 0) + 1; });
		return h;
	};
	const sendH = hist(sendDurs, [500, 1000, 2000, 4000]);
	const chatH = hist(chatDurs, [100, 500, 1000, 2000]);
	const timeline = [...tl.entries()].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({
		t, readN: b.readN, readSlow: b.readSlow, readMed: b.readN ? +(b.readSum / b.readN).toFixed(0) : 0,
		sendN: b.sendN, sendSlow: b.sendSlow, sendMed: b.sendN ? +(b.sendSum / b.sendN).toFixed(0) : 0,
	}));
	const out = {
		read: { all: stats(readBy.all), parent: stats(readBy.parent), card: stats(readBy.card) },
		readSlowTop30: slowRead.sort((a, b) => b.ms - a.ms).slice(0, 30),
		send: { stats: stats(sendDurs), failed: sendFailed, hist: sendH, slowTop30: slowSend.sort((a, b) => b.ms - a.ms).slice(0, 30) },
		chat: { stats: stats(chatDurs), hist: chatH },
		ws: { msgsReceived: wsMsgs, subscribeDenied: wsDenied },
		timeline,
	};
	fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
	console.log(`read all=${out.read.all.n} p95=${out.read.all.p95} | card p95=${out.read.card.p95} (n=${out.read.card.n}) | parent p95=${out.read.parent.p95} (n=${out.read.parent.n})`);
	console.log(`send n=${out.send.stats.n} med=${out.send.stats.med} p95=${out.send.stats.p95} failed=${sendFailed} | chat med=${out.chat.stats.med} p95=${out.chat.stats.p95}`);
	console.log(`ws msgs=${wsMsgs} denied=${wsDenied} | timeline buckets=${timeline.length}`);
});
