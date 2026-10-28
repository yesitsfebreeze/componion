import { mkdir, unlink, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, json, sessionDir, safeId, root, parseRollout, updateStatus } from './core';
import { Rpc, daemonCommand } from './rpc';
import { nativeCompact, handoff } from './v2';

export type Mode = 'native' | 'handoff';
const jobFile = (id: string) => join(sessionDir(id), 'v2-job.json');
const lockFile = (id: string) => join(sessionDir(id), 'v2-job.lock');
export async function enqueue(threadId: string, mode: Mode) {
  safeId(threadId);
  if (!['native', 'handoff'].includes(mode)) throw Error('Unknown compaction mode');
  await mkdir(sessionDir(threadId), { recursive: true, mode: 0o700 });
  const lock = lockFile(threadId);
  try {
    const old = await json(lock);
    if (old) {
      let alive = false;
      if (old.pid > 0) { try { process.kill(old.pid, 0); alive = true; } catch {} }
      if (alive || Date.now() - old.ts < 30000) return { ...(await json(jobFile(threadId), {})), alreadyQueued: true };
      await unlink(lock);
    }
    const handle = await open(lock, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: 0, ts: Date.now() }));
    await handle.close();
  } catch (e: any) {
    if (e.code === 'EEXIST') return { ...(await json(jobFile(threadId), {})), alreadyQueued: true };
    throw e;
  }
  const job = { threadId, mode, state: 'queued', ts: Date.now() };
  await atomic(jobFile(threadId), job);
  const child = spawn(process.execPath, [import.meta.path, threadId, mode], { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', () => { void unlink(lock).catch(() => {}); });
  await atomic(lock, { pid: child.pid, ts: Date.now() });
  child.unref();
  return job;
}
export async function runJob(threadId: string, mode: Mode, rpc: Rpc) {
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    const { thread } = await rpc.call('thread/read', { threadId });
    if (thread.status?.type === 'idle') {
      await atomic(jobFile(threadId), { threadId, mode, state: 'running', ts: Date.now() });
      const result = mode === 'native' ? await nativeCompact(rpc, threadId) : await handoff(rpc, threadId);
      if (mode === 'native' && thread.path) await updateStatus(threadId, parseRollout(await readFile(thread.path, 'utf8')));
      const job = { threadId, mode, state: 'completed', result, ts: Date.now() };
      await atomic(jobFile(threadId), job);
      return job;
    }
    if (thread.status?.type !== 'active') throw Error(`Thread is ${thread.status?.type}; no live runtime to compact`);
    await Bun.sleep(1000);
  }
  throw Error('Thread stayed active for ten minutes; no compaction performed');
}
if (import.meta.main) {
  const [threadId, mode] = process.argv.slice(2);
  let rpc: Rpc | undefined;
  try {
    safeId(threadId);
    const config = await json(join(root(), 'config.json'), {});
    rpc = await new Rpc(daemonCommand(config.v2Socket)).initialize();
    await runJob(threadId, mode as Mode, rpc);
  } catch (e) {
    await atomic(jobFile(threadId), { threadId, mode, state: 'failed', error: String(e instanceof Error ? e.message : e), ts: Date.now() });
  } finally { rpc?.close(); await unlink(lockFile(threadId)).catch(() => {}); }
}
