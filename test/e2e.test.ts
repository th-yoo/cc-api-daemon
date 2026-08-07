// test/e2e.test.ts — client -> unix socket -> spawned daemon -> ApiSession
// -> stub. Zero real API spend; the HTTP leg terminates at the local
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
// Also corrected: the socket-dir env var. acp-paths.ts's socketPath() reads
// `env.KKAMAK_ACP_SOCKET` as a full socket FILE path (not a directory) —
// verified by reading the function, not guessed from the plan's
// `KKAMAK_ACP_SOCKET_DIR` snippet, which doesn't exist in this codebase.
// Each test gets its own short unique path (sock-path.ts's shortSock(),
// same helper acp-client.test.ts/acp-daemon.test.ts already use — darwin
// sun_path caps at 104B) so a spawned daemon can never outlive its test
// into another one's socket.
//
// A THIRD reality-check beyond the plan's own two: ensureDaemon spawns in
// the BACKGROUND unconditionally once it holds the spawn lock and no
// daemon answers the first probe (acp-client.ts's ensureDaemon, step 2-3),
// regardless of waitMs — a waitMs:200 call that returns false has still
// kicked off a real subprocess that goes on to bind moments later. The
// "no daemon listening" test therefore ALSO needs spawn-log tracking and
// afterEach cleanup, not just the round-trip test; skipping that would leak
// a live daemon per run, the exact hazard every sibling test file's own
// header comment warns about ("NO TEST MAY EVER TOUCH
// ~/.config/kkamak/acp-*.sock" — this is how a test would violate it).
import { afterEach, beforeEach, test, expect } from "bun:test"
import fs from "node:fs"
import { ensureDaemon, daemonCall, closeSession } from "../src/index.ts"
import { ISO, stubEnv, respondWith, resetStub } from "./helpers.ts"
import { shortSock } from "./sock-path.ts"

const LIVE: Array<{ sock: string; spawnLog: string }> = []

// Cheap insurance against the shared-stub state a prior test file/test left
// behind (helpers.ts's server is process-wide) — the second test below
// doesn't expect to reach the stub at all (its daemonCall should fail at
// the socket-connect step), but if the background spawn from the first
// test's cleanup race ever DID win, a stale "pong" responder would turn a
// should-be-no-call into a false "ok" instead of a clean failure.
beforeEach(() => {
  resetStub()
})

async function waitForSpawnLog(file: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(file, "utf-8").trim()) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50))
  }
}

function killDaemonByPid(sock: string, spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
  for (const p of [sock, `${sock}.spawn.lock`, `${sock}.bind.lock`, spawnLog]) {
    try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
  }
}

// A daemon that survives the run wedges the next one on a stale socket —
// killed here, never left to the process exiting. Best-effort wait for a
// still-starting background spawn (see the header note above) before the
// kill pass, so a slow-to-bind daemon isn't missed and left orphaned.
afterEach(async () => {
  while (LIVE.length) {
    const e = LIVE.pop()!
    await waitForSpawnLog(e.spawnLog, 3_000)
    killDaemonByPid(e.sock, e.spawnLog)
  }
})

test("a turn round-trips client -> socket -> spawned daemon -> ApiSession -> stub", async () => {
  const sock = shortSock("e2e-ok")
  const spawnLog = `${sock}.spawnlog`
  LIVE.push({ sock, spawnLog })
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
  // dev machine might have set never wins over the fake one — zero real
  // spend stays guaranteed regardless of host environment.
  const env = {
    ...process.env,
    ...stubEnv(),
    KKAMAK_ACP_SOCKET: sock,
    KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
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
  const sock = shortSock("e2e-none")
  const spawnLog = `${sock}.spawnlog`
  // Registered for cleanup even though this test expects `false`: ensureDaemon
  // spawns in the background regardless of waitMs (see header note) — a
  // short waitMs just means the probe gives up before the spawn finishes
  // binding, not that no spawn happened.
  LIVE.push({ sock, spawnLog })
  // process.env spread first, same PATH reasoning as the test above.
  const env = {
    ...process.env,
    ...stubEnv(),
    KKAMAK_ACP_SOCKET: sock,
    KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
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
