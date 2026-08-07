# @th-yoo/cc-api-daemon

An ACP (Agent Client Protocol) daemon — unix socket, newline-delimited
JSON-RPC, a session pool — with `@anthropic-ai/sdk`'s `messages.create` as
the backend instead of a spawned Claude Code CLI subprocess. Same wire
protocol, socket, pool, and outcome semantics as meta-harness's
`cc-gate-plugin/src/acp`; every turn is exactly one `messages.create` call.

`ensureDaemon`/`daemonCall`/`closeSession` are the client trio: connect to a
running daemon, or spawn one, over a real unix socket. `ApiSession` is the
injectable backend the daemon runs by default (see "Swapping the backend"
below). `listModels`/`retrieveModel` wrap the Anthropic Models API — a
capability the ACP wire itself has no method for; see "Model metadata"
below.

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

// Connect to a daemon already listening on this env's socket, or spawn one
// and wait up to waitMs for it to bind. waitMs defaults to 0 (kick a
// background spawn, return immediately) — pass a real budget when the
// caller needs the daemon up before proceeding, e.g. a cold-start script.
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
`socketPath(env)` resolves to. Call `ensureDaemon` first (as above) unless
something else in the process already has.

### Running the daemon directly

`ensureDaemon`'s connect-or-spawn is the only path exercised in this
package's own tests and is the intended way to bring a daemon up. A host
that wants to pre-launch one explicitly (rather than let the first
`ensureDaemon` call spawn it) can still run the entry point directly:

```sh
bun src/acp-daemon.ts          # unix socket transport (default)
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
`envFingerprint` and binds a different socket path, so a client with a
mismatched env simply never reaches it (`no-call`) rather than reaching it
under the wrong credentials.

The OAuth lane sends `anthropic-beta: oauth-2025-04-20` with `apiKey`
explicitly suppressed; the apiKey lane suppresses `authToken`.

## Swapping the backend

`ApiSession` is the default session the daemon's pool constructs, but it is
injectable — `acp-daemon.ts`'s `runSocket`/`runStdio` (and the lower-level
`createDaemonState`) both accept a `makeSession` option shaped
`(env, warmOpts) => DispatchableSession`. A host embedding this daemon can
supply its own backend (a different model provider, a scripted fake for
tests) without touching the wire layer; `session-contract.ts`'s
`DispatchableSession` is the contract both implementations are checked
against.

## Outcome law

- `no-call` — provably nothing went toward the model: no socket reachable,
  connect refused, `initialize`/`session/new` failure, envFingerprint
  mismatch, a write error, or (daemon-side) a thinking-enabled refusal / no
  resolvable auth / a throw before `messages.create` is entered. Safe to
  fall back elsewhere.
- `call-consumed` — any ambiguity at or after the `session/prompt` frame's
  write callback reports success: HTTP error (including 401), timeout,
  socket close/error, budget expiry with no response, empty content. A call
  may have been spent; the caller must NOT double-spend.
- `maxRetries: 0` on the daemon's own SDK client — exactly one HTTP call
  ever per turn.

This vocabulary is specific to `daemonCall`'s billed `messages.create` send —
see "Model metadata" below for the separate, unbilled-GET outcome vocabulary
used by `listModels`/`retrieveModel`.

## Model metadata

`listModels`/`retrieveModel` wrap the Anthropic Models API
(`GET /v1/models`, `GET /v1/models/{id}`) — read-only, idempotent GETs, not
billed model turns, and not routed through the daemon/socket at all (they
call the Anthropic API directly from whichever process calls them). Unlike
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
- `budgetMs` on `daemonCall`/`closeSession` bounds the client-side socket
  phase only; daemon-side turn budgeting (queue wait, generation, auth
  resolution) is `ACP_BUDGET`'s own set of legs, not this parameter.
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
- A cancel (`session/cancel`) written in the same socket write as its target
  `session/prompt` cannot preempt that prompt's send on this backend:
  `ApiSession`'s dispatch loop has no yield point between dequeuing a turn
  and marking it sent, unlike the CLI-backed daemon this package mirrors,
  whose dynamic `import()` gave cancel a real pre-send window. Tracked as a
  design question, not silently patched over — see `test/acp-daemon.test.ts`'s
  two `test.todo` cases for the full trace.

## License

MIT.
