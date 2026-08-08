// index.ts — this package's PUBLIC surface.
//
// THE RULE: consumers import from THIS FILE. package.json's exports map
// resolves "." to this file and "./testing" to test/index.ts (A6.3, test-only
// machinery — fakeDaemon, discovery helpers, temp-HOME/daemon-reap
// utilities). Nothing else inside src/ or test/ is reachable. Adding an
// export here (or to test/index.ts) is a deliberate widening — do it on
// purpose.
//
// This package now has a real pinned consumer (meta-harness, both
// cc-gate-plugin and opencode-plugin) — nothing already exported may change
// shape.
//
// serveDaemon is deliberately NOT exported: acp-daemon.ts has no such
// function, only runServer/runStdio invoked from `if (import.meta.main)`,
// each calling `process.exit()` internally on shutdown — unsafe to call as
// a library function from a test process. `ensureDaemon` (below) is the
// supported way to get a daemon running from library code.

/** Client side: ensure a daemon is listening, send it a turn, close a
 * session. Real network I/O now (a localhost WebSocket ACP daemon), not the
 * former in-process credential-resolve-and-call. */
export { ensureDaemon, daemonCall, closeSession, type DaemonOutcome } from "./acp-client.ts"

/** Two default backends, routed by model (api-sdk merge brief HAZARD 3).
 * `ApiSession` is the per-session, never-pooled backend acp-daemon.ts
 * constructs directly for `*haiku*` models (HAZARD 2); `WarmSession` is
 * `SessionPool`'s own default backend for every other model, pooled
 * because of its ~140MB private RSS per child. Both exported so a host can
 * construct one directly, and so `makeSession`/`makeApiSession` injectors
 * (acp-pool.ts / acp-daemon.ts) have something to mirror. */
export { ApiSession } from "./api-session.ts"
export { WarmSession } from "./warm-session.ts"

/** `routeBackend` is THE dispatch rule above — exported (A6.4) so a
 * consumer can assert against the real function rather than a hand-copied
 * `model.includes("haiku")` that silently drifts from this package's own.
 * See route.ts's own header for why the default lane is "agent", not "api":
 * measured, not a preference. */
export { routeBackend } from "./route.ts"

/** The daemon's own timing budget (turn timeout, queue wait, CLI-spawn
 * floor, etc.) — exported (A6.4) so a consumer can pin its own
 * worst-case-timing assertions (e.g. a refusal boundary at
 * `daemonWorstCaseMs >= budgetMs`) against the real constant instead of a
 * hardcoded guess that can drift out of sync. */
export { ACP_BUDGET } from "./acp-wire.ts"

/** Isolation is a VALUE that crosses the wire on session/new, not an id.
 * `DEFAULT_ISOLATION` is the neutral profile `WarmSession` falls back to
 * when a caller omits `isolation` entirely — exported so a consumer can
 * name what it's getting instead of inheriting an unnameable default. */
export type { WarmIsolation } from "./acp-wire.ts"
export { DEFAULT_ISOLATION } from "./acp-wire.ts"

/** Model-identity check over what the wire actually reported. */
export { modelProvenBy } from "./acp-wire.ts"

/** The backend contract, for hosts injecting their own session. */
export type { DispatchableSession, TurnOutcome, CancelResult } from "./session-contract.ts"

/** Needed to type the injectable auth seam. */
export type { AuthDeps } from "./auth.ts"

/** The §6e instrument fingerprint — exported (A6.4) so a consumer can
 * compute the SAME fingerprint the daemon/client compute, e.g. to seed a
 * stale-discovery-file test fixture at the right fingerprint-derived path,
 * or to assert its own env-var aliasing (`./testing`'s `fakeDaemon` takes
 * a `fingerprint` string precisely so a caller can pass this). */
export { envFingerprint } from "./acp-paths.ts"

/** Read-only model metadata (GET, not a billed model turn) — deliberately
 * does NOT reuse daemonCall's no-call/call-consumed spend-boundary
 * vocabulary; see models.ts header. No ACP wire precedent for this: the
 * kkamak ACP surface these functions otherwise mirror has no model-list
 * method at all. Clean-slate addition, orthogonal to the daemon swap —
 * survives Task 5 untouched. */
export { listModels, retrieveModel } from "./models.ts"
export type { ModelListOutcome, ModelRetrieveOutcome, ModelInfo } from "./models.ts"
