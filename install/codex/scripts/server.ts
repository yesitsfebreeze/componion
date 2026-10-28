import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { decompress, json, makeIndex, root, safeId, search, sessionDir } from './core';
import { deck } from './deck';
import { enqueue } from './jobs';

const schema = (extra: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties: { session_id: { type: 'string', description: 'Codex session id supplied by the Componion SessionStart hook.' }, ...extra }, required: ['session_id', ...required], additionalProperties: false });
const string = { type: 'string' };
const threadSchema = { type: 'object', properties: { thread_id: { type: 'string', description: 'Actual Codex thread id, not a shared parent session id.' } }, required: ['thread_id'], additionalProperties: false };
const definitions = [
  { name: 'decompress', description: 'Read the exact original text of an archived message or tool result by id.', inputSchema: schema({ id: string }, ['id']) },
  { name: 'search_context', description: 'Search archived conversation text and tool results. Returns ids for decompress.', inputSchema: schema({ query: string }, ['query']) },
  { name: 'index_context', description: 'Archive this session and use JEV to build a recall index. Does not replace active context. Sends abridged history to the configured TypeSafe teacher.', inputSchema: schema() },
  { name: 'status', description: 'Read Componion status and the kern/orly/componion status bars.', inputSchema: schema() },
  { name: 'compact_context', description: 'Queue native Codex v2 compaction plus fast local recall restoration. Runs when the current turn finishes; poll compaction_status for completion. Keeps the same thread.', inputSchema: threadSchema },
  { name: 'fold_context', description: 'Queue an EXPERIMENTAL JEV-folded new-thread handoff when idle. Leaves the source intact. Does not switch the UI. Use only when the user requests a new-thread handoff; opaque signed histories are refused.', inputSchema: threadSchema },
  { name: 'compaction_status', description: 'Read the queued v2 job outcome, including the new thread id for an experimental handoff. Queued is not completed.', inputSchema: threadSchema },
];
export async function dispatch(request: any) {
  const id = request.id;
  if (id === undefined) return;
  let result: unknown;
  if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'componion', version: '0.1.0' } };
  else if (request.method === 'ping') result = {};
  else if (request.method === 'tools/list') result = { tools: definitions };
  else if (request.method === 'tools/call') {
    try {
      const { name, arguments: args = {} } = request.params ?? {};
      const sid = safeId(args.session_id ?? args.thread_id);
      let text: string;
      if (name === 'decompress') text = await decompress(sid, safeId(args.id));
      else if (name === 'search_context') {
        if (typeof args.query !== 'string') throw Error('query must be a string');
        text = await search(sid, args.query);
      } else if (name === 'index_context') text = (await makeIndex(sid)).text;
      else if (name === 'status') text = `${await deck(sid)}\n${JSON.stringify(await json(join(root(), 'status', `${sid}.json`)))}`;
      else if (name === 'compact_context' || name === 'fold_context') text = JSON.stringify(await enqueue(sid, name === 'compact_context' ? 'native' : 'handoff'));
      else if (name === 'compaction_status') text = JSON.stringify(await json(join(sessionDir(sid), 'v2-job.json'), { state: 'none' }));
      else throw Error(`Unknown tool: ${name}`);
      result = { content: [{ type: 'text', text }] };
    } catch (e) { result = { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] }; }
  } else return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  return { jsonrpc: '2.0', id, result };
}
if (import.meta.main) {
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    try { const reply = await dispatch(JSON.parse(line)); if (reply) console.log(JSON.stringify(reply)); }
    catch { console.log(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }
  }
}
