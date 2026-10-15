'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = resolve(__dirname, '../..');

// Exercise the shipped modules through their public API/middleware without a DB.
function load(relativePath, dependencies, globals = {}) {
	const module = { exports: {} };
	const requireStub = name => {
		assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
		return dependencies[name];
	};
	requireStub.main = { require: () => null };
	vm.runInNewContext(readFileSync(resolve(root, relativePath), 'utf8'), {
		module, exports: module.exports, require: requireStub,
		console: { log() {} }, process: { env: {} }, Buffer, ...globals,
	}, { filename: relativePath });
	return module.exports;
}

function chats(config, state) {
	const calls = { reputation: 0, privileges: 0, access: 0, saved: 0 };
	const api = load('nodebb/upstream/NodeBB/src/api/chats.js', {
		winston: {}, '../database': {}, '../privileges': {}, '../socket.io': {}, '../socket.io/helpers': {},
		'../meta': { config },
		'../utils': { isNumber: value => Number.isFinite(Number(value)) },
		'../plugins': { hooks: { fire: async (name, data) => data } },
		'../user': {
			getUserField: async () => { calls.reputation++; return state.reputation; },
			isPrivileged: async () => { calls.privileges++; return state.privileged; },
			isAdministrator: async () => false,
			updateOnlineUsers() {},
		},
		'../messaging': {
			canMessageRoom: async () => { calls.access++; if (state.denied) throw new Error('denied'); },
			checkContent: async () => {},
			addMessage: async () => { calls.saved++; return { mid: 1 }; },
			notifyUsersInRoom() {},
			canMessageUser: async () => {},
			notificationSettings: { ALLMESSAGES: 1 },
			newRoom: async () => 1,
			getRoomData: async () => ({ roomId: 1 }),
		},
	}, { Date: class extends Date { static now() { return 10000; } } });
	return { api, calls };
}

test('chat throttling preserves old decisions for HTTP and socket callers', async () => {
	for (const [normal, newcomer] of [[0, 0], [100, 100], [100, 1000], [1000, 100]]) {
		for (const reputation of [0, 10, 100, null]) {
			for (const privileged of [false, true]) {
				for (const age of [0, 1, 99, 100, 101, 499, 500, 999, 1000, 1001]) {
					for (const http of [false, true]) {
						const { api, calls } = chats({
							chatMessageDelay: normal, newbieChatMessageDelay: newcomer, newbieReputationThreshold: 10,
						}, { reputation, privileged });
						const session = { lastChatMessageTime: 10000 - age };
						const caller = { uid: 1, ...(http ? { request: { session } } : { session }) };
						const delay = !privileged && 10 > reputation ? newcomer : normal;
						const send = api.post(caller, { roomId: 1, message: 'hello' });
						if (age < delay) {
							await assert.rejects(send, /too-many-messages/);
							assert.equal(session.lastChatMessageTime, 10000 - age);
						} else {
							await send;
							assert.equal(session.lastChatMessageTime, 10000);
						}
						assert.equal(calls.access, 1);
						const needsIdentity = age < Math.max(normal, newcomer) && normal !== newcomer;
						assert.equal(calls.privileges, needsIdentity && 10 > reputation ? 1 : 0);
						assert.equal(calls.reputation, needsIdentity ? 1 : 0);
					}
				}
			}
		}
	}
});

test('room creation retains throttling and privilege changes take effect immediately', async () => {
	const state = { reputation: 0, privileged: true };
	const { api } = chats({ chatMessageDelay: 100, newbieChatMessageDelay: 1000, newbieReputationThreshold: 10 }, state);
	const caller = { uid: 1, session: { lastChatRoomCreateTime: 9500 } };
	await api.create(caller, { uids: [2] });
	state.privileged = false;
	caller.session.lastChatRoomCreateTime = 9500;
	await assert.rejects(api.create(caller, { uids: [2] }), /too-many-messages/);
});

test('first send skips identity lookup but the next send in the same session is throttled', async () => {
	const { api, calls } = chats({ chatMessageDelay: 100, newbieChatMessageDelay: 1000, newbieReputationThreshold: 10 }, { reputation: 0, privileged: false });
	const caller = { uid: 1, session: {} };
	await api.post(caller, { roomId: 1, message: 'first' });
	assert.equal(calls.privileges, 0);
	assert.equal(calls.reputation, 0);
	await assert.rejects(api.post(caller, { roomId: 1, message: 'second' }), /too-many-messages/);
	assert.equal(calls.privileges, 1);
	assert.equal(calls.saved, 1);
});

test('fast path still rejects unauthorized room writes', async () => {
	const { api, calls } = chats({ chatMessageDelay: 0, newbieChatMessageDelay: 0 }, { denied: true });
	await assert.rejects(api.post({ uid: 1, session: {} }, { roomId: 1, message: 'hello' }), /denied/);
	assert.equal(calls.saved, 0);
});

async function bridge(env = {}) {
	let now = 0;
	const refreshes = [];
	const middlewares = [];
	const plugin = load('plugins/nodebb-plugin-odysseia-bridge/library.js', {
		http: {
			get(options, callback) {
				const response = new EventEmitter();
				response.statusCode = 200;
				refreshes.push({ options, response });
				callback(response);
				const request = new EventEmitter();
				request.setTimeout = () => {};
				return request;
			},
		},
		crypto: require('node:crypto'),
		'./lib/centrifugo': { publish: async () => {} }, './lib/search': {}, './lib/decor': {}, './lib/slowmode': {}, './lib/reactions': {},
		'./lib/internal': { mount() {} },
	}, {
		process: { env },
		Date: class extends Date { static now() { return now; } },
	});
	await plugin.init({ router: { use: fn => middlewares.push(fn) } });
	return {
		plugin, rate: middlewares[0], cache: middlewares[1], refreshes,
		advance: value => { now += value; },
	};
}

function request(path = '/api/category/1', overrides = {}) {
	return { method: 'GET', path, originalUrl: path, headers: {}, ip: 'client', socket: { remoteAddress: '172.20.0.2', localPort: 4567 }, ...overrides };
}

test('native notification compatibility switch preserves the upstream hook payload', async () => {
	const data = { roomId: 1, fromUid: 2, message: { mid: 3 } };
	const enabled = await bridge({ ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY: '0' });
	assert.equal(await enabled.plugin.onChatNotify(data), data);
	const disabled = await bridge({ ODYSSEIA_DISABLE_NATIVE_CHAT_NOTIFY: '1' });
	assert.equal(await disabled.plugin.onChatNotify(data), undefined);
});

function response() {
	return Object.assign(new EventEmitter(), {
		statusCode: 200, headers: {},
		set(headers) { Object.assign(this.headers, headers); return this; },
		status(code) { this.statusCode = code; return this; },
		json(body) { this.body = body; return this; },
	});
}

async function render(cache, req, body = { cid: 1 }) {
	const res = response();
	let renders = 0;
	await cache(req, res, () => { renders++; res.json(body); });
	return { res, renders };
}

test('forged refresh headers cannot bypass throttling or force cache misses', async () => {
	const { rate, cache } = await bridge({ ODYSSEIA_API_RATE_MAX: '1' });
	const req = request(undefined, { headers: { 'x-odysseia-cache-refresh': '1' } });
	await rate(req, response(), () => {});
	const limited = response();
	await rate(req, limited, () => assert.fail('rate bypass'));
	assert.equal(limited.statusCode, 429);
	await render(cache, req);
	assert.equal((await render(cache, req)).renders, 0);
});

test('TTL=0 disables caching; STALE=0 disables stale replay; unrelated routes bypass cache', async () => {
	const disabled = await bridge({ ODYSSEIA_CATEGORY_CACHE_TTL_MS: '0' });
	await render(disabled.cache, request());
	assert.equal((await render(disabled.cache, request())).renders, 1);
	const noStale = await bridge({ ODYSSEIA_CATEGORY_CACHE_TTL_MS: '10', ODYSSEIA_CATEGORY_CACHE_STALE_MS: '0' });
	await render(noStale.cache, request());
	noStale.advance(10);
	assert.equal((await render(noStale.cache, request())).renders, 1);
	for (const req of [request('/api/category/1oops'), request(undefined, { method: 'POST' })]) {
		await render(noStale.cache, req);
		assert.equal((await render(noStale.cache, req)).renders, 1);
	}
});

test('background refresh is single-flight, worker-local, and does not evict unrelated entries', async () => {
	const { cache, rate, advance, refreshes } = await bridge({
		ODYSSEIA_CATEGORY_CACHE_TTL_MS: '10', ODYSSEIA_CATEGORY_CACHE_MAX: '2', ODYSSEIA_API_RATE_MAX: '1',
	});
	await render(cache, request('/api/category/1'));
	await render(cache, request('/api/category/2'));
	advance(10);
	await render(cache, request('/api/category/2'));
	await render(cache, request('/api/category/2'));
	assert.equal(refreshes.length, 1);
	const refresh = refreshes[0];
	const internal = request('/api/category/2', { headers: refresh.options.headers, socket: { remoteAddress: '127.0.0.1', localPort: 4567 } });
	assert.equal((await render(cache, internal)).renders, 1);
	await rate(request(), response(), () => {}); // exhaust the public bucket
	let bypassed = false;
	await rate(internal, response(), () => { bypassed = true; });
	assert.equal(bypassed, true);
	const external = response();
	await rate(request(undefined, { headers: refresh.options.headers }), external, () => assert.fail('non-loopback bypass'));
	assert.equal(external.statusCode, 429);
	const otherWorker = await bridge({ ODYSSEIA_API_RATE_MAX: '1' });
	await otherWorker.rate(request(), response(), () => {});
	const wrongWorker = response();
	await otherWorker.rate(internal, wrongWorker, () => assert.fail('cross-worker bypass'));
	assert.equal(wrongWorker.statusCode, 429);
	refresh.response.emit('data', Buffer.from('{"cid":2,"updated":true}'));
	refresh.response.emit('end');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal((await render(cache, request('/api/category/1'))).renders, 0);
	assert.equal((await render(cache, request('/api/category/2'))).res.body.updated, true);
});
