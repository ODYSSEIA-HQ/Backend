'use strict';

// Run beside NodeBB src/ with the refreshed local seed file. No credentials are logged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { io } = require('socket.io-client');
const base = 'http://127.0.0.1:4567';
const seed = JSON.parse(fs.readFileSync(process.argv[2] || '/tmp/lt/seed-output.json', 'utf8'));
const cookies = new Map();
let socket;

async function request(path, options = {}) {
	const response = await fetch(`${base}${path}`, {
		...options,
		headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...options.headers },
		signal: AbortSignal.timeout(15000),
	});
	for (const cookie of response.headers.getSetCookie()) {
		const pair = cookie.split(';')[0];
		const equal = pair.indexOf('=');
		cookies.set(pair.slice(0, equal), pair.slice(equal + 1));
	}
	assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
	return response.json();
}

(async () => {
	assert.equal(process.env.ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY, '0', 'Enable native notifications first');
	const { roomsByUser } = await import('./memberships.mjs');
	const rooms = roomsByUser(seed);
	let sender, receiver, roomId;
	for (const candidate of seed.users) {
		const own = rooms[seed.allUserUids.indexOf(candidate.uid)];
		const peer = seed.users.find(user => user.uid !== candidate.uid &&
			rooms[seed.allUserUids.indexOf(user.uid)].some(id => own.includes(id)));
		if (peer) {
			sender = candidate;
			receiver = peer;
			roomId = rooms[seed.allUserUids.indexOf(peer.uid)].find(id => own.includes(id));
			break;
		}
	}
	assert.ok(sender && receiver && roomId, 'Two seeded members must share a room');
	let config = await request('/api/config');
	await request('/api/v3/utilities/login', {
		method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': config.csrf_token },
		body: JSON.stringify({ username: receiver.username, password: `lt-pass-${receiver.username}` }),
	});
	config = await request('/api/config');
	socket = io(base, { transports: ['websocket'], reconnection: false, autoConnect: false,
		query: { _csrf: config.csrf_token },
		extraHeaders: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
	});
	const marker = `[native-smoke] ${Date.now()}`;
	const received = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Native message delivery timed out')), 15000);
		socket.on('event:chats.receive', data => {
			if (Number(data.roomId) === roomId && data.message.content.includes(marker)) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	// Attach a rejection handler before HTTP/connection work, then await the result below.
	received.catch(() => {});
	await new Promise((resolve, reject) => {
		socket.once('connect_error', reject);
		socket.once('connect', resolve);
		socket.connect();
	});
	await socket.timeout(5000).emitWithAck('modules.chats.enter', [roomId]);
	// Sender uses its Bearer identity, without the receiver's session cookie.
	// Write through another worker so the receiver exercises Redis cross-worker delivery.
	const response = await fetch(`http://127.0.0.1:4568/api/v3/chats/${roomId}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sender.token}` },
		body: JSON.stringify({ message: marker }), signal: AbortSignal.timeout(15000),
	});
	assert.equal(response.status, 200, `send: HTTP ${response.status}`);
	await received;
	console.log(JSON.stringify({ nativeMessageReceived: true, roomId, senderUid: sender.uid, receiverUid: receiver.uid }));
})().catch(err => { console.error(err.message); process.exitCode = 1; })
	.finally(() => { if (socket) socket.disconnect(); });
