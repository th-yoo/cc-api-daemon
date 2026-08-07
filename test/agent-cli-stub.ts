// Shared CLI-spawning stub helpers for gauge agent-sdk-transport tests.
// Extracted from gauge-agent-transport.test.ts (Task 4 Step 0, DECLARED
// EXCEPTION #4) so later test files (warm-session.test.ts, acp-wire.test.ts,
// etc.) can reuse them without duplicating the credentials probe or the
// SSE-shaped stub. NOT matched by bun's test glob — same as sdk-stub.ts.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { stubServer } from "./sdk-stub.ts"

// Fix-wave finding 4: every test that spawns the REAL bundled Claude Code CLI
// (anything that calls agentSdkCall, directly or via deriveRecord's agent-sdk
// route) needs on-disk Claude Code credentials for that spawned CLI to
// authenticate with — this repo travels across hosts (WSL2 box, MacBook, CI)
// and a host with no credentials must SKIP those tests loudly rather than
// FAIL them (bun test gates merges; a credential-less host failing here is
// not a real regression). Same credential source transport.ts's
// `readAuthToken` checks (darwin keychain / linux ~/.claude/.credentials.json)
// — this is a presence probe only, never reads or logs the token itself.
function hasClaudeCodeCredentials(): boolean {
  try {
    if (process.platform === "darwin") {
      execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf-8",
        timeout: 5000,
      })
      return true
    }
    return fs.existsSync(path.join(os.homedir(), ".claude", ".credentials.json"))
  } catch {
    return false
  }
}

export const HAS_CLAUDE_CODE_CREDENTIALS = hasClaudeCodeCredentials()
export const NO_CREDENTIALS_SKIP_REASON =
  "no on-disk Claude Code credentials found (~/.claude/.credentials.json / macOS keychain) — " +
  "CLI-spawning agentSdkCall tests require a credentialed host to authenticate the spawned CLI. " +
  "The measurement host (a host WITH credentials present) MUST still run these, not skip them."
if (!HAS_CLAUDE_CODE_CREDENTIALS) {
  console.warn(`SKIPPING CLI-spawning gauge-agent-transport tests: ${NO_CREDENTIALS_SKIP_REASON}`)
}

// Wire-capture finding (2026-08-03): the CLI process the Agent SDK spawns
// ALWAYS sends `stream: true` on /v1/messages — this is not toggled by any
// `Options` field (checked sdk.d.ts; no such option exists). A stub that
// answers with `Response.json(...)` (a plain, non-streaming body — the shape
// `sdkCall`'s stub in this same file's earlier tests correctly uses for the
// non-agent-sdk transport, since @anthropic-ai/sdk's `messages.create`
// defaults to non-streaming) fails Bun's `fetch()`-based SSE parsing inside
// the spawned CLI, which then silently FALLS BACK to a second, non-streaming
// request. That fallback is what first measured 2+ calls here — it is a test
// double defect, not a real extra model call: against the real Anthropic API
// (which always answers a `stream:true` request with a valid SSE body) the
// fallback path is never exercised. The fix is an SSE-shaped response, not a
// loosened assertion. Confirmed by wire capture: the CLI also separately
// issues a `HEAD /api/hello` connectivity probe before the real call; the
// shared `stubServer` helper's `body: (await req.json())` throws on that
// bodiless HEAD (visible as a benign "HEAD - /api/hello failed" stderr line)
// but the throw happens before `captured.push`, so it never reaches our
// `handler` callback and does not inflate CAPTURED.
//
// Fix round 3 (2026-08-03): `agentSdkCall` no longer sends `outputFormat`,
// so the CLI no longer forces a `StructuredOutput` tool — the model just
// emits plain text (our schema requirement now rides in the prompt text
// instead, and `parseRefinerOutput`/`parseChannelOutput` tolerate it). The
// stub therefore answers with a plain TEXT SSE stream, not a `tool_use`
// block — replaces the old `sseStructuredOutput` helper.
//
// `model` (Task 4 Step 0 addition): optional trailing parameter, defaulting
// to the incumbent literal, so a test can make the stub declare a DATED
// snapshot id in `message_start` and drive the CLI to key `modelUsage` by
// it (round-4 C1). Every pre-existing call site is byte-unchanged by this
// addition.
export function sseText(text: string, model = "claude-haiku-4-5"): Response {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

// Coordinator fix-round-1 finding (2026-08-03): spawning the bundled CLI
// takes long enough that a test whose earlier attempt was killed by bun:
// test's 5s default per-test timeout can still have its subprocess request
// land AFTER the timeout, mid-flight into whatever test runs next — a
// shared module-level `stub`/`CAPTURED` pair lets that stale arrival corrupt
// an unrelated test's count. Fix is structural, not just a longer timeout:
// every test that spawns the CLI gets its OWN `stubServer` instance created
// and stopped inside the test body, so a late arrival from a prior test's
// abandoned subprocess has no live capture array left to land in.
export function withCaptureStub() {
  const CAPTURED: Array<Record<string, unknown>> = []
  // sdk-stub.ts's Captured.body is ALREADY `Record<string, unknown>` (it
  // does `await req.json()`), and the stub exposes `stop`, not `close`. Do
  // not re-parse or re-cast it.
  const stub = stubServer((captured) => {
    CAPTURED.push(captured.body)
    // Fix round 3: no forced tool anymore — plain text carrying the JSON
    // our schema instruction (appended to the prompt by `agentSdkCall`)
    // asked for.
    return sseText('{"channel":"C4"}')
  })
  // The spawned CLI reads ANTHROPIC_BASE_URL from its own environment. The
  // stub binds port: 0, so the port is only known at runtime; `stub.url`
  // exposes it.
  //
  // Auth note (verified empirically, not assumed): agentSdkCall does not
  // pass an authToken — the spawned CLI resolves its own credentials from
  // ~/.claude/.credentials.json (confirmed by wire capture: the captured
  // `authorization` header carries this host's real oauth token). That
  // means these tests are hermetic against making a real MODEL call (every
  // request is intercepted by ANTHROPIC_BASE_URL pointing at the local
  // stub) but are NOT hermetic against needing live on-disk Claude Code
  // credentials to reach that point at all — a host with no
  // `~/.claude/.credentials.json` and no keychain entry will see
  // CAPTURED.length stay 0 (the CLI refuses before sending), not a passing
  // test.
  const env = { ...process.env, ANTHROPIC_BASE_URL: stub.url }
  return { CAPTURED, stub, env }
}

/** A server that accepts the connection and never answers. `stubServer`'s
 * handler type is `(c: Captured) => Response` — synchronous — so a hanging
 * stub cannot be expressed through it without widening a shared helper.
 * Raw Bun.serve is the established precedent (gauge-agent-transport.test.ts,
 * "timeout aborts and resolves undefined" test's `silent` server). */
export function silentServer(): { url: string; stop: () => void } {
  const s = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) }
}

/** A server whose FIRST request hangs forever and whose later requests are
 * answered normally — the shape the turn-timeout tests need. */
export function hangFirstServer(text: string, model = "claude-haiku-4-5"): { url: string; stop: () => void; count: () => number } {
  let n = 0
  const s = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.text()
      if (!body) return new Response(null, { status: 200 })   // HEAD /api/hello probe
      n++
      if (n === 1) return new Promise<Response>(() => {})
      return sseText(text, model)
    },
  })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true), count: () => n }
}

/** Poll `pred` until true or `ms` elapses; returns pred()'s final value.
 * REQUIRED by the cancel/close tests: "the turn has been SENT" is only
 * observable as "the stub received the request", and the CLI subprocess
 * takes 1.25-1.46 s to get there. A test that cancels or closes before
 * that point is testing a different branch than it claims to
 * (round-4 C3/I11). */
export async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pred()
}
