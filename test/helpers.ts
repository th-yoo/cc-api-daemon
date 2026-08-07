// helpers.ts — shared stub-server test harness (Task 4a of the api-sdk-swap
// plan). Extracted from call.test.ts's own inline Bun.serve block so
// api-session.test.ts can drive the SAME local stub without opening a
// second server. ZERO real API spend, ever — every caller must point
// ANTHROPIC_BASE_URL at STUB_URL (stubEnv()/apiKeyEnv() do this).
//
// Two API layers on the same underlying stub:
//  - low-level (setRespond/getCaptured/okBody/apiKeyEnv/oauthEnv): the
//    exact primitives call.test.ts already used inline, kept intact so its
//    existing assertions don't change shape, only their imports.
//  - declarative (respondWith/lastRequestBody/ISO/stubEnv): the shape
//    api-session.test.ts's plan-authored snippets expect.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { WarmIsolation } from "../src/acp-wire.ts"

/** Task 7 gate-split flag. ONE exported constant, read here and nowhere
 * else — three separate `process.env.KKAMAK_GATE_FAST` reads across three
 * test files is three chances to drift, and a drifted copy silently
 * under-tests (the exact failure shape CLAUDE.md rule 4 warns about,
 * though this is a different thing: an explicit, checked-in performance
 * flag, not a host-credential gate — see CLAUDE.md's "Credential safety"
 * section for the distinction). OPT-OUT polarity: unset (bare `bun test`)
 * runs everything; only `KKAMAK_GATE_FAST=1`, set in gate.json's own
 * `check` string, skips the slow (real `claude` CLI subprocess spawn)
 * blocks. `describe.skipIf` reports a skip count visibly in bun:test's own
 * output — never a silent absence. */
export const GATE_FAST = process.env.KKAMAK_GATE_FAST === "1"

export interface CapturedReq {
  headers: Headers
  body: Record<string, unknown>
  url: string
}

export function okBody(text: string, model: string = "claude-haiku-4-5-20251001"): Response {
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

export const STUB_URL = `http://127.0.0.1:${server.port}`
export const STUB_PORT = server.port

export function setRespond(fn: (c: CapturedReq) => Response | Promise<Response>): void {
  respond = fn
}

export function getCaptured(): CapturedReq[] {
  return captured
}

/** Call from each test file's own `beforeEach` — every file shares the one
 * server, so each must reset state it doesn't own the lifetime of. */
export function resetStub(): void {
  captured = []
  respond = () => okBody("ok")
}

/** Deliberately NOT called from any test file's `afterAll`. This server is
 * now shared across multiple test files (call.test.ts, api-session.test.ts)
 * that each run to completion independently — bun:test runs files
 * sequentially in discovery order (alphabetical here), so whichever file's
 * `afterAll` stopped it first would kill the server for every file that
 * runs after it (observed: api-session.test.ts sorts before call.test.ts
 * and stopping there broke every later call.test.ts request). The server
 * lives for the whole `bun test` process; the OS reclaims the ephemeral
 * port on exit, same as it always did for a file-scoped server. */
export function stopStub(): void {
  server.stop(true)
}

export function apiKeyEnv(): Record<string, string> {
  return { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: STUB_URL }
}

export function oauthEnv(): Record<string, string> {
  return { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: STUB_URL }
}

/** Task 4's own name for apiKeyEnv() — api-session.test.ts's plan snippets
 * call this stubEnv(). Same shape; kept both names rather than renaming
 * apiKeyEnv() and touching every existing call.test.ts call site for no
 * functional gain. */
export function stubEnv(): Record<string, string> {
  return apiKeyEnv()
}

/** Empty temp HOME → the linux credentials-file lane deterministically
 * fails on ANY machine, regardless of real keychain / ~/.claude state. */
export function emptyHomeDeps() {
  return {
    platform: "linux" as const,
    home: fs.mkdtempSync(path.join(os.tmpdir(), "cc-api-daemon-home-")),
  }
}

export function restoreEnvKey(key: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[key]
  else process.env[key] = saved
}

export const ISO: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "cc-api-daemon-test",
  thinking: { type: "disabled" },
}

export function lastRequestBody(): Record<string, unknown> {
  const last = captured[captured.length - 1]
  if (!last) throw new Error("lastRequestBody(): no request has been captured yet")
  return last.body
}

/** Declarative responder for ApiSession-shaped tests. `delayMs` is a REAL
 * delay (setTimeout), not a permanent hang — pair a long delayMs with a
 * short client-side budget/abort to simulate a hang; a short delayMs
 * resolves normally, letting turnInFlight-style tests observe the
 * in-between state. `onRequest` fires once per request, before the delay,
 * so ordering assertions (FIFO tests) see requests as they arrive. */
export interface RespondSpec {
  content?: Array<Record<string, unknown>>
  model?: string
  delayMs?: number
  status?: number
  onRequest?: (body: Record<string, unknown>) => void
}

export function respondWith(spec: RespondSpec): void {
  respond = async (c) => {
    spec.onRequest?.(c.body)
    if (spec.delayMs !== undefined) await new Promise<void>((r) => setTimeout(r, spec.delayMs))
    if (spec.status !== undefined) return new Response("stub error", { status: spec.status })
    return Response.json({
      id: "msg_x",
      type: "message",
      role: "assistant",
      model: spec.model ?? "claude-haiku-4-5",
      content: spec.content ?? [],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }
}
