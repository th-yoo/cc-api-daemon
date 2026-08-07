// test/api-session.test.ts — sendOne (the leaf) and ApiSession (the FIFO
// session backend) over the shared local stub (helpers.ts). ZERO real API
// spend, ever.
import { beforeEach, describe, expect, test } from "bun:test"
import { sendOne } from "../src/call.ts"
import { ISO, stubEnv, respondWith, resetStub, lastRequestBody } from "./helpers.ts"

// No afterAll(stopStub()) here — see helpers.ts: the stub server is shared
// across test files, and stopping it from one file's afterAll breaks every
// other file that runs after it in bun:test's sequential file order.
beforeEach(() => {
  resetStub()
})

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
