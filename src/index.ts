// index.ts — this package's PUBLIC surface.
//
// THE RULE: consumers import from THIS FILE. package.json's exports map
// resolves only ".", so nothing inside src/ is otherwise reachable. Adding
// an export here is a deliberate widening — do it on purpose.
//
// Task 5 of the api-sdk-swap plan: this now points at the REAL ACP daemon
// client (acp-client.ts) instead of the single-process in-process trio that
// used to live here — the package is the daemon it's named for, not a
// library that merely resolves credentials and makes one HTTP call itself.
// serveDaemon is deliberately NOT exported yet: acp-daemon.ts (as ported)
// has no such function, only runSocket/runStdio invoked from
// `if (import.meta.main)`, each calling `process.exit()` internally on
// shutdown — unsafe to call as a library function from a test process.
// Task 6's own e2e test is where that gets built and proven, per that
// task's own Step 3 ("adjust the test to the ported modules' real surface").

/** Client side: ensure a daemon is listening, send it a turn, close a
 * session. Real network I/O now (a unix-socket ACP daemon), not the
 * former in-process credential-resolve-and-call. */
export { ensureDaemon, daemonCall, closeSession, type DaemonOutcome } from "./acp-client.ts"

/** Two default backends, routed by model (api-sdk merge brief HAZARD 3,
 * routeBackend — src/route.ts, not exported: it is dispatch-internal
 * policy, not part of this package's public contract). `ApiSession` is the
 * per-session, never-pooled backend acp-daemon.ts constructs directly for
 * `*haiku*` models (HAZARD 2); `WarmSession` is `SessionPool`'s own default
 * backend (Task 5) for every other model, pooled because of its ~140MB
 * private RSS per child. Both exported so a host can construct one
 * directly, and so `makeSession`/`makeApiSession` injectors (acp-pool.ts /
 * acp-daemon.ts) have something to mirror. */
export { ApiSession } from "./api-session.ts"
export { WarmSession } from "./warm-session.ts"

/** Isolation is a VALUE that crosses the wire on session/new, not an id.
 * This package ships no isolation constant — that is caller-side policy. */
export type { WarmIsolation } from "./acp-wire.ts"

/** Model-identity check over what the wire actually reported. */
export { modelProvenBy } from "./acp-wire.ts"

/** The backend contract, for hosts injecting their own session. */
export type { DispatchableSession, TurnOutcome, CancelResult } from "./session-contract.ts"

/** Needed to type the injectable auth seam. */
export type { AuthDeps } from "./auth.ts"

/** Read-only model metadata (GET, not a billed model turn) — deliberately
 * does NOT reuse daemonCall's no-call/call-consumed spend-boundary
 * vocabulary; see models.ts header. No ACP wire precedent for this: the
 * kkamak ACP surface these functions otherwise mirror has no model-list
 * method at all. Clean-slate addition, orthogonal to the daemon swap —
 * survives Task 5 untouched. */
export { listModels, retrieveModel } from "./models.ts"
export type { ModelListOutcome, ModelRetrieveOutcome, ModelInfo } from "./models.ts"
