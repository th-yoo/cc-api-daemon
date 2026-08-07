// test/api-session.test.ts — ApiSession (the FIFO session backend) over the
// shared local stub (helpers.ts). ZERO real API spend, ever. sendOne's own
// leaf tests live in call.test.ts.
import { beforeEach, describe, expect, test } from "bun:test"
import { ApiSession } from "../src/api-session.ts"
import type { WarmConstructOpts } from "../src/acp-pool.ts"
import { ISO, stubEnv, respondWith, resetStub, lastRequestBody } from "./helpers.ts"

// No afterAll(stopStub()) here — see helpers.ts: the stub server is shared
// across test files, and stopping it from one file's afterAll breaks every
// other file that runs after it in bun:test's sequential file order.
beforeEach(() => {
  resetStub()
})

/** turnTimeoutMs is floored to AUTH_RESOLVE_BUDGET_MS (10s) by ApiSession's
 * own constructor regardless of what's passed here — none of the tests
 * below wait for that internal timer to fire, they either await a fast stub
 * response or drive cancel()/close() directly, so the floor doesn't slow
 * anything down. */
function warmOpts(overrides: Partial<WarmConstructOpts> = {}): WarmConstructOpts {
  return {
    isolation: ISO,
    turnTimeoutMs: 5_000,
    queueWaitMs: 5_000,
    clearTimeoutMs: 1_000,
    setModelMs: 1_000,
    hardGraceMs: 1_000,
    ...overrides,
  }
}

// sendOne's own leaf tests (ok, abort, messages-forwarding) live in
// call.test.ts now, alongside its full outcome-law suite (retargeted from
// the deleted daemonCall — Task 5) rather than duplicated here. This file
// covers ApiSession-level behavior only: lifecycle, oneShot/FIFO, cancel.

describe("ApiSession — lifecycle", () => {
  test("a fresh session is not in flight and closes idempotently", () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    expect(s.turnInFlight()).toBe(false)
    s.close()
    s.close()
    expect(s.turnInFlight()).toBe(false)
  })

  // Moved from 4b (see that commit): both call oneShot, which only exists
  // from this point on.
  test("close() before a turn settles makes the turn call-consumed, not a throw", async () => {
    respondWith({ delayMs: 5_000, content: [], model: "m" })
    const s = new ApiSession(stubEnv(), warmOpts())
    const p = s.oneShot("x", "claude-haiku-4-5", { recycle: false })
    s.close()
    expect((await p).kind).toBe("call-consumed")
  })

  test("turnInFlight is true while a turn is outstanding", async () => {
    respondWith({ delayMs: 50, content: [{ type: "text", text: "ok" }], model: "claude-haiku-4-5" })
    const s = new ApiSession(stubEnv(), warmOpts())
    const p = s.oneShot("x", "claude-haiku-4-5", { recycle: false })
    expect(s.turnInFlight()).toBe(true)
    await p
    expect(s.turnInFlight()).toBe(false)
    s.close()
  })
})

describe("ApiSession — oneShot + FIFO", () => {
  test("recycle: false carries history into the next turn", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ content: [{ type: "text", text: "one" }], model: "claude-haiku-4-5" })
    await s.oneShot("first", "claude-haiku-4-5", { recycle: false })
    respondWith({ content: [{ type: "text", text: "two" }], model: "claude-haiku-4-5" })
    await s.oneShot("second", "claude-haiku-4-5", { recycle: false })
    expect(lastRequestBody().messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
    ])
    s.close()
  })

  test("recycle: true clears history first — the /clear equivalent", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ content: [{ type: "text", text: "one" }], model: "claude-haiku-4-5" })
    await s.oneShot("first", "claude-haiku-4-5", { recycle: false })
    respondWith({ content: [{ type: "text", text: "two" }], model: "claude-haiku-4-5" })
    await s.oneShot("second", "claude-haiku-4-5", { recycle: true })
    expect(lastRequestBody().messages).toEqual([{ role: "user", content: "second" }])
    s.close()
  })

  test("turns run strictly FIFO, one at a time", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    const seen: string[] = []
    respondWith({
      onRequest: (b) => seen.push((b.messages as Array<{ content: string }>).at(-1)!.content),
      content: [{ type: "text", text: "r" }],
      model: "claude-haiku-4-5",
    })
    await Promise.all([
      s.oneShot("a", "claude-haiku-4-5", { recycle: true }),
      s.oneShot("b", "claude-haiku-4-5", { recycle: false }),
    ])
    expect(seen).toEqual(["a", "b"])
    s.close()
  })

  test("a turn that waits past queueWaitMs settles no-call — it never reached the wire", async () => {
    const s = new ApiSession(stubEnv(), { ...warmOpts(), queueWaitMs: 30 })
    respondWith({ delayMs: 300, content: [{ type: "text", text: "slow" }], model: "claude-haiku-4-5" })
    const first = s.oneShot("a", "claude-haiku-4-5", { recycle: true })
    const second = s.oneShot("b", "claude-haiku-4-5", { recycle: false })
    expect((await second).kind).toBe("no-call")
    await first
    s.close()
  })

  test("a failed turn does not poison history", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ status: 500 })
    expect((await s.oneShot("bad", "claude-haiku-4-5", { recycle: false })).kind).toBe("call-consumed")
    respondWith({ content: [{ type: "text", text: "ok" }], model: "claude-haiku-4-5" })
    await s.oneShot("good", "claude-haiku-4-5", { recycle: false })
    expect(lastRequestBody().messages).toEqual([{ role: "user", content: "good" }])
    s.close()
  })
})

// Step 3a: singleton safety, NOT skippable. This daemon is a singleton
// shared by every kkamak instance with the same env fingerprint; the pool
// hands one idle isolation-equal entry to whichever client asks next, and
// ApiSession.history IS the literal messages array — a missed recycle puts
// another client's prompts and replies into THIS client's HTTP request body
// and bills them to it. This is a billing/privacy property, not a nicety.
describe("ApiSession — cross-client leak (singleton safety)", () => {
  test("a recycled session leaks nothing from the previous client", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ content: [{ type: "text", text: "alpha-reply" }], model: "claude-haiku-4-5" })
    await s.oneShot("SECRET-FROM-CLIENT-A", "claude-haiku-4-5", { recycle: false })

    // the pool hands this same entry to a different session -> recycle: true
    respondWith({ content: [{ type: "text", text: "beta-reply" }], model: "claude-haiku-4-5" })
    await s.oneShot("client-B-prompt", "claude-haiku-4-5", { recycle: true })

    const sent = JSON.stringify(lastRequestBody())
    expect(sent).not.toContain("SECRET-FROM-CLIENT-A")
    expect(sent).not.toContain("alpha-reply")
    expect(lastRequestBody().messages).toEqual([{ role: "user", content: "client-B-prompt" }])
    s.close()
  })

  test("close() drops history so a reaped entry cannot resurrect it", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ content: [{ type: "text", text: "r" }], model: "claude-haiku-4-5" })
    await s.oneShot("SECRET", "claude-haiku-4-5", { recycle: false })
    s.close()
    expect((s as unknown as { history: unknown[] }).history).toEqual([])
  })
})

describe("ApiSession — cancel", () => {
  test("cancelling a queued turn is queued-dropped and settles no-call", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ delayMs: 200, content: [{ type: "text", text: "r" }], model: "claude-haiku-4-5" })
    const first = s.oneShot("a", "claude-haiku-4-5", { recycle: true, tag: "t1" })
    const second = s.oneShot("b", "claude-haiku-4-5", { recycle: false, tag: "t2" })
    expect(s.cancel("t2")).toBe("queued-dropped")
    expect((await second).kind).toBe("no-call")
    await first
    s.close()
  })

  test("cancelling the in-flight turn is interrupted and settles call-consumed", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    respondWith({ delayMs: 5_000, content: [], model: "m" })
    const p = s.oneShot("a", "claude-haiku-4-5", { recycle: true, tag: "t1" })
    await Bun.sleep(20)
    expect(s.cancel("t1")).toBe("interrupted")
    expect((await p).kind).toBe("call-consumed")
    s.close()
  })

  test("cancelling an unknown tag is unknown and disturbs nothing", async () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    expect(s.cancel("nope")).toBe("unknown")
    s.close()
  })
})
