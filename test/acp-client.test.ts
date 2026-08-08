// test/acp-client.test.ts — N3b: acp-client.ts's `daemonCall` and
// `ensureDaemon` over SCRIPTED FAKE daemons (no WarmSession, no CLI, no
// credentials, no model) plus one real-daemon e2e smoke test.
//
// Delta-memo governs over task-6-brief.md prose where they conflict:
//  · `_meta` is namespaced under `kkamak` (T2n) — acp-fake-daemon.ts already
//    produces that shape; nothing here constructs a bare `_meta.model`.
//  · the observed modelUsage key on the REAL driving path is UNDATED —
//    the e2e test uses HAIKU_OBSERVED_KEY, never a fabricated dated
//    literal. The FAKE daemon's own default (dated) is a DIFFERENT,
//    deliberately-scripted fixture per task-6-brief.md, not a claim about
//    the real API.
//  · `daemonCall`'s public signature has no session-bearing surface —
//    sessions are internal (user ruling, send-prompt-interface.md §4).
//
// websocket-transport swap: every test's isolation lever changes from a
// per-test unix socket path (`KKAMAK_ACP_SOCKET` override, bypassing
// fingerprint-derived addressing entirely) to a per-test throwaway HOME
// dir (`tempEnv` below) — discovery files are fingerprint-derived under
// `env.HOME`, same mechanism test/acp-daemon.test.ts already uses. This
// also RETIRES the old `~/.config/kkamak` hygiene assertion
// (`newAcpSocks`/`acpDir`/`PRE_EXISTING`): with every test's daemon living
// under its own throwaway HOME, none of them ever reach the real host
// directory at all, so there is nothing there left to diff.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { daemonCall, ensureDaemon, closeSession } from "../src/acp-client.ts"
import { ACP_BUDGET, modelProvenBy, type WarmIsolation } from "../src/acp-wire.ts"
import { envFingerprint, spawnLockPath, tryCreateLock, readDiscovery } from "../src/acp-paths.ts"
import { fakeDaemon } from "./acp-fake-daemon.ts"
import { stubServer, okResponse } from "./sdk-stub.ts"
import { LIVE_HOMES, tempHome, tempEnv, cleanupTempHomes } from "./temp-home.ts"
import { LIVE_DAEMONS, killDaemonByPid, waitForLines, reapDaemons } from "./daemon-reap.ts"

const HAIKU = "claude-haiku-4-5"
// Replaces the gauge's own GAUGE_ISOLATION, which was caller-side and this
// general ACP package no longer ships (Task 1 Step 2). N3c-iii: daemonCall's
// opts.isolation is REQUIRED, never defaulted. Every existing test in this
// file only cares that SOME isolation was sent, not which one, so they all
// share this constant; test 7 below uses its OWN distinct isolation to
// prove deep-equality end to end.
const TEST_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "acp-client-test",
  thinking: { type: "disabled" },
}
const ISO = { isolation: TEST_ISOLATION }

// tempHome/tempEnv/LIVE_HOMES/cleanupTempHomes and killDaemonByPid/
// waitForLines/LIVE_DAEMONS/reapDaemons live in temp-home.ts/daemon-reap.ts
// (A6.1) — extracted so they're importable outside a test runner (this
// file itself keeps its own `afterEach`, unchanged below).
const LIVE_FAKES: Array<{ stop: () => void }> = []

afterEach(() => {
  while (LIVE_FAKES.length) { const f = LIVE_FAKES.pop()!; try { f.stop() } catch { /* ignore */ } }
  reapDaemons()
  cleanupTempHomes()
})

describe("acp-client (fake daemons only — no CLI, no model)", () => {
  test("law L1: no daemon at all -> no-call, fast", async () => {
    const t0 = Date.now()
    // No fake ever registered for this HOME -- readDiscovery(env) finds
    // nothing, daemonCall's own fast-path resolves no-call without ever
    // attempting a connection.
    const r = await daemonCall("x", "claude-haiku-4-5", tempEnv("nodaemon"), ISO)
    expect(r.kind).toBe("no-call")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test("round-trips against a scripted fake daemon -> ok, text, DATED model evidence", async () => {
    const env = tempEnv("ok")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("hello", HAIKU, env, ISO)
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") throw new Error("unreachable")
    expect(r.text).toBe("ANSWER")
    expect(r.model).toBe("claude-haiku-4-5-20251001")
    expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    // Task 3: the `ok` outcome carries the sessionId the fake daemon issued
    // on session/new — the same id the fake recorded off the session/prompt
    // frame, proving daemonCall threads the SAME id it sent, not a fresh one.
    expect(r.sessionId).toBeTruthy()
    expect(r.sessionId).toBe(fake.promptParams()?.sessionId)
  })

  test("law L3(i): ACP_ERR_CALL_CONSUMED maps to call-consumed, NOT no-call", async () => {
    const env = tempEnv("consumed")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "call-consumed" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")
  })

  test("law L3(i): ACP_ERR_NO_CALL maps to no-call", async () => {
    const env = tempEnv("nocall")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "no-call" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("no-call")
  })

  test("law L3(i): data.callConsumed OVERRIDES a mismatched code", async () => {
    const env = tempEnv("mismatched")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "mismatched-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")   // the data field is authoritative
  })

  test("law L3(ii): a RECOGNIZED code with `data` ABSENT is HONOURED, both ways", async () => {
    const envA = tempEnv("codenodata-nocall")
    const fakeA = await fakeDaemon(envA, { fingerprint: envFingerprint(envA), answer: "no-call-code-no-data" })
    LIVE_FAKES.push(fakeA)
    expect((await daemonCall("x", HAIKU, envA, ISO)).kind).toBe("no-call")

    const envB = tempEnv("codenodata-consumed")
    const fakeB = await fakeDaemon(envB, { fingerprint: envFingerprint(envB), answer: "consumed-code-no-data" })
    LIVE_FAKES.push(fakeB)
    expect((await daemonCall("x", HAIKU, envB, ISO)).kind).toBe("call-consumed")
  })

  test("law L2: a NON-BOOLEAN data.callConsumed is an ambiguity, not a value", async () => {
    const env = tempEnv("nonboolean")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "nonboolean-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")
  })

  test("law L3(iii)/final-review Important 2: a NON-OBJECT `data` (data: \"false\") with ACP_ERR_NO_CALL does NOT launder into no-call", async () => {
    const env = tempEnv("nonobjectdata")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "nonobject-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    // `data` is present (a string, not an object) -- present-but-malformed
    // must fall to L2's default (call-consumed), never skip past step (iii)
    // into the recognized-code (ACP_ERR_NO_CALL) branch. Before the fix
    // this returned {kind:"no-call"} -- the double-spend direction.
    expect(r.kind).toBe("call-consumed")
  })

  test("law L2: an UNRECOGNIZED error code after the prompt was sent is call-consumed", async () => {
    const env = tempEnv("unknowncode")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "unknown-code" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")   // never no-call — that would double-spend
  })

  test("law L2: budget expiry after the prompt was sent is call-consumed", async () => {
    const env = tempEnv("hang")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "hang" })
    LIVE_FAKES.push(fake)
    const t0 = Date.now()
    const r = await daemonCall("x", HAIKU, env, { ...ISO, budgetMs: 500 })
    expect(r.kind).toBe("call-consumed")
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(fake.sawPrompt()).toBe(true)   // it really did cross the boundary
  })

  test("law L1: a daemon that dies before session/prompt is written is no-call", async () => {
    const env = tempEnv("die")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "die-before-prompt" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("law L1: a fingerprint mismatch refuses BEFORE sending anything", async () => {
    const env = tempEnv("fpmismatch")
    // The fake WRITES its discovery entry under `env` (findable), but
    // ANNOUNCES a fingerprint computed from a DIFFERENT env in its
    // initialize reply — the client finds it fine and refuses on the
    // handshake mismatch, not on failing to find it at all.
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint({ ...env, ANTHROPIC_BASE_URL: "http://other" }), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("Task 8: a daemon whose worst case exceeds the client budget is refused pre-send", async () => {
    const env = tempEnv("worstcase-refuse")
    // budgetMs (500) < daemonWorstCaseMs (999_000): the client must refuse
    // before session/prompt is ever written, same as the fingerprint-
    // mismatch case above — law L1, no-call.
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), daemonWorstCaseMs: 999_000, answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, { ...ISO, budgetMs: 500 })
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("Task 8: a daemon that omits daemonWorstCaseMs is accepted — older daemons stay compatible", async () => {
    const env = tempEnv("worstcase-omit")
    // No daemonWorstCaseMs field at all (undefined, the fake's default) —
    // additive/optional field, must not block a daemon that predates it.
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("ok")
    expect(fake.sawPrompt()).toBe(true)
  })

  test("ROUND-4 I4: lane selection does NOT change the client's fingerprint (or which discovery file it finds)", async () => {
    const home = tempHome("i4"); LIVE_HOMES.push(home)
    const base = { ...process.env, KKAMAK_ACP_TEST_MARKER: "acp-client-test", HOME: home }
    const envA = { ...base, KKAMAK_GAUGE_TRANSPORT: "sdk" }
    const envB = { ...base, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" }
    expect(envFingerprint(envA)).toBe(envFingerprint(envB))
    const fake = await fakeDaemon(envA, { fingerprint: envFingerprint(envA), answer: "ok" })
    LIVE_FAKES.push(fake)
    const rA = await daemonCall("x", HAIKU, envA, ISO)
    expect(rA.kind).toBe("ok")
    expect(fake.sawPrompt()).toBe(true)
    const rB = await daemonCall("x", HAIKU, envB, ISO)
    expect(rB.kind).toBe("ok")
  })

  test("daemonCall sends the model in _meta and the text verbatim", async () => {
    const env = tempEnv("verbatim")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const outgoing = "the exact outgoing string"
    await daemonCall(outgoing, HAIKU, env, ISO)
    const params = fake.promptParams()
    expect(params?._meta.model).toBe(HAIKU)
    expect(params?.prompt[0]?.text).toBe(outgoing)
  })

  test("N3c-iii test 7: daemonCall sends _meta.kkamak.isolation deep-equal to what the caller passed", async () => {
    const env = tempEnv("isolation")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const customIsolation: WarmIsolation = {
      ...TEST_ISOLATION, systemPrompt: "CLIENT-CALLER-ISOLATION-MARKER", title: "kkamak-client-test",
    }
    await daemonCall("x", HAIKU, env, { isolation: customIsolation })
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).toEqual(customIsolation)
    // and the shared-default-isolation calls elsewhere in this file are NOT
    // silently equal to this one, proving the assertion above is actually
    // discriminating on VALUE, not just presence.
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).not.toEqual(TEST_ISOLATION)
  })

  test("N3c-iii test 8: -32002 with data.callConsumed false from the fake -> {kind:\"no-call\"} (the load-bearing contract of daemon §2)", async () => {
    const env = tempEnv("poolexhausted")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "pool-exhausted" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    // NO new client-side code classifies this -- classifyPostSendError's
    // EXISTING step (i) (a boolean data.callConsumed wins outright) already
    // routes it here; this test verifies that by observation, per the
    // brief's own instruction ("verify by test, not by new code").
    expect(r.kind).toBe("no-call")
  })

  test("closeSession sends a session/close frame with the given sessionId and resolves the daemon's result", async () => {
    const env = tempEnv("close-ok")
    const fake = await fakeDaemon(env, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await closeSession("some-session-id", env)
    expect(r).toEqual({ closed: true })
    expect(fake.closeParams()).toEqual({ sessionId: "some-session-id" })
  })

  test("closeSession against an unreachable daemon resolves {closed:false, reason:\"unreachable\"} without throwing", async () => {
    const t0 = Date.now()
    // No fake registered for this HOME -- readDiscovery finds nothing.
    const r = await closeSession("some-session-id", tempEnv("noclose"))
    expect(r).toEqual({ closed: false, reason: "unreachable" })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test("the default budget is the contract constant, not a local literal", () => {
    expect(ACP_BUDGET.clientBudgetMs).toBe(36_000)
  })

  // No buildAgentOutgoingText test here: that builder lives in
  // meta-harness's src/gauge/agent-transport.ts, an unported gauge module
  // unrelated to the ACP daemon core — out of scope for this package.

  test("ensureDaemon spawns exactly ONE serving daemon under concurrent callers", async () => {
    const env = tempEnv("concurrent")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    LIVE_DAEMONS.push({ spawnLog })
    env.KKAMAK_ACP_TEST_SPAWN_LOG = spawnLog
    env.KKAMAK_ACP_IDLE_MS = "8000"
    const [a, b] = await Promise.all([
      ensureDaemon(env, { waitMs: 10_000 }),
      ensureDaemon(env, { waitMs: 10_000 }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    const lines = await waitForLines(spawnLog, 1, 2_000)
    expect(lines.length).toBe(1)
  }, 30_000)

  test("ROUND-4 I2: the spawned daemon publishes discovery under the env it was given", async () => {
    const env = tempEnv("i2")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    LIVE_DAEMONS.push({ spawnLog })
    env.KKAMAK_ACP_TEST_SPAWN_LOG = spawnLog
    env.KKAMAK_ACP_IDLE_MS = "8000"
    const ok = await ensureDaemon(env, { waitMs: 10_000 })
    expect(ok).toBe(true)
    expect(readDiscovery(env)).toBeTruthy()
  }, 30_000)

  test("ensureDaemon() defaults to waitMs 0: returns false immediately and still kicks a spawn", async () => {
    const env = tempEnv("waitms0")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    LIVE_DAEMONS.push({ spawnLog })
    env.KKAMAK_ACP_TEST_SPAWN_LOG = spawnLog
    env.KKAMAK_ACP_IDLE_MS = "8000"
    const t0 = Date.now()
    const ok = await ensureDaemon(env)
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    const lines = await waitForLines(spawnLog, 1, 15_000)
    expect(lines.length).toBe(1)
  }, 30_000)

  test("ensureDaemon NEVER throws when its own lock directory cannot be created", async () => {
    // websocket-transport swap: the old unwritable-parent trigger was an
    // explicit KKAMAK_ACP_SOCKET pointed at a nonexistent dir, caught by
    // ensureSocketDir. That function is gone (Task 2) — the equivalent
    // failure surface now is acquireAcpLock -> tryCreateLock's own
    // mkdirSync, which throws EACCES when the discovery/lock directory's
    // PARENT is unwritable. A HOME sitting under a 0500 (no write)
    // directory reproduces that: `${restricted}/home/.config/acpd/`
    // cannot be created because `restricted` itself refuses the write.
    const restricted = fs.mkdtempSync(path.join(tmpdir(), "c-restricted-"))
    fs.chmodSync(restricted, 0o500)
    const env = { ...process.env, HOME: path.join(restricted, "home") }
    try {
      await expect(ensureDaemon(env, { waitMs: 0 })).resolves.toBe(false)
    } finally {
      fs.chmodSync(restricted, 0o700)
      fs.rmSync(restricted, { recursive: true, force: true })
    }
  })

  test("a caller that LOSES the spawn lock never unlinks it", async () => {
    const env = tempEnv("loselock")
    const lockPath = spawnLockPath(env)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const created = tryCreateLock(lockPath, { pid: 999_999, ts: Date.now() })
    expect(created).toBe(true)
    const ok = await ensureDaemon(env, { waitMs: 0 })
    expect(ok).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
  })
})

// Re-enabled (Task 6, gate-debt paydown): skipped from Task 1 through Task
// 5 because it dispatches a real daemonCall through a really-spawned daemon
// and needed ApiSession wired in as the pool's default. Runs against
// ApiSession + the local stub now — deliberately NOT gated on
// HAS_CLAUDE_CODE_CREDENTIALS: that credential requirement belonged to the
// old agent-SDK-CLI transport (a spawned Claude Code CLI resolving its own
// keychain credentials); this backend's daemon resolves auth from its own
// env (auth.ts), no CLI involved.
describe("acp-client e2e (real daemon + stub)", () => {
  test("ensureDaemon + daemonCall against the real daemon", async () => {
    const env = tempEnv("e2e")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    LIVE_DAEMONS.push({ spawnLog })
    env.KKAMAK_ACP_TEST_SPAWN_LOG = spawnLog
    env.KKAMAK_ACP_IDLE_MS = "8000"
    // Plain JSON, not sseText(): sendOne (api-session.ts's leaf) calls the
    // real @anthropic-ai/sdk's messages.create WITHOUT stream:true, which
    // defaults to non-streaming — sseText() matched the OLD agent-SDK-CLI
    // transport, which always sent stream:true. Verified by running this
    // test first: it received call-consumed (an SSE body failing to parse
    // as the SDK's expected JSON response), not the plan's assumed pass.
    const cap = stubServer(() => okResponse("ANSWER"))
    try {
      // CI reality-check: on a dev host with real ambient credentials,
      // auth.ts's resolveAuth silently succeeds off THAT ambient state
      // even though ANTHROPIC_BASE_URL below redirects away from the real
      // API -- masking that this test never injected its own credential.
      // A credential-less host (CI) fails closed instead: no-call, not ok.
      // Fixed key wins over whatever the host ambiently has.
      env.ANTHROPIC_API_KEY = "k"
      env.ANTHROPIC_BASE_URL = cap.url
      const started = await ensureDaemon(env, { waitMs: 15_000 })
      expect(started).toBe(true)
      const r = await daemonCall("hello", HAIKU, env, ISO)
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") throw new Error("unreachable")
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally {
      cap.stop()
    }
    // SIGTERM by PID from the spawn log (never pkill -f, §6e / round-4 I9).
    killDaemonByPid(spawnLog)
    const gone = await (async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (!readDiscovery(env)) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return !readDiscovery(env)
    })()
    expect(gone).toBe(true)
  }, 60_000)

  // The invariant the CI failure this test was written to fix was really
  // about: no test outcome may depend on whether the HOST happens to carry
  // real credentials. Every test in this file already runs under a
  // throwaway, credential-free HOME by construction now (tempEnv) — this
  // test used to build its OWN separate scrubbed HOME specifically to
  // prove that; the invariant it proves is no longer this file's special
  // case, it is the file's DEFAULT. Kept explicit (rather than folded away
  // as redundant) because it names the property directly and deletes the
  // other auth lane too — the ONLY way this can reach `ok` is the
  // ANTHROPIC_API_KEY injected below.
  test("the round-trip succeeds even with every host credential scrubbed", async () => {
    const env = tempEnv("scrubbed")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    LIVE_DAEMONS.push({ spawnLog })
    env.KKAMAK_ACP_TEST_SPAWN_LOG = spawnLog
    env.KKAMAK_ACP_IDLE_MS = "8000"
    const cap = stubServer(() => okResponse("ANSWER"))
    try {
      env.ANTHROPIC_API_KEY = "k"
      env.ANTHROPIC_BASE_URL = cap.url
      delete env.ANTHROPIC_AUTH_TOKEN
      const started = await ensureDaemon(env, { waitMs: 15_000 })
      expect(started).toBe(true)
      const r = await daemonCall("hello", HAIKU, env, ISO)
      expect(r.kind).toBe("ok")
    } finally {
      cap.stop()
    }
    killDaemonByPid(spawnLog)
  }, 60_000)
})
