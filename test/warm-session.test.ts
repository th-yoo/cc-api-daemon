// Ported from meta-harness cc-gate-plugin's test/warm-session.test.ts
// (read-only source) — see src/warm-session.ts's header for the port
// rationale. Two changes from the upstream file, both required by this
// repo's CLAUDE.md credential-safety rules:
//
//  1. Every `describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)` is REMOVED
//     ("Never gate a test on host credential presence again" — that
//     pattern is what let a real host-credential dependency ship silently
//     upstream). Replaced by unconditional `describe` blocks.
//  2. Every `new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: ... })`
//     that spawns the real CLI subprocess is replaced by
//     `warmHermeticEnv(url)` (agent-cli-stub.ts) — verified empirically
//     that the spawned CLI honors an explicit ANTHROPIC_API_KEY over
//     on-disk/keychain credentials, so no host credential is required.
//
// Everything else — the assertions, the §6e law each test locks, the wall-
// clock budgets — is unchanged from the source.
import { describe, expect, test } from "bun:test"
import { WarmSession, selectEvidence } from "../src/warm-session.ts"
import { modelProvenBy, CLI_SPAWN_BUDGET_MS, GAUGE_ISOLATION } from "../src/acp-wire.ts"
import { sseText, hangFirstServer, until, warmHermeticEnv } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

// With turnTimeoutMs floored at CLI_SPAWN_BUDGET_MS (8s), a hard-reset
// test's worst case is ~8s + hardGrace + a full respawn + a second turn —
// comfortably over 60s only if something is wrong, but the margin has to
// exist or a slow host produces a false failure.
const CLI_TEST_TIMEOUT_MS = 90_000
const HAIKU = "claude-haiku-4-5"
// What the stub DECLARES in message_start. Measured (upstream, Step 1a):
// on the streaming-input + local-stub driving path these tests use, this
// declared id does NOT propagate into modelUsage's key — so it must never
// be read as a prediction of what TurnOutcome.model will be.
const STUB_DECLARED_MODEL = "claude-haiku-4-5-20251001"
// What modelUsage IS ACTUALLY keyed by on THIS driving path: the client-
// requested model id, verbatim — identical to HAIKU.
const HAIKU_OBSERVED_KEY = HAIKU
// §6e/round-4 C3: the turn's timers start at the PUSH while the subprocess
// is still booting (measured 1.25-1.46s). Every override below uses this
// floor; only hardGraceMs and queueWaitMs may be small, because neither
// measures generation.
const T = CLI_SPAWN_BUDGET_MS       // 8_000

describe("selectEvidence (§6e model-evidence selection, pure -- no CLI, no stub)", () => {
  test("single matching key is accepted as evidence", () => {
    const usage = { "claude-haiku-4-5": { outputTokens: 5, canonicalModel: "claude-haiku-4-5" } }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("claude-haiku-4-5")
    expect(e.canonicalModel).toBe("claude-haiku-4-5")
  })

  test("single NON-matching key proves nothing: empty evidence, so route() reports call-consumed, never a silent ok", () => {
    const usage = { "claude-opus-5-20260101": { outputTokens: 5, canonicalModel: "claude-opus-5" } }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("")
    expect(e.canonicalModel).toBe("")
  })

  test("empty modelUsage (the /clear synthetic-result shape, and a genuinely evidence-free result) is empty evidence", () => {
    expect(selectEvidence({}, HAIKU)).toEqual({ model: "", canonicalModel: "" })
    expect(selectEvidence(undefined, HAIKU)).toEqual({ model: "", canonicalModel: "" })
  })

  test("multi-key: an auxiliary model with ZERO output tokens does not block the provable key", () => {
    const usage = {
      "claude-haiku-4-5": { outputTokens: 5, canonicalModel: "claude-haiku-4-5" },
      "claude-3-5-haiku-20241022": { outputTokens: 0, canonicalModel: "claude-3-5-haiku-20241022" },
    }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("claude-haiku-4-5")
    expect(e.canonicalModel).toBe("claude-haiku-4-5")
  })

  test("multi-key: an auxiliary model with NONZERO output tokens makes the turn unprovable", () => {
    const usage = {
      "claude-haiku-4-5": { outputTokens: 5, canonicalModel: "claude-haiku-4-5" },
      "claude-3-5-haiku-20241022": { outputTokens: 2, canonicalModel: "claude-3-5-haiku-20241022" },
    }
    const e = selectEvidence(usage, HAIKU)
    expect(e.model).toBe("")
    expect(e.canonicalModel).toBe("")
  })
})

describe("WarmSession (spawns bundled CLI, hermetic — fake ANTHROPIC_API_KEY, local stub)", () => {
  test("two records reuse one subprocess; the second context is clean; exactly one call each", async () => {
    let n = 0
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText(`ANSWER-${++n}`, STUB_DECLARED_MODEL) })
    const ws = new WarmSession(warmHermeticEnv(cap.url))
    try {
      const r1 = await ws.oneShot("first record prompt", HAIKU, { recycle: true })
      const r2 = await ws.oneShot("second record prompt", HAIKU, { recycle: true })
      expect(r1.kind).toBe("ok")
      expect(r2.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)                        // exactly 1 model call per record
      const m2 = CAPTURED[1] as { messages: unknown[] }
      // THE binding assertion: the first record's text is gone from the
      // second turn's context — that is what "/clear reset the context"
      // means.
      expect(JSON.stringify(m2.messages)).not.toContain("first record prompt")
      expect(JSON.stringify(m2.messages)).toContain("second record prompt")
      expect(m2.messages.length).toBe(1)                     // bulk-history regression guard
      expect(ws.isWarm()).toBe(true)                         // no respawn between records
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("WarmSession forwards modelUsage's KEY verbatim, and modelProvenBy accepts it", async () => {
    // Measured (upstream Step 1a): declaring a dated snapshot id in the
    // stub's message_start does NOT make modelUsage's key differ on this
    // driving path — it comes back keyed by the client-requested (undated)
    // model, verbatim. Asserts the OBSERVED shape.
    const cap = stubServer(() => sseText("ANSWER", STUB_DECLARED_MODEL))
    const ws = new WarmSession(warmHermeticEnv(cap.url))
    try {
      const r = await ws.oneShot("model-evidence record", HAIKU, { recycle: true })
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") return
      expect(r.model).toBe(HAIKU_OBSERVED_KEY)               // the KEY, verbatim — observed undated
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("a stub-declared DIFFERENT model does not make modelUsage's key differ -- WarmSession forwards it verbatim and it still proves the request", async () => {
    const cap = stubServer(() => sseText("ANSWER", "claude-opus-5-20260101"))
    const ws = new WarmSession(warmHermeticEnv(cap.url))
    try {
      const r = await ws.oneShot("wrong model record", HAIKU, { recycle: true })
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") return
      expect(r.model).toBe(HAIKU_OBSERVED_KEY)
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("recycle:false keeps context (ACP multi-prompt session semantics)", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession(warmHermeticEnv(cap.url))
    try {
      await ws.oneShot("turn one marker", HAIKU, { recycle: true })
      await ws.oneShot("turn two", HAIKU, { recycle: false })
      expect(JSON.stringify((CAPTURED[1] as { messages: unknown[] }).messages)).toContain("turn one marker")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5: a SENT turn that times out is call-consumed (never partial text); session stays warm", async () => {
    // The endpoint ACCEPTS the connection and never answers: the request is
    // in flight at the API, so the conservative side of the ambiguity is
    // "consumed" — the caller must NOT fall back.
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: T, hardGraceMs: 4_000 })
    try {
      const r1 = await ws.oneShot("hanging record", HAIKU, { recycle: true })
      expect(r1.kind).toBe("call-consumed")                  // NOT ok, NOT no-call
      expect("text" in r1).toBe(false)                       // no truncated text escapes
      const r2 = await ws.oneShot("normal record", HAIKU, { recycle: true })
      expect(r2.kind).toBe("ok")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L6: a 500 (api_retry) is call-consumed and the retry is never consumed as a result", async () => {
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER", STUB_DECLARED_MODEL)))
    const ws = new WarmSession(warmHermeticEnv(cap.url))
    try {
      const r = await ws.oneShot("retry-provoking record", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
      expect(n).toBeLessThanOrEqual(2)   // the abort races an in-flight retry; a THIRD request means it never landed
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5 has NO connection-only exception: an unreachable endpoint AFTER the push is call-consumed", async () => {
    const ws = new WarmSession(warmHermeticEnv("http://127.0.0.1:9"), { turnTimeoutMs: T, hardGraceMs: 4_000 })
    try {
      const r = await ws.oneShot("x", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
    } finally { ws.close() }
  }, CLI_TEST_TIMEOUT_MS)

  test("FIFO: concurrent oneShots serialize; BOTH resolve; two calls total", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession(warmHermeticEnv(cap.url), { queueWaitMs: 60_000 })
    try {
      const [a, b] = await Promise.all([
        ws.oneShot("record A", HAIKU, { recycle: true }),
        ws.oneShot("record B", HAIKU, { recycle: true }),
      ])
      expect(a.kind).toBe("ok")
      expect(b.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L4: a turn still queued at its queue-wait cap resolves no-call, provably unsent", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 500 })
    try {
      const first = ws.oneShot("occupies the session", HAIKU, { recycle: true })
      const queued = await ws.oneShot("never gets its turn", HAIKU, { recycle: true })
      expect(queued.kind).toBe("no-call")        // never reached execute()
      await first                                 // drain, whatever it becomes (<= ~10s)
      expect(cap.count()).toBe(1)                 // the queued turn sent NOTHING
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancel(tag) drops only that caller's turn, never the other caller's in-flight turn", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      const inflight = ws.oneShot("A in flight", HAIKU, { recycle: true, tag: "A" })
      const queued = ws.oneShot("B queued", HAIKU, { recycle: true, tag: "B" })
      expect(ws.cancel("B")).toBe("queued-dropped")
      expect((await queued).kind).toBe("no-call")
      expect(ws.cancel("nobody")).toBe("unknown")     // must not touch A
      const a = await inflight
      expect(a.kind).toBe("call-consumed")            // A ended on its OWN timeout, not B's cancel
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancel scoping, WRONG-OWNER shape: a cancel naming the QUEUED turn's tag never reaches the IN-FLIGHT turn", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      const inflight = ws.oneShot("A in flight", HAIKU, { recycle: true, tag: "tag-A" })
      const queued = ws.oneShot("B queued", HAIKU, { recycle: true, tag: "tag-B" })
      expect(await until(() => cap.count() >= 1, 30_000)).toBe(true)   // A has been SENT
      expect(ws.cancel("tag-C")).toBe("unknown")       // nobody: must be a no-op
      expect(ws.cancel("tag-A")).toBe("interrupted")   // the in-flight turn, by ITS OWN tag
      const a = await inflight
      expect(a.kind).toBe("call-consumed")             // it was SENT; never no-call
      const b = await queued
      expect(b.kind === "ok" || b.kind === "no-call").toBe(true)   // untouched by A's cancel
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancelling a turn BEFORE it pushes drops it — a cancel must never cause a model call", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      // Turn 1 warms the session so turn 2 takes the /clear path (the window
      // this test needs); wait for it to finish.
      expect((await ws.oneShot("warm the session", HAIKU, { recycle: true })).kind).toBe("ok")
      const before = CAPTURED.length                     // 1
      const second = ws.oneShot("must never be sent", HAIKU, { recycle: true, tag: "C" })
      // Cancel immediately: the turn is current, the /clear is in flight,
      // nothing has been pushed for THIS turn.
      const verdict = ws.cancel("C")
      expect(verdict === "unsent-dropped" || verdict === "queued-dropped").toBe(true)
      expect((await second).kind).toBe("no-call")        // provably unsent
      await new Promise((r) => setTimeout(r, 2_000))     // let any stray push land
      expect(CAPTURED.length).toBe(before)               // ZERO extra model calls
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("a hardReset with a turn QUEUED behind it does not kill the replacement session", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: T, hardGraceMs: 1, queueWaitMs: 60_000 })
    try {
      const a = ws.oneShot("A hangs and is hard-reset", HAIKU, { recycle: true })
      const b = ws.oneShot("B must survive the teardown", HAIKU, { recycle: true })
      expect((await a).kind).toBe("call-consumed")   // A was sent
      expect((await b).kind).toBe("ok")              // B ran on the REPLACEMENT Query
      expect(ws.isWarm()).toBe(true)                 // and that Query is still alive
      expect(cap.count()).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("close() settles every outstanding caller — no hanging promises", async () => {
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    const ws = new WarmSession(warmHermeticEnv(cap.url), { turnTimeoutMs: 30_000, hardGraceMs: 5_000, queueWaitMs: 60_000 })
    const inflight = ws.oneShot("A", HAIKU, { recycle: true })
    const queued = ws.oneShot("B", HAIKU, { recycle: true })
    // Deterministic instead of a fixed sleep: close only once A has crossed
    // the send boundary.
    expect(await until(() => cap.count() >= 1, 30_000)).toBe(true)
    ws.close()
    const [a, b] = await Promise.all([inflight, queued])
    expect(a.kind).toBe("call-consumed")            // sent, therefore consumed
    expect(b.kind).toBe("no-call")                  // queued: provably unsent
    expect(ws.isWarm()).toBe(false)
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)

  test("close() during the SDK import does not spawn a subprocess or send anything", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession(warmHermeticEnv(cap.url))
    const p = ws.oneShot("must never reach the model", HAIKU, { recycle: true })
    ws.close()                                       // same tick as the enqueue
    expect((await p).kind).toBe("no-call")
    await new Promise((r) => setTimeout(r, 3_000))   // generous: a leaked spawn would land here
    expect(CAPTURED.length).toBe(0)
    expect(ws.isWarm()).toBe(false)
    expect(ws.turnInFlight()).toBe(false)
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)
})

// WarmSession takes an `isolation` option, defaulting to GAUGE_ISOLATION.
// Neither test below spawns the CLI — WarmSession's constructor never
// calls ensure()/query().
describe("WarmSession isolation option (construction only, no CLI spawn)", () => {
  test("GAUGE_ISOLATION is the §6d set, field for field", () => {
    expect(GAUGE_ISOLATION).toEqual({
      systemPrompt: "",
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      persistSession: false,
      strictMcpConfig: true,
      tools: [],
      title: "kkamak-gauge",
      thinking: { type: "disabled" },
    })
  })

  test("the DEFAULT isolation is the gauge one — omitting the option changes nothing", () => {
    const ws = new WarmSession({})
    expect(ws.isolation).toEqual(GAUGE_ISOLATION)
    ws.close()
  })
})

describe("a custom isolation reaches the wire", () => {
  test("a non-empty systemPrompt is what the request carries", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    const ws = new WarmSession(warmHermeticEnv(cap.url), {
      isolation: { ...GAUGE_ISOLATION, systemPrompt: "MARKER-SYSTEM-PROMPT", title: "kkamak-reasoning" },
    })
    try {
      expect((await ws.oneShot("hi", HAIKU, { recycle: true })).kind).toBe("ok")
      expect(JSON.stringify(CAPTURED[0])).toContain("MARKER-SYSTEM-PROMPT")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)
})
