'use strict';

/**
 * Meilisearch 索引同步：帖子事件 → posts 索引
 * 中文分词由 Meilisearch 引擎层（charabia）处理，这里只做文档映射
 */
const { MeiliSearch } = require('meilisearch');

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
		searchableAttributes: ['content'],
		// cid 可过滤：搜索侧按阅读权限排除受限板块（R18/R18G）
		filterableAttributes: ['tid', 'uid', 'timestamp', 'cid'],
		sortableAttributes: ['timestamp'],
	});
	indexReady = true;
}

/** post → 索引文档（Meilisearch 主键必须是字符串友好的数字，用 pid） */
function toDoc(post) {
	return {
		id: String(post.pid),
		pid: post.pid,
		tid: post.tid,
		cid: Number(post.cid) || 0, // 所属板块，权限过滤依据；无 cid 的旧文档为 0
		uid: post.uid,
		content: String(post.content || '').replace(/<[^>]*>/g, ' '), // 去标签，索引纯文本
		timestamp: post.timestamp || Date.now(),
	};
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

/** 整帖清除（topic.purge 时批量删除） */
async function deleteTopicPosts(pids) {
	try {
		await ensureIndex();
		await client.index(INDEX_UID).deleteDocuments(pids.map(String));
	} catch (err) {
		console.error('[odysseia-bridge] meili 批量删除失败', err.message);
	}
}

module.exports = { indexPost, deletePost, deleteTopicPosts };
