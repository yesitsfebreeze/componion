import { mkdir, readFile, writeFile, rename, readdir, appendFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compact } from '../jev/compact';
import { collectToolCalls } from '../jev/state';
import { buildJevRequest, parseJevResponse, DEFAULT_MODEL } from '../jev/request';
import type { Message, JevAsker } from '../jev/types';

export const codexHome = () => process.env.CODEX_HOME || join(process.env.HOME!, '.codex');
export const root = () => join(codexHome(), 'componion');
export function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}$/.test(value)) throw Error('Invalid session or archive id');
  return value;
}
export const sessionDir = (sid: string) => join(root(), 'sessions', safeId(sid));
export async function json(path: string, fallback: any = null): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
export async function atomic(path: string, value: unknown) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
export const asText = (x: any): string => typeof x === 'string' ? x : Array.isArray(x)
  ? x.map(v => typeof v?.text === 'string' ? v.text : JSON.stringify(v)).join('\n') : JSON.stringify(x ?? '');
export type Entry = { id: string; text: string; tool?: string; callId?: string };
export function parseRollout(body: string) {
  const messages: Message[] = [], entries: Entry[] = [];
  let tokens = 0, window = 0, nativeCompactions = 0;
  for (const line of body.split('\n')) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.payload ?? {};
    if (e.type === 'compacted') { nativeCompactions++; tokens = 0; }
    if (e.type === 'event_msg' && p.type === 'token_count' && p.info) {
      tokens = p.info.last_token_usage?.input_tokens ?? tokens;
      window = p.info.model_context_window ?? window;
    }
    if (e.type !== 'response_item') continue;
    if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
      const text = asText(p.content);
      messages.push({ role: p.role, text, toolUses: [] });
      entries.push({ id: 'm-' + createHash('sha256').update(line).digest('hex').slice(0, 24), text });
    } else if (/^(function|custom_tool|local_shell)_call$/.test(p.type)) {
      let input = p.arguments ?? p.input ?? p.action ?? {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
      if (!input || typeof input !== 'object' || Array.isArray(input)) input = { value: input };
      const id = String(p.call_id ?? p.id ?? '');
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: p.name ?? 'shell', input }] });
    } else if (/^(function|custom_tool|local_shell)_call_output$/.test(p.type)) {
      const text = asText(p.output), callId = String(p.call_id ?? p.id ?? '');
      const id = 't-' + createHash('sha256').update(callId).digest('hex').slice(0, 24);
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: callId, text }] });
      entries.push({ id, text, callId });
    }
  }
  return { messages, entries, tokens, window, nativeCompactions };
}
export async function findTranscript(sid: string, supplied?: string): Promise<string | undefined> {
  safeId(sid);
  const candidates = supplied ? [supplied] : [];
  if (!supplied) {
    const { Glob } = await import('bun');
    try { for await (const path of new Glob(`**/*${sid}.jsonl`).scan(join(codexHome(), 'sessions'))) candidates.push(join(codexHome(), 'sessions', path)); } catch {}
  }
  for (const path of candidates) {
    try {
      const handle = await open(path, 'r');
      let body: string;
      try { const bytes = Buffer.alloc(65536); const result = await handle.read(bytes, 0, bytes.length, 0); body = bytes.subarray(0, result.bytesRead).toString(); } finally { await handle.close(); }
      const meta = body.split('\n').find(l => { try { return JSON.parse(l).type === 'session_meta'; } catch { return false; } });
      if (meta && JSON.parse(meta).payload?.id === sid) return path;
    } catch {}
  }
}
export async function archive(sid: string, path?: string) {
  const file = await findTranscript(sid, path);
  if (!file) throw Error('No matching Codex transcript found');
  const data = parseRollout(await readFile(file, 'utf8'));
  const dir = join(sessionDir(sid), 'originals');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = new Set(await readdir(dir));
  const pending = data.entries.filter(e => !existing.has(`${e.id}.txt`));
  for (let offset = 0; offset < pending.length; offset += 32) {
    await Promise.all(pending.slice(offset, offset + 32).map(async entry => {
      // Rename only complete originals into place; interruption cannot publish a partial archive.
      const target = join(dir, `${entry.id}.txt`), temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, entry.text, { mode: 0o600 });
      await rename(temp, target);
    }));
  }
  return { ...data, file };
}
export async function decompress(sid: string, id: string) {
  return readFile(join(sessionDir(sid), 'originals', `${safeId(id)}.txt`), 'utf8');
}
export async function search(sid: string, query: string) {
  if (!query.trim()) throw Error('Provide a non-empty query');
  const dir = join(sessionDir(sid), 'originals'), hits: string[] = [];
  for (const file of (await readdir(dir)).sort()) {
    if (!file.endsWith('.txt')) continue;
    for (const line of (await readFile(join(dir, file), 'utf8')).split('\n')) {
      if (line.toLowerCase().includes(query.toLowerCase())) hits.push(`${file.slice(0, -4)}: ${line.slice(0, 200)}`);
      if (hits.length >= 50) return hits.join('\n');
    }
  }
  return hits.join('\n') || 'No matches';
}
export function jevAsker(): JevAsker {
  return { ask: async (state, questions) => {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw Error('no TYPESAFE_API_KEY');
    const request = buildJevRequest({ apiKey: key }, state, questions);
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(12000) });
    const result = parseJevResponse(response.status, response.ok, await response.text());
    const dir = join(process.env.HOME!, '.jev', 'log');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ ts: Date.now(), client: 'componion', model: result.model ?? DEFAULT_MODEL, state, questions, answers: result.answers }) + '\n', { mode: 0o600 });
    return result;
  } };
}
export async function makeIndex(sid: string, path?: string, asker = jevAsker(), options: { fast?: boolean } = {}) {
  const started = performance.now();
  const file = await findTranscript(sid, path);
  if (!file) throw Error('No matching Codex transcript found');
  const signature = async () => { const s = await stat(file); return `${file}:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; };
  const source = await signature();
  const originalsSignature = async () => { try { const s = await stat(join(sessionDir(sid), 'originals')); return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return null; } };
  if (options.fast) {
    const cached = await json(join(sessionDir(sid), 'index.json'));
    if (cached?.v === 2 && cached.source === source && cached.fast === true && cached.originalsSource && cached.originalsSource === await originalsSignature()) return { ...cached, cacheHit: true, preparationMs: performance.now() - started };
  }
  const data = await archive(sid, file);
  const calls = collectToolCalls(data.messages, 6);
  const heads = new Map<string, number>();
  let jev = options.fast ? 'fast deterministic recall (no network grading)' : 'no candidate calls';
  if (!options.fast) try {
    const result = await compact(data.messages, asker, { keepThreshold: 0.6, maxStateTokens: 15000, maxRequestTokens: 18000, preserveRecentMessages: 6 });
    for (const decision of result.decisions) {
      const call = calls.find(c => c.id === decision.id);
      if (call) heads.set(call.tool_use_id, decision.action === 'keep' ? 400 : decision.action === 'drop_result' ? 100 : 0);
    }
    if (result.stats.requests) jev = 'jev';
  } catch (e) { jev = `jev failed: ${String(e instanceof Error ? e.message : e).replace(/\s+/g, ' ').slice(0, 80)}`; }
  const lines = data.entries.map(e => `${e.id}: ${e.callId ? `tool ${e.callId}` : 'message'} (${e.text.length} chars) ${e.text.replace(/\s+/g, ' ').slice(0, e.callId ? heads.get(e.callId) ?? 100 : 240)}`);
  // Keep complete recent entries within a bounded recall budget; search still covers every original.
  const recent: string[] = []; let chars = 0;
  for (let i = lines.length - 1; i >= 0; i--) { if (chars + lines[i].length + 1 > 10000) break; recent.push(lines[i]); chars += lines[i].length + 1; }
  const index = { v: 2, ts: Date.now(), jev, text: recent.reverse().join('\n'), entries: lines.length,
    source: await signature() === source ? source : null, originalsSource: await originalsSignature(), fast: !!options.fast, cacheHit: false, preparationMs: performance.now() - started };
  await atomic(join(sessionDir(sid), 'index.json'), index);
  await updateStatus(sid, { ...data, jev });
  return index;
}
export async function updateStatus(sid: string, extra: Record<string, unknown> = {}) {
  const file = join(root(), 'status', `${safeId(sid)}.json`);
  const previous = await json(file, {});
  const { tokens, window, nativeCompactions, jev, cwd, transcript, ended } = extra;
  const status = { v: 1, saved: 0, folds: 0, lastFold: 0, compacting: false, failures: 0, nextCompactAt: 0,
    jev: '', ...previous, ...Object.fromEntries(Object.entries({ tokens, window, nativeCompactions, jev, cwd, transcript, ended }).filter(([, v]) => v !== undefined)),
    ts: Date.now(), mode: 'native-compaction-with-recall' };
  await atomic(file, status);
  return status;
}
