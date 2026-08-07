# @th-yoo/cc-api-daemon

An ACP (Agent Client Protocol) daemon — a localhost WebSocket server,
JSON-RPC, a session pool — with `@anthropic-ai/sdk`'s `messages.create` as
the backend instead of a spawned Claude Code CLI subprocess. Same wire
protocol, pool, and outcome semantics as meta-harness's
`cc-gate-plugin/src/acp`; every turn is exactly one `messages.create` call.

`ensureDaemon`/`daemonCall`/`closeSession` are the client trio: connect to a
running daemon, or spawn one, over a real WebSocket. `ApiSession` is the
injectable backend the daemon runs by default (see "Swapping the backend"
below). `listModels`/`retrieveModel` wrap the Anthropic Models API — a
capability the ACP wire itself has no method for; see "Model metadata"
below. **Read "Security" below before running this on a machine you share
with anything else** — the daemon authenticates no WebSocket connection at
all.

## Install

Not yet published to npm — add from git:

```sh
bun add git+https://github.com/th-yoo/cc-api-daemon.git
```

Requires Bun (`engines.bun >= 1.0`); raw `.ts` sources are what the package
exports.

## Usage

```ts
import {
  ensureDaemon,
  daemonCall,
  closeSession,
  modelProvenBy,
  type WarmIsolation,
} from "@th-yoo/cc-api-daemon"

// Isolation values are caller-side policy — this package ships none.
const isolation: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "my-probe",
  thinking: { type: "disabled" },
}

// Connect to a daemon already listening on this env's discovery entry, or
// spawn one and wait up to waitMs for it to bind. waitMs defaults to 0
// (kick a background spawn, return immediately) — pass a real budget when
// the caller needs the daemon up before proceeding, e.g. a cold-start script.
await ensureDaemon(process.env, { waitMs: 10_000 })

const requested = "claude-haiku-4-5"
const outcome = await daemonCall("Say ok.", requested, process.env, { isolation })

switch (outcome.kind) {
  case "ok":
    if (!modelProvenBy(outcome.model, requested, outcome.canonicalModel)) {
      throw new Error(`served by ${outcome.model}, not ${requested}`)
    }
    console.log(outcome.text)
    await closeSession(outcome.sessionId!, process.env)
    break
  case "no-call":
    // Provably nothing was sent — safe to fall back to another lane.
    break
  case "call-consumed":
    // A call may have been spent — do NOT retry elsewhere.
    break
}
```

`daemonCall` does not spawn a daemon itself — it only connects to whatever
port `readDiscovery(env)` resolves to. Call `ensureDaemon` first (as above)
unless something else in the process already has.

### Running the daemon directly

`ensureDaemon`'s connect-or-spawn is the only path exercised in this
package's own tests and is the intended way to bring a daemon up. A host
that wants to pre-launch one explicitly (rather than let the first
`ensureDaemon` call spawn it) can still run the entry point directly:

```sh
bun src/acp-daemon.ts          # WebSocket transport on 127.0.0.1 (default)
bun src/acp-daemon.ts --stdio  # stdio transport
```

There is no `serveDaemon`-style importable function — every runtime side
effect in `acp-daemon.ts` lives behind `if (import.meta.main)`, so the
daemon is a script, not a library call.

## Auth

Credential precedence, first hit wins:

1. `env.ANTHROPIC_API_KEY`
2. `env.ANTHROPIC_AUTH_TOKEN`
3. darwin: macOS keychain item `Claude Code-credentials`
4. else: `~/.claude/.credentials.json`

Resolved **daemon-side** now (inside `ApiSession`, per turn), not by the
client process that calls `daemonCall`. The env that matters is whichever
one first spawned the daemon: `Bun.spawn`'s `env` option *replaces* the
child process's environment rather than merging with the caller's, so the
daemon subprocess runs with exactly the env object passed to the
`ensureDaemon` call that spawned it, for its whole lifetime (until idle
reaped). A daemon spawned with a different env computes a different
`envFingerprint` and publishes a different discovery entry, so a client
with a mismatched env simply never reaches it (`no-call`) rather than
reaching it under the wrong credentials — **but see "Security" below**:
that mismatch check only protects a client from talking to the *wrong*
daemon, not from an *unrelated* WebSocket client talking to the *right* one.

The OAuth lane sends `anthropic-beta: oauth-2025-04-20` with `apiKey`
explicitly suppressed; the apiKey lane suppresses `authToken`.

## Security

**The daemon accepts every WebSocket upgrade with no Origin check and no
token.** This is a deliberate ruling (2026-08-07), recorded here so a reader
who finds an unauthenticated localhost daemon holding API credentials finds
the decision documented, not left to infer it — the same way
`chronos-api-0.4.5`'s reference upgrade handler this package's server
wiring follows also performs no check.

What this accepts:

- **Any local process** can drive the daemon and spend the host's Anthropic
  credentials. This is *not* a regression from the old unix-socket
  transport — its `0700` socket directory already admitted any process
  running as the same user; the daemon binding `127.0.0.1` instead of a
  filesystem path changes the mechanism, not who was already trusted.
- **Any web page the user's browser visits** can connect. This *is* new.
  A WebSocket handshake is not subject to the same-origin policy —
  `new WebSocket('ws://127.0.0.1:PORT')` from any page succeeds regardless
  of which site served it — and loopback binding does not prevent this;
  it only prevents a *remote* attacker, not one running in the browser
  already open on the same machine.

The stakes are real but bounded: everything reachable over this wire is
either a billed `messages.create` turn (spending the *daemon's* resolved
credentials, never the caller's own) or the read-only, unbilled model
metadata in "Model metadata" below — there is no data exfiltration path,
no write access to anything on disk beyond what a turn's own model output
could already produce, and no credential value is ever echoed back over
the wire (`envFingerprint`'s redaction, and `auth.ts` never logging a
resolved token, both still apply — see `CLAUDE.md`'s "Credential safety").
The exposure is "an unrelated page can make the daemon spend money and
return text," not "an unrelated page can read the API key."

**If this ruling is ever revisited, the fix is small and belongs at the
upgrade handler** (`acp-daemon.ts`'s `server.on("upgrade", ...)`): require
a token in a *custom header* (the browser `WebSocket` constructor cannot
set headers, so that alone excludes browser pages by construction), reject
any request carrying an `Origin` header at all, and keep the token in a
`0600` file next to the discovery entry. Roughly 30 lines. Noted here so
the option is costed, not to relitigate it.

## Swapping the backend

`ApiSession` is the default session the daemon's pool constructs, but it is
injectable — `acp-daemon.ts`'s `runServer`/`runStdio` (and the lower-level
`createDaemonState`) both accept a `makeSession` option shaped
`(env, warmOpts) => DispatchableSession`. A host embedding this daemon can
supply its own backend (a different model provider, a scripted fake for
tests) without touching the wire layer; `session-contract.ts`'s
`DispatchableSession` is the contract both implementations are checked
against.

## Outcome law

- `no-call` — provably nothing went toward the model: no discovery entry /
  daemon reachable, connect refused, `initialize`/`session/new` failure,
  envFingerprint mismatch, a send error, or (daemon-side) a thinking-enabled
  refusal / no resolvable auth / a throw before `messages.create` is
  entered. Safe to fall back elsewhere.
- `call-consumed` — any ambiguity at or after the `session/prompt` message
  is sent: HTTP error (including 401), timeout, connection close/error,
  budget expiry with no response, empty content. A call may have been
  spent; the caller must NOT double-spend.
- `maxRetries: 0` on the daemon's own SDK client — exactly one HTTP call
  ever per turn.

This vocabulary is specific to `daemonCall`'s billed `messages.create` send —
see "Model metadata" below for the separate, unbilled-GET outcome vocabulary
used by `listModels`/`retrieveModel`.

## Model metadata

`listModels`/`retrieveModel` wrap the Anthropic Models API
(`GET /v1/models`, `GET /v1/models/{id}`) — read-only, idempotent GETs, not
billed model turns, and not routed through the daemon at all (they call the
Anthropic API directly from whichever process calls them). Unlike
`daemonCall`, there is no no-call/call-consumed double-spend concern here,
so the outcome vocabulary names what actually happened instead:

```ts
import { listModels, retrieveModel } from "@th-yoo/cc-api-daemon"

const list = await listModels(process.env)
if (list.kind === "ok") {
  for (const model of list.models) console.log(model.id, model.display_name)
}

const one = await retrieveModel("claude-opus-5", process.env)
switch (one.kind) {
  case "ok":
    console.log(one.model.max_input_tokens, one.model.capabilities)
    break
  case "not-found":
    // the model ID doesn't exist / isn't resolvable
    break
  case "no-auth":
  case "error":
    break
}
```

- `ok` — `{ models: ModelInfo[] }` (list) or `{ model: ModelInfo }`
  (retrieve). `ModelInfo` is re-exported verbatim from the SDK.
- `no-auth` — no resolvable credentials; zero requests sent.
- `not-found` — `retrieveModel` only: HTTP 404, the model ID doesn't resolve.
- `error` — any other failure (HTTP error, timeout, network). Carries
  optional `status`/`message` from the SDK's `APIError` when available.

`listModels` drains every page into one flat array — there is no
partial-success arm; a failure partway through a multi-page walk discards
what was collected and returns `error`.

### `kkamak/models/list` — model enumeration ON THE WIRE

`listModels`/`retrieveModel` above are direct SDK calls — no daemon
involved at all, one process's own credentials. `kkamak/models/list` is the
same capability reachable *through* the daemon, over the socket, for a
caller that only speaks ACP and has no direct access to this process's own
`listModels` import:

```
--> {"jsonrpc":"2.0","id":1,"method":"kkamak/models/list"}
<-- {"jsonrpc":"2.0","id":1,"result":[{"id":"claude-haiku-4-5-20251001", ...}]}
```

Stateless metadata, not a turn — callable any time after `initialize`, no
`session/new` needed. `result` is `ModelInfo[]` verbatim (the daemon is a
pipe here, not a curator, matching `listModels`'s own re-export-don't-trim
choice). Namespaced `kkamak/models/list`, not `models/list` — see
`src/acp-wire.ts`'s own comment above `ACP_MODELS_LIST` for why a bare
`models/*` would squat on a name ACP itself might reserve.

**Credential boundary**: results come from the *daemon's* resolved
credentials, never the caller's — a client learns what the daemon can see,
not what the client's own process could see if it called the Anthropic API
directly. Combined with the daemon's no-auth WebSocket ruling (see
"Security" above), this means any local process — or, per that same
ruling, any web page the user's browser has open — can enumerate whatever
models the daemon's credentials expose. Low stakes (read-only, unbilled
metadata, no credential value crosses the wire), but stated here rather
than left implicit.

Errors are its own pair, deliberately not `daemonCall`'s no-call/
call-consumed (that vocabulary encodes billed-call spend-risk; this is an
unbilled GET, same reasoning as `listModels`'s own outcome vocabulary
above) and deliberately not `-32002`/`-32003` either (`-32002` already
means "pool exhausted" on `session/prompt` in this daemon):

- `-32004` — no resolvable credentials (mirrors `listModels`'s `no-auth`).
- `-32005` — any other upstream failure; `error.data.status` carries the
  HTTP status when the SDK's `APIError` provided one.

Not yet done, on purpose: **no caching**. Model lists are near-static and
this is a plausible place to cache a response for a short TTL, but this
first cut ships uncached — every `kkamak/models/list` call is a real
`GET /v1/models` round-trip. Add caching later as its own deliberate
change if the extra latency/request volume becomes a real cost, not
bundled in here.

## Known limitations

- `canonicalModel === model` always — the raw API exposes exactly one
  identity field, so `modelProvenBy`'s `canonicalModel` branch is dead code
  here. Documented, not "fixed".
- HTTP 401 classifies as `call-consumed` even though it provably consumed
  nothing — classification is uniformly post-`messages.create`;
  distinguishing status codes is a non-goal.
- Bun-only: raw `.ts` sources are published (`exports` maps to
  `src/index.ts`); non-Bun consumers need a build step. Verified against
  `@anthropic-ai/sdk` 0.115.0.
- env-param-authority exceptions: the SDK reads `ANTHROPIC_CUSTOM_HEADERS`
  (also `ANTHROPIC_LOG`, `ANTHROPIC_WEBHOOK_SIGNING_KEY`) unconditionally
  from the real `process.env`, with no constructor option to suppress them —
  unclosable, documented.
- `budgetMs` on `daemonCall`/`closeSession` bounds the client-side
  connection phase only; daemon-side turn budgeting (queue wait, generation,
  auth resolution) is `ACP_BUDGET`'s own set of legs, not this parameter.
- `listModels`/`retrieveModel`'s `budgetMs` becomes the SDK client's
  per-HTTP-request `timeout`, which only starts once the request itself
  begins — credential resolution (`buildClient` → `resolveAuth`) runs
  synchronously before that, with its own ~10s darwin-keychain worst case,
  so total wall-clock can run to roughly `budgetMs + 10s`. Unlike
  `daemonCall`'s turn, there is no outer deadline wrapping both phases here.
- `listModels`'s `budgetMs` bounds each individual HTTP request in a
  pagination walk, not the total time to drain all pages — a multi-page
  catalog issues one request per page, each independently bounded.
- `listModels`/`retrieveModel` don't expose the Models API's `betas`
  parameter yet — add later as its own deliberate widening if a caller
  needs a beta-gated model list.
- `ApiSession`'s dispatch loop has no yield point between dequeuing a turn
  and marking it sent — `session/cancel` can never preempt a turn already
  in `drain()`'s hands, unlike the CLI-backed daemon this package mirrors,
  whose dynamic `import()` gave cancel a real pre-send window. Under the
  unix-socket transport this was directly demonstrable (two frames written
  in one socket call, decoded and dispatched in one synchronous pass); over
  WebSocket each message is its own event-loop turn, so the same race can no
  longer even be constructed to prove it on the wire — the underlying gap in
  `ApiSession` is unaffected and still real, only the test that could show
  it is gone. Tracked as a design question, not silently patched over.

## License

MIT.
