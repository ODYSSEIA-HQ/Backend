'use strict';

// Run beside NodeBB src/. Exercise the shipped adapter against the configured Redis.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');
require('nconf').file({ file: process.env.CONFIG || '/opt/config/config.json' });
const { socketAdapter } = require('./src/database/redis');
const servers = [];
const adapters = [];
const clients = [];

(async () => {
	const namespace = `/adapter-smoke-${randomUUID()}`;
	const namespaces = [];
	for (let index = 0; index < 2; index++) {
		const server = new Server();
		servers.push(server);
		server.adapter(await socketAdapter());
		const nsp = server.of(namespace);
		namespaces.push(nsp);
		adapters.push(server.of('/').adapter, nsp.adapter);
		server.listen(0);
	}
	const connected = new Promise(resolve => namespaces[1].once('connection', resolve));
	const client = io(`http://127.0.0.1:${servers[1].httpServer.address().port}${namespace}`, {
		transports: ['websocket'], reconnection: false,
	});
	clients.push(client);
	const timeout = setTimeout(() => { console.error('Adapter smoke timed out'); process.exit(1); }, 15000);
	try {
		const remoteSocket = await connected;
		remoteSocket.data.uid = 'smoke-user';
		await remoteSocket.join('smoke-room');
		const sockets = await namespaces[0].in('smoke-room').fetchSockets();
		assert.deepEqual(sockets.map(socket => socket.data.uid), ['smoke-user']);
		await remoteSocket.leave('smoke-room');
		assert.equal((await namespaces[0].in('smoke-room').fetchSockets()).length, 0);
		console.log(JSON.stringify({ crossWorkerQuery: true, leaveVisibleImmediately: true }));
	} finally {
		clearTimeout(timeout);
	}
})().catch(err => { console.error(err.message); process.exitCode = 1; }).finally(async () => {
	clients.forEach(client => client.disconnect());
	await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
	const connections = new Set(adapters.flatMap(adapter => [adapter.pubClient, adapter.subClient]));
	await Promise.all([...connections].map(connection => connection.quit()));
});
