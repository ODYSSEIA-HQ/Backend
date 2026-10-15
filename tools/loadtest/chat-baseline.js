// ODYSSEIA 缝合压测 · 裸基线场景
// ============================================================
// 对赌规格：3 万讨论帖 / 4000 活跃聊天室 / 2500 WS 在线 / 全服 100 msg/s
// 通过线：send→receive P95 < 500ms；目标：P95 < 100ms
//
// 三个并行场景：
//   receivers — ramping-vus 到 LT_ONLINE，每 VU 以某 lt 用户身份直连 Centrifugo WS，
//               订阅其成员房间 chat:{roomId}（走 BFF subscribe proxy 全链路），
//               解析 [lt-ping] {ts} 标记计算端到端时延（同 k6 进程同钟，无偏差）
//   senders   — constant-arrival-rate LT_MSG_RATE/s，POST NodeBB 写 API
//               /api/v3/chats/{roomId}（Bearer = seed 发的用户 token）
//   readers   — constant-arrival-rate LT_READ_RATE/s，GET /api/category/{cid}
//               （70% 随机卡分类 + 30% 父分类=全卡列表）
//
// 容器内运行（grafana/k6，挂 odysseia_app 网络）：
//   docker run --rm --network odysseia_app \
//     -v ${PWD}/tools/loadtest:/loadtest \
//     -e LT_HMAC_SECRET=<CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY> \
//     grafana/k6 run --summary-export /loadtest/results/baseline-summary.json \
//     /loadtest/chat-baseline.js
//
// 已知偏差（报告需注明）：
//   1. 走 Caddy 内网压测入口 :8090（12 worker LB）。禁止直连 nodebb:4567 单端口——
//      cluster 布局下会把全部流量钉死到 1 个 worker，指标无意义（RUNBOOK §7 坑表 #2）。
//      WS 仍直连 centrifugo:8000（Caddy 的 WS 反代仅对公网站点暴露）。
//   2. dev 库已关闭发帖节流（postDelay 等=0）；聊天限流为 session 级，
//      Bearer 无 cookie 每请求新 session → 实际不触发（生产浏览器带 cookie 会触发）
//   3. 每 WS 会话存活 60–120s 后重连，churn 高于生产稳态（偏保守/更严苛）
'use strict';

import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { roomsByUser } from './memberships.mjs';

// ---------- 配置 ----------
const HTTP_BASE = __ENV.LT_HTTP_BASE || 'http://caddy:8090';
const WS_BASE = __ENV.LT_WS_BASE || 'ws://centrifugo:8000';
const HMAC_SECRET = __ENV.LT_HMAC_SECRET || '';
const ONLINE = parseInt(__ENV.LT_ONLINE || '2500', 10);
const MSG_RATE = parseInt(__ENV.LT_MSG_RATE || '100', 10);
const READ_RATE = parseInt(__ENV.LT_READ_RATE || '30', 10);
const RAMP = __ENV.LT_RAMP || '120s';
const HOLD = __ENV.LT_HOLD || '300s';

if (!HMAC_SECRET) { throw new Error('LT_HMAC_SECRET 必填（Centrifugo 连接 token 本地铸造）'); }

// ---------- 种子数据（SharedArray：全局解析一次，2500 VU 共享） ----------
const seedRaw = (() => {
	try { return open('/loadtest/seed-output.json'); } catch (e) { /* 宿主机直跑回退 */ }
	return open('./seed-output.json');
})();
const seed = JSON.parse(seedRaw);
const N_USERS = seed.allUserUids.length;

const allUserUids = new SharedArray('lt-uids', () => seed.allUserUids);
const cids = new SharedArray('lt-cids', () => seed.cids);
const tokenUsers = new SharedArray('lt-token-users', () => seed.users);
// 使用数据库导出的真实成员关系；旧种子必须先刷新，不能回退到下标推算。
const roomsByUserIdx = new SharedArray('lt-rooms-by-user', () => roomsByUser(seed));

// ---------- 指标 ----------
const chatLatency = new Trend('chat_latency_ms', true);
const chatReceived = new Counter('chat_received');
const chatSentOk = new Counter('chat_sent_ok');
const sendErrors = new Counter('send_errors');
const wsErrors = new Counter('ws_errors');
const wsSubscribeDenied = new Counter('ws_subscribe_denied');
const wsConnected = new Counter('ws_connected');

// ---------- 场景 ----------
export const options = {
	scenarios: {
		receivers: {
			executor: 'ramping-vus',
			startVUs: 0,
			stages: [
				{ duration: RAMP, target: ONLINE },
				{ duration: HOLD, target: ONLINE },
				{ duration: '30s', target: 0 },
			],
			exec: 'receiver',
		},
		senders: {
			executor: 'constant-arrival-rate',
			rate: MSG_RATE,
			timeUnit: '1s',
			duration: HOLD, // 满在线后才开打
			startTime: RAMP,
			// VU 池必须覆盖 rate × 单请求延迟：100/s × ~2.5s ≈ 250 VU。
			// full3/full7 实测 maxVUs=120 时吞吐被钉死在 ~42-47/s（120÷延迟），
			// dropped 万级——测的是 k6 池上限不是服务端容量（RUNBOOK §7）。
			preAllocatedVUs: 100,
			maxVUs: 300,
			exec: 'sender',
		},
		readers: {
			executor: 'constant-arrival-rate',
			rate: READ_RATE,
			timeUnit: '1s',
			duration: HOLD,
			startTime: RAMP,
			// read 稳态 med ~150ms，但灾难窗口排队可达 5s+：30/s × 5s = 150，
			// 池太小会把排队中的 read 丢迭代（dropped），延迟统计偏乐观。
			preAllocatedVUs: 15,
			maxVUs: 100,
			exec: 'reader',
		},
	},
	thresholds: {
		chat_latency_ms: ['p(95)<500'],           // 通过线 500ms；目标 100ms 看报告
		'http_req_duration{scenario:read}': ['p(95)<500'],
		'http_req_failed{scenario:send}': ['rate<0.01'],
	},
	// 2500 WS 长连接：k6 默认每 VU 一个 runtime，够用；磁盘/网络指标关掉省开销
	noConnectionReuse: false,
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

// ---------- 场景：WS 接收端 ----------
export function receiver() {
	const userIdx = (__VU - 1) % N_USERS;
	const uid = allUserUids[userIdx];
	const myRooms = roomsByUserIdx[userIdx];
	if (!myRooms || myRooms.length === 0) { wsErrors.add(1); return; }
	const roomId = myRooms[Math.floor(Math.random() * myRooms.length)];
	const token = mintJwt(String(uid), 7200);
	const sessionMs = 60000 + Math.floor(Math.random() * 60000); // 60–120s
	const url = `${WS_BASE}/connection/websocket`;

	ws.connect(url, {}, (socket) => {
		let cmdId = 0;
		const deadline = Date.now() + sessionMs;

		socket.on('open', () => {
			cmdId += 1;
			socket.send(JSON.stringify({ id: cmdId, connect: { token, name: 'k6' } }));
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
			if (msg.id && msg.error) {
				// subscribe 被拒（BFF proxy 拦截）或 connect 失败
				wsSubscribeDenied.add(1);
				return;
			}
			const push = msg.push;
			if (!push || !push.pub || !push.pub.data) { return; }
			const data = push.pub.data;
			if (data.type === 'chat.new' && data.message && typeof data.message.content === 'string') {
				const m = data.message.content.match(/\[lt-ping\] (\d+)/);
				if (m) {
					chatLatency.add(Date.now() - parseInt(m[1], 10));
					chatReceived.add(1);
				}
			}
		});

		socket.on('error', () => { wsErrors.add(1); });
		socket.setInterval(() => { if (Date.now() > deadline) { socket.close(); } }, 1000);
	});
	// ws.connect 返回即会话已关闭（VU 迭代结束，ramping-vus 补位重连）
	sleep(Math.random() * 2); // 重连抖动，防齐步风暴
}

// ---------- 场景：消息发送端 ----------
export function sender() {
	const tu = tokenUsers[Math.floor(Math.random() * tokenUsers.length)];
	const userIdx = seed.allUserUids.indexOf(tu.uid);
	const myRooms = roomsByUserIdx[userIdx];
	if (!myRooms || myRooms.length === 0) { sendErrors.add(1); return; }
	const roomId = myRooms[Math.floor(Math.random() * myRooms.length)];

	const ts = Date.now();
	const nonce = Math.random().toString(36).slice(2, 10);
	const res = http.post(
		`${HTTP_BASE}/api/v3/chats/${roomId}`,
		JSON.stringify({ message: `[lt-ping] ${ts} ${nonce}` }),
		{
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${tu.token}`,
			},
			tags: { scenario: 'send' },
			timeout: '30s',
		}
	);
	const ok = check(res, { 'send 200': (r) => r.status === 200 });
	if (ok) { chatSentOk.add(1); } else {
		sendErrors.add(1);
		if (__ENV.LT_LOG_ERRORS === '1') {
			let status;
			try { status = res.json('status'); } catch { /* 非 JSON 仅记录 HTTP 状态 */ }
			console.warn(`send failed: HTTP ${res.status} ${JSON.stringify(status || {})}`);
		}
	}
}

// ---------- 场景：HTTP 读路径 ----------
export function reader() {
	// 30% 打父分类（全卡列表，3000 子分类分页），70% 打随机卡分类
	if (Math.random() < 0.3) {
		http.get(`${HTTP_BASE}/api/category/${seed.parentCid}`, {
			tags: { scenario: 'read', endpoint: 'category-parent' },
			timeout: '30s',
		});
	} else {
		const cid = cids[Math.floor(Math.random() * cids.length)];
		http.get(`${HTTP_BASE}/api/category/${cid}`, {
			tags: { scenario: 'read', endpoint: 'category-card' },
			timeout: '30s',
		});
	}
}
