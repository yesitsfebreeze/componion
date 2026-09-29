// Deterministic replay: real transcripts, every request re-played plain and
// through componion's own minify + fold. No model, no network, no luck.
// Cost model (Anthropic, 1h cache): uncached input 1x, cache write 2x, cache read 0.1x.
import { readFileSync } from 'fs';
import { minify, fold, chars } from '../hooks/componion.ts';

type Msg = { role: 'user' | 'assistant'; text: string; toolUses: any[]; toolResults?: any[] };
const SYSTEM = 66000;                 // tools + system prefix, measured, always cached after request 1
const tok = (s: string) => Math.ceil(s.length / 4);
const size = (m: Msg) => tok(JSON.stringify(m));

function load(path: string): { msgs: Msg[]; requests: number[] } {
  const msgs: Msg[] = [], requests: number[] = [];
  let lastReq = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const d = JSON.parse(line); const m = d.message;
    if (!m || (d.type !== 'user' && d.type !== 'assistant') || d.isSidechain) continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
    const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    if (d.type === 'assistant') {
      const uses = blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ tool_use_id: b.id, tool: b.name, input: b.input }));
      if (d.requestId && d.requestId === lastReq) { const p = msgs.at(-1)!; p.text += text; p.toolUses.push(...uses); continue; }
      lastReq = d.requestId; requests.push(msgs.length);
      msgs.push({ role: 'assistant', text, toolUses: uses });
    } else {
      const results = blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => ({
        tool_use_id: b.tool_use_id, isError: !!b.is_error,
        text: typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: any) => c.text ?? '').join('\n') }));
      msgs.push({ role: 'user', text, toolUses: [], ...(results.length ? { toolResults: results } : {}) });
    }
  }
  // Pair each result's text onto its call, as the engine's SessionMessage does.
  const out = new Map<string, string>();
  for (const m of msgs) for (const r of m.toolResults ?? []) out.set(r.tool_use_id, r.text);
  for (const m of msgs) for (const u of m.toolUses) u.text = out.get(u.tool_use_id);
  return { msgs, requests };
}

// Replays the requests; `view` maps the history so far to what is sent.
// Measured on logged request bodies (2026-09-24): after a fold tools and system
// stay cached, but every message is re-written, because Claude Code merges the
// fold block into the first user message.
function replay(requests: number[], viewAt: (i: number) => Msg[], resets = new Set<number>()) {
  let prev: string[] = [], sent = 0, cost = 0, peak = 0;
  requests.forEach((at, k) => {
    const ctx = viewAt(at).map((m) => JSON.stringify(m));
    let same = 0; if (!resets.has(at)) while (same < ctx.length && same < prev.length && ctx[same] === prev[same]) same++;
    const toks = ctx.map((s) => tok(s)), total = toks.reduce((a, b) => a + b, 0);
    const read = toks.slice(0, same).reduce((a, b) => a + b, 0), write = total - read;
    sent += SYSTEM + total; peak = Math.max(peak, SYSTEM + total);
    cost += (k ? SYSTEM * 0.1 : SYSTEM * 2) + read * 0.1 + write * 2;
    prev = ctx;
  });
  return { sent, cost, peak, last: SYSTEM + viewAt(requests.at(-1)!).reduce((a, m) => a + size(m), 0) };
}

const MIN = Number(process.env.MIN ?? 50000), GROWTH = Number(process.env.GROWTH ?? 20000), KEEP = Number(process.env.KEEP ?? 6000), LIVE = 8000;
function bench(path: string) {
  const { msgs, requests } = load(path);
  // componion: results minified on arrival; folds land once history grew GROWTH since the last one.
  const live = msgs.map((m) => m.toolResults ? { ...m, toolResults: m.toolResults.map((r) => ({ ...r, text: minify(r.text, LIVE, r.tool_use_id) })) } : m);
  for (const m of live) for (const u of m.toolUses) { const r = live.flatMap((x) => x.toolResults ?? []).find((r) => r.tool_use_id === u.tool_use_id); if (r) u.text = r.text; }
  let view: Msg[] = [], seen = 0, lastFold = 0, n = 0, indexChars = 0;
  const resets = new Set<number>();
  const views = new Map<number, Msg[]>();
  for (const at of requests) {
    view = [...view, ...live.slice(seen, at)]; seen = at;
    // a fold happens between turns: only when a user prompt starts the request
    const prompt = at > 0 && live[at - 1].role === 'user' && !live[at - 1].toolResults?.length;
    const t = view.reduce((a, m) => a + size(m), 0);
    if (prompt && t >= MIN && t - lastFold >= GROWTH) {
      const folded = fold(view as never, KEEP, new Map(), ++n) as Msg[] | null;
      if (folded) { indexChars += folded.find((m) => !view.includes(m))!.text.length; view = folded; resets.add(at); lastFold = view.reduce((a, m) => a + size(m), 0); }
    }
    views.set(at, view);
  }
  const plain = replay(requests, (i) => msgs.slice(0, i));
  const onlyMin = replay(requests, (i) => live.slice(0, i));
  const comp = replay(requests, (i) => views.get(i)!, resets);
  const pct = (a: number, b: number) => `${(100 * (1 - a / b)).toFixed(1)}%`;
  console.log(`${path.split('/').pop()}: ${requests.length} requests, ${n} folds, fold index ${indexChars} chars`);
  console.log(`  last context   plain ${plain.last}  minify ${onlyMin.last} (${pct(onlyMin.last, plain.last)})  componion ${comp.last} (${pct(comp.last, plain.last)})`);
  console.log(`  tokens sent    plain ${plain.sent}  minify ${pct(onlyMin.sent, plain.sent)}  componion ${pct(comp.sent, plain.sent)}`);
  console.log(`  cache cost     plain ${plain.cost.toFixed(0)}  minify ${pct(onlyMin.cost, plain.cost)}  componion ${pct(comp.cost, plain.cost)}`);
}
for (const p of process.argv.slice(2)) bench(p);
