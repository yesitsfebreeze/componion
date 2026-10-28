import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Rpc, daemonCommand } from './rpc';
import { handoff, nativeCompact, requireIdle } from './v2';
import { enqueue } from './jobs';
import { json, root, sessionDir } from './core';
import { handle } from '../hooks/adapter';

const dir = await mkdtemp('/tmp/componion-v2-');
const originalHome = process.env.CODEX_HOME;
const requests: any[] = [];
let slow = false;
const http = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
  if (request.method !== 'POST') return new Response('{}', { headers: { 'content-type': 'application/json' } });
  const body = await request.json();
  requests.push(body);
  if (slow) await Bun.sleep(700);
  const text = JSON.stringify(body).includes('Summarize the conversation.') ? 'NATIVE_SUMMARY_PROOF' : 'MODEL_REPLY_SENTINEL';
  const id = `r${requests.length}`;
  const item = { type: 'message', id: `m${requests.length}`, role: 'assistant', content: [{ type: 'output_text', text }] };
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const grader = { ask: async (_state: any, questions: any) => ({ answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.01 }])) }) };
let rpc: Rpc | undefined;
let serverProcess: ReturnType<typeof spawn> | undefined;
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
try {
  process.env.CODEX_HOME = dir;
  await writeFile(join(dir, 'config.toml'), `model = "mock-model"\nmodel_provider = "fixture"\nmodel_auto_compact_token_limit = 1000000\ncompact_prompt = "Summarize the conversation."\n[features]\nhooks = false\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${http.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
  const socket = join(dir, 'rpc.sock');
  serverProcess = spawn('codex', ['app-server', '--listen', `unix://${socket}`], { env: { ...process.env, CODEX_HOME: dir }, stdio: 'ignore' });
  const ready = Date.now() + 10000;
  while (!(await stat(socket).catch(() => null)) && Date.now() < ready) await Bun.sleep(50);
  rpc = await new Rpc(daemonCommand(socket), { ...process.env, CODEX_HOME: dir }).initialize();
  await mkdir(root(), { recursive: true });
  await writeFile(join(root(), 'config.json'), JSON.stringify({ v2Socket: socket, foldFromTokens: 1, surface: 'sidecar' }));
  const start = await rpc.call('thread/start', { cwd: dir, baseInstructions: 'Synthetic test only.', approvalPolicy: 'never', sandbox: 'read-only', experimentalRawEvents: true });
  const sid = start.thread.id;
  async function turn(id: string, text: string) {
    let done = false, error = '';
    const listener = (e: any) => {
      if (e.params?.threadId !== id) return;
      if (e.method === 'turn/completed') { done = true; error = e.params.turn?.error?.message ?? ''; }
    };
    rpc!.listeners.add(listener);
    try {
      await rpc!.call('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }] });
      const end = Date.now() + 20000;
      while (!done && Date.now() < end) await Bun.sleep(50);
      assert(done && !error, `Turn failed: ${error || 'timeout'}`);
    } finally { rpc!.listeners.delete(listener); }
  }
  await turn(sid, 'Remember the initial test goal.');
  const items = Array.from({ length: 8 }, (_, i) => [
    { type: 'function_call', name: 'fixture_tool', call_id: `c${i}`, arguments: '{}' },
    { type: 'function_call_output', call_id: `c${i}`, output: `OLD_TOOL_${i}_` + 'unneeded fixture '.repeat(100) },
  ]).flat();
  await rpc.call('thread/inject_items', { threadId: sid, items });
  await turn(sid, 'This is the latest user request, preserve it.');
  slow = true;
  const activeTurn = turn(sid, 'Test the busy guard.');
  await Bun.sleep(150);
  let refused = false;
  try { await requireIdle(rpc, sid); } catch (e) { refused = String(e).includes('active'); }
  assert(refused, 'Busy thread was not refused');
  await activeTurn; slow = false;
  const before = await rpc.call('thread/read', { threadId: sid });
  const sourceBefore = await readFile(before.thread.path, 'utf8');
  const handed = await handoff(rpc, sid, grader);
  assert(handed.threadId !== sid, 'Handoff did not create a separate thread');
  await turn(handed.threadId, 'Check the handoff context.');
  const handoffInput = JSON.stringify(requests.at(-1).input);
  assert(!handoffInput.includes('OLD_TOOL_0_'), 'Dropped tool output remains in handoff request');
  assert(handoffInput.includes('latest user request'), 'Handoff lost recent user request');
  assert(handoffInput.includes('componion v2 handoff'), 'Handoff recall bridge is missing');
  const sourceAfter = await readFile(before.thread.path, 'utf8');
  assert(sourceAfter.startsWith(sourceBefore), 'Source thread history was rewritten');
  console.log(`PASS v2 JEV handoff: ${handed.removedChars} serialized chars removed; next model request omits old output and retains recent request; source preserved`);
  const result = await nativeCompact(rpc, sid, grader);
  await turn(sid, 'Check the compacted context.');
  const input = JSON.stringify(requests.at(-1).input);
  assert(input.includes('NATIVE_SUMMARY_PROOF'), 'Native summary missing from next model request');
  assert(input.includes(result.marker), 'JEV recall index missing from next model request');
  assert(!requests.at(-1).input.some((item: any) => item.role === 'assistant' && JSON.stringify(item).includes('MODEL_REPLY_SENTINEL')), 'Pre-compaction assistant message remains in next request');
  console.log('PASS v2 native compaction: completion observed; next model request contains summary and JEV recall index, not old assistant history');
  slow = true;
  const running = turn(sid, 'Check the queued worker after this turn.');
  await Bun.sleep(100);
  await handle({ session_id: sid, hook_event_name: 'Stop', transcript_path: before.thread.path, cwd: dir });
  const queued = await json(join(sessionDir(sid), 'v2-job.json'));
  assert(queued.state === 'queued', 'Worker did not enqueue');
  const duplicate = await enqueue(sid, 'native');
  assert(duplicate.alreadyQueued, 'Duplicate worker was started');
  await running; slow = false;
  const deadline = Date.now() + 30000;
  let job: any;
  while (Date.now() < deadline) {
    job = await json(join(sessionDir(sid), 'v2-job.json'));
    if (['completed', 'failed'].includes(job?.state)) break;
    await Bun.sleep(100);
  }
  assert(job?.state === 'completed', `Queued worker did not complete: ${JSON.stringify(job)}`);
  await turn(sid, 'Check queued compaction context.');
  assert(JSON.stringify(requests.at(-1).input).includes(job.result.marker), 'Queued recall missing from model input');
  console.log(`PASS Stop-triggered worker: queued during active turn, deduplicated, waited for idle, completed on the same socket; recall verified in next request; grader=${job.result.jev}`);
  console.log('PASS active-thread guard; no live user threads touched; local fixture model, deterministic grader for direct paths, configured JEV for worker');
} finally {
  rpc?.close(); serverProcess?.kill(); http.stop(true);
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  await rm(dir, { recursive: true, force: true });
}
