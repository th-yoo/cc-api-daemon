# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@th-yoo/cc-api-daemon` — an ACP (Agent Client Protocol) daemon: unix
socket, newline-delimited JSON-RPC, a session pool. Same wire protocol,
socket, pool, and outcome semantics as meta-harness's `cc-gate-plugin/src/acp`,
but backed by `@anthropic-ai/sdk`'s `messages.create` instead of a spawned
Claude Code CLI subprocess — every turn is exactly one `messages.create`
call, not a subprocess round-trip.

Client trio: `ensureDaemon` (connect-or-spawn over the socket),
`daemonCall` (one turn), `closeSession`. `ApiSession` is the default
backend the daemon's pool constructs — injectable via `makeSession`, see
"Swapping the backend" below. Two more exports, `listModels`/`retrieveModel`,
wrap the Anthropic Models API directly (no socket involved) — a capability
the ACP wire itself has no method for; see "Model metadata" below — with a
deliberately *different* outcome vocabulary, since it's an unbilled GET
rather than a billed send. Bun-only; raw `.ts` sources are what the package
exports (`package.json` `exports["."]` → `src/index.ts`).

## Commands

- `bun install --frozen-lockfile` — install deps
- `bun test` — run all tests
- `bun test test/call.test.ts` — run a single test file
- `bun test -t "<name>"` — filter by test name
- `bun run typecheck` (or `bunx tsc --noEmit`) — typecheck, no emit
- `bun scripts/smoke.ts` — live smoke test, **real API spend (one haiku call)**; run deliberately, never in CI. Spawns/waits for a real daemon first (`ensureDaemon(env, { waitMs })`), then one real `daemonCall` round-trip.

CI (`.github/workflows/ci.yml`) runs `bun test` then `bunx tsc --noEmit` on push/PR to `main`.

## Architecture

Twelve files in `src/`, layered bottom-up. Two independent axes matter more
than a strict dependency chain: **wire vs. backend** (what crosses the
socket vs. what a session does to answer a turn) and **client vs. server**
(`acp-client.ts` never imports `acp-daemon.ts` — a caller on an eager
import path must be able to pull in the client without transitively
pulling in something that can start a server; the only link between them is
`acp-client.ts`'s `DAEMON_ENTRY`, a sibling-path *string*, not a module
import).

- **`acp-wire.ts`** — the §6e ACP wire subset: JSON-RPC method names, error
  codes, `FrameDecoder`, `AcpInitializeResult`/`AcpPromptParams`/etc.
  shapes, `ACP_BUDGET`, `WarmIsolation`, `modelProvenBy`. Zero internal
  deps. A private instrument profile, not a general-purpose ACP agent —
  `_meta.kkamak.model` is required on every prompt, there is no
  model-listing method.
- **`acp-paths.ts`** — endpoint/lock/fingerprint seam (`socketPath`,
  `envFingerprint`, lock acquire/release). Deliberately separate from
  `acp-daemon.ts` for the client/server split above.
- **`session-contract.ts`** — the backend-neutral dispatch contract
  (`DispatchableSession`, `TurnOutcome`, `CancelResult`) both `ApiSession`
  and any injected backend are checked against.
- **`auth.ts`** — credential resolution (`resolveAuth`), ported from
  meta-harness `cc-gate-plugin/src/gauge/transport.ts`.
- **`client.ts`** — shared Anthropic SDK client construction
  (`buildClient`), including the ambient-env-leak guards below. Used by
  `call.ts` and `models.ts` — the one place that invariant is implemented.
- **`call.ts`** — `sendOne`, the one-`messages.create`-per-call leaf.
  Stateless per call; the caller supplies the full `messages` array.
- **`api-session.ts`** — `ApiSession`, the default `DispatchableSession`
  backend: owns the accumulated conversation array (there is no subprocess
  holding state — "warm" here means the array persists, not a process),
  strict FIFO dispatch via `pending`/`current`/`drain()`.
- **`acp-pool.ts`** — `SessionPool`: long-lived `ApiSession`s (or an
  injected backend) keyed by isolation *value*, not by session id. The
  daemon mints one ACP session id per request; the pool is the keep-alive
  layer underneath.
- **`acp-daemon.ts`** — the daemon: `DaemonState`/`createDaemonState`/
  `createDispatcher`, wired to `runSocket`/`runStdio`. Every runtime side
  effect (binding the socket, spawning, `process.exit()` on shutdown) lives
  behind `if (import.meta.main)` — the daemon is a *script*, not an
  importable server function. There is no `serveDaemon`.
- **`acp-client.ts`** — `ensureDaemon`/`daemonCall`/`closeSession`: connect
  to a running daemon or spawn one, the three-way outcome
  (`ok`/`no-call`/`call-consumed`), the spawn-lock sequence.
- **`models.ts`** — read-only model metadata (`listModels`, `retrieveModel`)
  over the Anthropic Models API, called directly — no socket, no daemon
  involved. No ACP wire precedent — a clean-slate addition with its own
  non-spend outcome vocabulary (`ok`/`no-auth`/`error`/`not-found`); see
  "Model metadata" below.
- **`index.ts`** — the ONLY public surface. `package.json`'s `exports` map
  resolves only `"."`, so nothing inside `src/` is reachable except what
  `index.ts` re-exports. Adding an export there is a deliberate widening of
  the public API, not incidental.

### The outcome law (§6e, load-bearing across the whole package)

Every `daemonCall` returns a `DaemonOutcome` and **never throws**. Three arms:

- `no-call` — provably nothing went toward the model. Client-side: no
  socket reachable, connect refused, `initialize`/`session/new` failure,
  envFingerprint mismatch, a write error (L1, before the `session/prompt`
  frame's write callback reports success). Daemon-side (folds into the same
  arm over the wire): thinking-enabled refusal, no resolvable auth, a throw
  before `messages.create` is entered.
- `call-consumed` — any ambiguity at or after that send boundary (L2): HTTP
  error incl. 401, timeout, empty content, socket close/error, budget
  expiry with no response. A call may have been spent; caller must NOT
  retry/double-spend.
- `ok` — success, with `text`, `model`, `canonicalModel`, `sessionId`.

`sessionId` is minted before any check runs and carried on every arm.
`maxRetries: 0` always on the daemon's own SDK client — exactly one HTTP
call ever per turn.

### The send boundary and history (`api-session.ts`)

`ApiSession.drain()` is strict FIFO, one turn on the wire at a time. The
send boundary is one line: `turn.sent = true`, set immediately before
`sendOne(...)` is called — everything from that line onward is
call-consumed, nothing before it is. History (the `messages` array threaded
into the next turn) advances **only on a proven-`ok` turn**:
a failed or aborted turn must not leave a dangling user message that every
later turn re-sends and re-pays for.

Structural finding (not yet fixed, see README "Known limitations" and
`test/acp-daemon.test.ts`'s two `test.todo` cases): there is no `await`
between dequeuing a turn (`this.pending.shift()`) and the send boundary —
the first real yield point is buried inside `sendOne`'s own
`client.messages.create()` call, one level too deep for a `session/cancel`
arriving in the same socket chunk as its target prompt to ever preempt the
send. Upstream's CLI-backed `WarmSession` didn't have this gap because its
first await was a dynamic `import()` sitting *before* the send boundary.

### Swapping the backend (`makeSession`)

`acp-daemon.ts`'s `runSocket`/`runStdio` (and the lower-level
`createDaemonState`) accept `opts.makeSession?: (env, warmOpts) =>
DispatchableSession`, threaded straight through to `SessionPool`. Omit it
and the pool defaults to `(e, warmOpts) => new ApiSession(e, warmOpts)`.
This is the supported seam for injecting a different backend (another
model provider, a scripted fake for tests) without touching the wire layer
— `session-contract.ts`'s `DispatchableSession` is what both sides are
checked against.

### Auth precedence (`auth.ts`)

1. `env.ANTHROPIC_API_KEY` (non-empty)
2. `env.ANTHROPIC_AUTH_TOKEN` (non-empty) — also the test/keychain-less-host seam
3. darwin: macOS keychain item `Claude Code-credentials` via `security` (10s exec timeout; a darwin failure does NOT fall through to the credentials file)
4. else: `~/.claude/.credentials.json`

Resolution never throws — undefined on any failure. Resolved **daemon-side**
now (inside `ApiSession`/`sendOne`, per turn) — the `env` that matters is
whichever one first spawned the daemon: `Bun.spawn`'s `env` option
*replaces* the child process's environment rather than merging with the
caller's, so the daemon subprocess runs with exactly the env object passed
to the `ensureDaemon` call that spawned it, for its whole lifetime. See
"ambient-env leak guards" below for the separate SDK-level guard.

### Ambient-env leak guards (`client.ts`)

The `@anthropic-ai/sdk` client defaults any *omitted* (`undefined`) `apiKey`/`authToken`/`baseURL` constructor option from the real `process.env`, and composes both auth headers with no precedence if both are present — a host carrying the other credential ambiently would silently send both `X-Api-Key` and `Authorization`. So in both auth lanes the not-chosen field is always explicit `null`, and `baseURL` is always `env.ANTHROPIC_BASE_URL ?? null` (never omitted). This is why `buildClient` constructs two full, separately-shaped `new Anthropic(...)` calls rather than building one options object conditionally — don't collapse them. `call.ts` and `models.ts` both call `buildClient` rather than reimplementing this — the invariant lives in exactly one place.

The OAuth (authToken) lane sends `anthropic-beta: oauth-2025-04-20`; the apiKey lane does not.

### Model metadata (`models.ts`)

`listModels`/`retrieveModel` wrap `GET /v1/models` and `GET /v1/models/{id}` — read-only, idempotent GETs, not billed model turns, called directly against the Anthropic API (no socket, no daemon). They deliberately do **not** reuse `DaemonOutcome`'s `no-call`/`call-consumed` vocabulary: that vocabulary exists specifically to encode billed-call spend-risk, which doesn't apply to an unbilled GET. Instead: `ok` / `no-auth` / `error` (+ `not-found` for `retrieveModel`, since a 404 there carries real information a caller can act on — unlike `daemonCall`'s uniform post-send classification, which exists only to preserve the spend-boundary law).

No ACP wire precedent exists for this: the actual kkamak ACP surface (`meta-harness/cc-gate-plugin/src/acp/acp-wire.ts`) has no model-list or config-option method at all — it's a narrow private instrument profile, not a general-purpose ACP agent. (Public ACP does have a model-listing convention — a `session/set_config_option` mechanism with a shallow `{value, name, description}` model category — but nothing in kkamak's wire subset implements it.) So `ModelInfo` is re-exported verbatim from the SDK rather than reshaped to either precedent.

`listModels` auto-drains every page into one flat array (`PagePromise` is an `AsyncIterable`); a failure partway through a multi-page walk discards the partial list rather than returning it — binary all-or-`error`, no partial-success arm.

### Known, intentional limitations (see README "Known limitations" for full detail)

- `canonicalModel === model` always — the raw API exposes one identity field, so `modelProvenBy`'s `canonicalModel` branch is dead code here, kept for interface parity.
- HTTP 401 classifies as `call-consumed` (uniform post-`messages.create` classification is a conscious non-goal to refine).
- `listModels`/`retrieveModel`'s `budgetMs` becomes the SDK client's per-request `timeout`, which only starts once the HTTP request begins — `resolveAuth`'s ~10s darwin-keychain worst case runs synchronously before that, unbounded by `budgetMs`. `ApiSession`'s own turn doesn't have this gap: `turnTimeoutMs`'s abort deadline is scheduled before `sendOne` is called, so it covers auth resolution too (`ACP_BUDGET.turnTimeoutMs` is sized `>= AUTH_RESOLVE_BUDGET_MS` for exactly this reason).
- `listModels`'s `budgetMs` bounds each individual HTTP request in a pagination walk, not the total time to drain all pages.
- The SDK reads `ANTHROPIC_CUSTOM_HEADERS`/`ANTHROPIC_LOG`/`ANTHROPIC_WEBHOOK_SIGNING_KEY` unconditionally from the real `process.env` with no way to suppress — documented as unclosable, not a bug to fix.
- A `session/cancel` in the same socket chunk as its target `session/prompt` cannot preempt the send — see "The send boundary and history" above.

## Provenance / porting notes

Several files carry deliberate ports from a sibling project, meta-harness's `cc-gate-plugin` (`src/acp/*`, `src/gauge/transport.ts`, `minimal/providers/anthropic-api.ts`). Where a file's header cites line numbers or a specific origin function, treat that as the design rationale — changes that diverge from the cited behavior should be intentional and worth a comment, not accidental drift.
