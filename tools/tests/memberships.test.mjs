import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomsByUser, snapshotMemberships } from '../loadtest/memberships.mjs';

test('snapshot follows real membership rather than room order and reflects revocation', async () => {
	const seed = { allUserUids: [10, 20], roomIds: [8, 3] };
	const membership = new Map([[10, [false, true]], [20, [true, true]]]);
	const db = { isMemberOfSortedSets: async (keys, uid) => {
		assert.deepEqual(keys, ['chat:room:8:uids', 'chat:room:3:uids']);
		return membership.get(uid);
	} };
	assert.deepEqual(await snapshotMemberships(db, seed), [[3], [8, 3]]);
	membership.set(20, [true, false]);
	assert.deepEqual(await snapshotMemberships(db, seed), [[3], [8]]);
});

test('legacy, empty, incomplete and malformed snapshots fail before generating traffic', () => {
	const base = { allUserUids: [10, 20], roomIds: [8, 3] };
	for (const patch of [{}, { roomsByUserIdx: [[8]] }, { roomsByUserIdx: [[], [8, 3]] },
		{ roomsByUserIdx: [[8], [8]] }, { roomsByUserIdx: [[8, 8], [3]] },
		{ roomsByUserIdx: [[99], [3]] }, { roomIds: [8, 8], roomsByUserIdx: [[8], [8]] }]) {
		assert.throws(() => roomsByUser({ ...base, ...patch }));
	}
});
