import { test, expect, mock } from 'claude-code/testing';
import { homedir } from 'node:os';
import { slim, keepFrom, fileLists, cut, minify, minifyDeep, failureLine, fold, frozenEnd, FOLD_TAG, statusPayload, jevHeads, home } from './componion.ts';

const big = 'x'.repeat(10_000);
const transcript = [
  { role: 'user', text: 'fix the test', toolUses: [] },
  { role: 'assistant', text: '<recap>old</recap>reading', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/r.ts' }, text: big }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big, isError: false }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Edit', input: { file_path: '/m.ts' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'y'.repeat(500), isError: true }] },
  { role: 'user', text: 'now run it', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [] },
] as const;
const limits = { keepRecentTokens: 2, toolResultMaxChars: 2000, outcomeMaxChars: 120 };

test('cut point never splits a call from its result', () => {
  expect(keepFrom(transcript, 2)).toBe(5);
  expect(keepFrom(transcript, 5)).toBe(3);
});

test('older messages are slimmed, recent ones kept whole', () => {
  const out = slim(transcript, limits);
  expect(out[1].text).toBe('reading');
  expect(out[2].toolResults![0].text.length).toBeLessThan(2100);
  expect(out[4].toolResults![0].text.length).toBeLessThan(200);
  expect(out[5]).toBe(transcript[5]);
  expect(out[0]).toBe(transcript[0]);
  expect(cut('short', 10)).toBe('short');
});

test('file lists name reads and modifications', () => {
  const lists = fileLists(transcript);
  expect(lists).toContain('<read-files>\n/r.ts\n</read-files>');
  expect(lists).toContain('<modified-files>\n/m.ts\n</modified-files>');
});

test('minify drops noise, keeps words', () => {
  const noisy = '\x1b[32mok\x1b[0m   \n' + 'same\n'.repeat(50) + '\n\n\n\n' + '10%\r50%\r100% done\n' + 'x'.repeat(200);
  const out = minify(noisy, 20_000);
  expect(out).toContain('ok\nsame [×50]\n\n100% done');
  expect(out).not.toContain('\x1b');
  expect(minifyDeep({ stdout: noisy, data: noisy }, 20_000)).toEqual({ stdout: out, data: noisy });
});

test('rolling fold: index in order, frozen prefix and tail untouched, ids kept', () => {
  const heads = new Map([['a', 400], ['b', 0]]);
  const out = fold(transcript, 2, heads, 1)!;
  expect(out[0]).toBe(transcript[0]);
  expect(out[1].text.startsWith(FOLD_TAG)).toBe(true);
  // Every index line gets a short fN.k id; a call shows its bare main argument.
  expect(out[1].text).toContain('a f1.0: reading');
  expect(out[1].text).toContain('f1.1 Read /r.ts (10000 chars): xxxx');
  expect(out[1].text).toContain('f1.2 Edit /m.ts (0 chars)');
  expect(out[1].text).not.toContain('#a ');
  expect(out[1].text).toContain('<modified-files>\n/m.ts');
  expect(out.slice(2)).toEqual([transcript[5], transcript[6]]);
  // A second fold appends after the first; the first is never rewritten.
  const grown = [...out, { role: 'assistant', text: 'more', toolUses: [] }, { role: 'user', text: 'next', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }] as never[];
  expect(frozenEnd(grown)).toBe(2);
  const again = fold(grown, 2, new Map(), 2)!;
  expect(again[1]).toBe(out[1]);
  expect(again[2].text).toContain('F2');
  expect(fold(again, 2, new Map(), 3)).toBe(null);
  // One message holds the whole budget right past the frozen run: fold up to the next cut point.
  const long = [transcript[0], out[1], { role: 'user', text: 'big', toolUses: [] }, { role: 'assistant', text: 'y'.repeat(40000), toolUses: [] }, { role: 'user', text: 'new', toolUses: [] }] as never[];
  const rolled = fold(long, 500, new Map(), 3)!;
  expect(rolled.length).toBe(4);
  expect(rolled[3]).toBe(long[4]);
});

test('one long autonomous turn folds, and never splits a call from its result', () => {
  const call = (k: number) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${k}`, tool: 'Bash', input: { command: 'ls' }, text: 'r'.repeat(4000) }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}`, text: 'r'.repeat(4000), isError: false }] },
  ];
  const turn = [{ role: 'user', text: 'work the board', toolUses: [] }, ...Array.from({ length: 20 }, (_, k) => call(k)).flat()] as never[];
  const out = fold(turn, 6000, new Map(), 1)!;
  expect(out).not.toBe(null);
  expect(out[1].text.startsWith(FOLD_TAG)).toBe(true);
  expect(out[2].role).toBe('assistant');
  expect(out.length).toBeLessThan(turn.length);
  expect(out[1].text).toContain('f1.0 Bash ls (4000 chars)');
  expect(out[1].text).not.toContain('{"command"');
  // Every result left in the tail answers a call also in the tail.
  const calls = new Set(out.flatMap((m: any) => m.toolUses.map((u: any) => u.tool_use_id)));
  for (const m of out.slice(2) as any[]) for (const r of m.toolResults ?? []) expect(calls.has(r.tool_use_id)).toBe(true);
});

test('failure lines and cut ids', () => {
  expect(failureLine([{ tool: 'Bash', text: 'exit 1\n' + 'e'.repeat(300) }, { tool: 'Bash', text: 'x' }], 120).length).toBeLessThan(140);
  expect(cut('z'.repeat(500), 200, 'toolu_1')).toContain('decompress id=toolu_1');
});

test('status payload matches CONTRACT §2', () => {
  const s = { saved: 75000, folds: 3, lastFold: 12000, jev: 'F3: 12 msgs folded · jev', compacting: false, failures: 0, nextCompactAt: 85000 };
  expect(Object.keys(statusPayload(s, 1))).toEqual(['v', 'ts', 'saved', 'folds', 'lastFold', 'jev', 'compacting', 'failures', 'nextCompactAt']);
  expect(statusPayload(s, 1).v).toBe(1);
});

test('a minified tool result keeps the context an inner hook added', async ($, on) => {
  on('tool.call', async () => ({ result: 'same\n'.repeat(50), context: ['kern: nudge'] }));
  const r = await $.tool.call({ tool: 'Bash', command: 'rg x', tool_use_id: 'toolu_t' } as any);
  expect(String(r.result)).toContain('same [×50]');
  expect(r.context).toEqual(['kern: nudge']);
});

test('decompress reads the exact id back, never a longer one ending the same', async ($, on) => {
  mock.env(on, { HOME: '/h' });
  on('session.id' as never, (async () => ({ value: 'sid' })) as never);
  const files: Record<string, string> = { '/h/.claude/componion/sid/f11.1.txt': 'eleventh', '/h/.claude/componion/sid/f1.1.txt': 'first' };
  on('fs.read' as never, (async (_$: unknown, e: { path: string }) => {
    return e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' };
  }) as never);
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: 'f1.1' } as any)).result).toBe('first');
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: '#f11.1' } as any)).result).toBe('eleventh');
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: '../x' } as any)).isError).toBe(true);
});

test('decompress resolves a fold short id through its alias, and still an old toolu id', async ($, on) => {
  mock.env(on, { HOME: '/h' });
  on('session.id' as never, (async () => ({ value: 'sid' })) as never);
  const files: Record<string, string> = { '/h/.claude/componion/sid/toolu_x.txt': 'out', '/h/.claude/componion/sid/f2.3.ref': 'toolu_x' };
  on('fs.read' as never, (async (_$: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' })) as never);
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: 'f2.3' } as any)).result).toBe('out');
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: '#toolu_x' } as any)).result).toBe('out');
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: 'f2.4' } as any)).isError).toBe(true);
});

test('decompress of a stored Bash result returns its plain output, not escaped JSON', async ($, on) => {
  mock.env(on, { HOME: '/h' });
  on('session.id' as never, (async () => ({ value: 'sid' })) as never);
  const bash = JSON.stringify({ stdout: 'a "q"\nb', stderr: 'warn', interrupted: false, isImage: false, noOutputExpected: false });
  const files: Record<string, string> = { '/h/.claude/componion/sid/t1.txt': bash, '/h/.claude/componion/sid/t2.txt': '{"k":1}', '/h/.claude/componion/sid/t3.txt': JSON.stringify({ stdout: 'x', stderr: '', interrupted: true }) };
  on('fs.read' as never, (async (_$: unknown, e: { path: string }) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' })) as never);
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: 't1' } as any)).result).toBe('a "q"\nb\nwarn');
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: 't2' } as any)).result).toBe('{"k":1}');
  expect((await $.tool.call({ tool: 'mcp__componion__decompress', id: 't3' } as any)).result).toBe('x\n[interrupted]');
});

test('after a fold the SessionStart re-run adds no second copy; after a summary it does', async ($, on) => {
  on('classic.SessionStart' as never, (async () => ({ additionalContext: ['CAVEMAN MODE ACTIVE'] })) as never);
  on('session.compact' as never, (async () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] })) as never);
  const call = (k: number) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${k}`, tool: 'Bash', input: { command: 'ls' }, text: 'r'.repeat(4000) }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}`, text: 'r'.repeat(4000), isError: false }] },
  ];
  const long = [{ role: 'user', text: 'work', toolUses: [] }, ...Array.from({ length: 20 }, (_, k) => call(k)).flat()];
  const folded = await $.session.compact({ trigger: 'manual', messages: long } as any);
  expect((folded as any).messages[1].text.startsWith(FOLD_TAG)).toBe(true);
  expect((await $.classic.SessionStart({ source: 'compact' } as any) as any).additionalContext).toBeUndefined();
  // Nothing to fold: the built-in summary replaced the history, so the hooks' context comes back.
  await $.session.compact({ trigger: 'manual', messages: long.slice(0, 1) } as any);
  expect((await $.classic.SessionStart({ source: 'compact' } as any) as any).additionalContext).toEqual(['CAVEMAN MODE ACTIVE']);
  expect((await $.classic.SessionStart({ source: 'startup' } as any) as any).additionalContext).toEqual(['CAVEMAN MODE ACTIVE']);
});

test('a failed Jev grade names its reason in the status, clipped to 80 chars', async () => {
  const region = transcript.slice(0, 3) as never;
  const $ = (env: string | undefined, text: string) => ({
    env: { get: async () => env }, settings: { read: async () => ({}) }, ui: { log: () => {} },
    http: { fetch: async () => ({ status: 500, ok: false, text }) },
  }) as never;
  const out = { jev: '' };
  await jevHeads($(undefined, ''), region, {}, out);
  expect(out.jev).toBe('jev failed: no TYPESAFE_API_KEY');
  await jevHeads($('k', 'overloaded\n'.repeat(40)), region, { preserveRecentMessages: 0 }, out);
  expect(out.jev.slice(0, 50)).toBe('jev failed: Jev request failed (500): overloaded o');
  expect(out.jev.length).toBe('jev failed: '.length + 80);
});

test('an answered Jev call appends one dataset line; a failed log write still folds', async () => {
  const region = transcript.slice(0, 3) as never;
  const runs: any[] = [];
  const $ = (run: (argv: string[], init: any) => Promise<unknown>) => ({
    env: { get: async (k: string) => (k === 'HOME' ? '/h' : 'k') }, settings: { read: async () => ({}) }, ui: { log: () => {} },
    http: { fetch: async (_: string, init: any) => {
      const qs = Object.keys(JSON.parse(init.body).questions);
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-9', answers: Object.fromEntries(qs.map((q) => [q, { noul: 0.9 }])) }) };
    } },
    process: { run },
  }) as never;
  const out = { jev: '' };
  const heads = await jevHeads($(async (argv, init) => runs.push({ argv, init })), region, { preserveRecentMessages: 0 }, out);
  const line0 = () => JSON.parse(runs[0].init.stdin);
  expect(out.jev).toBe('jev');
  expect(runs.length).toBe(1);
  expect(runs[0].argv[3]).toBe('/h/.jev/log');
  expect(runs[0].argv[4]).toBe(`${new Date(line0().ts).toISOString().slice(0, 10)}.jsonl`);
  expect(runs[0].init.stdin.endsWith('\n')).toBe(true);
  expect(runs[0].init.stdin.indexOf('\n')).toBe(runs[0].init.stdin.length - 1);
  const line = JSON.parse(runs[0].init.stdin);
  expect(Object.keys(line)).toEqual(['ts', 'client', 'model', 'state', 'questions', 'answers']);
  expect([line.client, line.model]).toEqual(['componion', 'jev-9']);
  expect(Object.keys(line.answers)).toEqual(Object.keys(line.questions));
  const failing = await jevHeads($(async () => { throw new Error('disk full'); }), region, { preserveRecentMessages: 0 }, out);
  expect(out.jev).toBe('jev');
  expect(failing.size).toBe(heads.size);
});

test('home is always absolute: USERPROFILE fallback, placeholder strings skipped', async () => {
  const $ = (env: Record<string, string>) => ({ env: { get: async (k: string) => env[k] } }) as any;
  expect(await home($({ HOME: '/h', USERPROFILE: 'C:\\Users\\u' }))).toBe('/h');
  expect(await home($({ USERPROFILE: 'C:\\Users\\u' }))).toBe('C:\\Users\\u');
  // A host that stringifies a missing env var hands back "undefined"; interpolating
  // it made a relative "undefined/" dir under the cwd.
  expect(await home($({ HOME: 'undefined' }))).toBe(homedir());
  expect(await home($({ HOME: 'null', USERPROFILE: 'undefined' }))).toBe(homedir());
  expect((await home($({}))).startsWith('/') || /^[A-Za-z]:[\\/]/.test(await home($({})))).toBe(true);
});
