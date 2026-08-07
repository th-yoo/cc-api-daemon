// call.test.ts — the outcome-law suite for sendOne, run entirely against
// a LOCAL Bun.serve stub of POST /v1/messages. ZERO real API spend, ever.
//
// Determinism rule (enforced throughout): EVERY sendOne passes `env`
// explicitly with ANTHROPIC_BASE_URL pointed at the stub; the zero-hit
// cases additionally pin auth via env/authDeps so host keychain state can
// never leak in. Only the two poisoning tests touch process.env — and they
// set AND restore it in try/finally.
//
// Retargeted from daemonCall to sendOne (Task 5 of the api-sdk-swap plan):
// daemonCall/ensureDaemon/closeSession are deleted from call.ts (index.ts
// now points at the real acp-client.ts trio instead — see that file's own
// test/acp-client.test.ts). sendOne shares call.ts's ambient-env-leak
// guards and outcome law with the deleted daemonCall, so this coverage
// carries over rather than being lost; TurnOutcome has no sessionId field,
// so every sessionId-specific assertion from the old suite is dropped.
import { beforeEach, describe, expect, test } from "bun:test"
import { sendOne } from "../src/call.ts"
import { modelProvenBy } from "../src/acp-wire.ts"
import {
  STUB_URL, STUB_PORT, okBody, setRespond, getCaptured, resetStub,
  apiKeyEnv, oauthEnv, emptyHomeDeps, restoreEnvKey, ISO,
} from "./helpers.ts"

const DATED_MODEL = "claude-haiku-4-5-20251001"
const ALIAS_MODEL = "claude-haiku-4-5"

// No afterAll(stopStub()) here — the stub server is shared across test
// files now (see helpers.ts); stopping it from one file's afterAll breaks
// every other file that runs after it in bun:test's sequential file order.
beforeEach(() => {
  resetStub()
})

// ── 1. ok path ─────────────────────────────────────────────────────────────

describe("ok path", () => {
  test("success → kind ok, text, dated model on both fields, modelProvenBy", async () => {
    setRespond(() => okBody("hello", DATED_MODEL))
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.text).toBe("hello")
    expect(out.model).toBe(DATED_MODEL)
    expect(out.canonicalModel).toBe(DATED_MODEL)
    expect(modelProvenBy(out.model, ALIAS_MODEL, out.canonicalModel)).toBe(true)
  })

  // ── 2. multi-text-block: "" join + non-text filtering ──
  test("multi-block content → all text blocks concatenated with \"\", non-text filtered", async () => {
    setRespond(() =>
      Response.json({
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: DATED_MODEL,
        content: [
          { type: "text", text: "AB" },
          { type: "tool_use", id: "toolu_01", name: "noop", input: {} },
          { type: "text", text: "CD" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.text).toBe("ABCD")
  })
})

// ── 3. auth precedence + header shape ──────────────────────────────────────

describe("auth headers", () => {
  test("apiKey lane → x-api-key set, NO authorization header", async () => {
    await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(getCaptured().length).toBe(1)
    expect(getCaptured()[0]!.headers.get("x-api-key")).toBe("k")
    expect(getCaptured()[0]!.headers.get("authorization")).toBeNull()
  })

  test("OAuth lane → authorization Bearer, NO x-api-key, oauth beta header", async () => {
    await sendOne("hi", ALIAS_MODEL, oauthEnv(), { isolation: ISO })
    expect(getCaptured().length).toBe(1)
    expect(getCaptured()[0]!.headers.get("authorization")).toBe("Bearer t")
    expect(getCaptured()[0]!.headers.get("x-api-key")).toBeNull()
    expect(getCaptured()[0]!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
  })
})

// ── 4. no-auth → no-call, ZERO stub hits ───────────────────────────────────

describe("pre-auth no-call", () => {
  test("no credentials resolvable → no-call, zero requests (empty-home authDeps)", async () => {
    const out = await sendOne(
      "hi",
      ALIAS_MODEL,
      { ANTHROPIC_BASE_URL: STUB_URL },
      { isolation: ISO, authDeps: emptyHomeDeps() },
    )
    expect(out.kind).toBe("no-call")
    expect(getCaptured().length).toBe(0)
  })
})

// ── 5. AMBIENT-ENV LEAK REGRESSION (the plan's Critical) ───────────────────

describe("ambient process.env poisoning", () => {
  test("poisoned ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL cannot leak into an apiKey-lane call", async () => {
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN
    const savedBase = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_AUTH_TOKEN = "poison"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1"
    try {
      const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
      expect(out.kind).toBe("ok")
      expect(getCaptured().length).toBe(1)
      expect(getCaptured()[0]!.headers.get("x-api-key")).toBe("k")
      expect(getCaptured()[0]!.headers.get("authorization")).toBeNull()
      expect(new URL(getCaptured()[0]!.url).port).toBe(String(STUB_PORT))
      expect(new URL(getCaptured()[0]!.url).pathname).toBe("/v1/messages")
    } finally {
      restoreEnvKey("ANTHROPIC_AUTH_TOKEN", savedToken)
      restoreEnvKey("ANTHROPIC_BASE_URL", savedBase)
    }
  })

  test("poisoned ANTHROPIC_API_KEY cannot leak into an OAuth-lane call", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "poison"
    try {
      const out = await sendOne("hi", ALIAS_MODEL, oauthEnv(), { isolation: ISO })
      expect(out.kind).toBe("ok")
      expect(getCaptured().length).toBe(1)
      expect(getCaptured()[0]!.headers.get("x-api-key")).toBeNull()
      expect(getCaptured()[0]!.headers.get("authorization")).toBe("Bearer t")
    } finally {
      restoreEnvKey("ANTHROPIC_API_KEY", savedKey)
    }
  })
})

// ── 6. system param ────────────────────────────────────────────────────────

describe("system param", () => {
  test("systemPrompt \"\" → request body has NO system key", async () => {
    await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(getCaptured().length).toBe(1)
    expect("system" in getCaptured()[0]!.body).toBe(false)
  })

  test("non-empty systemPrompt → body.system carries it verbatim", async () => {
    await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: { ...ISO, systemPrompt: "be terse" },
    })
    expect(getCaptured().length).toBe(1)
    expect(getCaptured()[0]!.body.system).toBe("be terse")
  })
})

// ── 7. thinking enabled → no-call ──────────────────────────────────────────

describe("thinking", () => {
  test("thinking { type: \"enabled\" } → no-call, zero stub hits", async () => {
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: { ...ISO, thinking: { type: "enabled" } },
    })
    expect(out.kind).toBe("no-call")
    expect(getCaptured().length).toBe(0)
  })
})

// ── 8–11. call-consumed arms ───────────────────────────────────────────────

describe("call-consumed arms", () => {
  test("HTTP 500 → call-consumed, EXACTLY one request (maxRetries 0 pinned)", async () => {
    setRespond(() => new Response("boom", { status: 500 }))
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(out.kind).toBe("call-consumed")
    expect(getCaptured().length).toBe(1)
  })

  test("HTTP 401 → call-consumed (uniform post-create classification), exactly one request", async () => {
    setRespond(() =>
      Response.json({ type: "error", error: { type: "authentication_error", message: "nope" } }, { status: 401 }),
    )
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(out.kind).toBe("call-consumed")
    expect(getCaptured().length).toBe(1)
  })

  test("hanging server + small budgetMs → call-consumed (SDK timeout)", async () => {
    setRespond(() => new Promise<Response>(() => {}))
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: ISO,
      budgetMs: 1_500,
    })
    expect(out.kind).toBe("call-consumed")
  }, 10_000)

  test("empty content array → call-consumed", async () => {
    setRespond(() =>
      Response.json({
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: DATED_MODEL,
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(out.kind).toBe("call-consumed")
  })

  test("only empty-text blocks → call-consumed", async () => {
    setRespond(() => okBody(""))
    const out = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(out.kind).toBe("call-consumed")
  })
})

// ── 12. never-rejects ───────────────────────────────────────────────────────

describe("never rejects", () => {
  test("one representative of each arm resolves without throwing", async () => {
    // ok
    setRespond(() => okBody("ok"))
    const ok = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(ok.kind).toBe("ok")

    // pre-auth no-call
    const noAuth = await sendOne(
      "hi",
      ALIAS_MODEL,
      { ANTHROPIC_BASE_URL: STUB_URL },
      { isolation: ISO, authDeps: emptyHomeDeps() },
    )
    expect(noAuth.kind).toBe("no-call")

    // thinking no-call
    const thinking = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: { ...ISO, thinking: { type: "enabled" } },
    })
    expect(thinking.kind).toBe("no-call")

    // 500 call-consumed
    setRespond(() => new Response("boom", { status: 500 }))
    const failed = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO })
    expect(failed.kind).toBe("call-consumed")

    // hang call-consumed
    setRespond(() => new Promise<Response>(() => {}))
    const hung = await sendOne("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: ISO,
      budgetMs: 1_500,
    })
    expect(hung.kind).toBe("call-consumed")
  }, 15_000)
})

// ── 13. sendOne-specific: abort signal + caller-supplied history ───────────
// New surface daemonCall never had — added for ApiSession's cancel/FIFO.

describe("sendOne-specific", () => {
  test("an aborted request is call-consumed, never no-call", async () => {
    const ac = new AbortController()
    setRespond(() => new Promise<Response>(() => {}))
    const p = sendOne("x", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO, signal: ac.signal })
    ac.abort()
    expect((await p).kind).toBe("call-consumed")
  })

  test("a caller-supplied messages array is forwarded verbatim, not rebuilt from outgoingText", async () => {
    setRespond(() => okBody("ok"))
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
    ]
    await sendOne("second", ALIAS_MODEL, apiKeyEnv(), { isolation: ISO, messages })
    expect(getCaptured()[0]!.body.messages).toEqual(messages)
  })
})
