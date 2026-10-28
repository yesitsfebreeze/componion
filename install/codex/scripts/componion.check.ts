import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archive, decompress, findTranscript, json, makeIndex, parseRollout, root, safeId, search, sessionDir, updateStatus } from './core';
import { bar, rows } from './deck';
import { dispatch } from './server';
import { handle } from '../hooks/adapter';
import { activeItems, foldedItems, requireIdle } from './v2';

let dir: string, old: string | undefined, rollout: string;
const sid = 'test-session';
const event = (type: string, payload: any) => JSON.stringify({ type, payload });
function fixture() {
  return [event('session_meta', { id: sid }), event('response_item', { type: 'message', role: 'user', content: [{ text: 'Preserve the exact originals' }] }),
    ...Array.from({ length: 8 }, (_, i) => [
      event('response_item', { type: 'function_call', name: 'exec_command', call_id: `call-${i}`, arguments: JSON.stringify({ cmd: `read ${i}` }) }),
      event('response_item', { type: 'function_call_output', call_id: `call-${i}`, output: `unique-${i} \u001b[31mλ\r\n` + 'repeated content '.repeat(100) }),
    ]).flat(), event('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 50000 }, model_context_window: 200000 } })].join('\n');
}
beforeEach(async () => {
  old = process.env.CODEX_HOME;
  dir = await mkdtemp(join(tmpdir(), 'componion-test-'));
  process.env.CODEX_HOME = dir;
  await mkdir(join(dir, 'sessions'), { recursive: true });
  rollout = join(dir, 'sessions', `rollout-${sid}.jsonl`);
  await writeFile(rollout, fixture());
});
afterEach(async () => {
  if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old;
  await rm(dir, { recursive: true, force: true });
});
test('parses paired Codex calls, last-request usage and malformed trailing lines', () => {
  const r = parseRollout(fixture() + '\n{"partial":');
  expect(r.messages).toHaveLength(17);
  expect(r.entries).toHaveLength(9);
  expect(r.messages[1].toolUses[0].input.cmd).toBe('read 0');
  expect(r.tokens).toBe(50000);
  expect(r.window).toBe(200000);
});
test('records native compaction separately and clears stale usage', () => {
  const r = parseRollout(fixture() + '\n' + event('compacted', { message: 'summary' }));
  expect(r.tokens).toBe(0);
  expect(r.nativeCompactions).toBe(1);
});
test('finds the matching rollout and rejects another session', async () => {
  expect(await findTranscript(sid)).toBe(rollout);
  expect(await findTranscript('other-session', rollout)).toBeUndefined();
});
test('rejects archive traversal and malformed session ids', () => {
  for (const bad of ['../secret', '/tmp/x', '', 'x/y', null]) expect(() => safeId(bad)).toThrow();
});
test('archives exact originals, searches them, and never edits the rollout', async () => {
  const before = await readFile(rollout, 'utf8');
  const data = await archive(sid, rollout);
  expect(await decompress(sid, data.entries[1].id)).toBe(data.entries[1].text);
  expect(await search(sid, 'unique-0')).toContain(data.entries[1].id);
  await archive(sid, rollout);
  expect(await readFile(rollout, 'utf8')).toBe(before);
});
test('JEV decisions change the index while originals remain recoverable', async () => {
  let requests = 0;
  const result = await makeIndex(sid, rollout, { ask: async (_state, questions) => {
    requests++;
    return { answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.01 }])) };
  } });
  expect(requests).toBeGreaterThan(0);
  expect(result.jev).toBe('jev');
  expect(result.text.split('\n')[1]).not.toContain('unique-0');
  const data = parseRollout(fixture());
  expect(await decompress(sid, data.entries[1].id)).toBe(data.entries[1].text);
  const status = await json(join(root(), 'status', `${sid}.json`));
  expect(status.saved).toBe(0);
  expect(status.folds).toBe(0);
});
test('failed grading keeps a deterministic recall index with a diagnostic', async () => {
  const result = await makeIndex(sid, rollout, { ask: async () => { throw Error('teacher offline'); } });
  expect(result.jev).toBe('jev failed: teacher offline');
  expect(result.text).toContain('unique-0');
});
test('startup preserves prior status; compact restart injects recall index', async () => {
  await makeIndex(sid, rollout, { ask: async () => { throw Error('offline'); } });
  const response = await handle({ session_id: sid, hook_event_name: 'SessionStart', source: 'compact', transcript_path: rollout, cwd: dir });
  expect(response?.hookSpecificOutput?.additionalContext).toContain('unique-0');
  expect((await json(join(root(), 'status', `${sid}.json`))).jev).toContain('offline');
});
test('disabled hooks produce no context or status', async () => {
  await mkdir(root(), { recursive: true });
  await writeFile(join(root(), 'config.json'), '{"enabled":false}');
  expect(await handle({ session_id: sid, hook_event_name: 'SessionStart' })).toBeUndefined();
  expect(await json(join(root(), 'status', `${sid}.json`))).toBeNull();
});
test('turn-end hooks emit the trio by default without blocking the turn', async () => {
  await mkdir(root(), { recursive: true });
  await writeFile(join(root(), 'config.json'), '{"autoCompact":false}');
  const prior = process.env.KERN_BIN;
  process.env.KERN_BIN = '/usr/bin/false';
  try {
    const output = await handle({ session_id: sid, hook_event_name: 'Stop', transcript_path: rollout, cwd: dir });
    expect(output?.systemMessage).toContain('ctx   ');
    expect(output?.systemMessage).toContain('kern  unavailable');
    expect(output?.systemMessage).toContain('orly  awaiting verdict');
    expect(output).not.toHaveProperty('decision');
    expect(output).not.toHaveProperty('continue');
  } finally { if (prior === undefined) delete process.env.KERN_BIN; else process.env.KERN_BIN = prior; }
});
test('failed archive prevents index publication', async () => {
  await expect(makeIndex(sid, join(dir, 'missing.jsonl'))).rejects.toThrow('No matching');
  expect(await json(join(sessionDir(sid), 'index.json'))).toBeNull();
});
test('bar agrees with Claude segment semantics and clamps invalid metrics', () => {
  expect(bar(50, 80, 100)).toBe('█████▓▓▓░░');
  expect(bar(90, 300, 100)).toBe('█████████▓');
  expect(bar(-1, NaN, 0)).toBe('░░░░░░░░░░');
});
test('trio rows expose missing producers and preserve the blocked verdict', () => {
  expect(rows({}, null, null, sid).join('\n')).toContain('kern  unavailable');
  const out = rows({ tokens: 45000, window: 200000, saved: 0 }, { pct: 58, blocked: true, items: ['check failed'] }, { build: '12345678', sessions: { [sid]: { offered: 5, used: 3 } } }, sid).join('\n');
  expect(out).toContain('★★★☆☆ 3/5 used');
  expect(out).toContain('58% blocked');
  expect(out).toContain('0 folded');
});
test('MCP initialize, list, recall, notifications and errors', async () => {
  expect((await dispatch({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }))?.result).toHaveProperty('protocolVersion', '2025-03-26');
  const tools: any = await dispatch({ id: 2, method: 'tools/list' });
  expect(tools.result.tools).toHaveLength(7);
  expect(await dispatch({ method: 'notifications/initialized' })).toBeUndefined();
  const data = await archive(sid, rollout);
  const answer: any = await dispatch({ id: 3, method: 'tools/call', params: { name: 'decompress', arguments: { session_id: sid, id: data.entries[1].id } } });
  expect(answer.result.content[0].text).toBe(data.entries[1].text);
  const bad: any = await dispatch({ id: 4, method: 'tools/call', params: { name: 'decompress', arguments: { session_id: sid, id: '../escape' } } });
  expect(bad.result.isError).toBe(true);
});
test('v2 uses replacement history instead of resurrecting pre-compaction items', () => {
  const before = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] };
  const after = { ...before, content: [{ type: 'input_text', text: 'summary' }] };
  const history = event('response_item', before) + '\n' + event('compacted', { replacement_history: [after] });
  expect(activeItems(history)).toEqual([after]);
  expect(() => activeItems(event('compacted', {}))).toThrow('no explicit');
  expect(() => activeItems(event('event_msg', { type: 'thread_rolled_back' }))).toThrow('Rolled-back');
});
test('v2 never selectively rewrites opaque signed history', async () => {
  let called = false;
  await expect(foldedItems([{ type: 'reasoning', encrypted_content: 'opaque' }], sid, { ask: async () => { called = true; return { answers: {} }; } })).rejects.toThrow('Opaque');
  expect(called).toBe(false);
});
test('v2 refuses active or unloaded threads before any mutation request', async () => {
  for (const state of ['active', 'notLoaded', 'systemError']) {
    const methods: string[] = [];
    const rpc = { call: async (method: string) => { methods.push(method); return { thread: { status: { type: state } } }; } };
    await expect(requireIdle(rpc as any, sid)).rejects.toThrow('requires an idle');
    expect(methods).toEqual(['thread/read']);
  }
});
test('v2 handoff removes complete call/result pairs and keeps recent pairs intact', async () => {
  const items = fixture().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'response_item').map(e => e.payload);
  const result = await foldedItems(items, sid, { ask: async (_s, q) => ({ answers: Object.fromEntries(Object.keys(q).map(k => [k, { noul: 0 }])) }) });
  expect(result.items.some(i => i.call_id === 'call-0')).toBe(false);
  expect(result.items.filter(i => i.call_id === 'call-7')).toHaveLength(2);
  expect(result.removedChars).toBeGreaterThan(0);
});
test('fast preparation avoids the teacher, caches unchanged rollouts and invalidates appended output', async () => {
  let asks = 0; const asker = { ask: async () => { asks++; throw Error('must not call'); } };
  const first = await makeIndex(sid, rollout, asker, { fast: true });
  expect(first.cacheHit).toBe(false);
  expect((await makeIndex(sid, rollout, asker, { fast: true })).cacheHit).toBe(true);
  await writeFile(rollout, fixture()+'\n'+event('response_item',{type:'function_call_output',call_id:'fresh',output:'newly appended Ω'}));
  const next = await makeIndex(sid, rollout, asker, { fast: true });
  expect(next.cacheHit).toBe(false); expect(next.text).toContain('newly appended Ω'); expect(asks).toBe(0);
  const entry = parseRollout(await readFile(rollout,'utf8')).entries.at(-1)!;
  expect(await decompress(sid,entry.id)).toBe('newly appended Ω');
});
test('fast preparation invalidates truncation and same-size rewrite', async () => {
  await makeIndex(sid,rollout,undefined,{fast:true});
  await writeFile(rollout,fixture().replace('unique-0','change-0'));
  expect((await makeIndex(sid,rollout,undefined,{fast:true})).cacheHit).toBe(false);
  await writeFile(rollout,event('session_meta',{id:sid})+'\n'+event('response_item',{type:'message',role:'user',content:[{text:'short replacement'}]}));
  const index=await makeIndex(sid,rollout,undefined,{fast:true});
  expect(index.entries).toBe(1);expect(index.text).toContain('short replacement');
});
test('PreCompact uses local recall even when grading is unavailable', async () => {
  await handle({session_id:sid,hook_event_name:'PreCompact',transcript_path:rollout});
  expect((await json(join(sessionDir(sid),'index.json'))).fast).toBe(true);
});
test('deleted originals invalidate fast cache and are restored before publishing',async()=>{
 await makeIndex(sid,rollout,undefined,{fast:true});
 const entry=parseRollout(fixture()).entries[1];await rm(join(sessionDir(sid),'originals',entry.id+'.txt'));
 const restored=await makeIndex(sid,rollout,undefined,{fast:true});expect(restored.cacheHit).toBe(false);expect(await decompress(sid,entry.id)).toBe(entry.text);
});
