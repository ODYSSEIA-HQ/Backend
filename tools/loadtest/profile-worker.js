'use strict';

// docker cp tools/loadtest/profile-worker.js odysseia-nodebb-1:/tmp/profile-worker.js
// docker exec odysseia-nodebb-1 node /tmp/profile-worker.js [seconds] [pid]
// 只监听容器回环；结束时关闭 inspector，不改应用代码。
const fs = require('node:fs');
const seconds = Math.min(45, Math.max(1, Number(process.argv[2]) || 15));
const rss = pid => {
	try { return Number(fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] || 0); }
	catch { return 0; }
};
const pid = Number(process.argv[3]) || fs.readdirSync('/proc')
	.filter(p => /^\d+$/.test(p))
	.map(Number)
	.sort((a, b) => rss(b) - rss(a))
	.find(p => {
		try {
			return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').includes('/usr/src/app/app.js');
		} catch { return false; }
	});

async function main() {
	if (!pid) throw new Error('No NodeBB worker found');
	process.kill(pid, 'SIGUSR1');
	let target;
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			[target] = await (await fetch('http://127.0.0.1:9229/json/list')).json();
			if (target) break;
		} catch { /* 等待 inspector 就绪 */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	if (!target) throw new Error('Inspector did not start');
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true });
		socket.addEventListener('error', reject, { once: true });
	});
	let id = 0;
	const pending = new Map();
	socket.addEventListener('message', ({ data }) => {
		const reply = JSON.parse(data);
		const call = pending.get(reply.id);
		if (!call) return;
		pending.delete(reply.id);
		clearTimeout(call.timeout);
		if (reply.error) call.reject(new Error(reply.error.message));
		else call.resolve(reply.result);
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const callId = ++id;
		const timeout = setTimeout(() => {
			pending.delete(callId);
			reject(new Error(`${method} timed out`));
		}, 10000);
		pending.set(callId, { resolve, reject, timeout });
		socket.send(JSON.stringify({ id: callId, method, params }));
	});
	let verified = false;
	try {
		const identity = await send('Runtime.evaluate', { expression: 'process.pid', returnByValue: true });
		if (identity.result.value !== pid) throw new Error('Port 9229 belongs to another process');
		verified = true;
		await send('Runtime.evaluate', { expression: `(() => {
			const { PerformanceObserver, monitorEventLoopDelay } = process.mainModule.require('node:perf_hooks');
			const state = { gcCount: 0, gcTotalMs: 0, gcMaxMs: 0 };
			state.loop = monitorEventLoopDelay({ resolution: 20 });
			state.loop.enable();
			state.observer = new PerformanceObserver(list => {
				for (const entry of list.getEntries()) {
					state.gcCount++;
					state.gcTotalMs += entry.duration;
					state.gcMaxMs = Math.max(state.gcMaxMs, entry.duration);
				}
			});
			state.observer.observe({ entryTypes: ['gc'] });
			globalThis.__odyProfileObservation = state;
			return true;
		})()` });
		await send('Profiler.enable');
		await send('Profiler.start');
		await new Promise(resolve => setTimeout(resolve, seconds * 1000));
		const { profile } = await send('Profiler.stop');
		fs.writeFileSync('/tmp/odysseia-worker.cpuprofile', JSON.stringify(profile));
		const memory = await send('Runtime.evaluate', { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true });
		const observation = await send('Runtime.evaluate', { expression: `(() => {
			const state = globalThis.__odyProfileObservation;
			state.loop.disable();
			state.observer.disconnect();
			const result = { gcCount: state.gcCount, gcTotalMs: state.gcTotalMs, gcMaxMs: state.gcMaxMs,
				loopP99Ms: state.loop.percentile(99) / 1e6, loopMaxMs: state.loop.max / 1e6 };
			delete globalThis.__odyProfileObservation;
			return JSON.stringify(result);
		})()`, returnByValue: true });
		const totals = new Map();
		for (const node of profile.nodes) {
			const frame = node.callFrame;
			const key = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
			totals.set(key, (totals.get(key) || 0) + (node.hitCount || 0));
		}
		console.log(JSON.stringify({ pid, seconds, memory: JSON.parse(memory.result.value), observation: JSON.parse(observation.result.value), top: [...totals]
			.sort((a, b) => b[1] - a[1]).slice(0, 25) }, null, 2));
	} finally {
		// 异步关闭 inspector，先让协议响应发出，再断连接。
		if (verified) await send('Runtime.evaluate', { expression: 'if (globalThis.__odyProfileObservation) { __odyProfileObservation.loop.disable(); __odyProfileObservation.observer.disconnect(); delete globalThis.__odyProfileObservation; } setTimeout(() => process.mainModule.require("node:inspector").close(), 100); true' }).catch(() => {});
		socket.close();
	}
}

main().catch(err => { console.error(err.message); process.exitCode = 1; });
