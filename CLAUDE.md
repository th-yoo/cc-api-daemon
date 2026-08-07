# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@th-yoo/cc-api-daemon` — a single-process `@anthropic-ai/sdk` twin of the kkamak
ACP warm-lane client surface (`ensureDaemon`, `daemonCall`, `closeSession`,
`DaemonOutcome`, `WarmIsolation`, `modelProvenBy`). Same six exports and
outcome semantics as the original out-of-process ACP daemon, but each
`daemonCall` is exactly one Messages API call — no daemon process, no socket,
no subprocess. Two more exports, `listModels`/`retrieveModel`, wrap the
Anthropic Models API — a capability the original ACP surface never had (its
wire protocol has no model-list method at all; see "Model metadata" below) —
with a deliberately *different* outcome vocabulary, since it's an unbilled
GET rather than a billed send. Bun-only; raw `.ts` sources are what the
package exports (`package.json` `exports["."]` → `src/index.ts`).

## Commands

- `bun install --frozen-lockfile` — install deps
- `bun test` — run all tests
- `bun test test/call.test.ts` — run a single test file
- `bun test -t "<name>"` — filter by test name
- `bun run typecheck` (or `bunx tsc --noEmit`) — typecheck, no emit
- `bun scripts/smoke.ts` — live smoke test, **real API spend (one haiku call)**; run deliberately, never in CI

CI (`.github/workflows/ci.yml`) runs `bun test` then `bunx tsc --noEmit` on push/PR to `main`.

## Architecture

Six files in `src/`, layered strictly bottom-up:

- **`types.ts`** — wire-independent core types (`WarmIsolation`, `DaemonOutcome`, `modelProvenBy`). Zero imports, pure module.
- **`auth.ts`** — credential resolution (`resolveAuth`), ported from meta-harness `cc-gate-plugin/src/gauge/transport.ts`. Depends only on `types.ts`-free node builtins.
- **`client.ts`** — shared Anthropic SDK client construction (`buildClient`), including the ambient-env-leak guards below. Used by `call.ts` and `models.ts` — the one place that invariant is implemented.
- **`call.ts`** — the daemon logic (`daemonCall`, `ensureDaemon`, `closeSession`), the single-process replacement for the ACP client's `transport.ts`.
- **`models.ts`** — read-only model metadata (`listModels`, `retrieveModel`) over the Anthropic Models API. No ACP wire precedent — a clean-slate addition with its own, non-spend outcome vocabulary (`ok`/`no-auth`/`error`/`not-found`); see "Model metadata" below.
- **`index.ts`** — the ONLY public surface. `package.json`'s `exports` map resolves only `"."`, so nothing inside `src/` is reachable except what `index.ts` re-exports. Adding an export there is a deliberate widening of the public API, not incidental.

### The outcome law (§6e, load-bearing across the whole package)

Every `daemonCall` returns a `DaemonOutcome` and **never throws**. Three arms:

- `no-call` — provably nothing went toward the model (thinking-enabled refusal, no resolvable auth, a throw before `messages.create` is entered). Safe for the caller to fall back elsewhere.
- `call-consumed` — any ambiguity at or after `messages.create` (HTTP error incl. 401, timeout, empty content). A call may have been spent; caller must NOT retry/double-spend.
- `ok` — success, with `text`, `model`, `canonicalModel`.

`sessionId` is minted before any check runs and carried on every arm (a deliberate departure from the original ACP client, which only set it on `ok`). `maxRetries: 0` always — exactly one HTTP call ever per `daemonCall`.

### Auth precedence (`auth.ts`)

1. `env.ANTHROPIC_API_KEY` (non-empty)
2. `env.ANTHROPIC_AUTH_TOKEN` (non-empty) — also the test/keychain-less-host seam
3. darwin: macOS keychain item `Claude Code-credentials` via `security` (10s exec timeout; a darwin failure does NOT fall through to the credentials file)
4. else: `~/.claude/.credentials.json`

Resolution never throws — undefined on any failure. The `env` param passed to `daemonCall`/`ensureDaemon` is the sole authority for these values, not the real `process.env` — see "ambient-env leak guards" below.

### Ambient-env leak guards (`client.ts`)

The `@anthropic-ai/sdk` client defaults any *omitted* (`undefined`) `apiKey`/`authToken`/`baseURL` constructor option from the real `process.env`, and composes both auth headers with no precedence if both are present — a host carrying the other credential ambiently would silently send both `X-Api-Key` and `Authorization`. So in both auth lanes the not-chosen field is always explicit `null`, and `baseURL` is always `env.ANTHROPIC_BASE_URL ?? null` (never omitted). This is why `buildClient` constructs two full, separately-shaped `new Anthropic(...)` calls rather than building one options object conditionally — don't collapse them. `call.ts` and `models.ts` both call `buildClient` rather than reimplementing this — the invariant lives in exactly one place.

The OAuth (authToken) lane sends `anthropic-beta: oauth-2025-04-20`; the apiKey lane does not.

### Model metadata (`models.ts`)

`listModels`/`retrieveModel` wrap `GET /v1/models` and `GET /v1/models/{id}` — read-only, idempotent GETs, not billed model turns. They deliberately do **not** reuse `DaemonOutcome`'s `no-call`/`call-consumed` vocabulary: that vocabulary exists specifically to encode billed-call spend-risk, which doesn't apply to an unbilled GET. Instead: `ok` / `no-auth` / `error` (+ `not-found` for `retrieveModel`, since a 404 there carries real information a caller can act on — unlike `daemonCall`'s uniform post-send classification, which exists only to preserve the spend-boundary law).

No ACP wire precedent exists for this: the actual kkamak ACP surface (`meta-harness/cc-gate-plugin/src/acp/acp-wire.ts`) has no model-list or config-option method at all — it's a narrow private instrument profile, not a general-purpose ACP agent. (Public ACP does have a model-listing convention — a `session/set_config_option` mechanism with a shallow `{value, name, description}` model category — but nothing in kkamak's wire subset implements it.) So `ModelInfo` is re-exported verbatim from the SDK rather than reshaped to either precedent.

`listModels` auto-drains every page into one flat array (`PagePromise` is an `AsyncIterable`); a failure partway through a multi-page walk discards the partial list rather than returning it — binary all-or-`error`, no partial-success arm.

### Known, intentional limitations (see README "Known limitations" for full detail)

- `ensureDaemon`'s `waitMs` is accepted-and-ignored (interface parity only; nothing to wait for in-process).
- `canonicalModel === model` always — the raw API exposes one identity field, so `modelProvenBy`'s `canonicalModel` branch is dead code here, kept for interface parity.
- HTTP 401 classifies as `call-consumed` (uniform post-`messages.create` classification is a conscious non-goal to refine).
- `budgetMs` bounds only the HTTP phase; keychain/file auth resolution runs before it (~10s worst case), so worst-case wall-clock ≈ `budgetMs + 10s`.
- `listModels`'s `budgetMs` bounds each individual HTTP request in a pagination walk, not the total time to drain all pages.
- The SDK reads `ANTHROPIC_CUSTOM_HEADERS`/`ANTHROPIC_LOG`/`ANTHROPIC_WEBHOOK_SIGNING_KEY` unconditionally from the real `process.env` with no way to suppress — documented as unclosable, not a bug to fix.

## Provenance / porting notes

Several files carry deliberate ports from a sibling project, meta-harness's `cc-gate-plugin` (`src/acp/*`, `src/gauge/transport.ts`, `minimal/providers/anthropic-api.ts`). Where a file's header cites line numbers or a specific origin function, treat that as the design rationale — changes that diverge from the cited behavior should be intentional and worth a comment, not accidental drift.
