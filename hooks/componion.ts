// The one compaction plugin. Every mechanism of ~/dev/ranking.csv the
// function-hook API reaches:
//   live     minify every tool result before the model reads it; the original
//            stays on disk for decompress (persistence, compact serialization)
//   rolling  fold old history into an index block appended after the earlier
//            folds; nothing before it is ever rewritten, so the model only sees
//            the conversation move forward, and every folded message stays
//            reachable by id (decompress, search_context). Jev decides how much
//            of each folded tool result the index keeps. A fold runs in the
//            background after a turn, only once the context grew enough to pay
//            for the one prompt-cache rewrite it causes, or once the cache has
//            gone cold anyway.
//   fallback the built-in summary over a slimmed transcript when nothing can be
//            folded (2000-char results, <recap>, summary template, file lists)
//   turn end a bar of context after compression, before it, and the window;
//            failed turns distilled to one line (slim, OUTCOME_MAX 120)
import type { EngineInterface, Register, SessionMessage } from 'claude-code';
import { compact } from '../jev/compact.js';
import { buildJevRequest, parseJevResponse, DEFAULT_MODEL } from '../jev/request.js';

type Limits = { keepRecentTokens: number; toolResultMaxChars: number; outcomeMaxChars: number; cutUserChars?: number };

const SUMMARY_TEMPLATE = `Structure the summary under these headings, terse, facts only:
## Goal
## Constraints & Preferences
## Progress (done / in progress / blocked)
## Key Decisions
## Next Steps
## Critical Context (exact paths, commands, error strings, ids)
Carry the <read-files> and <modified-files> lists below forward verbatim.`;

const FILE_TOOLS: Record<string, 'read' | 'modified'> = {
  Read: 'read', Grep: 'read', Glob: 'read', NotebookRead: 'read',
  Edit: 'modified', Write: 'modified', MultiEdit: 'modified', NotebookEdit: 'modified',
};
// Tools whose output the model copies back verbatim (Edit's old_string): never minified.
const VERBATIM = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SKIP_KEYS = new Set(['data', 'base64', 'source']);
const MAX_TOOLS = 8;
export const FOLD_TAG = '[componion fold';
const TOOL_PREFIX = 'mcp__componion__';

export const tokens = (chars: number) => Math.ceil(chars / 4);

export function cut(text: string, max: number, id?: string): string {
  if (text.length <= max) return text;
  const half = Math.max(0, Math.floor((max - 80) / 2));
  const tail = id ? `; decompress id=${id}` : '';
  return `${text.slice(0, half)}\n[… componion cut ${text.length - 2 * half} chars${tail} …]\n${text.slice(-half)}`;
}

// Loss-free for reading: ANSI colour, progress-bar overwrites, trailing blanks,
// blank-line runs and repeated lines go; the words stay.
export function minify(text: string, maxChars: number, id?: string): string {
  if (text.length < 200) return text;
  const lines = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).trimEnd());
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
    if (!(lines[i] === '' && out.at(-1) === '')) out.push(j > i && lines[i] ? `${lines[i]} [×${j - i + 1}]` : lines[i]);
    i = j + 1;
  }
  return cut(out.join('\n'), maxChars, id);
}

export function minifyDeep(value: unknown, maxChars: number, id?: string, key = ''): unknown {
  if (typeof value === 'string') return SKIP_KEYS.has(key) ? value : minify(value, maxChars, id);
  if (Array.isArray(value)) return value.map((v) => minifyDeep(v, maxChars, id));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, minifyDeep(v, maxChars, id, k)]));
  return value;
}

// A stored Bash result is its JSON object; read back, the escaped \n and \"
// cost ~7% more than the words (measured over a day of decompress calls).
export function plainShell(text: string): string {
  if (!text.startsWith('{"stdout":')) return text;
  try {
    const o = JSON.parse(text);
    if (typeof o.stdout !== 'string') return text;
    return [o.stdout, o.stderr, o.interrupted ? '[interrupted]' : ''].filter(Boolean).join('\n');
  } catch { return text; }
}

const stripRecap = (text: string) => text.replace(/<recap>[\s\S]*?<\/recap>\s*/g, '');
// `!` command output rides in user text; old runs keep a head and tail (excludeFromContext).
const cutBash = (text: string, max: number) =>
  text.replace(/(<bash-std(?:out|err)>)([\s\S]*?)(<\/bash-std(?:out|err)>)/g, (_, a, body, b) => a + cut(body, max) + b);

const size = (m: SessionMessage) => m.text.length
  + m.toolUses.reduce((k, u) => k + (u.text?.length ?? 0) + JSON.stringify(u.input).length, 0)
  + (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0);
export const chars = (ms: readonly SessionMessage[]) => ms.reduce((n, m) => n + size(m), 0);

// Cut point: a message that carries no tool results (a prompt or an assistant
// message). Compaction runs between turns, so every call before it has its
// result before it too, and a long autonomous turn still folds.
const cutPoint = (m: SessionMessage) => !m.toolResults?.length;

// Oldest index kept whole: the newest `keepTokens` (chars/4), moved back to a cut point.
export function keepFrom(messages: readonly SessionMessage[], keepTokens: number): number {
  let i = messages.length, budget = keepTokens;
  while (i > 0 && budget > 0) budget -= tokens(size(messages[--i]));
  while (i > 0 && !cutPoint(messages[i])) i--;
  return i;
}

export function slim(messages: readonly SessionMessage[], limits: Limits): SessionMessage[] {
  const from = keepFrom(messages, limits.keepRecentTokens);
  return messages.map((m, i) => {
    if (i >= from) return m;
    let text = cutBash(stripRecap(m.text), limits.toolResultMaxChars);
    if (limits.cutUserChars && m.role === 'user') text = cut(text, limits.cutUserChars);
    const toolResults = m.toolResults?.map((r) => {
      const max = r.isError ? limits.outcomeMaxChars : limits.toolResultMaxChars;
      return r.text.length <= max ? r : { tool_use_id: r.tool_use_id, isError: r.isError, text: cut(r.text, max, r.tool_use_id) };
    });
    const toolUses = m.toolUses.map((u) =>
      u.text && u.text.length > limits.toolResultMaxChars
        ? { ...u, result: undefined, text: cut(u.text, limits.toolResultMaxChars, u.tool_use_id) }
        : u,
    );
    const changed = text !== m.text
      || toolResults?.some((r, j) => r !== m.toolResults![j])
      || toolUses.some((u, j) => u !== m.toolUses[j]);
    if (!changed) return m;
    return { role: m.role, text, toolUses, ...(toolResults ? { toolResults } : {}) };
  });
}

const filePath = (u: { input: Record<string, unknown> }) => {
  const p = u.input.file_path ?? u.input.notebook_path ?? u.input.path;
  return typeof p === 'string' ? p : undefined;
};

export function fileLists(messages: readonly SessionMessage[]): string {
  const files = { read: new Set<string>(), modified: new Set<string>() };
  for (const m of messages)
    for (const u of m.toolUses) {
      const kind = FILE_TOOLS[u.tool], path = filePath(u);
      if (kind && path) files[kind].add(path);
    }
  for (const p of files.modified) files.read.delete(p);
  return `<read-files>\n${[...files.read].join('\n')}\n</read-files>\n<modified-files>\n${[...files.modified].join('\n')}\n</modified-files>`;
}

// Heads Jev grants a folded tool result: kept whole-ish, trimmed, or id only.
const HEAD = { keep: 400, drop_result: 100, drop_call: 0 } as const;
export type Heads = Map<string, number>;

const oneLine = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n);

// The leading run the model has already read and a fold never touches: the
// first prompt (its context blocks ride on it) and every earlier fold.
export function frozenEnd(messages: readonly SessionMessage[]): number {
  let i = messages.length ? 1 : 0;
  while (i < messages.length && messages[i].text.startsWith(FOLD_TAG)) i++;
  return i;
}

// One short id per fold index line, text and tool call alike: fN.0, fN.1, …
// A call's original stays under its toolu id; fN.k.ref points there.
export function lineIds(region: readonly SessionMessage[], n: number): Map<object, string> {
  const ids = new Map<object, string>();
  let c = 0;
  for (const m of region) {
    if (m.text) ids.set(m, `f${n}.${c++}`);
    for (const u of m.toolUses) ids.set(u, `f${n}.${c++}`);
  }
  return ids;
}

// The bare argument a call is known by; compact JSON for anything else.
const mainArg = (u: { input: Record<string, unknown> }) => {
  const i = u.input ?? {};
  const v = filePath(u) ?? [i.command, i.pattern, i.prompt, i.url].find((x) => typeof x === 'string');
  return typeof v === 'string' ? v : JSON.stringify(i);
};

// Rolling fold: messages [frozen, tail) become one index block, in order, each
// by id; the tail (newest `keepTokens`, from a cut point) and the frozen run
// stay the engine's own objects. Null when there is nothing worth folding.
export function fold(messages: readonly SessionMessage[], keepTokens: number, heads: Heads, n: number): SessionMessage[] | null {
  const from = frozenEnd(messages);
  let to = keepFrom(messages, keepTokens);
  // One message holds the whole budget right past the frozen run: fold up to
  // the next cut point instead.
  if (to - from < 2) to = messages.findIndex((m, i) => i > from + 1 && cutPoint(m));
  if (to < 0 || to - from < 2) return null;
  const region = messages.slice(from, to);
  const ids = lineIds(region, n);
  const lines: string[] = [];
  for (const m of region) {
    if (m.text) lines.push(`${m.role === 'user' ? 'u' : 'a'} ${ids.get(m)}: ${oneLine(stripRecap(m.text), 240)}${m.text.length > 240 ? ` (+${m.text.length - 240} chars)` : ''}`);
    for (const u of m.toolUses) {
      const out = u.text ?? '';
      const head = heads.get(u.tool_use_id) ?? HEAD.drop_result;
      lines.push(`${ids.get(u)} ${u.tool} ${oneLine(mainArg(u), 80)}${u.isError ? ' ERROR' : ''} (${out.length} chars)${head && out ? `: ${oneLine(out, head)}` : ''}`);
    }
  }
  const text = `${FOLD_TAG} F${n}: ${region.length} earlier messages, oldest first. Full text of any #id or fN.k: mcp__componion__decompress; search all: mcp__componion__search_context.]\n${lines.join('\n')}\n${fileLists(region)}`;
  return [...messages.slice(0, from), { role: 'user', text, toolUses: [] }, ...messages.slice(to)];
}

// Three segments over `width` cells: context after compression, what
// compression took out (before minus after), and the window left free.
export function bar(t: { after: number; before: number; window: number }, width: number): [string, string, string] {
  const cells = (n: number) => Math.round((Math.min(n, t.window) / t.window) * width);
  const a = cells(t.after), b = Math.max(0, cells(t.before) - a);
  return ['█'.repeat(a), '▓'.repeat(b), '░'.repeat(Math.max(0, width - a - b))];
}

// One line per failed turn: its tools (up to 8) and the first error, 120 chars.
export const failureLine = (fails: { tool: string; text: string }[], outcomeMax: number) =>
  `${[...new Set(fails.map((f) => f.tool))].slice(0, MAX_TOOLS).join(',')}: ${fails[0].text.replace(/\s+/g, ' ').slice(0, outcomeMax)}`;

// CONTRACT §2 (~/orchi/docs/CONTRACT.md): what kern's turn deck reads.
export type Status = { saved: number; folds: number; lastFold: number; jev: string; compacting: boolean; failures: number; nextCompactAt: number };
export const statusPayload = (s: Status, ts: number) => ({ v: 1, ts, ...s });

type State = { home: string };

// Sibling of the per-session originals dir, so decompress/search_context never list it.
// Plain write: $.fs has no rename, so a reader may rarely see a torn file and must treat bad JSON as silent.
async function publish($: EngineInterface, s: Status) {
  try {
    const path = `${await $.env.get('HOME')}/.claude/componion/status/${await $.session.id()}.json`;
    await $.fs.write(path, JSON.stringify(statusPayload(s, Date.now())));
  } catch { /* status is best effort */ }
}

async function dir($: EngineInterface, s: State) {
  return (s.home ||= `${await $.env.get('HOME')}/.claude/componion/${await $.session.id()}`);
}

// Originals stay on disk; the model reads them back through decompress.
async function keepOriginal($: EngineInterface, s: State, id: string, text: string, ext = 'txt') {
  try {
    const path = `${await dir($, s)}/${id}.${ext}`;
    if (!(await $.fs.exists(path))) await $.fs.write(path, text);
  } catch { /* recall is best effort */ }
}

// CONTRACT §8 dataset: one line per answered Jev call. $.fs has no append or
// mkdir, so a child does both; perl's syswrite is one O_APPEND write, so
// kern and orly appending the same file never interleave. Best effort.
async function logJev($: EngineInterface, entry: object) {
  try {
    const day = new Date().toISOString().slice(0, 10); // UTC day, CONTRACT §8
    const script = 'use File::Path; mkpath($ARGV[0]); open(F, ">>", "$ARGV[0]/$ARGV[1]") or die; local $/; syswrite(F, <STDIN>)';
    await $.process.run(['perl', '-e', script, `${await $.env.get('HOME')}/.jev/log`, `${day}.jsonl`], { stdin: JSON.stringify(entry) + '\n' });
  } catch { /* the dataset never fails a fold */ }
}

// Jev grades each tool call in the region; its answer always shapes the
// fold (a paid call is never discarded). Unreachable, every call gets a
// short head and the fold goes ahead anyway.
export async function jevHeads($: EngineInterface, region: readonly SessionMessage[], options: object, out: { jev: string }): Promise<Heads> {
  const heads: Heads = new Map();
  if (!region.some((m) => m.toolUses.length)) return heads;
  try {
    const apiKey = (await $.env.get('TYPESAFE_API_KEY'))
      ?? (((await $.settings.read()).env as Record<string, unknown> | undefined)?.TYPESAFE_API_KEY as string | undefined);
    if (!apiKey) throw new Error('no TYPESAFE_API_KEY');
    const asker = { ask: async (st: never, questions: never) => {
      const q = buildJevRequest({ apiKey, model: DEFAULT_MODEL }, st, questions);
      const init = { method: q.method, headers: q.headers, body: q.body };
      const r = await $.http.fetch(q.url, init).catch(() => $.http.fetch(q.url, init));
      const res = parseJevResponse(r.status, r.ok, r.text);
      void logJev($, { ts: Date.now(), client: 'componion', model: res.model ?? DEFAULT_MODEL, state: st, questions, answers: res.answers });
      return res;
    } };
    const result = await compact(region as never, asker as never, options);
    for (const d of result.decisions) heads.set(d.id, HEAD[d.action as keyof typeof HEAD] ?? HEAD.drop_result);
    out.jev = 'jev';
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    $.ui.log(`componion: jev failed: ${reason}`, { to: 'debug' });
    out.jev = `jev failed: ${reason.slice(0, 80)}`;
  }
  return heads;
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return; // A/B baseline: `--settings` pluginConfigs componion@inline enabled=false
  const n = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d);
  const limits: Limits = {
    keepRecentTokens: n('keepRecentTokens', 6000),
    toolResultMaxChars: n('toolResultMaxChars', 2000),
    outcomeMaxChars: n('outcomeMaxChars', 120),
  };
  const liveMax = n('liveResultMaxChars', 8000);
  const keepThreshold = n('keepThreshold', 0.6);
  // Measured on logged request bodies: after a fold tools and system stay
  // cached, but every message is written to the cache again (Claude Code
  // merges the fold block into the first user message). A fold pays for that
  // only once the context is big, so it waits for `foldFromTokens`, then runs
  // every `compactEveryTokens` (bench/replay.ts sweep: 50k/20k saved most and
  // on every replayed session). A cold cache folds for free.
  // Whatever Jev answers is installed; a paid call is never thrown away.
  const foldFrom = n('foldFromTokens', 50000);
  const growthTokens = n('compactEveryTokens', 20000);
  const cacheTtlMs = n('cacheTtlMinutes', 60) * 60000;
  const jevOptions = {
    preserveRecentMessages: 0,
    keepThreshold,
    maxStateTokens: n('maxStateTokens', 15000),
    maxRequestTokens: n('maxRequestTokens', 18000),
    truncateHeadChars: n('truncateHeadChars', 150),
  };

  let saved = 0, folds = 0, failures = 0, lastFold = 0, jev = '', compacting = false, lastCompactAt = 0, foldedRestart = false, idle: { cancel: () => void } | undefined;
  const state: State = { home: '' };
  const grade = { jev: '' };
  let fails: { tool: string; text: string }[] = [];
  const status = (): Status => ({ saved, folds, lastFold, jev, compacting, failures, nextCompactAt: lastCompactAt + growthTokens });
  const shots = new Map<string, { after: number; before: number; window: number; jev: string }>();

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'decompress',
      description: 'Read back the full original of a message or tool result componion cut or folded. Pass the id from a "decompress id=…" marker or a fold index line (#toolu_… or fN.k).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    });
    await $.tool.register({
      name: 'search_context',
      description: 'Search every message and tool result componion cut or folded this session. Returns matching lines with their decompress id.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    });
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    if (e.tool === `${TOOL_PREFIX}decompress`) {
      const id = String((e as { id?: unknown }).id ?? '').replace(/^#/, '');
      // Exact id: a suffix match would read f11.1 back for f1.1.
      const read = async (x: string, ext: string) => (/^[\w.-]+$/.test(x) ? $.fs.read(`${await dir($, state)}/${x}.${ext}`).catch(() => undefined) : undefined);
      // A fold's short id for a call is a .ref naming its toolu original.
      const ref = await read(id, 'ref');
      const text = await read(ref?.trim() ?? id, 'txt');
      return text !== undefined ? { result: plainShell(text) } : { result: `no original stored for ${id}`, isError: true };
    }
    if (e.tool === `${TOOL_PREFIX}search_context`) {
      const q = String((e as { query?: unknown }).query ?? '').toLowerCase();
      const hits: string[] = [];
      for (const f of await $.fs.list(await dir($, state)).catch(() => [])) {
        if (!f.name.endsWith('.txt')) continue;
        const text = await $.fs.read(`${state.home}/${f.name}`).catch(() => '');
        for (const line of text.split('\n')) if (line.toLowerCase().includes(q) && hits.length < 50) hits.push(`${f.name.replace(/\.txt$/, '')}: ${line.slice(0, 200)}`);
      }
      return { result: hits.join('\n') || `nothing matches ${q}` };
    }
    const r = await next(e);
    if (r.deny !== undefined) return r;
    if (r.isError && !e.agentId) fails.push({ tool: e.tool, text: String(r.text ?? JSON.stringify(r.result)) });
    if (VERBATIM.has(e.tool) || r.isError || r.result === undefined) return r;
    try {
      const id = e.tool_use_id;
      const result = minifyDeep(r.result, liveMax, id);
      const before = JSON.stringify(r.result);
      const k = before.length - JSON.stringify(result).length;
      if (k <= 0) return r;
      saved += tokens(k);
      if (id) await keepOriginal($, state, id, typeof r.result === 'string' ? r.result : before);
      // The context hooks below attached must ride on: the engine skips a hook that drops it.
      return { result, ...(r.context ? { context: r.context } : {}) };
    } catch {
      return r;
    }
  });

  on('session.compact', async ($, e, next) => {
    const main = !e.agentId;
    if (main) foldedRestart = false;
    const n = frozenEnd(e.messages);
    const probe = fold(e.messages, limits.keepRecentTokens, new Map(), n);
    const region = probe ? e.messages.slice(n, e.messages.length - (probe.length - n - 1)) : [];
    // Originals first: every folded message stays readable by its id.
    const ids = lineIds(region, n);
    for (const m of region) {
      if (m.text.length > 240) void keepOriginal($, state, ids.get(m)!, m.text);
      for (const u of m.toolUses) if (u.text) {
        void keepOriginal($, state, u.tool_use_id, u.text);
        void keepOriginal($, state, ids.get(u)!, u.tool_use_id, 'ref');
      }
      for (const r of m.toolResults ?? []) void keepOriginal($, state, r.tool_use_id, r.text);
    }
    const folded = fold(e.messages, limits.keepRecentTokens, await jevHeads($, region, jevOptions, grade), n);
    if (folded) {
      const k = Math.max(0, tokens(chars(e.messages) - chars(folded)));
      if (main) { saved += k; lastFold = k; folds++; foldedRestart = true; jev = `F${n}: ${region.length} msgs folded · ${grade.jev}`; void publish($, status()); }
      return { messages: folded };
    }
    if (e.trigger === 'plugin') {
      $.ui.log(`componion: no fold: frozen ${n}, of ${e.messages.length}: ${e.messages.map((m) => `${m.role[0]}${m.toolUses.length ? 't' : ''}${m.toolResults?.length ? 'r' : ''}${Math.round(chars([m]) / 400)}`).join(' ')}`, { to: 'debug' });
      return { skip: 'nothing to fold yet' };
    }
    // `/compact` or the engine's threshold with nothing foldable: the built-in
    // summary, over a slimmed transcript.
    const instructions = [e.instructions, SUMMARY_TEMPLATE, fileLists(e.messages)].filter(Boolean).join('\n\n');
    const r = await next({ ...e, messages: slim(e.messages, limits), instructions });
    if (r.messages && main) saved += Math.max(0, tokens(chars(e.messages) - chars(r.messages)));
    return r;
  });

  // A fold is a compaction, so the engine re-runs every SessionStart hook with
  // source `compact`. The frozen first message still holds what they said at
  // startup, so after a fold a re-run only adds another copy (a hook's stdout
  // rides beside the result, so dropping `additionalContext` is not enough):
  // skip it. After the built-in summary they run as usual.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'compact' || !foldedRestart) return next(e);
    foldedRestart = false;
    return {};
  });

  // After a turn: compact when it pays (growth or cold cache); a failed turn leaves one line on disk.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && fails.length) {
      const line = `${new Date().toISOString()} ${failureLine(fails, limits.outcomeMaxChars)}\n`;
      fails = [];
      failures++;
      const path = `${await $.env.get('HOME')}/.claude/componion/failures.log`;
      void $.fs.read(path).catch(() => '').then((old) => $.fs.write(path, String(old) + line)).catch(() => {});
    }
    if (!e.agentId) {
      const tokensNow = (await $.session.usage()).context.tokens ?? 0;
      const run = async () => {
        if (compacting) return;
        compacting = true;
        lastFold = 0;
        try { await $.session.compact(); } catch { /* headless sessions cannot compact */ } finally {
          compacting = false;
          lastCompactAt = tokensNow - lastFold;
          void publish($, status());
        }
      };
      // Grown enough since the last compaction to be worth a Jev pass now.
      if (tokensNow >= foldFrom && tokensNow - lastCompactAt >= growthTokens) void run();
      // Idle past the cache TTL: the next request rewrites the cache anyway,
      // so compact then at no cache cost, whatever the reduction.
      idle?.cancel();
      idle = $.clock.after(cacheTtlMs + 30000, () => { void run(); });
      await publish($, status());
    }
    return next(e);
  });

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    // kern's turn deck draws this line when present (CONTRACT §3).
    const { value: deck } = await $.state.get({ plugin: 'kern', key: 'deck' } as never);
    if (deck) return next(e);
    const drawn = await next(e);
    let shot = shots.get(e.requestId);
    if (!shot) {
      // Right after a compaction the last response's count is gone; the local
      // /context estimate (no request sent) stands in until the next response.
      let { context } = await $.session.usage();
      if (!context.tokens) context = (await $.session.usage({ breakdown: 'summary' })).context;
      const after = context.tokens || context.breakdown?.totalTokens || 0;
      shot = { after, before: after + saved, window: context.window, jev };
      if (after) shots.set(e.requestId, shot);
    }
    if (!shot.after || !shot.window) return drawn;
    const { Box, Text } = $.ui.resolve(e);
    const [a, b, r] = bar(shot, Math.max(10, Math.min(40, (e.viewport?.columns ?? 80) - 60)));
    const k = (x: number) => `${Math.round(x / 1000)}k`;
    return Box({ flexDirection: 'column', children: [
      drawn,
      Text({ children: [
        '  ',
        Text({ color: 'green', children: a }),
        Text({ color: 'yellow', children: b }),
        Text({ dimColor: true, children: `${r} ${k(shot.after)} now · ${k(shot.before)} uncompressed · ${k(shot.window)} window${shot.jev ? ` · ${shot.jev}` : ''}` }),
      ] }),
    ] });
  });
};
