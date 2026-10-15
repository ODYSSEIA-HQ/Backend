// ODYSSEIA 压测造数据——容器内直调 NodeBB src API（绕开 HTTP 慢速层）
// 用法（nodebb 容器内；require('./src/*') 相对本文件位置解析，
//       故必须落在 /usr/src/app 下跑，别放 /tmp）：
//   docker exec odysseia-nodebb-1 mkdir -p /tmp/lt
//   docker cp tools/loadtest/seed.js odysseia-nodebb-1:/usr/src/app/lt-seed.js
//   docker cp tools/loadtest/memberships.mjs odysseia-nodebb-1:/usr/src/app/memberships.mjs
//   docker exec -w /usr/src/app odysseia-nodebb-1 node lt-seed.js [--categories 3000] [--topics-per-cat 10] [--rooms 4000] [--users 60]
//   docker cp odysseia-nodebb-1:/tmp/lt/seed-output.json tools/loadtest/seed-output.json
// 幂等：已造数据登记在 lt:seeded:* zset，重跑自动跳过。
// 产出：/tmp/lt/seed-output.json（cid 列表 / roomId 列表 / 用户 token，供 k6 消费）
'use strict';

const path = require('path');
const fs = require('fs');
const nconf = require('nconf');

nconf.argv().env().file({ file: process.env.CONFIG || '/opt/config/config.json' });

const db = require('./src/database');
const Categories = require('./src/categories');
const Topics = require('./src/topics');
const User = require('./src/user');
const Messaging = require('./src/messaging');
const privileges = require('./src/privileges');
const apiUtils = require('./src/api/utils');

const args = {};
process.argv.slice(2).forEach((v, i, a) => {
	if (v.startsWith('--')) { args[v.slice(2)] = a[i + 1]; }
});
const N_CATEGORIES = parseInt(args.categories || '3000', 10);
const TOPICS_PER_CAT = parseInt(args['topics-per-cat'] || '10', 10);
const N_ROOMS = parseInt(args.rooms || '4000', 10);
const N_USERS = parseInt(args.users || '60', 10);
const N_TOKEN_USERS = Math.min(20, N_USERS); // 写 API token 只发给前 20 个用户
const BATCH = 8;

const REG = { users: 'lt:seeded:users', cats: 'lt:seeded:cats', rooms: 'lt:seeded:rooms' };
const pad = (n, w = 5) => String(n).padStart(w, '0');
let done = 0;
function progress(label, total) {
	done += 1;
	if (done % 200 === 0 || done === total) {
		console.log(`[seed] ${label} ${done}/${total}`);
	}
}

async function mapBatch(items, size, fn) {
	const out = [];
	for (let i = 0; i < items.length; i += size) {
		const chunk = items.slice(i, i + size);
		out.push(...await Promise.all(chunk.map(fn)));
	}
	return out;
}

async function seedUsers() {
	const existing = new Set(await db.getSortedSetRange(REG.users, 0, -1));
	const wanted = Array.from({ length: N_USERS }, (_, i) => `lt-user-${pad(i + 1)}`);
	const toCreate = wanted.filter(u => !existing.has(u));
	if (toCreate.length) {
		await mapBatch(toCreate, BATCH, async (username) => {
			const uid = await User.create({
				username,
				password: `lt-pass-${username}`,
				email: `${username}@loadtest.local`,
			});
			await db.sortedSetAdd(REG.users, uid, username);
			progress('users', toCreate.length);
		});
	}
	const rows = await Promise.all(wanted.map(u => db.sortedSetScore(REG.users, u).then(uid => ({ username: u, uid }))));
	return rows.map(r => ({ username: r.username, uid: parseInt(r.uid, 10) }));
}

async function seedTokens(users) {
	const out = [];
	for (const u of users.slice(0, N_TOKEN_USERS)) {
		// tokens.generate 返回 token 字符串本体（不是对象）
		const token = await apiUtils.tokens.generate({ uid: u.uid, description: 'loadtest' });
		out.push({ username: u.username, uid: u.uid, token });
	}
	return out;
}

async function seedCategories(adminUid) {
	// 父分类「卡讨论区」：卡分类统一挂载点
	let parentCid = await db.getObjectField('lt:seeded:meta', 'parentCid');
	if (!parentCid) {
		const parent = await Categories.create({
			name: '卡讨论区',
			description: 'loadtest 卡分类挂载点',
		});
		parentCid = parent.cid;
		await db.setObject('lt:seeded:meta', { parentCid: String(parentCid) });
		// 父分类权限：注册可读写、游客可读（卡分类批量继承同一口径）
		await privileges.categories.give(['find', 'read', 'topics:create', 'topics:reply'], parentCid, 'registered-users');
		await privileges.categories.give(['find', 'read'], parentCid, 'guests');
	}
	parentCid = parseInt(parentCid, 10);

	const existing = new Set((await db.getSortedSetRange(REG.cats, 0, -1)).map(String));
	const wanted = Array.from({ length: N_CATEGORIES }, (_, i) => ({ handle: `card-${pad(i + 1)}`, idx: i + 1 }));
	const toCreate = wanted.filter(c => !existing.has(c.handle));
	const created = await mapBatch(toCreate, BATCH, async (c) => {
		const cat = await Categories.create({
			name: `Loadtest Card ${c.idx}`,
			description: `loadtest 卡分类 #${c.idx}`,
			parentCid,
		});
		await db.sortedSetAdd(REG.cats, c.idx, c.handle);
		await db.setObjectField(`lt:seeded:cat-cid`, c.handle, cat.cid);
		progress('categories', toCreate.length);
		return cat.cid;
	});
	// 批量授权（give 支持 cid 数组，250 一批）
	const allHandles = wanted.map(c => c.handle);
	const allCids = await Promise.all(allHandles.map(h => db.getObjectField('lt:seeded:cat-cid', h).then(Number)));
	const newCids = created.length ? allCids.filter(cid => cid) : [];
	for (let i = 0; i < newCids.length; i += 250) {
		const slice = newCids.slice(i, i + 250);
		await privileges.categories.give(['find', 'read', 'topics:create', 'topics:reply'], slice, 'registered-users');
		await privileges.categories.give(['find', 'read'], slice, 'guests');
	}
	console.log(`[seed] categories total=${allCids.length} (new ${toCreate.length})`);
	return { parentCid, cids: allCids.filter(Boolean) };
}

async function seedTopics(users, cids) {
	const seededKey = 'lt:seeded:topics-done';
	const donePairs = new Set(await db.getSortedSetRange(seededKey, 0, -1));
	const jobs = [];
	cids.forEach((cid) => {
		for (let t = 1; t <= TOPICS_PER_CAT; t += 1) {
			const key = `${cid}:${t}`;
			if (!donePairs.has(key)) { jobs.push({ cid, t, key }); }
		}
	});
	const filler = '这是一段用于压测的讨论内容正文，包含足够长度的文本以接近真实社区帖子体积。'.repeat(4);
	await mapBatch(jobs, BATCH, async (j) => {
		const u = users[j.t % users.length]; // 轮换作者，规避任何单用户限频
		await Topics.post({
			uid: u.uid,
			cid: j.cid,
			title: `卡 ${j.cid} 讨论串 ${j.t}`,
			content: `[lt] ${filler} (cid=${j.cid}, n=${j.t})`,
		});
		await db.sortedSetAdd(seededKey, Date.now(), j.key);
		progress('topics', jobs.length);
	});
	console.log(`[seed] topics total=${cids.length * TOPICS_PER_CAT} (new ${jobs.length})`);
}

async function seedRooms(users) {
	const existing = new Set((await db.getSortedSetRange(REG.rooms, 0, -1)).map(String));
	const wanted = Array.from({ length: N_ROOMS }, (_, i) => i + 1);
	const toCreate = wanted.filter(i => !existing.has(`room-${i}`));
	const now = Date.now();
	await mapBatch(toCreate, BATCH, async (i) => {
		const a = users[i % users.length];
		const b = users[(i + 7) % users.length];
		const roomId = await Messaging.newRoom(a.uid, { uids: [b.uid], roomName: `lt-room-${i}` });
		// 5 条消息，时间戳撒在最近一小时内（=「活跃线程」）
		for (let m = 0; m < 5; m += 1) {
			await Messaging.addMessage({
				uid: (m % 2 === 0 ? a : b).uid,
				roomId,
				content: `[lt] room ${i} msg ${m}`,
				timestamp: now - Math.floor(Math.random() * 3600_000),
			});
		}
		await db.sortedSetAdd(REG.rooms, i, `room-${i}`);
		await db.setObjectField('lt:seeded:room-id', `room-${i}`, roomId);
		progress('rooms', toCreate.length);
	});
	const roomIds = await Promise.all(wanted.map(i => db.getObjectField('lt:seeded:room-id', `room-${i}`).then(Number)));
	console.log(`[seed] rooms total=${roomIds.length} (new ${toCreate.length})`);
	return roomIds; // 缺失/重复 ID 由 snapshotMemberships 拒绝，不能静默缩小场景。
}

async function disableThrottles() {
	// 压测造数据/跑测期间关闭发帖节流（跑完报告需注明此偏差；生产配置不受影响——这是 dev 库）
	const meta = require('./src/meta');
	await meta.configs.set('postDelay', 0);
	await meta.configs.set('newbiePostDelay', 0);
	await meta.configs.set('initialPostDelay', 0);
	await meta.configs.set('newbiePostDelayThreshold', 0);
	console.log('[seed] throttles disabled');
}

(async () => {
	await db.init();
	await require('./src/meta').configs.init(); // post LRU 缓存依赖 meta.config.postCacheSize
	await disableThrottles();
	const adminUid = 1;
	console.log(`[seed] target: users=${N_USERS} categories=${N_CATEGORIES} topics/cat=${TOPICS_PER_CAT} rooms=${N_ROOMS}`);
	const users = await seedUsers();
	const tokens = await seedTokens(users);
	const { parentCid, cids } = await seedCategories(adminUid);
	await seedTopics(users, cids);
	const roomIds = await seedRooms(users);
	const output = {
		generatedAt: new Date().toISOString(),
		parentCid,
		cids,
		roomIds,
		users: tokens, // 仅前 20 个用户带写 API token
		allUserUids: users.map(u => u.uid),
	};
	const { snapshotMemberships } = await import('./memberships.mjs');
	output.roomsByUserIdx = await snapshotMemberships(db, output);
	output.membershipsCheckedAt = new Date().toISOString();
	fs.writeFileSync('/tmp/lt/seed-output.json', JSON.stringify(output), { mode: 0o600 });
	console.log(`[seed] DONE -> /tmp/lt/seed-output.json (${JSON.stringify(output).length} bytes)`);
	await db.close();
	process.exit(0);
})().catch((err) => {
	console.error('[seed] FAILED', err);
	process.exit(1);
});
