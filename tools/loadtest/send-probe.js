// 空载单请求探针：区分「固有处理时间」与「排队延迟」
// 用法：docker run --rm --network odysseia_app -v <loadtest>:/loadtest grafana/k6 run /loadtest/send-probe.js
import http from 'k6/http';
import { sleep } from 'k6';
import { Trend } from 'k6/metrics';

const sendDur = new Trend('probe_send_ms');
const HTTP_BASE = __ENV.LT_HTTP_BASE || 'http://caddy:8090';

const seedRaw = (() => {
	try { return open('/loadtest/seed-output.json'); } catch (e) { /* 宿主机直跑回退 */ }
	return open('./seed-output.json');
})();
const seed = JSON.parse(seedRaw);
const N = seed.allUserUids.length;
const u = seed.users[0];
const idx = seed.allUserUids.indexOf(u.uid);
const rooms = [];
seed.roomIds.forEach((rid, z) => {
	const i = z + 1;
	if (i % N === idx || (i + 7) % N === idx) rooms.push(rid);
});
if (!rooms.length) { throw new Error('no room for user[0]'); }
const roomId = rooms[0];

export const options = { vus: 1, iterations: 20, thresholds: {} };

export default function () {
	const res = http.post(
		`${HTTP_BASE}/api/v3/chats/${roomId}`,
		JSON.stringify({ message: 'probe ping' }),
		{
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` },
			timeout: '30s',
		}
	);
	sendDur.add(res.timings.duration);
	if (res.status !== 200) { console.log(`status=${res.status} body=${res.body && res.body.slice(0, 120)}`); }
	sleep(2);
}
