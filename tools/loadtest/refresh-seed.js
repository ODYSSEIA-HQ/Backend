'use strict';

// Copy beside NodeBB src/, together with memberships.mjs. Does not change DB permissions.
const fs = require('node:fs');
const file = process.argv[2] || '/tmp/lt/seed-output.json';
require('nconf').file({ file: process.env.CONFIG || '/opt/config/config.json' });
const db = require('./src/database');

(async () => {
	const { snapshotMemberships } = await import('./memberships.mjs');
	const seed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
	await db.init();
	seed.roomsByUserIdx = await snapshotMemberships(db, seed);
	seed.membershipsCheckedAt = new Date().toISOString();
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(seed), { mode: 0o600 });
	fs.renameSync(`${file}.tmp`, file);
	console.log(JSON.stringify({ users: seed.allUserUids.length, rooms: seed.roomIds.length,
		memberships: seed.roomsByUserIdx.reduce((n, rooms) => n + rooms.length, 0) }));
	await db.close();
	process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
