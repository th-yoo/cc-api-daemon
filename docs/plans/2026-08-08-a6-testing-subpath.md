# A6 — publish the test machinery, and the exports downstream needs

Handoff spec, authored by the meta-harness side (now a real consumer: it pins this
package at `469456b` in both `cc-gate-plugin` and `opencode-plugin`).

Phase A is done and pushed as v0.2.0. This is the follow-on that unblocks three
downstream tasks. Same discipline as before: the items marked **CRITICAL** come from
review rounds that found the *previous* round's fix to be wrong. Do not simplify them.

## Why

Downstream needs three things this package does not currently expose:

1. **A WebSocket fake daemon.** meta-harness has to port two test files off a
   unix-socket fake that cannot talk to this package's client. It should not
   re-implement yours — that is how the two drift.
2. **`envFingerprint`, `routeBackend`, `ACP_BUDGET` on the main entry.** Downstream
   must assert the routing rule against the *real* `routeBackend`, not a hand-copied
   `model.includes("haiku")` that silently drifts from yours; and must pin the
   `daemonWorstCaseMs >= budgetMs` refusal boundary against the real `ACP_BUDGET`
   rather than a hardcoded `32_000`.
3. **The temp-`HOME` and daemon-reaping helpers.** See CRITICAL 2.

## Global constraints

- Back-compat: this package now has a real pinned consumer. Nothing already exported
  may change shape.
- Every change lands with its own test; the suite stays green at each commit.
- Three verifications before push, run CONCURRENTLY (they are independent processes):
  `bunx tsc --noEmit`, `bun test`, and
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test`.
- Baseline is `469456b` (v0.2.0, 255 pass / 0 fail). Report the final SHA and all three results.

## A6.1 — CRITICAL: extract before you export

`killDaemonByPid`, `waitForLines`, `tempHome` and `tempEnv` are module-local closures
inside `test/acp-client.test.ts` — a file that calls `afterEach` at module scope
(`:56-68`, `:78-101`, `:87-91`). Re-exporting from that file would drag `bun:test`
into the published surface, which would break any consumer importing it outside a
test runner.

- [ ] Extract them into plain, non-test modules first (e.g. `test/temp-home.ts` and
      `test/daemon-reap.ts`). No `bun:test` import in either.
- [ ] `test/acp-client.test.ts` then imports them, keeping its own `afterEach`.
      Its behavior must not change — the suite is the proof.

## A6.2 — CRITICAL: export the cleanup contract, not just the helpers

`tempEnv` closes over a module-level `LIVE_HOMES` registry whose only sweep is that
same module-scope `afterEach`, which also drives `LIVE_FAKES.stop()` and
`killDaemonByPid(LIVE_DAEMONS)`. A non-test module cannot register `afterEach`. If you
export the helpers without their cleanup, every consumer suite leaks temp HOME dirs and
leaves spawned daemons alive for `DEFAULT_IDLE_MS` (900 000 ms) each.

- [ ] Expose the registries plus explicit `cleanupTempHomes()` and `reapDaemons()`
      (names your call) so a consumer can call them from its own `afterEach`.
- [ ] Document that obligation in the README section for `./testing` — a consumer that
      forgets it will not fail loudly, it will just leak.

## A6.3 — the `./testing` subpath export

- [ ] Add `"./testing"` to `package.json`'s `exports`, re-exporting: the WebSocket
      `fakeDaemon`, `discoveryPath`, `readDiscovery`, `writeDiscovery`, `waitForLines`,
      the reaper helpers, and the temp-`HOME` helpers + cleanup from A6.2.
      (`readDiscovery` matters: a downstream negative test needs to assert that *no*
      discovery file was published.)
- [ ] **Do NOT add a `files` field to `package.json`.** Its absence is what makes
      `test/` reachable over a git dependency. Adding one later silently breaks
      `./testing` for every consumer.
- [ ] Move `@types/ws` from `devDependencies` to `dependencies`. A git dependency never
      installs devDependencies, and consumers typecheck this package's raw `.ts` — so
      without it, `test/acp-fake-daemon.ts`'s `import { WebSocketServer, type WebSocket }
      from "ws"` fails to typecheck downstream.

## A6.4 — main-entry exports

- [ ] Add `envFingerprint`, `routeBackend` and `ACP_BUDGET` to `src/index.ts`.
- [ ] **Rewrite `src/index.ts`'s header in the same commit — it currently forbids
      exactly this.** `:24-25` says `routeBackend` is "not exported: it is
      dispatch-internal policy, not part of this package's public contract", and `:3-5`
      says "package.json's exports map resolves only `.`, so nothing inside src/ is
      otherwise reachable". Both become false the moment this lands. Shipping comments
      that contradict the code is the exact defect class A5 just cleaned up.

## A6.5 — verify the downstream typecheck, which is the whole point

P0 (the consumer-side typecheck probe) passed against v0.2.0, but it was structurally
blind to this work: `exports` mapped only `"."`, and `ws` types enter solely through
`test/acp-fake-daemon.ts`. `./testing` re-opens the question that probe could not answer.

- [ ] Prove it: in a scratch dir, install this package at your new SHA under
      **`cc-gate-plugin`'s exact tsconfig** — it extends `@tsconfig/node22` with **no
      `types` field**, so every `@types` package is global, and it has BOTH `@types/bun`
      and `@types/node` installed. Import from `@th-yoo/cc-api-daemon/testing` and run
      `bunx tsc --noEmit`.
- [ ] The specific risk is `test/acp-fake-daemon.ts`'s `(ev: MessageEvent)` / `WebSocket`
      usage against globals that **both** `@types/node` (undici) and `@types/bun`
      declare. If that collides, fix it HERE — a downstream workaround is not
      acceptable, because the consumer cannot edit this package.
- [ ] Report the probe result explicitly. A green package suite does NOT prove this;
      your own tsconfig narrows to `"types": ["bun"]` and will not reproduce it.

## A6.6 — land it

- [ ] Minor version bump (0.3.0).
- [ ] README: document `./testing` — what it exports, that it is test-only, and the
      A6.2 cleanup obligation.
- [ ] Three verifications concurrently, push, report the SHA and all three results
      plus the A6.5 probe outcome.
