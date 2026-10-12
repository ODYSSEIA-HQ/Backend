'use strict';

/**
 * Centrifugo HTTP API 客户端（fire-and-forget：广播失败只记日志，绝不阻塞 NodeBB 主流程）
 */
const API_URL = process.env.CENTRIFUGO_API_URL || 'http://centrifugo:8000/api';
const API_KEY = process.env.CENTRIFUGO_HTTP_API_KEY || '';

async function publish(channel, data) {
	try {
		const res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				Authorization: `apikey ${API_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ method: 'publish', params: { channel, data } }),
		});
		if (!res.ok) {
			console.error(`[odysseia-bridge] centrifugo publish ${channel} 失败: HTTP ${res.status}`);
		}
	} catch (err) {
		console.error(`[odysseia-bridge] centrifugo 不可达 (${channel}):`, err.message);
	}
}

module.exports = { publish };
