'use strict';

/**
 * Meilisearch 索引同步 + 权限过滤查询：帖子事件 → posts 索引
 * 中文分词由 Meilisearch 引擎层（charabia）处理，这里只做文档映射
 *
 * 索引形态（单索引 posts，主帖/回帖同池）：
 *   - isMain = true 的文档携带 title（titles 搜索用 attributesToSearchOn 运行时限定）
 *   - cid 全量携带：查询侧按搜索者可读板块过滤，受限板块（R18/R18G）对无权者出局
 */
const { MeiliSearch } = require('meilisearch');

function loadModule(...paths) {
	for (const p of paths) {
		try {
			return require.main.require(p);
		} catch (e) {
			/* 尝试下一个路径 */
		}
	}
	return null;
}

// 整帖重建 / 主帖重刷时读库用；常规写路径不触碰 NodeBB 模块（事件 payload 自足）
const db = loadModule('./src/database');
const posts = loadModule('./src/posts');

const client = new MeiliSearch({
	host: process.env.MEILI_HOST || 'http://meilisearch:7700',
	apiKey: process.env.MEILI_MASTER_KEY || '',
});

const INDEX_UID = 'posts';
let indexReady = false;

async function ensureIndex() {
	if (indexReady) return;
	const task = await client.createIndex(INDEX_UID, { primaryKey: 'id' });
	await client.waitForTask(task.taskUid);
	await client.index(INDEX_UID).updateSettings({
		// title 仅主帖有值；posts / titles 检索域由查询侧 attributesToSearchOn 运行时切换
		searchableAttributes: ['content', 'title'],
		// cid / isMain 可过滤：搜索侧按阅读权限排除受限板块（R18/R18G）、标题搜索只打主帖
		filterableAttributes: ['tid', 'uid', 'timestamp', 'cid', 'isMain'],
		sortableAttributes: ['timestamp'],
	});
	indexReady = true;
}

/** post → 索引文档（Meilisearch 主键必须是字符串友好的数字，用 pid）
 *  title / isMain 只在明确提供时写入：addDocuments 是 upsert-merge 语义，
 *  编辑回帖（不带 title）不会抹掉主帖文档里已索引的标题 */
function toDoc(post) {
	const doc = {
		id: String(post.pid),
		pid: post.pid,
		tid: post.tid,
		cid: Number(post.cid) || 0, // 所属板块，权限过滤依据；无 cid 的旧文档为 0（不可被搜到）
		uid: post.uid,
		content: String(post.content || '').replace(/<[^>]*>/g, ' '), // 去标签，索引纯文本
		timestamp: post.timestamp || Date.now(),
	};
	if (post.isMain) doc.isMain = true;
	if (post.title) doc.title = String(post.title);
	return doc;
}

async function indexPost(post) {
	try {
		await ensureIndex();
		await client.index(INDEX_UID).addDocuments([toDoc(post)]);
	} catch (err) {
		console.error('[odysseia-bridge] meili 索引失败 pid=' + post.pid, err.message);
	}
}

async function deletePost(pid) {
	try {
		await ensureIndex();
		await client.index(INDEX_UID).deleteDocument(String(pid));
	} catch (err) {
		console.error('[odysseia-bridge] meili 删除失败 pid=' + pid, err.message);
	}
}

/** 整帖清除（topic.purge 时按 pids 批量删除） */
async function deleteTopicPosts(pids) {
	try {
		await ensureIndex();
		await client.index(INDEX_UID).deleteDocuments(pids.map(String));
	} catch (err) {
		console.error('[odysseia-bridge] meili 批量删除失败', err.message);
	}
}

/** 整帖软删摘索引：按 tid filter 批删（SDK deleteDocuments({ filter })，Meili v1.2+）。
 *  不能依赖 zset——topic 软删不动 tid:{tid}:posts，集合里帖子照旧 */
async function deleteTopic(tid) {
	try {
		await ensureIndex();
		await client.index(INDEX_UID).deleteDocuments({ filter: `tid = ${Number(tid)}` });
	} catch (err) {
		console.error('[odysseia-bridge] meili 整帖删除失败 tid=' + tid, err.message);
	}
}

/** 整帖恢复回索引：zset tid:{tid}:posts 当前恰为活跃帖集合（单帖软删已移出），
 *  逐帖重建并按 mainPid 回填主帖 isMain / title */
async function reindexTopic(tid, topicMeta) {
	try {
		if (!db || !posts || !tid) return;
		const pids = await db.getSortedSetRange(`tid:${Number(tid)}:posts`, 0, -1);
		if (!Array.isArray(pids) || !pids.length) return;
		const postsData = await posts.getPostsFields(pids, ['pid', 'tid', 'cid', 'uid', 'content', 'timestamp']);
		const docs = postsData.filter(Boolean).map((p) => {
			const doc = toDoc(p);
			if (topicMeta && topicMeta.mainPid && Number(topicMeta.mainPid) === Number(p.pid)) {
				doc.isMain = true;
				if (topicMeta.title) doc.title = String(topicMeta.title);
			}
			return doc;
		});
		if (!docs.length) return;
		await ensureIndex();
		await client.index(INDEX_UID).addDocuments(docs);
	} catch (err) {
		console.error('[odysseia-bridge] meili 整帖重建失败 tid=' + tid, err.message);
	}
}

/** 主帖单帖重刷（topic 改名后刷新索引 title，否则 titles 搜索命中旧标题） */
async function reindexMainPost(topicMeta) {
	try {
		if (!posts || !topicMeta || !topicMeta.mainPid) return;
		const [postData] = await posts.getPostsFields(
			[topicMeta.mainPid],
			['pid', 'tid', 'cid', 'uid', 'content', 'timestamp']
		);
		if (!postData) return;
		await ensureIndex();
		await client.index(INDEX_UID).addDocuments([toDoc({ ...postData, isMain: true, title: topicMeta.title })]);
	} catch (err) {
		console.error('[odysseia-bridge] meili 主帖重刷失败 tid=' + (topicMeta && topicMeta.tid), err.message);
	}
}

/**
 * 权限过滤查询（filter:search.query 的引擎侧）
 *
 * @param {object} payload hook payload：{ index: 'post'|'topic', content, matchWords, cid, uid, searchData, ids }
 *   - payload.cid 是用户在搜索界面勾选的板块范围，vendor 侧未做权限过滤，不可直信（须与 allowedCids 求交）
 *   - payload.uid 是按发帖人过滤（postedBy），不是搜索者身份
 * @param {number[]} allowedCids 搜索者可读板块集（library 侧 privileges.categories.filterCids 算好传入）
 * @returns {Promise<{ids: number[]}>} index='post' 时为 pids，index='topic' 时为 tids
 */
async function searchQuery(payload, allowedCids) {
	const isTopic = payload && payload.index === 'topic';
	const allowed = (Array.isArray(allowedCids) ? allowedCids : []).map(Number).filter(Boolean);
	const selected = (Array.isArray(payload && payload.cid) ? payload.cid : []).map(Number).filter(Boolean);
	const cids = selected.length ? allowed.filter(c => selected.includes(c)) : allowed;
	if (!cids.length) return { ids: [] };

	const filters = [`cid IN [${cids.join(',')}]`];
	if (isTopic) filters.push('isMain = true'); // 标题搜索只打主帖
	const uids = (Array.isArray(payload && payload.uid) ? payload.uid : []).map(Number).filter(Boolean);
	if (uids.length) filters.push(`uid IN [${uids.join(',')}]`);

	const opts = {
		filter: filters.join(' AND '),
		// posts 检索域限定正文 / titles 限定标题（Meili v1.3+ 运行时参数）
		attributesToSearchOn: isTopic ? ['title'] : ['content'],
		attributesToRetrieve: ['pid', 'tid'],
		// vendor 拿全量 ids 自行过滤 + 分页（matchCount / pageCount 在 vendor 侧算），此处给足量
		limit: 500,
	};
	if ((payload.matchWords || 'all') === 'any') {
		opts.matchingStrategy = 'last'; // 任一词命中即召回（近似 any）
	}
	const sortBy = payload.searchData && payload.searchData.sortBy;
	if (sortBy === 'timestamp') {
		opts.sort = ['timestamp:desc'];
	}

	await ensureIndex();
	const res = await client.index(INDEX_UID).search(String(payload.content || ''), opts);
	const ids = [];
	const seen = new Set();
	for (const hit of (res && res.hits) || []) {
		const id = Number(isTopic ? hit.tid : hit.pid);
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return { ids };
}

module.exports = {
	indexPost,
	deletePost,
	deleteTopicPosts,
	deleteTopic,
	reindexTopic,
	reindexMainPost,
	searchQuery,
};
