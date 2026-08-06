# @th-yoo/cc-api-daemon

Single-process `@anthropic-ai/sdk` twin of the kkamak ACP warm-lane client
surface. Same six exports (`ensureDaemon`, `daemonCall`, `closeSession`,
`DaemonOutcome`, `WarmIsolation`, `modelProvenBy`) and the same outcome
semantics — but each `daemonCall` is exactly one Messages API call. No daemon
process, no socket, no subprocess.

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
  daemonCall,
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

const requested = "claude-haiku-4-5"
const outcome = await daemonCall("Say ok.", requested, process.env, { isolation })

switch (outcome.kind) {
  case "ok":
    if (!modelProvenBy(outcome.model, requested, outcome.canonicalModel)) {
      throw new Error(`served by ${outcome.model}, not ${requested}`)
    }
    console.log(outcome.text)
    break
  case "no-call":
    // Provably nothing was sent — safe to fall back to another lane.
    break
  case "call-consumed":
    // A call may have been spent — do NOT retry elsewhere.
    break
}
```

## Auth

Credential precedence, first hit wins:

1. `env.ANTHROPIC_API_KEY`
2. `env.ANTHROPIC_AUTH_TOKEN`
3. darwin: macOS keychain item `Claude Code-credentials`
4. else: `~/.claude/.credentials.json`

The `env` PARAM you pass to `daemonCall`/`ensureDaemon` is the authority —
not the real `process.env` (see Known limitations for the SDK-side
exceptions). The OAuth lane sends `anthropic-beta: oauth-2025-04-20` with
`apiKey` explicitly suppressed; the apiKey lane suppresses `authToken`.

## Outcome law

- `no-call` — provably nothing went toward the model: thinking-enabled
  refusal, no resolvable auth, a throw before the request is entered. Safe to
  fall back elsewhere.
- `call-consumed` — any ambiguity at or after `messages.create`: HTTP error,
  timeout, empty content. A call may have been spent; the caller must NOT
  double-spend.
- `maxRetries: 0` — exactly one HTTP call ever per `daemonCall`.

## Known limitations

- `ensureDaemon`'s `waitMs` is accepted-and-ignored — there is nothing to
  wait for in a single process. This is a semantic drift from the original
  surface that a knowing caller would trip on.
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
- `budgetMs` bounds the HTTP phase only; keychain/file auth resolution runs
  before it with its own ~10s worst-case, so worst-case wall-clock is
  roughly `budgetMs + 10s`.

## License

MIT.
