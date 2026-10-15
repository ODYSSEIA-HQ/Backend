// Shared by Node seed export and k6. Never infer authorization from room order.
export function roomsByUser(seed) {
	const { allUserUids, roomIds, roomsByUserIdx } = seed;
	for (const ids of [allUserUids, roomIds]) {
		if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
			ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
			throw new Error('Invalid seed: user and room IDs must be unique positive integers');
		}
	}
	if (!Array.isArray(roomsByUserIdx) || roomsByUserIdx.length !== allUserUids.length) {
		throw new Error('Missing membership snapshot; run refresh-seed.js before the load test');
	}
	const allowed = new Set(roomIds);
	const covered = new Set();
	for (const rooms of roomsByUserIdx) {
		if (!Array.isArray(rooms) || !rooms.length || new Set(rooms).size !== rooms.length ||
			rooms.some(id => !allowed.has(id))) {
			throw new Error('Invalid membership snapshot: empty, duplicate or unknown rooms');
		}
		rooms.forEach(id => covered.add(id));
	}
	if (covered.size !== allowed.size) throw new Error('Some rooms have no load-test members');
	return roomsByUserIdx;
}

export async function snapshotMemberships(db, seed) {
	const keys = seed.roomIds.map(id => `chat:room:${id}:uids`);
	const snapshot = [];
	// One batch per user, bounded concurrency; use the same membership set as NodeBB.
	for (const uid of seed.allUserUids) {
		const flags = await db.isMemberOfSortedSets(keys, uid);
		snapshot.push(seed.roomIds.filter((id, index) => flags[index]));
	}
	return roomsByUser({ ...seed, roomsByUserIdx: snapshot });
}
