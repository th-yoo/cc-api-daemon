// index.ts — this package's PUBLIC surface.
//
// THE RULE: consumers import from THIS FILE, never from a module inside
// src/ directly (package.json's exports map only resolves ".", so nothing
// else is even reachable from outside).
//
// The interface mirrors meta-harness cc-gate-plugin/src/acp/index.ts —
// ensureDaemon, daemonCall, DaemonOutcome, closeSession, WarmIsolation,
// modelProvenBy — with a single-process @anthropic-ai/sdk implementation
// behind it instead of the out-of-process ACP daemon. Adding an export here
// is a deliberate widening of the public surface; do it on purpose, not
// because something happened to need it.

/** The daemon lifecycle: ensure a call could resolve credentials, then send
 * a turn. `closeSession` is a stateless no-op kept for interface parity. */
export { ensureDaemon, daemonCall, closeSession } from "./call.ts"

/** Isolation is a VALUE the caller supplies per call, not an id. */
export type { DaemonOutcome, WarmIsolation } from "./types.ts"

/** Model-identity check over what the API actually reported. */
export { modelProvenBy } from "./types.ts"

/** Must be barrel-exported: package.json's exports map only resolves ".",
 * so external consumers could not otherwise name the type (needed to type
 * the injectable `authDeps` seam). Clean-slate addition — not part of the
 * original acp/index.ts surface. */
export type { AuthDeps } from "./auth.ts"
