# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@th-yoo/cc-api-daemon` — an ACP (Agent Client Protocol) daemon: a
localhost WebSocket server, JSON-RPC, a session pool. Same wire protocol,
pool, and outcome semantics as meta-harness's `cc-gate-plugin/src/acp`,
but backed by `@anthropic-ai/sdk`'s `messages.create` instead of a spawned
Claude Code CLI subprocess — every turn is exactly one `messages.create`
call, not a subprocess round-trip. **The WebSocket handshake is
unauthenticated by deliberate ruling — read "Security" below before
touching the transport layer.**

Client trio: `ensureDaemon` (connect-or-spawn over WebSocket),
`daemonCall` (one turn), `closeSession`. `ApiSession` is the default
backend the daemon's pool constructs — injectable via `makeSession`, see
"Swapping the backend" below. Two more exports, `listModels`/`retrieveModel`,
wrap the Anthropic Models API directly (no daemon involved) — a capability
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

CI (`.github/workflows/ci.yml`) runs `bun test`, `bunx tsc --noEmit`, then `bun test` again with credentials explicitly scrubbed, on push/PR to `main`.

## Credential safety

**This repo is public** (github.com/th-yoo/cc-api-daemon) — every CI log
line is public. That is the threat model: a test that leaks a real
credential into stdout/stderr, or that quietly depends on one being present
to pass, exposes it to anyone who can read a GitHub Actions log. Everything
below exists to make that structurally hard, not just discouraged.

1. **The enforceable invariant**: `env -u ANTHROPIC_API_KEY -u
   ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test` must pass — currently
   187 pass / 0 fail. No test outcome may depend on host credentials. This
   is the check that would have caught a real bug on its first commit
   instead of three commits later: Task 6's two reenabled describe blocks
   (`acp-client.test.ts`'s e2e test, `acp-daemon.test.ts`'s "reaches the
   stubbed model" block) redirected `ANTHROPIC_BASE_URL` to a local stub but
   never overrode the credential itself, so `resolveAuth` silently fell
   through to whatever real credential the DEV HOST carried. It passed
   locally for three commits (Task 6, 7, 8) before failing on the first
   credential-less CI runner. Run the scrubbed command locally before
   trusting a green `bun test` on any host that might have real credentials
   lying around — CI also runs it as an explicit step (see below), but that
   step existing doesn't excuse skipping the local check, since CI is the
   *last* place you want to discover this.
2. **CI runs the scrubbed command as its own step**
   (`.github/workflows/ci.yml`, "bun test (credentials explicitly
   scrubbed)"), not folded into the normal `bun test` step. The normal
   `ubuntu-latest` step already happens to run credential-less today (no
   `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` secret is wired into this
   workflow) — but that's incidental, not enforced, and would silently stop
   being true the day a real key is added for some unrelated reason (a live
   integration test, say). The explicit step keeps the invariant checked
   regardless of what the workflow's secrets look like later.
3. **Every test that spawns a real daemon or builds a real Anthropic client
   must spread its own fake credential AFTER `...process.env`**, never
   before, and never rely on `ANTHROPIC_BASE_URL` redirection alone.
   Overriding only the URL still lets `resolveAuth` fall through to whatever
   real credential the host ambiently carries — sends a REAL token to a
   local stub (harmless: nothing reaches the real API) but is not what the
   test claims to be testing, and inverts silently the moment the host has
   no such credential. Use `test/helpers.ts`'s `stubEnv()`/`apiKeyEnv()`/
   `oauthEnv()` where available; `test/acp-daemon.test.ts`'s `spawnDaemon()`
   helper centralizes the injection for every daemon it spawns, so a new
   test using it inherits the fix automatically. **Grepping for the
   `ANTHROPIC_BASE_URL` literal to audit this undercounts**: `stubEnv()`
   supplies both `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from inside
   the helper, so a call site using it correctly has no `ANTHROPIC_BASE_URL`
   literal of its own to find.
4. **Never gate a test on host credential presence again** (no
   `describe.skipIf(!hasCredentials)` or equivalent). That pattern is what
   let the bug above ship in the first place, one layer removed: Task 1's
   `HAS_CLAUDE_CODE_CREDENTIALS` gate (since deleted — it stopped gating
   anything once Task 6 dropped the `skipIf`, but kept firing an
   unconditional `console.warn` naming tests this package doesn't have, on
   every credential-less run) hid a real dependency instead of removing it.
   A `skipIf` on credentials doesn't make a test credential-independent, it
   just stops running the test on the machine most likely to expose the
   dependency (a fresh CI runner) — the dependency ships silently until
   someone reads the actual failure. If a test genuinely needs live
   credentials (nothing in this package currently does), it needs its own
   clearly-named opt-in, not a silent skip.
5. **Existing protections worth preserving, not weakening**: `envFingerprint`
   (`acp-paths.ts`) redacts any env key matching `ACP_SECRET_KEY_RE =
   /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` to `KEY=set` before hashing —
   a credential's VALUE never enters the fingerprint, and the rule is
   name-shaped so a new credential variable is covered the day it appears,
   with no enum to keep in sync. `auth.ts` never logs a resolved token (zero
   `console.*` calls in the file). The production daemon spawn
   (`acp-client.ts`'s `spawnDaemonProcess`) runs with `stdout: "ignore",
   stderr: "ignore"` — a daemon crash or stray log line never reaches a
   parent process's output.

## Architecture

Thirteen files in `src/`, layered bottom-up. Two independent axes matter
more than a strict dependency chain: **wire vs. backend** (what crosses the
connection vs. what a session does to answer a turn) and **client vs.
server** (`acp-client.ts` never imports `acp-daemon.ts` — a caller on an
eager import path must be able to pull in the client without transitively
pulling in something that can start a server; the only link between them is
`acp-client.ts`'s `DAEMON_ENTRY`, a sibling-path *string*, not a module
import).

- **`acp-wire.ts`** — the §6e ACP wire subset: JSON-RPC method names, error
  codes, `AcpInitializeResult`/`AcpPromptParams`/etc. shapes, `ACP_BUDGET`,
  `WarmIsolation`, `modelProvenBy`. Also still exports `FrameDecoder`/
  `encodeFrame` — dead to the WebSocket transport (a WS message is already
  a discrete frame) but kept because `acp-daemon.ts`'s `--stdio` entry
  point still needs them: stdin/stdout is a raw byte stream with no message
  boundaries of its own. Zero internal deps. A private instrument profile,
  not a general-purpose ACP agent — `_meta.kkamak.model` is required on
  every prompt, there is no model-listing method.
- **`jsonrpc.ts`** — JSON-RPC 2.0 envelope validation for the WebSocket
  transport (`validateJsonRpc`, `createErrorResponse`) — ported from
  chronos-api-0.4.5's discipline, hand-rolled and dependency-free (no
  zod), matching every other file in `src/`. Runs BEFORE `acp-daemon.ts`'s
  dispatcher, catching malformed envelopes (wrong `jsonrpc` version,
  missing `method`, bad `id` type) the dispatcher's own permissive casts
  would otherwise silently mishandle. The one rule worth remembering: a
  notification (no `id`) never reaches the `ok` arm, even when otherwise
  well-formed — `isNotification` is the caller's entire instruction to
  skip replying, checked BEFORE `code`/`message` are ever used.
- **`acp-paths.ts`** — endpoint/lock/fingerprint seam (`discoveryPath`,
  `readDiscovery`, `writeDiscovery`, `wsUrl`, `envFingerprint`, lock
  acquire/release). Deliberately separate from `acp-daemon.ts` for the
  client/server split above.
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
  `createDispatcher`, wired to `runServer`/`runStdio`. `runServer` is
  `http.createServer()` + `WebSocketServer({noServer:true})` + a manual
  `upgrade` handler (chronos-api-0.4.5's wiring, minus Koa — this package
  serves no HTTP routes). Every runtime side effect (binding, spawning,
  `process.exit()` on shutdown) lives behind `if (import.meta.main)` — the
  daemon is a *script*, not an importable server function. There is no
  `serveDaemon`.
- **`acp-client.ts`** — `ensureDaemon`/`daemonCall`/`closeSession`: connect
  to a running daemon (via `readDiscovery` → the GLOBAL, browser-standard
  `WebSocket` — not the `ws` package's client class, which is the daemon's
  SERVER half only) or spawn one, the three-way outcome
  (`ok`/`no-call`/`call-consumed`), the spawn-lock sequence.
- **`models.ts`** — read-only model metadata (`listModels`, `retrieveModel`)
  over the Anthropic Models API, called directly — no daemon involved. No
  ACP wire precedent — a clean-slate addition with its own non-spend
  outcome vocabulary (`ok`/`no-auth`/`error`/`not-found`); see "Model
  metadata" below.
- **`index.ts`** — the ONLY public surface. `package.json`'s `exports` map
  resolves only `"."`, so nothing inside `src/` is reachable except what
  `index.ts` re-exports. Adding an export there is a deliberate widening of
  the public API, not incidental.

### The outcome law (§6e, load-bearing across the whole package)

Every `daemonCall` returns a `DaemonOutcome` and **never throws**. Three arms:

- `no-call` — provably nothing went toward the model. Client-side: no
  discovery entry / daemon reachable, connect refused, `initialize`/
  `session/new` failure, envFingerprint mismatch, a send error (L1, before
  the `session/prompt` message is confirmed sent — see "The send boundary"
  below for what "confirmed" means on this transport). Daemon-side (folds
  into the same arm over the wire): thinking-enabled refusal, no resolvable
  auth, a throw before `messages.create` is entered.
- `call-consumed` — any ambiguity at or after that send boundary (L2): HTTP
  error incl. 401, timeout, empty content, connection close/error, budget
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

Structural finding (not yet fixed, see README "Known limitations"): there
is no `await` between dequeuing a turn (`this.pending.shift()`) and the
send boundary — the first real yield point is buried inside `sendOne`'s
own `client.messages.create()` call, one level too deep for a
`session/cancel` to ever preempt a send already in `drain()`'s hands.
Upstream's CLI-backed `WarmSession` didn't have this gap because its first
await was a dynamic `import()` sitting *before* the send boundary. Under
the (now-retired) unix-socket transport this was directly demonstrable —
two frames written in one socket call landed in the daemon's decode loop
in one synchronous pass. Over WebSocket each message is its own
event-loop turn, so the two tests that proved this on the wire were
deleted as unconstructible (not fixed, not re-skipped) rather than kept
red or hidden — the gap in `ApiSession` itself is unaffected.

On the CLIENT side (`acp-client.ts`), the send boundary is adapted for the
transport too: `sentPrompt` is set right after a non-throwing `ws.send()`
returns, not inside a write-completion callback — the global `WebSocket`
API offers none (unlike `ws`'s own client class, or the old `net.Socket`).
This crosses the boundary marginally EARLIER than the write-callback
version did, which is the safe direction for §6e's law: it can only
convert a would-be `no-call` into a `call-consumed`, never the reverse.

### Swapping the backend (`makeSession`)

`acp-daemon.ts`'s `runServer`/`runStdio` (and the lower-level
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

### Security — the WebSocket handshake is unauthenticated (`acp-daemon.ts`)

Deliberate ruling (2026-08-07), not an oversight: `server.on("upgrade", ...)` accepts every request — no Origin check, no token — following chronos-api-0.4.5's reference upgrade handler, which does the same. Two consequences worth stating plainly:

- Any local process reaching `127.0.0.1` can drive the daemon and spend its resolved credentials. NOT a regression from the unix-socket transport, whose `0700` directory admitted the same set of processes (anything running as the same user) — the mechanism changed, not who was trusted.
- Any web page the user's browser visits can connect too — `new WebSocket('ws://127.0.0.1:PORT')` is not subject to same-origin policy, and loopback binding does not stop a script running IN a browser already open on the same machine. This IS new relative to the unix socket.

Full detail, the bounded blast radius, and the ~30-line fix if this is ever revisited (a custom-header token + Origin rejection, since the browser `WebSocket` constructor cannot set headers) are in README's own "Security" section — do not re-add auth to the upgrade handler without a fresh ruling; this one was made deliberately, twice-stated, by the user.

### Model metadata (`models.ts`)

`listModels`/`retrieveModel` wrap `GET /v1/models` and `GET /v1/models/{id}` — read-only, idempotent GETs, not billed model turns, called directly against the Anthropic API (no daemon). They deliberately do **not** reuse `DaemonOutcome`'s `no-call`/`call-consumed` vocabulary: that vocabulary exists specifically to encode billed-call spend-risk, which doesn't apply to an unbilled GET. Instead: `ok` / `no-auth` / `error` (+ `not-found` for `retrieveModel`, since a 404 there carries real information a caller can act on — unlike `daemonCall`'s uniform post-send classification, which exists only to preserve the spend-boundary law).

No ACP wire precedent exists for the ORIGINAL kkamak surface: `meta-harness/cc-gate-plugin/src/acp/acp-wire.ts` has no model-list or config-option method at all — it's a narrow private instrument profile, not a general-purpose ACP agent. (Public ACP does have a model-listing convention — a `session/set_config_option` mechanism with a shallow `{value, name, description}` model category — but nothing in kkamak's wire subset implements it.) So `ModelInfo` is re-exported verbatim from the SDK rather than reshaped to either precedent. THIS package's own wire now diverges from that precedent deliberately — see `kkamak/models/list` immediately below.

`listModels` auto-drains every page into one flat array (`PagePromise` is an `AsyncIterable`); a failure partway through a multi-page walk discards the partial list rather than returning it — binary all-or-`error`, no partial-success arm.

### `kkamak/models/list` (`acp-daemon.ts`, `acp-wire.ts`)

Model enumeration reachable over the wire, not just as a direct SDK-backed export — for a caller that only speaks ACP and has no import access to `models.ts` itself. Handled at the TOP of `createDispatcher`'s switch, entirely bypassing `pool`/`state`/`ApiSession` — stateless metadata, not a turn: no `session/new`, no `pool.acquire`, callable any time after `initialize`. `createDispatcher` therefore takes a fourth parameter, `env` (the daemon's own spawn env), threaded straight to `listModels(env)` — everything else in the dispatcher signature was daemon-global state that already existed; `env` is the one new piece this method needed.

Method name is `kkamak/models/list`, never a bare `models/list` — the ACP extensibility rule this file already applies to `_meta` fields (see the comment above `AcpInitializeResult` in `acp-wire.ts`) reasons identically about method NAMES: ACP has `session/*` today and could plausibly reserve `models/*` tomorrow, so a bare `models/list` would squat on it.

Result is `ModelInfo[]` **verbatim** in the JSON-RPC `result` field (not wrapped in `{models: [...]}`) — the daemon is a pipe, not a curator, matching `models.ts`'s own re-export-don't-trim choice.

Errors are its own pair — `ACP_ERR_MODELS_NO_AUTH = -32004`, `ACP_ERR_MODELS_UPSTREAM_ERROR = -32005` — deliberately NOT `ACP_ERR_NO_CALL`/`ACP_ERR_CALL_CONSUMED` (those encode billed-call spend-risk, which an unbilled `GET /v1/models` has none of — the identical reasoning `models.ts` already applied when it got its own `ok`/`no-auth`/`error`/`not-found` vocabulary instead of reusing `DaemonOutcome`, commit 80ae1ea) and deliberately NOT `-32002`/`-32003` either: `-32002` already means "pool exhausted" on `session/prompt` in this exact codebase (`acp-daemon.ts`, baked into `test/acp-fake-daemon.ts`'s fixtures too) — reusing it here would make the same numeric code mean two unrelated things depending on which method a reader happens to be looking at. `respondError`'s `data` parameter is `unknown`, not narrowed to `{callConsumed: boolean}`, specifically so this method's own `{status?: number}` error data can share the same helper.

Budget: no explicit `budgetMs` passed to `listModels(env)` — its own default (`models.ts`'s private `DEFAULT_MODELS_BUDGET_MS`, not exported) already applies when omitted, which IS this method's timeout leg; exporting the constant just to hand it back would be pure indirection.

Not done here, on purpose: **no caching**. Model lists are near-static and a plausible caching target, but this method ships uncached — every call is a real round-trip. A deliberate later change if request volume/latency becomes a real cost, not bundled into this one.

### Known, intentional limitations (see README "Known limitations" for full detail)

- `canonicalModel === model` always — the raw API exposes one identity field, so `modelProvenBy`'s `canonicalModel` branch is dead code here, kept for interface parity.
- HTTP 401 classifies as `call-consumed` (uniform post-`messages.create` classification is a conscious non-goal to refine).
- `listModels`/`retrieveModel`'s `budgetMs` becomes the SDK client's per-request `timeout`, which only starts once the HTTP request begins — `resolveAuth`'s ~10s darwin-keychain worst case runs synchronously before that, unbounded by `budgetMs`. `ApiSession`'s own turn doesn't have this gap: `turnTimeoutMs`'s abort deadline is scheduled before `sendOne` is called, so it covers auth resolution too (`ACP_BUDGET.turnTimeoutMs` is sized `>= AUTH_RESOLVE_BUDGET_MS` for exactly this reason).
- `listModels`'s `budgetMs` bounds each individual HTTP request in a pagination walk, not the total time to drain all pages.
- The SDK reads `ANTHROPIC_CUSTOM_HEADERS`/`ANTHROPIC_LOG`/`ANTHROPIC_WEBHOOK_SIGNING_KEY` unconditionally from the real `process.env` with no way to suppress — documented as unclosable, not a bug to fix.
- `session/cancel` cannot preempt a send already in `ApiSession.drain()`'s hands — see "The send boundary and history" above.

## Provenance / porting notes

Several files carry deliberate ports from a sibling project, meta-harness's `cc-gate-plugin` (`src/acp/*`, `src/gauge/transport.ts`, `minimal/providers/anthropic-api.ts`). Where a file's header cites line numbers or a specific origin function, treat that as the design rationale — changes that diverge from the cited behavior should be intentional and worth a comment, not accidental drift.
