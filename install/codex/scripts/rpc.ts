import { createInterface } from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const daemonCommand = (socket?: string) => ['node', fileURLToPath(new URL('./socket-bridge.cjs', import.meta.url)), ...(socket ? [socket] : [])];

export class Rpc {
  process: ChildProcessWithoutNullStreams;
  sequence = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  listeners = new Set<(event: any) => void>();
  stderr = '';
  constructor(command = daemonCommand(), env = process.env) {
    this.process = spawn(command[0], command.slice(1), { env, stdio: 'pipe' });
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-1000); });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
      } else if (message.method && message.id === undefined) {
        for (const listener of this.listeners) listener(message);
      } else if (message.method && message.id !== undefined) {
        this.process.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Componion does not handle approvals or tool execution' } }) + '\n');
      }
    });
    const failed = () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error(`Codex v2 connection closed${this.stderr ? ': ' + this.stderr.trim() : ''}`)); }
      this.pending.clear();
    };
    this.process.on('exit', failed);
    this.process.on('error', failed);
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'componion', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.process.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return this;
  }
  call(method: string, params: any, timeout = 15000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out; outcome may be unknown`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  close() { this.process.stdin.end(); this.process.kill(); }
}
