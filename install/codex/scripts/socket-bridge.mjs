import WebSocket from 'ws';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const socket = process.argv[2] || join(process.env.CODEX_HOME || join(process.env.HOME, '.codex'), 'app-server-control', 'app-server-control.sock');
if (!socket.startsWith('/') || /[:?]/.test(socket)) throw Error('Expected an absolute Unix socket path without colon or question mark');
const ws = new WebSocket(`ws+unix:${socket}:/`, { handshakeTimeout: 5000, maxPayload: 64 * 1024 * 1024 });
const queue = [];
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (ws.readyState === WebSocket.OPEN) ws.send(line); else queue.push(line); });
ws.on('open', () => { for (const line of queue.splice(0)) ws.send(line); });
ws.on('message', data => process.stdout.write(data.toString() + '\n'));
ws.on('error', error => { console.error(error.message); process.exit(1); });
ws.on('close', () => process.exit(0));
input.on('close', () => ws.close());
