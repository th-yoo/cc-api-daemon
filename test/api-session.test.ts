// test/api-session.test.ts — sendOne (the leaf) and ApiSession (the FIFO
// session backend) over the shared local stub (helpers.ts). ZERO real API
// spend, ever.
import { beforeEach, describe, expect, test } from "bun:test"
import { sendOne } from "../src/call.ts"
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

describe("sendOne — the leaf", () => {
  test("sendOne returns ok with the model the API echoed", async () => {
    respondWith({ content: [{ type: "text", text: "hi" }], model: "claude-haiku-4-5-20251001" })
    const out = await sendOne("say hi", "claude-haiku-4-5", stubEnv(), { isolation: ISO })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.text).toBe("hi")
    expect(out.model).toBe("claude-haiku-4-5-20251001")
    expect(out.canonicalModel).toBe("claude-haiku-4-5-20251001")
  })

  test("an aborted request is call-consumed, never no-call", async () => {
    const ac = new AbortController()
    respondWith({ delayMs: 5_000, content: [], model: "m" })
    const p = sendOne("x", "claude-haiku-4-5", stubEnv(), { isolation: ISO, signal: ac.signal })
    ac.abort()
    expect((await p).kind).toBe("call-consumed")
  })

  test("sendOne forwards a caller-supplied messages array verbatim", async () => {
    respondWith({ content: [{ type: "text", text: "ok" }], model: "claude-haiku-4-5" })
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
    ]
    await sendOne("second", "claude-haiku-4-5", stubEnv(), { isolation: ISO, messages })
    expect(lastRequestBody().messages).toEqual(messages)
  })
})

// The other two tests the plan's 4b Step 1 shows here (close()-before-settle,
// turnInFlight-while-outstanding) both call s.oneShot(...), which does not
// exist until 4c — under TypeScript that is a compile error blocking the
// whole file, not a runtime failure the way the plan's "still fail" framing
// assumes. Moved to land with 4c instead, where oneShot is real.
describe("ApiSession — lifecycle", () => {
  test("a fresh session is not in flight and closes idempotently", () => {
    const s = new ApiSession(stubEnv(), warmOpts())
    expect(s.turnInFlight()).toBe(false)
    s.close()
    s.close()
    expect(s.turnInFlight()).toBe(false)
  })
})
