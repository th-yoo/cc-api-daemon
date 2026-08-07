// test/e2e.test.ts — client -> WebSocket -> spawned daemon -> ApiSession ->
// stub. Zero real API spend; the HTTP leg terminates at the local
// Bun.serve stub (helpers.ts).
//
// CORRECTION on the plan's own Step 1 template (meta-harness commit
// 26b9b44): `serveDaemon` does not exist — acp-daemon.ts exports only
// DaemonState/createDaemonState/createDispatcher, and every runtime side
// effect is behind `if (import.meta.main)`, making the daemon a script, not
// a callable. Uses the real path instead: `ensureDaemon(env, {waitMs})`
// connect-or-spawns via acp-client.ts's own `DAEMON_ENTRY =
// path.join(import.meta.dir, "acp-daemon.ts")` sibling resolution — this
// exercises the actual production launch path, not a test-only entry point.
//
// websocket-transport swap (Task 5): each test now gets its own throwaway
// HOME dir, not a unique unix socket path — discoveryPath (acp-paths.ts)
// consults env.HOME explicitly, so a fresh mkdtemp'd HOME per test is what
// isolates one test's daemon/discovery entry from another's, same mechanism
// test/acp-daemon.test.ts and test/acp-client.test.ts already use. A
// survivor daemon now holds a PORT, not a socket file, and a stale
// discovery entry pointing at a dead port is the wedge shape afterEach
// below has to avoid — same reasoning as the sibling files' own headers.
import { afterEach, beforeEach, test, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { ensureDaemon, daemonCall, closeSession } from "../src/index.ts"
import { ISO, stubEnv, respondWith, resetStub } from "./helpers.ts"

const LIVE: Array<{ home: string; spawnLog: string }> = []

// Cheap insurance against the shared-stub state a prior test file/test left
// behind (helpers.ts's server is process-wide) — the second test below
// doesn't expect to reach the stub at all (its daemonCall should fail at
// the connect step), but if the background spawn from the first test's
// cleanup race ever DID win, a stale "pong" responder would turn a
// should-be-no-call into a false "ok" instead of a clean failure.
beforeEach(() => {
  resetStub()
})

function tempEndpoint(tag: string) {
  const home = fs.mkdtempSync(path.join(tmpdir(), `e2e-${tag}-`))
  return { home, spawnLog: path.join(home, "spawnlog") }
}

async function waitForSpawnLog(file: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(file, "utf-8").trim()) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
}

function killDaemonByPid(home: string, spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}

// A daemon that survives the run wedges the next one on a stale discovery
// entry — killed here, never left to the process exiting. Best-effort wait
// for a still-starting background spawn (see the header note above) before
// the kill pass, so a slow-to-bind daemon isn't missed and left orphaned.
afterEach(async () => {
  while (LIVE.length) {
    const e = LIVE.pop()!
    await waitForSpawnLog(e.spawnLog, 3_000)
    killDaemonByPid(e.home, e.spawnLog)
  }
})

test("a turn round-trips client -> WebSocket -> spawned daemon -> ApiSession -> stub", async () => {
  const e = tempEndpoint("ok")
  LIVE.push(e)
  // `Bun.spawn`'s `env` option REPLACES the child's environment entirely
  // (it does not merge with the current process's) — spawnDaemonProcess
  // (acp-client.ts) forwards exactly this object to the daemon subprocess.
  // `stubEnv()` alone is only {ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL}: a
  // spawned `bash -c "nohup bun ..."` with THAT as its whole environment
  // has no PATH, so it silently fails to resolve `bun` (stdout/stderr are
  // "ignore"d in production, so this fails invisibly — found by tracing the
  // ported daemon directly, since it binds fine standalone but never did
  // under this test until this fix). Spread real process.env FIRST for
  // PATH/HOME/etc., then stubEnv() OVER it so a real ANTHROPIC_API_KEY this
  // dev machine might have set never wins over the fake one, and HOME LAST
  // so this test's own throwaway dir always wins over whatever stubEnv()
  // or process.env carry — zero real spend AND full discovery isolation
  // stay guaranteed regardless of host environment.
  const env = {
    ...process.env,
    ...stubEnv(),
    HOME: e.home,
    KKAMAK_ACP_TEST_SPAWN_LOG: e.spawnLog,
    KKAMAK_ACP_IDLE_MS: "8000",
  }

  // connect-or-spawn: this is what actually starts the daemon in production
  expect(await ensureDaemon(env, { waitMs: 10_000 })).toBe(true)

  respondWith({ content: [{ type: "text", text: "pong" }], model: "claude-haiku-4-5-20251001" })
  const out = await daemonCall("ping", "claude-haiku-4-5", env, { isolation: ISO })

  expect(out.kind).toBe("ok")
  if (out.kind !== "ok") throw new Error("unreachable")
  expect(out.text).toBe("pong")
  expect(out.sessionId).toBeTruthy()
  expect(await closeSession(out.sessionId!, env)).toMatchObject({ closed: true })
}, 30_000)

test("no daemon listening -> ensureDaemon false, daemonCall no-call", async () => {
  const e = tempEndpoint("none")
  // Registered for cleanup even though this test expects `false`: ensureDaemon
  // spawns in the background regardless of waitMs (see header note) — a
  // short waitMs just means the probe gives up before the spawn finishes
  // binding, not that no spawn happened.
  LIVE.push(e)
  // process.env spread first, HOME last — same reasoning as the test above.
  const env = {
    ...process.env,
    ...stubEnv(),
    HOME: e.home,
    KKAMAK_ACP_TEST_SPAWN_LOG: e.spawnLog,
    KKAMAK_ACP_IDLE_MS: "8000",
  }
  // waitMs: 0, not the plan's 200 — verified empirically: with the PATH fix
  // above, real spawn+bind on this host lands well under 200ms, so a
  // waitMs:200 poll observes `true` almost as often as `false` (flaky, not
  // deterministic). waitMs: 0 takes ensureDaemon's own documented
  // zero-poll path (still kicks the spawn, returns false immediately
  // without checking again) — the same shape acp-client.test.ts's own
  // "ensureDaemon() defaults to waitMs 0" test already relies on.
  expect(await ensureDaemon(env, { waitMs: 0 })).toBe(false)
  expect((await daemonCall("x", "claude-haiku-4-5", env, { isolation: ISO })).kind).toBe("no-call")
})
