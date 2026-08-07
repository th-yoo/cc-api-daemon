// models.test.ts — the outcome suite for listModels/retrieveModel, run
// entirely against a LOCAL Bun.serve stub of GET /v1/models[/:id]. ZERO real
// API spend, ever. Mirrors call.test.ts's stub-server pattern; the ambient
// process.env poisoning tests are the most important cases here — this is a
// new call site for a guard that previously had exactly one.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { listModels, retrieveModel } from "../src/models.ts"

// ── fixtures ─────────────────────────────────────────────────────────────

const MODEL_A = {
  type: "model" as const,
  id: "claude-haiku-4-5-20251001",
  display_name: "Claude Haiku 4.5",
  created_at: "2025-10-01T00:00:00Z",
  max_input_tokens: 200_000,
  max_tokens: 64_000,
  capabilities: null,
}

const MODEL_B = {
  type: "model" as const,
  id: "claude-opus-5",
  display_name: "Claude Opus 5",
  created_at: "2026-01-01T00:00:00Z",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: null,
}

// ── stub server: one shared Bun.serve on port 0, per-test responder ────────

interface CapturedReq {
  headers: Headers
  url: string
  method: string
}

function pageBody(data: Array<typeof MODEL_A>, hasMore: boolean, lastId: string | null): Response {
  return Response.json({ data, has_more: hasMore, first_id: data[0]?.id ?? null, last_id: lastId })
}

function notFoundBody(): Response {
  return Response.json({ type: "error", error: { type: "not_found_error", message: "model not found" } }, { status: 404 })
}

let captured: CapturedReq[] = []
let respond: (c: CapturedReq) => Response | Promise<Response> = () => pageBody([MODEL_A], false, null)

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const c: CapturedReq = { headers: req.headers, url: req.url, method: req.method }
    captured.push(c)
    return respond(c)
  },
})
const STUB_URL = `http://127.0.0.1:${server.port}`

beforeEach(() => {
  captured = []
  respond = () => pageBody([MODEL_A], false, null)
})

afterAll(() => {
  server.stop(true)
})

// ── helpers ────────────────────────────────────────────────────────────────

/** Empty temp HOME → the linux credentials-file lane deterministically fails
 * on ANY machine, regardless of real keychain / ~/.claude state. */
function emptyHomeDeps() {
  return {
    platform: "linux" as const,
    home: fs.mkdtempSync(path.join(os.tmpdir(), "cc-api-daemon-models-home-")),
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

// ── 1–2. listModels ok + pagination ────────────────────────────────────────

describe("listModels ok", () => {
  test("single page → models array matches stub data", async () => {
    respond = () => pageBody([MODEL_A, MODEL_B], false, null)
    const out = await listModels(apiKeyEnv())
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.models).toEqual([MODEL_A, MODEL_B])
  })

  test("two pages (has_more + after_id cursor) → both pages flattened, exactly 2 requests", async () => {
    respond = (c) => {
      const url = new URL(c.url)
      if (url.searchParams.get("after_id") === MODEL_A.id) return pageBody([MODEL_B], false, null)
      return pageBody([MODEL_A], true, MODEL_A.id)
    }
    const out = await listModels(apiKeyEnv())
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.models).toEqual([MODEL_A, MODEL_B])
    expect(captured.length).toBe(2)
    expect(new URL(captured[1]!.url).searchParams.get("after_id")).toBe(MODEL_A.id)
  })
})

// ── 3, 7. no-auth → ZERO stub hits ──────────────────────────────────────────

describe("no-auth", () => {
  test("listModels: no credentials resolvable → no-auth, zero requests", async () => {
    const out = await listModels({ ANTHROPIC_BASE_URL: STUB_URL }, { authDeps: emptyHomeDeps() })
    expect(out.kind).toBe("no-auth")
    expect(captured.length).toBe(0)
  })

  test("retrieveModel: no credentials resolvable → no-auth, zero requests", async () => {
    const out = await retrieveModel(MODEL_A.id, { ANTHROPIC_BASE_URL: STUB_URL }, { authDeps: emptyHomeDeps() })
    expect(out.kind).toBe("no-auth")
    expect(captured.length).toBe(0)
  })
})

// ── 4. listModels HTTP error ────────────────────────────────────────────────

describe("listModels error", () => {
  test("HTTP 500 → error, exactly one request (maxRetries 0 pinned)", async () => {
    respond = () => new Response("boom", { status: 500 })
    const out = await listModels(apiKeyEnv())
    expect(out.kind).toBe("error")
    if (out.kind !== "error") throw new Error("unreachable")
    expect(out.status).toBe(500)
    expect(captured.length).toBe(1)
  })
})

// ── 5, 6, 12. retrieveModel ok / not-found / generic error ─────────────────

describe("retrieveModel", () => {
  test("ok → model matches stub data", async () => {
    respond = () => Response.json(MODEL_B)
    const out = await retrieveModel(MODEL_B.id, apiKeyEnv())
    expect(out.kind).toBe("ok")
    if (out.kind !== "ok") throw new Error("unreachable")
    expect(out.model).toEqual(MODEL_B)
  })

  test("HTTP 404 → not-found, distinct from generic error", async () => {
    respond = () => notFoundBody()
    const out = await retrieveModel("does-not-exist", apiKeyEnv())
    expect(out.kind).toBe("not-found")
  })

  test("HTTP 500 (non-404) → generic error, not not-found", async () => {
    respond = () => new Response("boom", { status: 500 })
    const out = await retrieveModel(MODEL_A.id, apiKeyEnv())
    expect(out.kind).toBe("error")
    if (out.kind !== "error") throw new Error("unreachable")
    expect(out.status).toBe(500)
  })

  test("empty/malformed modelId never throws", async () => {
    respond = () => notFoundBody()
    const out = await retrieveModel("", apiKeyEnv())
    expect(["ok", "no-auth", "not-found", "error"]).toContain(out.kind)
  })
})

// ── 8. AMBIENT-ENV LEAK REGRESSION — new call site for a previously-single-site guard ──

describe("ambient process.env poisoning", () => {
  test("poisoned ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL cannot leak into an apiKey-lane listModels call", async () => {
    const savedToken = process.env.ANTHROPIC_AUTH_TOKEN
    const savedBase = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_AUTH_TOKEN = "poison"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1"
    try {
      const out = await listModels(apiKeyEnv())
      expect(out.kind).toBe("ok")
      expect(captured.length).toBe(1)
      expect(captured[0]!.headers.get("x-api-key")).toBe("k")
      expect(captured[0]!.headers.get("authorization")).toBeNull()
      expect(new URL(captured[0]!.url).port).toBe(String(server.port))
    } finally {
      restoreEnvKey("ANTHROPIC_AUTH_TOKEN", savedToken)
      restoreEnvKey("ANTHROPIC_BASE_URL", savedBase)
    }
  })

  test("poisoned ANTHROPIC_API_KEY cannot leak into an OAuth-lane retrieveModel call", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "poison"
    try {
      respond = () => Response.json(MODEL_A)
      const out = await retrieveModel(MODEL_A.id, oauthEnv())
      expect(out.kind).toBe("ok")
      expect(captured.length).toBe(1)
      expect(captured[0]!.headers.get("x-api-key")).toBeNull()
      expect(captured[0]!.headers.get("authorization")).toBe("Bearer t")
    } finally {
      restoreEnvKey("ANTHROPIC_API_KEY", savedKey)
    }
  })
})

// ── 9. auth header shape ────────────────────────────────────────────────────

describe("auth headers", () => {
  test("apiKey lane → x-api-key set, NO authorization header", async () => {
    await listModels(apiKeyEnv())
    expect(captured.length).toBe(1)
    expect(captured[0]!.headers.get("x-api-key")).toBe("k")
    expect(captured[0]!.headers.get("authorization")).toBeNull()
  })

  test("OAuth lane → authorization Bearer, NO x-api-key, oauth beta header", async () => {
    await listModels(oauthEnv())
    expect(captured.length).toBe(1)
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer t")
    expect(captured[0]!.headers.get("x-api-key")).toBeNull()
    expect(captured[0]!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
  })
})

// ── 10. never-rejects ────────────────────────────────────────────────────────

describe("never rejects", () => {
  test("one representative of each outcome kind resolves without throwing", async () => {
    respond = () => pageBody([MODEL_A], false, null)
    await expect(listModels(apiKeyEnv())).resolves.toHaveProperty("kind", "ok")

    await expect(
      listModels({ ANTHROPIC_BASE_URL: STUB_URL }, { authDeps: emptyHomeDeps() }),
    ).resolves.toHaveProperty("kind", "no-auth")

    respond = () => new Response("boom", { status: 500 })
    await expect(listModels(apiKeyEnv())).resolves.toHaveProperty("kind", "error")

    respond = () => notFoundBody()
    await expect(retrieveModel("nope", apiKeyEnv())).resolves.toHaveProperty("kind", "not-found")
  })
})

// ── 11. hang/timeout ─────────────────────────────────────────────────────────

describe("hang/timeout", () => {
  test("listModels: hanging server + small budgetMs → error (SDK timeout)", async () => {
    respond = () => new Promise<Response>(() => {})
    const out = await listModels(apiKeyEnv(), { budgetMs: 1_500 })
    expect(out.kind).toBe("error")
  }, 10_000)

  test("retrieveModel: hanging server + small budgetMs → error (SDK timeout)", async () => {
    respond = () => new Promise<Response>(() => {})
    const out = await retrieveModel(MODEL_A.id, apiKeyEnv(), { budgetMs: 1_500 })
    expect(out.kind).toBe("error")
  }, 10_000)
})
