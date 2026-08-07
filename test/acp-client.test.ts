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
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { daemonCall, ensureDaemon, closeSession } from "../src/acp-client.ts"
import { ACP_BUDGET, modelProvenBy, type WarmIsolation } from "../src/acp-wire.ts"
import { envFingerprint, spawnLockPath, tryCreateLock } from "../src/acp-paths.ts"
import { fakeDaemon } from "./acp-fake-daemon.ts"
import { shortSock } from "./sock-path.ts"
import { stubServer, okResponse } from "./sdk-stub.ts"

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

/** Every test builds its OWN socket path under tmpdir — no test may ever
 * touch the real ~/.config/kkamak store (asserted in afterEach below).
 * Short names via sock-path.ts: darwin sun_path caps the path at 104B. */
function tempSock(tag: string): string {
  return shortSock(tag)
}

/** The base env every fake-daemon test starts from. `envFingerprint` is
 * computed from THIS object, and every fake in this file MUST be built
 * with `envFingerprint(ENV)` (or a deliberately-mismatched variant) so a
 * fake's echo can never silently disagree with what the client itself
 * fingerprints. */
const ENV: Record<string, string | undefined> = { ...process.env, KKAMAK_ACP_TEST_MARKER: "acp-client-test" }

const LIVE_FAKES: Array<{ stop: () => void }> = []
const LIVE_DAEMONS: Array<{ sock: string; spawnLog: string }> = []

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

/** Leak check is a DELTA against what was already listening, not absolute
 * emptiness. `~/.config/kkamak` is shared with the live host, and since the
 * review-sensor was armed (2026-08-06, ledger ts 1785996709580) it drives the
 * ACP warm lane, so a real `acp-<fp>.sock` is routinely present while tests
 * run. An absolute `toEqual([])` fails every test in this file on an armed
 * host and wedges the gate that runs them (observed: 72 failures from one
 * pre-existing socket). The delta still catches what this guards — production
 * code ignoring `KKAMAK_ACP_SOCKET` and falling back to the default
 * fingerprint-derived path, which appears as a NEW file during a test. */
const acpDir = () => path.join(process.env.HOME ?? "", ".config", "kkamak")
const acpSocksNow = (): string[] =>
  fs.existsSync(acpDir()) ? fs.readdirSync(acpDir()).filter((f) => f.startsWith("acp-")) : []
const PRE_EXISTING = new Set(acpSocksNow())
const newAcpSocks = (): string[] => acpSocksNow().filter((f) => !PRE_EXISTING.has(f))

afterEach(() => {
  while (LIVE_FAKES.length) { const f = LIVE_FAKES.pop()!; try { f.stop() } catch { /* ignore */ } }
  while (LIVE_DAEMONS.length) { const d = LIVE_DAEMONS.pop()!; killDaemonByPid(d.sock, d.spawnLog) }
  expect(newAcpSocks()).toEqual([])
})

async function waitForLines(file: string, n: number, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms
  for (;;) {
    let lines: string[] = []
    try { lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()) } catch { /* not yet */ }
    if (lines.length >= n || Date.now() > deadline) return lines
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe("acp-client (fake daemons only — no CLI, no model)", () => {
  test("law L1: no daemon at all -> no-call, fast", async () => {
    const t0 = Date.now()
    const r = await daemonCall("x", "claude-haiku-4-5", {
      ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-${Date.now()}.sock`,
    }, ISO)
    expect(r.kind).toBe("no-call")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test("round-trips against a scripted fake daemon -> ok, text, DATED model evidence", async () => {
    const sock = tempSock("ok")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
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
    const sock = tempSock("consumed")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "call-consumed" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")
  })

  test("law L3(i): ACP_ERR_NO_CALL maps to no-call", async () => {
    const sock = tempSock("nocall")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "no-call" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("no-call")
  })

  test("law L3(i): data.callConsumed OVERRIDES a mismatched code", async () => {
    const sock = tempSock("mismatched")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "mismatched-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")   // the data field is authoritative
  })

  test("law L3(ii): a RECOGNIZED code with `data` ABSENT is HONOURED, both ways", async () => {
    const sockA = tempSock("codenodata-nocall")
    const envA = { ...ENV, KKAMAK_ACP_SOCKET: sockA }
    const fakeA = fakeDaemon(sockA, { fingerprint: envFingerprint(envA), answer: "no-call-code-no-data" })
    LIVE_FAKES.push(fakeA)
    expect((await daemonCall("x", HAIKU, envA, ISO)).kind).toBe("no-call")

    const sockB = tempSock("codenodata-consumed")
    const envB = { ...ENV, KKAMAK_ACP_SOCKET: sockB }
    const fakeB = fakeDaemon(sockB, { fingerprint: envFingerprint(envB), answer: "consumed-code-no-data" })
    LIVE_FAKES.push(fakeB)
    expect((await daemonCall("x", HAIKU, envB, ISO)).kind).toBe("call-consumed")
  })

  test("law L2: a NON-BOOLEAN data.callConsumed is an ambiguity, not a value", async () => {
    const sock = tempSock("nonboolean")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "nonboolean-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")
  })

  test("law L3(iii)/final-review Important 2: a NON-OBJECT `data` (data: \"false\") with ACP_ERR_NO_CALL does NOT launder into no-call", async () => {
    const sock = tempSock("nonobjectdata")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "nonobject-data" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    // `data` is present (a string, not an object) -- present-but-malformed
    // must fall to L2's default (call-consumed), never skip past step (iii)
    // into the recognized-code (ACP_ERR_NO_CALL) branch. Before the fix
    // this returned {kind:"no-call"} -- the double-spend direction.
    expect(r.kind).toBe("call-consumed")
  })

  test("law L2: an UNRECOGNIZED error code after the prompt was sent is call-consumed", async () => {
    const sock = tempSock("unknowncode")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "unknown-code" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("call-consumed")   // never no-call — that would double-spend
  })

  test("law L2: budget expiry after the prompt was sent is call-consumed", async () => {
    const sock = tempSock("hang")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "hang" })
    LIVE_FAKES.push(fake)
    const t0 = Date.now()
    const r = await daemonCall("x", HAIKU, env, { ...ISO, budgetMs: 500 })
    expect(r.kind).toBe("call-consumed")
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(fake.sawPrompt()).toBe(true)   // it really did cross the boundary
  })

  test("law L1: a daemon that dies before session/prompt is written is no-call", async () => {
    const sock = tempSock("die")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "die-before-prompt" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("law L1: a fingerprint mismatch refuses BEFORE sending anything", async () => {
    const sock = tempSock("fpmismatch")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint({ ...env, ANTHROPIC_BASE_URL: "http://other" }), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("Task 8: a daemon whose worst case exceeds the client budget is refused pre-send", async () => {
    const sock = tempSock("worstcase-refuse")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    // budgetMs (500) < daemonWorstCaseMs (999_000): the client must refuse
    // before session/prompt is ever written, same as the fingerprint-
    // mismatch case above — law L1, no-call.
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), daemonWorstCaseMs: 999_000, answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, { ...ISO, budgetMs: 500 })
    expect(r.kind).toBe("no-call")
    expect(fake.sawPrompt()).toBe(false)
  })

  test("Task 8: a daemon that omits daemonWorstCaseMs is accepted — older daemons stay compatible", async () => {
    const sock = tempSock("worstcase-omit")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    // No daemonWorstCaseMs field at all (undefined, the fake's default) —
    // additive/optional field, must not block a daemon that predates it.
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    expect(r.kind).toBe("ok")
    expect(fake.sawPrompt()).toBe(true)
  })

  test("ROUND-4 I4: lane selection and socket path do NOT change the client's fingerprint", async () => {
    const sock = tempSock("i4")
    const envA = { ...ENV, KKAMAK_ACP_SOCKET: sock, KKAMAK_GAUGE_TRANSPORT: "sdk" }
    const envB = { ...ENV, KKAMAK_ACP_SOCKET: sock, KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" }
    expect(envFingerprint(envA)).toBe(envFingerprint(envB))
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(envA), answer: "ok" })
    LIVE_FAKES.push(fake)
    const rA = await daemonCall("x", HAIKU, envA, ISO)
    expect(rA.kind).toBe("ok")
    expect(fake.sawPrompt()).toBe(true)
    const rB = await daemonCall("x", HAIKU, envB, ISO)
    expect(rB.kind).toBe("ok")
  })

  test("daemonCall sends the model in _meta and the text verbatim", async () => {
    const sock = tempSock("verbatim")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const outgoing = "the exact outgoing string"
    await daemonCall(outgoing, HAIKU, env, ISO)
    const params = fake.promptParams()
    expect(params?._meta.model).toBe(HAIKU)
    expect(params?.prompt[0]?.text).toBe(outgoing)
  })

  test("N3c-iii test 7: daemonCall sends _meta.kkamak.isolation deep-equal to what the caller passed", async () => {
    const sock = tempSock("isolation")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
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
    const sock = tempSock("poolexhausted")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "pool-exhausted" })
    LIVE_FAKES.push(fake)
    const r = await daemonCall("x", HAIKU, env, ISO)
    // NO new client-side code classifies this -- classifyPostSendError's
    // EXISTING step (i) (a boolean data.callConsumed wins outright) already
    // routes it here; this test verifies that by observation, per the
    // brief's own instruction ("verify by test, not by new code").
    expect(r.kind).toBe("no-call")
  })

  test("closeSession sends a session/close frame with the given sessionId and resolves the daemon's result", async () => {
    const sock = tempSock("close-ok")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const fake = fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
    LIVE_FAKES.push(fake)
    const r = await closeSession("some-session-id", env)
    expect(r).toEqual({ closed: true })
    expect(fake.closeParams()).toEqual({ sessionId: "some-session-id" })
  })

  test("closeSession against a dead socket resolves {closed:false, reason:\"unreachable\"} without throwing", async () => {
    const t0 = Date.now()
    const r = await closeSession("some-session-id", {
      ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-close-${Date.now()}.sock`,
    })
    expect(r).toEqual({ closed: false, reason: "unreachable" })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  test("the default budget is the contract constant, not a local literal", () => {
    expect(ACP_BUDGET.clientBudgetMs).toBe(30_000)
  })

  // No buildAgentOutgoingText test here: that builder lives in
  // meta-harness's src/gauge/agent-transport.ts, an unported gauge module
  // unrelated to the ACP daemon core — out of scope for this package.

  test("ensureDaemon spawns exactly ONE serving daemon under concurrent callers", async () => {
    const sock = tempSock("concurrent")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const env = {
      ...ENV,
      KKAMAK_ACP_SOCKET: sock,
      KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
      KKAMAK_ACP_IDLE_MS: "8000",
    }
    const [a, b] = await Promise.all([
      ensureDaemon(env, { waitMs: 10_000 }),
      ensureDaemon(env, { waitMs: 10_000 }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    const lines = await waitForLines(spawnLog, 1, 2_000)
    expect(lines.length).toBe(1)
  }, 30_000)

  test("ROUND-4 I2: the spawned daemon binds the socket the CALLER named", async () => {
    const sock = tempSock("i2")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const env = {
      ...ENV,
      KKAMAK_ACP_SOCKET: sock,
      KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
      KKAMAK_ACP_IDLE_MS: "8000",
    }
    const ok = await ensureDaemon(env, { waitMs: 10_000 })
    expect(ok).toBe(true)
    expect(fs.existsSync(sock)).toBe(true)
    expect(newAcpSocks()).toEqual([])
  }, 30_000)

  test("ensureDaemon() defaults to waitMs 0: returns false immediately and still kicks a spawn", async () => {
    const sock = tempSock("waitms0")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    const env = {
      ...ENV,
      KKAMAK_ACP_SOCKET: sock,
      KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
      KKAMAK_ACP_IDLE_MS: "8000",
    }
    const t0 = Date.now()
    const ok = await ensureDaemon(env)
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    const lines = await waitForLines(spawnLog, 1, 15_000)
    expect(lines.length).toBe(1)
  }, 30_000)

  test("ensureDaemon NEVER throws on an unwritable socket dir", async () => {
    await expect(ensureDaemon({ ...ENV, KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" }, { waitMs: 0 }))
      .resolves.toBe(false)
  })

  test("a caller that LOSES the spawn lock never unlinks it", async () => {
    const sock = tempSock("loselock")
    const env = { ...ENV, KKAMAK_ACP_SOCKET: sock }
    const lockPath = spawnLockPath(env)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const created = tryCreateLock(lockPath, { pid: 999_999, ts: Date.now() })
    expect(created).toBe(true)
    try {
      const ok = await ensureDaemon(env, { waitMs: 0 })
      expect(ok).toBe(false)
      expect(fs.existsSync(lockPath)).toBe(true)
    } finally {
      try { fs.rmSync(lockPath, { force: true }) } catch { /* ignore */ }
    }
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
    const sock = tempSock("e2e")
    const spawnLog = `${sock}.spawnlog`
    LIVE_DAEMONS.push({ sock, spawnLog })
    // Plain JSON, not sseText(): sendOne (api-session.ts's leaf) calls the
    // real @anthropic-ai/sdk's messages.create WITHOUT stream:true, which
    // defaults to non-streaming — sseText() matched the OLD agent-SDK-CLI
    // transport, which always sent stream:true. Verified by running this
    // test first: it received call-consumed (an SSE body failing to parse
    // as the SDK's expected JSON response), not the plan's assumed pass.
    const cap = stubServer(() => okResponse("ANSWER"))
    try {
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: cap.url,
        KKAMAK_ACP_SOCKET: sock,
        KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
        KKAMAK_ACP_IDLE_MS: "8000",
      }
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
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
    const gone = await (async () => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        if (!fs.existsSync(sock)) return true
        await new Promise((r) => setTimeout(r, 100))
      }
      return !fs.existsSync(sock)
    })()
    expect(gone).toBe(true)
  }, 60_000)
})
