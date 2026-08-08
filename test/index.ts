// test/index.ts — the `./testing` subpath's public surface (A6.3).
//
// THE RULE, mirroring src/index.ts: a consumer imports from THIS FILE, via
// `@th-yoo/cc-api-daemon/testing`. No `bun:test` import anywhere in this
// file or anything it re-exports — a file that imports `bun:test` at
// module scope (like this package's own `*.test.ts` files, which call
// `afterEach` at module scope) would drag a test-runner dependency into
// what is otherwise a plain library import (A6.1).
//
// `package.json` has no `files` field — its ABSENCE is what makes `test/`
// reachable at all over a git dependency (the default `npm`/`bun`
// packing behavior only excludes what `.gitignore`/`.npmignore` name, and
// neither excludes `test/`). Adding a `files` field later would silently
// break this subpath for every consumer — don't.
//
// CLEANUP OBLIGATION (A6.2): `tempEnv`/`fakeDaemon`-adjacent spawns
// register themselves on `LIVE_HOMES`/`LIVE_DAEMONS`, but nothing here
// sweeps those registries automatically — there is no `afterEach` in this
// file. A consumer MUST call `cleanupTempHomes()` and `reapDaemons()` from
// its own test-runner teardown, or every throwaway HOME dir this creates
// leaks on disk, and every daemon `fakeDaemon`'s real-daemon counterpart
// spawns stays alive for the full `DEFAULT_IDLE_MS` (900 000 ms) idle
// budget.

/** A scripted ACP daemon over WebSocket — no WarmSession, no CLI, no real
 * model. Mirrors the real daemon's wire shape exactly where it matters for
 * a client under test (fingerprint echo, `_meta.kkamak` namespacing,
 * session/update-then-result ordering). See acp-fake-daemon.ts's own
 * header for the full contract. */
export { fakeDaemon } from "./acp-fake-daemon.ts"
export type {
  FakeAnswer, FakeDaemonOpts, FakePromptParams, FakeSessionNewParams, FakeDaemonHandle,
} from "./acp-fake-daemon.ts"

/** Discovery-file plumbing — a downstream negative test needs
 * `readDiscovery` to assert that *no* discovery file was published. */
export { discoveryPath, readDiscovery, writeDiscovery } from "../src/acp-paths.ts"
export type { DiscoveryInfo } from "../src/acp-paths.ts"

/** Real spawned-daemon reaping: `LIVE_DAEMONS`/`reapDaemons()` (the
 * cleanup contract, A6.2) plus the two leaf helpers. */
export { LIVE_DAEMONS, killDaemonByPid, waitForLines, reapDaemons } from "./daemon-reap.ts"

/** Throwaway-HOME isolation: `LIVE_HOMES`/`cleanupTempHomes()` (the
 * cleanup contract, A6.2) plus the two leaf helpers. */
export { LIVE_HOMES, tempHome, tempEnv, cleanupTempHomes } from "./temp-home.ts"
