import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { json, root, safeId, sessionDir } from './core';

const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, n) : 0;
export function bar(after: number, before: number, window: number, width = 10) {
  width = Math.max(1, Math.min(80, Math.floor(finite(width))));
  if (!(window > 0)) return '░'.repeat(width);
  const cells = (n: number) => Math.round(Math.min(finite(n), window) / window * width);
  const a = cells(after), b = Math.max(0, cells(before) - a);
  return '█'.repeat(a) + '▓'.repeat(b) + '░'.repeat(Math.max(0, width - a - b));
}
const k = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
export function rows(c: any, o: any, kern: any, sid: string): string[] {
  const out: string[] = [];
  const s = kern?.sessions?.[sid];
  const signals: [number, number][] = [];
  if (typeof o?.pct === 'number') signals.push([0.45, Math.min(100, finite(o.pct)) / 100 * (o.blocked ? 0.5 : 1)]);
  if (s?.offered > 0) signals.push([0.2, Math.min(finite(s.used), s.offered) / s.offered]);
  if (c?.window > 0 && c?.tokens > 0) signals.push([0.2, Math.max(0, 1 - c.tokens / c.window)]);
  if (signals.length) out.push(`turn  ${Math.round(100 * signals.reduce((n, [w, v]) => n + w * v, 0) / signals.reduce((n, [w]) => n + w, 0))}`);
  if (c?.tokens > 0 && c?.window > 0) out.push(`ctx   ${bar(c.tokens, c.tokens + finite(c.saved), c.window)} ${k(c.tokens)}/${k(c.window)} · ${k(finite(c.saved))} folded`);
  else out.push('ctx   usage not yet reported');
  out.push(`jev   ${c?.jev || 'awaiting compaction'} · ${c?.nativeCompactions ?? 0} native compactions · recall archive`);
  if (c?.v2) out.push(`v2    ${c.v2.mode} ${c.v2.state}${c.v2.error ? ` · ${c.v2.error}` : ''}${c.v2.result?.mode === 'v2-handoff' ? ` · new thread ${c.v2.result.threadId}` : ''}`);
  if (!kern) out.push('kern  unavailable');
  else if (s?.offered > 0) {
    const stars = Math.round(5 * Math.min(finite(s.used), s.offered) / s.offered);
    out.push(`kern  ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)} ${finite(s.used)}/${s.offered} used · ${String(kern.build ?? '').slice(0, 8)}${kern.stale ? ' stale' : ''}`);
  } else out.push(`kern  ${String(kern.build ?? 'connected').slice(0, 16)}${kern.stale ? ' stale' : ''} · no recall metrics for this session`);
  out.push(typeof o?.pct === 'number' ? `orly  ${bar(o.pct, o.pct, 100)} ${o.pct}%${o.blocked ? ' blocked' : ''} · ${(o.items ?? []).slice(0, 2).join(' · ')}` : 'orly  awaiting verdict');
  return out.map(line => line.replace(/[\x00-\x1f\x7f]/g, ' '));
}
export async function kernStatus(cwd?: string) {
  try {
    const p = Bun.spawn([process.env.KERN_BIN || 'kern', 'status', '--json'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const timeout = setTimeout(() => p.kill(), 2000);
    try {
      const [stdout, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return code === 0 ? JSON.parse(stdout) : null;
    } finally { clearTimeout(timeout); }
  } catch { return null; }
}
export async function deck(sid: string) {
  safeId(sid);
  const c = await json(join(root(), 'status', `${sid}.json`), {});
  c.v2 = await json(join(sessionDir(sid), 'v2-job.json'));
  const [o, kern] = await Promise.all([json(join(process.env.HOME!, '.orly', 'status', `${sid}.json`)), kernStatus(c?.cwd)]);
  return rows(c, o, kern, sid).join('\n');
}
export async function newestSession(cwd = process.cwd()) {
  const found: { sid: string; ts: number }[] = [];
  for (const f of await readdir(join(root(), 'status')).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const s = await json(join(root(), 'status', f));
    if (s?.cwd === cwd && !s.ended) found.push({ sid: f.slice(0, -5), ts: s.ts });
  }
  return found.sort((a, b) => b.ts - a.ts)[0]?.sid;
}
if (import.meta.main) {
  const args = process.argv.slice(2), at = args.indexOf('--session');
  const sid = at >= 0 ? args[at + 1] : process.env.CODEX_THREAD_ID || await newestSession();
  if (!sid) { console.error('No session in this directory yet. Pass --session <id>.'); process.exit(1); }
  do {
    if (args.includes('--watch') && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
    console.log(await deck(sid));
    if (!args.includes('--watch')) break;
    await Bun.sleep(5000);
  } while (true);
}
