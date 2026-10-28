# Componion for Codex

The Codex member of the kern(2), orly, componion trio. Requires Bun, Node,
and Codex on PATH. The v2 worker connects to the existing local Codex daemon.
The JEV compaction engine is vendored from the local Claude Componion 5.3.0
plugin (fast-jev-compaction 0.3.0, MIT); see `jev/LICENSE`.

Before native Codex compaction, the plugin archives originals and builds a
bounded deterministic recall index locally, without a network grading request.
An unchanged rollout reuses the prepared index. Stop prepares the index between
turns; set `prewarm: false` to disable this. Explicit `index_context` and the
experimental handoff retain JEV grading. After compaction, a
SessionStart hook supplies the recent index and recall instructions.
`decompress` retrieves exact originals; `search_context` finds archived text.
All tools take an explicit `session_id`, supplied by the startup hook.
`index_context` can create an archive before compaction is due.

The three v2 tools take an actual `thread_id` instead:

- `compact_context`: queue native compaction of the current thread, then
  inject the fast recall index. A detached worker waits until the turn ends,
  observes compaction completion, and only then restores recall.
- `fold_context`: explicit experimental new-thread handoff using
  `thread/resume.history`. JEV removes or shortens older tool pairs; recent
  pairs, non-tool messages, and archive references remain. The source is
  preserved and the result reports the new thread id. This does not switch
  the Codex UI. Opaque signed histories and unsupported sandboxes are refused.
- `compaction_status`: read queued/running/completed/failed state and the
  resulting thread id. Do not wait for completion within the requesting
  turn: the worker needs that turn to finish first.

`TYPESAFE_API_KEY` enables grading. JEV receives abridged conversation text
and tool inputs, with output-size notes instead of full tool results.
Successful answers append to `~/.jev/log/YYYY-MM-DD.jsonl`, matching the
trio's teacher dataset format. Without a key, on timeout, or on invalid
answers, a deterministic recall index remains available; status names the
failure. Originals must finish writing before the index is published.

Status appears at turn end through Codex's `systemMessage` hook output.
Codex renders this as a warning/event, not a custom panel. Rows use the
Claude block and star vocabulary: turn score, ctx, JEV, kern, orly.
Missing metrics stay unknown. `kern status --json` is read in the session's
working directory; set `KERN_BIN` to use a specific kern2 binary. orly
publishes its existing `~/.orly/status/<session>.json`. The two Stop hooks
can run concurrently, so orly's row can initially be the previous verdict;
the `status` tool reads the latest file when requested.

Local files live in `${CODEX_HOME:-~/.codex}/componion/`: `status/`,
`sessions/<session>/originals/`, and `sessions/<session>/index.json`.
Files are private to the user and status/index updates use atomic rename.
Archives persist after session end. No Claude settings or archives change.

Optional `config.json` in that directory accepts `{"enabled":false}` to
disable hooks, or `{"surface":"sidecar"}` to silence turn-end output.
A sidecar is available with `bun install/codex/scripts/deck.ts --session <id> --watch`.

With trusted hooks, Stop queues v2 native compaction above 50,000 input
tokens, at most once per ten minutes. Set `autoCompact: false` to disable
this, or `foldFromTokens` to change the threshold. A busy thread is polled
for at most ten minutes. Duplicate requests share the current job. Missing
daemon, timeout, unsupported thread state, or RPC failure leaves a diagnostic
in `sessions/<thread>/v2-job.json` and the v2 status row. The plugin does not
start, restart, or stop the user's daemon. `v2Socket` optionally selects an
absolute local socket path. The default is Codex's app-server control socket.

The control socket uses WebSocket frames, not newline JSON. The bundled
Node bridge uses ws (MIT, `scripts/ws-LICENSE`); no npm install is needed
in the installed plugin. Rebuild it with `bun build --target=node --format=cjs install/codex/scripts/socket-bridge.mjs --outfile install/codex/scripts/socket-bridge.cjs` after changes.

## Host boundary

JEV archive indexes do not replace active Codex history. The same-thread
v2 path delegates history replacement to native compaction and appends the
recall index afterwards. The experimental handoff installs a reduced history
in a **new thread**: v2 rejects history overrides for loaded threads. Its
`history` parameter is marked unstable and reserved for Codex Cloud in the
0.157.1 schema. The isolated integration test exercises the installed runtime
before relying on it; this is not a stable API guarantee.

The plugin does not minify live tool responses or embed Claude's live UI band.
`saved`, `folds`, and `lastFold` stay zero; `nativeCompactions` reports native
compactions and the handoff result reports serialized characters removed,
including its added recall bridge, rather than claiming measured token savings.

See [Codex hooks](https://learn.chatgpt.com/docs/hooks) and
[plugin packaging](https://developers.openai.com/plugins/build/plugins).
Install with `codex plugin add componion@personal`, then review and trust
the plugin hooks through Codex's `/hooks` UI and start a new thread.
Plugin installation alone does not grant hook trust. Tests from the plugin root: `bun test ./install/codex/scripts/componion.check.ts`.
Run `bun install/codex/scripts/check-v2.ts` for the isolated real-Codex test: a local fixture model
captures outgoing model requests to prove history replacement, recent-context
retention, recall injection, and the queued worker's idle wait. Direct paths
use a deterministic JEV test double; the native worker uses fast local recall with no teacher request. No user threads are
used or modified by this test.

For a real-host discovery check after installation, run
`python3 install/codex/scripts/check-host.py` from a kern
workspace. It checks tool handshakes and reports hook trust without changing
trust or starting a model turn. The legacy MCP manifest resolves `cwd: "."`
against the installed plugin root; `${PLUGIN_ROOT}` is only expanded in
hook commands on this compatibility path.

## Preparation benchmark

Run `bun install/codex/scripts/benchmark.ts` from the plugin root. It compares
the original serial archive preparation with the fast path on 2,000 tool
outputs (18 MB), with seven warm runs. The baseline excludes all network
grading. A representative run measured 98.75 ms vs 0.61 ms for unchanged
history (162× faster). Cold preparation was 212.84 ms vs 283.30 ms, so it
was slower in that run. Prewarming moves that cost between turns; it is not
a native model compaction speed measurement. The native model still owns
summarization latency. Cache invalidation covers appended/truncated/rewritten
rollouts and removed originals; index publication follows completed archive
writes. `preparationMs`, `cacheHit` and `totalMs` are reported by native jobs.
