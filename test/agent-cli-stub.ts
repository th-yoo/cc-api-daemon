// Shared CLI-spawning stub helpers for warm-session.test.ts. Ported from
// meta-harness cc-gate-plugin's test/agent-cli-stub.ts (read-only source),
// REDUCED to what this repo's WarmSession tests actually use (sseText,
// hangFirstServer, until) and made hermetic: the upstream file gated its
// CLI-spawning describe blocks on `HAS_CLAUDE_CODE_CREDENTIALS` (on-disk
// keychain / credentials-file presence), which is exactly the pattern this
// repo's CLAUDE.md forbids ("Never gate a test on host credential presence
// again") — it hides a real dependency instead of removing it. Removed
// entirely; see warmHermeticEnv() below for what replaces it.
import { stubServer } from "./sdk-stub.ts"

// Wire-capture finding (meta-harness, 2026-08-03): the CLI process the
// Agent SDK spawns ALWAYS sends `stream: true` on /v1/messages — a stub
// that answers with a plain, non-streaming `Response.json(...)` body fails
// Bun's SSE parsing inside the spawned CLI. The fix is an SSE-shaped
// response.
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
 * takes ~1.25-1.46s to get there. */
export async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pred()
}

/** Hermetic env for a WarmSession that spawns the real bundled CLI against
 * a LOCAL stub — CLAUDE.md credential-safety rule 3: spread `process.env`
 * (the subprocess needs PATH/HOME/TMPDIR to boot at all) then override the
 * credential fields AFTER, never rely on ANTHROPIC_BASE_URL redirection
 * alone. `ANTHROPIC_AUTH_TOKEN` is explicitly unset (not omitted) so a real
 * OAuth token on the host env never reaches the subprocess — WarmSession's
 * own `ensure()` filters out `undefined` values before building the child
 * env, so this key never reaches the spawn. Verified empirically: the
 * spawned CLI honors an explicit ANTHROPIC_API_KEY over on-disk/keychain
 * credentials, so no on-disk credential is ever required to run these
 * tests — `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds
 * bun test` passes identically to a run on a credentialed host. */
export function warmHermeticEnv(baseUrl: string): Record<string, string | undefined> {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: "hermetic-test-key",
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: baseUrl,
  }
}
