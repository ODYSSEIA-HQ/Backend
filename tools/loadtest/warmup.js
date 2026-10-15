// ODYSSEIA 压测预热场景——full5 尸检教训固化
// ============================================================
// full5 判废主因（方法论污染）：容器重建后 2.5 分钟即开压，冷启动状态
// （V8 优化未热 / Mongo wiredTiger cache 空 / 分类缓存空 / 连接池未建）
// 全部计入指标，读作「性能劣化」。本脚本把正式压测将命中的全部路径
// 预先喂到稳态：
//   cards  — 20 VU 顺序分片，全量 3000 卡分类各 GET 一次：分类缓存
//            （TTL 300s / MAX 4000）全量常驻 + 回源数据进 wiredTiger
//            cache + read 路径 JIT 热
//   parent — parentCid（全卡列表页）× 10：readers 30% 流量热点
//   sends  — 25/s × 20s = 500 条 chat 写：addMessage → bridge hook →
//            Centrifugo publish 全链路 JIT 热（[lt-warm] 前缀不撞
//            [lt-ping]，残余订阅者不会误计 chat_latency）
//   ws     — 100 连接快速建立：Centrifugo connect + BFF subscribe proxy
//
// 时序约束（重要）：cards 前段写入的缓存条目 TTL 300s，而正式压测的
// readers 在 k6 启动 120s（LT_RAMP）后才开打——warmup 结束后 2 分钟内
// 必须启动 chat-baseline.js，否则预热白做。
//
// 用法（与 chat-baseline.js 同姿势，容器内挂 odysseia_app 网络）：
//   docker run --rm --network odysseia_app \
//     -v ${PWD}/tools/loadtest:/loadtest \
//     -e LT_HMAC_SECRET=<CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY> \
//     grafana/k6 run /loadtest/warmup.js
//
// 判据：http_req_failed < 1% 且 ws_errors 少量（重建后首连可能有个位数
// 拒绝）；任何批量 5xx 都先排查再开正式压测。
'use strict';

import ws from 'k6/ws';
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { roomsByUser } from './memberships.mjs';

// ---------- 配置 ----------
// 必须与 chat-baseline.js 同入口（caddy:8090 LB）——直连 nodebb:4567 会钉死单 worker，
// 预热只热 1/12 的 worker 缓存（RUNBOOK §7 坑表 #2）
const HTTP_BASE = __ENV.LT_HTTP_BASE || 'http://caddy:8090';
const WS_BASE = __ENV.LT_WS_BASE || 'ws://centrifugo:8000';
const HMAC_SECRET = __ENV.LT_HMAC_SECRET || '';
const CARD_VUS = 20; // cards 分片并行度

if (!HMAC_SECRET) { throw new Error('LT_HMAC_SECRET 必填（Centrifugo 连接 token 本地铸造）'); }

// ---------- 种子数据（与 chat-baseline.js 同源同构） ----------
const seedRaw = (() => {
	try { return open('/loadtest/seed-output.json'); } catch (e) { /* 宿主机直跑回退 */ }
	return open('./seed-output.json');
})();
const seed = JSON.parse(seedRaw);
const N_USERS = seed.allUserUids.length;

const allUserUids = new SharedArray('lt-uids', () => seed.allUserUids);
const tokenUsers = new SharedArray('lt-token-users', () => seed.users);
// 使用数据库导出的真实成员关系；旧种子必须先刷新，不能回退到下标推算。
const roomsByUserIdx = new SharedArray('lt-rooms-by-user', () => roomsByUser(seed));

// ---------- 指标 ----------
const sendErrors = new Counter('warm_send_errors');
const wsErrors = new Counter('warm_ws_errors');
const wsConnected = new Counter('warm_ws_connected');

// ---------- 场景（时序：cards 0s → parent 30s → sends 45s → ws 75s，总 ~110s） ----------
export const options = {
	scenarios: {
		cards: {
			executor: 'per-vu-iterations',
			vus: CARD_VUS,
			iterations: Math.ceil(seed.cids.length / CARD_VUS),
			exec: 'cardWarmer',
		},
		parent: {
			executor: 'per-vu-iterations',
			vus: 1,
			iterations: 1,
			startTime: '30s',
			exec: 'parentWarmer',
		},
		sends: {
			executor: 'constant-arrival-rate',
			rate: 25,
			timeUnit: '1s',
			duration: '20s',
			startTime: '45s',
			preAllocatedVUs: 10,
			maxVUs: 30,
			exec: 'warmSender',
		},
		ws: {
			executor: 'ramping-vus',
			startVUs: 0,
			stages: [
				{ duration: '20s', target: 100 },
				{ duration: '15s', target: 0 },
			],
			startTime: '75s',
			exec: 'wsWarmer',
		},
	},
	thresholds: {
		http_req_failed: ['rate<0.01'],
	},
	userAgent: 'odysseia-loadtest/1.0',
};

// ---------- JWT 本地铸造（sub=uid 字符串，与 BFF /token 同构） ----------
function b64urlStr(s) {
	return encoding.b64encode(s, 'rawurl');
}
function mintJwt(uidStr, ttlSec) {
	const header = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const now = Math.floor(Date.now() / 1000);
	const payload = b64urlStr(JSON.stringify({
		sub: uidStr,
		iss: 'odysseia-loadtest',
		iat: now,
		exp: now + (ttlSec || 7200),
	}));
	const toSign = `${header}.${payload}`;
	const sig = encoding.b64encode(crypto.hmac('sha256', HMAC_SECRET, toSign, 'binary'), 'rawurl');
	return `${toSign}.${sig}`;
}

// ---------- 场景：卡分类全量喂热 ----------
// VU v（1 起）按步长 CARD_VUS 顺序领走 indices v-1, v-1+20, v-1+40 ...
// 20 VU × 150 迭代覆盖 3000 cid（cids 不足整除时末位 VU 空转返回）
export function cardWarmer() {
	const idx = (__VU - 1) + __ITER * CARD_VUS;
	if (idx >= seed.cids.length) { return; }
	http.get(`${HTTP_BASE}/api/category/${seed.cids[idx]}`, { timeout: '30s' });
}

// ---------- 场景：父分类（全卡列表页）× 10 ----------
export function parentWarmer() {
	for (let i = 0; i < 10; i += 1) {
		http.get(`${HTTP_BASE}/api/category/${seed.parentCid}`, { timeout: '30s' });
	}
}

// ---------- 场景：chat 写路径喂热 ----------
export function warmSender() {
	const tu = tokenUsers[Math.floor(Math.random() * tokenUsers.length)];
	const userIdx = seed.allUserUids.indexOf(tu.uid);
	const myRooms = roomsByUserIdx[userIdx];
	if (!myRooms || myRooms.length === 0) { sendErrors.add(1); return; }
	const roomId = myRooms[Math.floor(Math.random() * myRooms.length)];

	http.post(
		`${HTTP_BASE}/api/v3/chats/${roomId}`,
		JSON.stringify({ message: `[lt-warm] ${Date.now()}` }),
		{
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${tu.token}`,
			},
			timeout: '30s',
		}
	);
}

// ---------- 场景：WS 连接/订阅链路喂热 ----------
export function wsWarmer() {
	const userIdx = (__VU - 1) % N_USERS;
	const uid = allUserUids[userIdx];
	const myRooms = roomsByUserIdx[userIdx];
	if (!myRooms || myRooms.length === 0) { wsErrors.add(1); return; }
	const roomId = myRooms[Math.floor(Math.random() * myRooms.length)];
	const token = mintJwt(String(uid), 7200);

	ws.connect(`${WS_BASE}/connection/websocket`, {}, (socket) => {
		let cmdId = 0;
		socket.on('open', () => {
			cmdId += 1;
			socket.send(JSON.stringify({ id: cmdId, connect: { token, name: 'k6-warm' } }));
		});
		socket.on('message', (raw) => {
			if (raw === '{}') { socket.send('{}'); return; } // Centrifugo 应用层 ping → pong
			let msg;
			try { msg = JSON.parse(raw); } catch (e) { return; }
			if (msg.id && msg.connect) {
				wsConnected.add(1);
				cmdId += 1;
				socket.send(JSON.stringify({ id: cmdId, subscribe: { channel: `chat:${roomId}` } }));
				return;
			}
			if (msg.id && msg.error) { wsErrors.add(1); }
		});
		socket.on('error', () => { wsErrors.add(1); });
		socket.setTimeout(() => { socket.close(); }, 10000); // 挂 10s 即关，只热链路
	});
	sleep(1);
}
