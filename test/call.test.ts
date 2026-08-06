// call.test.ts — the outcome-law suite for daemonCall, run entirely against
// a LOCAL Bun.serve stub of POST /v1/messages. ZERO real API spend, ever.
//
// Determinism rule (enforced throughout): EVERY daemonCall passes `env`
// explicitly with ANTHROPIC_BASE_URL pointed at the stub; the zero-hit
// cases additionally pin auth via env/authDeps so host keychain state can
// never leak in. Only the two poisoning tests touch process.env — and they
// set AND restore it in try/finally.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { daemonCall, ensureDaemon, closeSession } from "../src/call.ts"
import { modelProvenBy, type WarmIsolation, type DaemonOutcome } from "../src/types.ts"

// ── local isolation constant — caller-side policy, deliberately NOT in src/ ─

const TEST_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "cc-api-daemon-test",
  thinking: { type: "disabled" },
}

const DATED_MODEL = "claude-haiku-4-5-20251001"
const ALIAS_MODEL = "claude-haiku-4-5"

// ── stub server: one shared Bun.serve on port 0, per-test responder ────────

interface CapturedReq {
  headers: Headers
  body: Record<string, unknown>
  url: string
}

function okBody(text: string, model: string = DATED_MODEL): Response {
  return Response.json({
    id: "msg_x",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

let captured: CapturedReq[] = []
let respond: (c: CapturedReq) => Response | Promise<Response> = () => okBody("ok")

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const bodyText = await req.text()
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>
    } catch {
      // non-JSON probe — answer without capturing (not a model call)
      return new Response(null, { status: 200 })
    }
    const c: CapturedReq = { headers: req.headers, body, url: req.url }
    captured.push(c)
    return respond(c)
  },
})
const STUB_URL = `http://127.0.0.1:${server.port}`

beforeEach(() => {
  captured = []
  respond = () => okBody("ok")
})

afterAll(() => {
  // force: also kills the connection the hang test left in flight
  server.stop(true)
})

// ── helpers ────────────────────────────────────────────────────────────────

/** Empty temp HOME → the linux credentials-file lane deterministically fails
 * on ANY machine, regardless of real keychain / ~/.claude state. */
function emptyHomeDeps() {
  return {
    platform: "linux" as const,
    home: fs.mkdtempSync(path.join(os.tmpdir(), "cc-api-daemon-home-")),
  }
}

function apiKeyEnv() {
  return { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: STUB_URL }
}

function oauthEnv() {
  return { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: STUB_URL }
}

function restoreEnvKey(key: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[key]
  else process.env[key] = saved
}

function expectSessionId(out: DaemonOutcome): void {
  expect(typeof out.sessionId).toBe("string")
  expect(out.sessionId!.length).toBeGreaterThan(0)
}

// ── 1. ok path ─────────────────────────────────────────────────────────────

describe("ok path", () => {
  test("success → kind ok, text, dated model on both fields, sessionId, modelProvenBy", async () => {
    respond = () => okBody("hello", DATED_MODEL)
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.text).toBe("hello")
    expect(out.model).toBe(DATED_MODEL)
    expect(out.canonicalModel).toBe(DATED_MODEL)
    expectSessionId(out)
    expect(modelProvenBy(out.model, ALIAS_MODEL, out.canonicalModel)).toBe(true)
  })

  // ── 2. multi-text-block: "" join + non-text filtering ──
  test("multi-block content → all text blocks concatenated with \"\", non-text filtered", async () => {
    respond = () =>
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
      })
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.text).toBe("ABCD")
  })
})

// ── 3. auth precedence + header shape ──────────────────────────────────────

describe("auth headers", () => {
  test("apiKey lane → x-api-key set, NO authorization header", async () => {
    await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(captured.length).toBe(1)
    expect(captured[0]!.headers.get("x-api-key")).toBe("k")
    expect(captured[0]!.headers.get("authorization")).toBeNull()
  })

  test("OAuth lane → authorization Bearer, NO x-api-key, oauth beta header", async () => {
    await daemonCall("hi", ALIAS_MODEL, oauthEnv(), { isolation: TEST_ISOLATION })
    expect(captured.length).toBe(1)
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer t")
    expect(captured[0]!.headers.get("x-api-key")).toBeNull()
    expect(captured[0]!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
  })
})

// ── 4. no-auth → no-call, ZERO stub hits ───────────────────────────────────

describe("pre-auth no-call", () => {
  test("no credentials resolvable → no-call, zero requests (empty-home authDeps)", async () => {
    const out = await daemonCall(
      "hi",
      ALIAS_MODEL,
      { ANTHROPIC_BASE_URL: STUB_URL },
      { isolation: TEST_ISOLATION, authDeps: emptyHomeDeps() },
    )
    expect(out.kind).toBe("no-call")
    expectSessionId(out)
    expect(captured.length).toBe(0)
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
      const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
      expect(out.kind).toBe("ok")
      expect(captured.length).toBe(1)
      expect(captured[0]!.headers.get("x-api-key")).toBe("k")
      expect(captured[0]!.headers.get("authorization")).toBeNull()
      expect(new URL(captured[0]!.url).port).toBe(String(server.port))
      expect(new URL(captured[0]!.url).pathname).toBe("/v1/messages")
    } finally {
      restoreEnvKey("ANTHROPIC_AUTH_TOKEN", savedToken)
      restoreEnvKey("ANTHROPIC_BASE_URL", savedBase)
    }
  })

  test("poisoned ANTHROPIC_API_KEY cannot leak into an OAuth-lane call", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "poison"
    try {
      const out = await daemonCall("hi", ALIAS_MODEL, oauthEnv(), { isolation: TEST_ISOLATION })
      expect(out.kind).toBe("ok")
      expect(captured.length).toBe(1)
      expect(captured[0]!.headers.get("x-api-key")).toBeNull()
      expect(captured[0]!.headers.get("authorization")).toBe("Bearer t")
    } finally {
      restoreEnvKey("ANTHROPIC_API_KEY", savedKey)
    }
  })
})

// ── 6. system param ────────────────────────────────────────────────────────

describe("system param", () => {
  test("systemPrompt \"\" → request body has NO system key", async () => {
    await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(captured.length).toBe(1)
    expect("system" in captured[0]!.body).toBe(false)
  })

  test("non-empty systemPrompt → body.system carries it verbatim", async () => {
    await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: { ...TEST_ISOLATION, systemPrompt: "be terse" },
    })
    expect(captured.length).toBe(1)
    expect(captured[0]!.body.system).toBe("be terse")
  })
})

// ── 7. thinking enabled → no-call ──────────────────────────────────────────

describe("thinking", () => {
  test("thinking { type: \"enabled\" } → no-call, zero stub hits", async () => {
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: { ...TEST_ISOLATION, thinking: { type: "enabled" } },
    })
    expect(out.kind).toBe("no-call")
    expectSessionId(out)
    expect(captured.length).toBe(0)
  })
})

// ── 8–11. call-consumed arms ───────────────────────────────────────────────

describe("call-consumed arms", () => {
  test("HTTP 500 → call-consumed, EXACTLY one request (maxRetries 0 pinned)", async () => {
    respond = () => new Response("boom", { status: 500 })
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(out.kind).toBe("call-consumed")
    expect(captured.length).toBe(1)
  })

  test("HTTP 401 → call-consumed (uniform post-create classification), exactly one request", async () => {
    respond = () =>
      Response.json({ type: "error", error: { type: "authentication_error", message: "nope" } }, { status: 401 })
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(out.kind).toBe("call-consumed")
    expect(captured.length).toBe(1)
  })

  test("hanging server + small budgetMs → call-consumed (SDK timeout)", async () => {
    respond = () => new Promise<Response>(() => {})
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: TEST_ISOLATION,
      budgetMs: 1_500,
    })
    expect(out.kind).toBe("call-consumed")
  }, 10_000)

  test("empty content array → call-consumed", async () => {
    respond = () =>
      Response.json({
        id: "msg_x",
        type: "message",
        role: "assistant",
        model: DATED_MODEL,
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(out.kind).toBe("call-consumed")
  })

  test("only empty-text blocks → call-consumed", async () => {
    respond = () => okBody("")
    const out = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(out.kind).toBe("call-consumed")
  })
})

// ── 12. never-rejects + sessionId on every arm ─────────────────────────────

describe("never rejects, sessionId everywhere", () => {
  test("one representative of each arm resolves with a non-empty sessionId", async () => {
    // ok
    respond = () => okBody("ok")
    const ok = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(ok.kind).toBe("ok")
    expectSessionId(ok)

    // pre-auth no-call
    const noAuth = await daemonCall(
      "hi",
      ALIAS_MODEL,
      { ANTHROPIC_BASE_URL: STUB_URL },
      { isolation: TEST_ISOLATION, authDeps: emptyHomeDeps() },
    )
    expect(noAuth.kind).toBe("no-call")
    expectSessionId(noAuth)

    // thinking no-call
    const thinking = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: { ...TEST_ISOLATION, thinking: { type: "enabled" } },
    })
    expect(thinking.kind).toBe("no-call")
    expectSessionId(thinking)

    // 500 call-consumed
    respond = () => new Response("boom", { status: 500 })
    const failed = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), { isolation: TEST_ISOLATION })
    expect(failed.kind).toBe("call-consumed")
    expectSessionId(failed)

    // hang call-consumed
    respond = () => new Promise<Response>(() => {})
    const hung = await daemonCall("hi", ALIAS_MODEL, apiKeyEnv(), {
      isolation: TEST_ISOLATION,
      budgetMs: 1_500,
    })
    expect(hung.kind).toBe("call-consumed")
    expectSessionId(hung)
  }, 15_000)
})

// ── 13. ensureDaemon ───────────────────────────────────────────────────────

describe("ensureDaemon", () => {
  test("true with ANTHROPIC_API_KEY in env", async () => {
    await expect(ensureDaemon({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: STUB_URL })).resolves.toBe(true)
  })

  test("false with empty env + credential-less authDeps, no throw", async () => {
    await expect(
      ensureDaemon({ ANTHROPIC_BASE_URL: STUB_URL }, { authDeps: emptyHomeDeps() }),
    ).resolves.toBe(false)
  })
})

// ── 14. closeSession ───────────────────────────────────────────────────────

describe("closeSession", () => {
  test("stateless no-op → { closed: true }", async () => {
    await expect(closeSession("whatever", apiKeyEnv())).resolves.toEqual({ closed: true })
  })
})
