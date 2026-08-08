// test/acp-daemon.test.ts — N3a: the ACP daemon (socket server, dispatcher,
// idle self-exit) over the REAL daemon process, driven as a child.
//
// Delta-memo governs over task-5-brief.md prose where they conflict:
//  · _meta is namespaced under `kkamak` (T2n) — every custom field here is
//    `_meta.kkamak.*`, never a bare `_meta.model`.
//  · the dated-model-key assumption in the plan text is dead on this driving
//    path (T4·1a probe) — STUB_DECLARED_MODEL / HAIKU_OBSERVED_KEY below
//    mirror warm-session.test.ts's split constants, never a local
//    `HAIKU_DATED` literal.
//  · acp-paths.ts is already built; this file imports it, never
//    re-implements it.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { sseText, until } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"
import { GATE_FAST } from "./helpers.ts"

/** Plain JSON, not sseText(): api-session.ts's sendOne calls the real
 * @anthropic-ai/sdk's messages.create WITHOUT stream:true (non-streaming
 * default) — sseText() matched the OLD agent-SDK-CLI transport, which
 * always sent stream:true. Used by the ApiSession-backed daemon suite
 * (Task 6) below; the earlier "no model reached" suite's sseText() calls
 * are untouched — their stubs are never actually parsed (SHOULD-NEVER-BE-
 * CALLED / cancelled-before-dispatch), so the shape never mattered there. */
function okBody(text: string, model: string): Response {
  return Response.json({
    id: "msg_stub", type: "message", role: "assistant", model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** ApiSession-lane analogue of agent-cli-stub.ts's `hangFirstServer`: same
 * "first request hangs forever, later ones answer" shape, but answering
 * with `okBody` (plain JSON), not `sseText` (SSE) — the warm-session merge
 * (api-sdk merge brief Task 2) repurposed agent-cli-stub.ts's own
 * `hangFirstServer` back to its ORIGINAL SSE shape (it now backs
 * WarmSession's real CLI-subprocess tests, which do need SSE), so a
 * shared name serving two backends with two different wire shapes would be
 * a landmine — this daemon's own ApiSession-backed tests get their own
 * copy instead, local to this file, same as `okBody` already is. */
function hangFirstServer(text: string, model: string): { url: string; stop: () => void; count: () => number } {
  let n = 0
  const s = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.text()
      if (!body) return new Response(null, { status: 200 })   // HEAD /api/hello probe
      n++
      if (n === 1) return new Promise<Response>(() => {})
      return okBody(text, model)
    },
  })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true), count: () => n }
}
import {
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED, AUTH_RESOLVE_BUDGET_MS,
  type WarmIsolation,
} from "../src/acp-wire.ts"
import { envFingerprint, readDiscovery, writeDiscovery, wsUrl } from "../src/acp-paths.ts"
import { createDaemonState, createDispatcher } from "../src/acp-daemon.ts"
import { SessionPool, type WarmSessionLike, type WarmConstructOpts } from "../src/acp-pool.ts"
import type { TurnOutcome, CancelResult, DispatchableSession } from "../src/session-contract.ts"

// Replaces the gauge's own TEST_ISOLATION/TEST_ISOLATION_2 constants,
// which were caller-side and this general ACP package no longer ships
// (Task 1 Step 2). Arbitrary but distinct content — only the distinctness
// (used by isolation-segregation assertions) and shape matter here.
const TEST_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "acp-daemon-test-a",
  thinking: { type: "disabled" },
}

const TEST_ISOLATION_2: WarmIsolation = {
  systemPrompt: "reason carefully",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "acp-daemon-test-b",
  thinking: { type: "disabled" },
}

// N3c-iii: session/new now REQUIRES `_meta.kkamak.isolation` (a session
// mapped to no isolation cannot be recorded, and session/prompt then has
// nothing to key `pool.acquire()` on). A second, distinct isolation
// (distinct systemPrompt marker) proves isolation segregation ON THE WIRE
// for test 1, never inferred.
const MARKER_ISOLATION: WarmIsolation = {
  ...TEST_ISOLATION,
  systemPrompt: "REASONING-MARKER-SYSTEM-PROMPT",
  title: "kkamak-test-marker",
}

const DAEMON_TEST_TIMEOUT_MS = 60_000
const HAIKU = "claude-haiku-4-5"
// api-sdk merge brief HAZARD 3: routeBackend sends *haiku* to the api lane
// (per-session ApiSession, never pooled) and everything else to the agent
// lane (SessionPool). Tests below that exercise POOL mechanics specifically
// (entry sharing/segregation, recycle-on-reuse, pool exhaustion, dispatch
// races) use this constant instead of HAIKU, so they keep exercising the
// pool regardless of which backend SessionPool defaults to — Task 5 flips
// that default from ApiSession to WarmSession, and these tests' local JSON
// stub fixtures (okBody/stubServer) will need converting to the CLI lane's
// SSE shape at that point (see this repo's own status report for the note).
const AGENT_TEST_MODEL = "claude-sonnet-5"
// STUB_DECLARED_MODEL is what the stub puts in its response body's `model`
// field. Reality-check (Task 6): the original T4·1a split here assumed
// modelUsage is keyed by the client-requested ALIAS regardless of what the
// server declared — a quirk specific to the OLD agent-SDK-CLI transport's
// own modelUsage map. On this backend, sendOne (api-session.ts) returns
// `response.model` verbatim from the raw API response — the daemon forwards
// whatever the stub actually declared. So `_meta.kkamak.model` assertions
// use STUB_DECLARED_MODEL directly now; HAIKU_OBSERVED_KEY is unused
// (kept, not deleted, in case a future test needs the undated alias itself
// rather than what a stub echoes).
const STUB_DECLARED_MODEL = "claude-haiku-4-5-20251001"
const HAIKU_OBSERVED_KEY = HAIKU

/** Every test builds its OWN throwaway HOME dir under tmpdir. Discovery
 * files, both spawn/bind locks, and the daemon's spawn-log all live under
 * it (acp-paths.ts's discoveryPath consults `env.HOME` explicitly, ahead
 * of the real host's `os.homedir()`, for exactly this isolation seam) — so
 * NO TEST EVER TOUCHES the real host's `~/.config/acpd/`, without an
 * afterEach hygiene assertion needing to check for it: killDaemon below
 * just removes the whole throwaway HOME. */
function tempEndpoint(tag: string) {
  const home = fs.mkdtempSync(path.join(tmpdir(), `d-${tag}-`))
  return { home, spawnLog: path.join(home, "spawnlog") }
}

/** Spawn the REAL daemon as a detached child.
 *
 * `env` is passed EXPLICITLY and is the SAME object the caller fingerprints
 * (round-4 I2): the daemon computes envFingerprint(process.env) and
 * discoveryPath(process.env) from what it inherits, so a spawner that
 * fingerprints one env and launches with another gets a daemon publishing a
 * different discovery file echoing a different fingerprint — mutual
 * refusal forever.
 *
 * ACP_IDLE_MS (still set here under its legacy spelling, KKAMAK_ACP_IDLE_MS —
 * see buildDaemonEnv below) is ALWAYS set to a few seconds here (round-4 M8):
 * the production default is 900 000 ms, and a test daemon that survives an
 * afterEach failure would sit on the host for fifteen minutes. */
/** Extracted so a test can compute the EXACT env a daemon will be spawned
 * with BEFORE actually spawning it — needed to seed a stale discovery
 * entry at the right fingerprint-derived path ahead of time (the
 * stale-takeover test below), and to avoid the `readDiscovery({HOME:
 * home})` bug this file's own history already caught once: a minimal
 * {HOME} object and the real ~40-key spawned env compute DIFFERENT
 * envFingerprints, hence different discovery paths. */
function buildDaemonEnv(home: string, spawnLog: string, extra: Record<string, string> = {}, idleMs = "8000"): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    // CI reality-check (Task 6 was never credential-FREE, only
    // credential-DEPENDENT with the dependency hidden behind
    // HAS_CLAUDE_CODE_CREDENTIALS -- dropping that gate exposed it instead
    // of removing it). Every reenabled test below that reaches ApiSession's
    // send boundary resolves auth from THIS spawned daemon's env
    // (auth.ts's ANTHROPIC_API_KEY lane, checked first) -- on a dev host
    // with real ambient credentials that ladder silently succeeds even
    // though ANTHROPIC_BASE_URL is redirected to the local stub; on a
    // credential-less host (a fresh CI runner) it fails closed, no-call.
    // A fixed fake key here, spread BEFORE `...extra`, makes auth
    // resolution deterministic regardless of host credential state --
    // `...extra` still wins if a future test needs a different value.
    ANTHROPIC_API_KEY: "k",
    HOME: home,
    KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
    KKAMAK_ACP_IDLE_MS: idleMs,
    ...extra,
  }
}

function spawnDaemon(home: string, spawnLog: string, extra: Record<string, string> = {}, idleMs = "8000") {
  const env = buildDaemonEnv(home, spawnLog, extra, idleMs)
  const daemon = path.join(import.meta.dir, "..", "src", "acp-daemon.ts")
  const quoted = ["bun", daemon].map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    env, stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  return { env }
}

/** Read the POST-LISTEN pids out of the spawn log and SIGTERM each one, then
 * remove the whole throwaway HOME dir (discovery file, both locks, and the
 * spawn log itself all live under it). Pid-scoped kill, never `pkill -f` —
 * §6e forbids host-wide teardown (round-4 I9), and the Bun.spawn handle is
 * the `bash -c nohup` shell, not the daemon. */
function killDaemon(home: string, spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Poll the spawn log for at least `n` post-listen lines. */
async function waitForSpawnLog(spawnLog: string, n: number, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms
  for (;;) {
    let lines: string[] = []
    try { lines = fs.readFileSync(spawnLog, "utf-8").split("\n").filter((l) => l.trim()) } catch { /* not yet */ }
    if (lines.length >= n || Date.now() > deadline) return lines
    await new Promise((r) => setTimeout(r, 50))
  }
}

interface JsonRpcReply { id?: number | string; result?: unknown; error?: { code: number; message: string; data?: { callConsumed: boolean; model?: string } } }

/** Minimal JSON-RPC-over-WebSocket ACP client. Each connection gets its OWN
 * request-id counter starting at 1 — the real-world shape, and the reason
 * cancel-scoping must be tag-based (round-3 C2).
 *
 * websocket-transport swap: replaces the old net.connect + FrameDecoder
 * client. No `requestBatch` anymore — that existed ONLY to force two
 * frames into ONE `socket.write()` so the daemon decoded+dispatched them
 * in the SAME synchronous pass (the same-chunk-cancel trick both deleted
 * cancel-race tests relied on, see this file's own note below). A
 * WebSocket message IS its own frame; there is no "same chunk" to force
 * two `.send()` calls into, so the concept has no home here — retired
 * along with the tests that were its only callers. */
function connectNdjson(env: Record<string, string | undefined>): Promise<{
  request: (method: string, params?: unknown) => Promise<any>
  notify: (method: string, params?: unknown) => void
  onNotification: (method: string, cb: (params: any) => void) => void
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    // Bug fixed while chasing a "no discovery file" false-negative: this
    // MUST be readDiscovery(env) with the SAME env spawnDaemon actually
    // spawned the daemon with, not a minimal {HOME: home} stand-in.
    // envFingerprint hashes the WHOLE env (minus the denylist), so a
    // 1-key object and the real ~40-key spawned env compute DIFFERENT
    // fingerprints and therefore DIFFERENT discovery paths -- connectNdjson
    // would reliably look in the wrong place. Verified the two fingerprints
    // actually differ before concluding this, not assumed.
    const discovery = readDiscovery(env)
    if (!discovery) {
      reject(new Error(`connectNdjson: no discovery file for this env — call waitForSpawnLog first`))
      return
    }
    const ws = new WebSocket(wsUrl(discovery.port))
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
    const notifHandlers = new Map<string, (p: any) => void>()

    ws.onopen = () => {
      resolve({
        request(method: string, params?: unknown) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
          })
        },
        notify(method: string, params?: unknown) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }))
        },
        onNotification(method: string, cb: (params: any) => void) { notifHandlers.set(method, cb) },
        close() { ws.close() },
      })
    }
    ws.onmessage = (ev) => {
      let msg: (JsonRpcReply & { method?: string; params?: unknown }) | undefined
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (!msg) return
      if (msg.id === undefined && typeof msg.method === "string") {
        const h = notifHandlers.get(msg.method)
        if (h) h(msg.params)
        return
      }
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
        else p.resolve(msg.result)
      }
    }
    ws.onerror = () => reject(new Error("connectNdjson: WebSocket error"))
  })
}

const LIVE: Array<{ home: string; spawnLog: string }> = []

// websocket-transport swap: the old hygiene assertion here diffed
// `~/.config/kkamak` against what was already listening on the REAL host,
// because the socket path had nowhere else to live. Discovery files now
// live under each test's own throwaway HOME (tempEndpoint), so there is no
// shared real-host directory to diff — a leaked daemon is caught the same
// way any other test-scoped resource leak is (its temp HOME dir simply
// stays behind), not by a bespoke directory-delta check.
afterEach(() => {
  while (LIVE.length) { const e = LIVE.pop()!; killDaemon(e.home, e.spawnLog) }
})

// ── wire-level behaviour: no model is ever reached, so NO credentials
// guard. Round-4 M6: a blanket describe.skipIf over this block would throw
// away real coverage on a credential-less host, because the daemon's
// WarmSession does not start a Query until a prompt actually arrives.
describe("acp-daemon wire behaviour (no model reached)", () => {
  test("missing _meta.kkamak.model -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls", async () => {
    const e = tempEndpoint("nocall"); LIVE.push(e)
    const cap = stubServer(() => sseText("SHOULD-NEVER-BE-CALLED"))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      await expect(c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "hi" }],
        // no _meta at all
      })).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      expect(cap.captured.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  // A2: ACP_TEST_SPAWN_LOG (new spelling) alone — no KKAMAK_ACP_TEST_SPAWN_LOG
  // at all — still makes the daemon write its post-listen line. Spawned
  // directly rather than through the spawnDaemon()/buildDaemonEnv() helpers,
  // which always set the legacy spelling for every other test's teardown.
  test("ACP_TEST_SPAWN_LOG (new spelling) alone makes the daemon write its post-listen line", async () => {
    const e = tempEndpoint("spawnlog-new-spelling"); LIVE.push(e)
    const env = buildDaemonEnv(e.home, e.spawnLog)
    delete (env as Record<string, string | undefined>).KKAMAK_ACP_TEST_SPAWN_LOG
    env.ACP_TEST_SPAWN_LOG = e.spawnLog
    const daemon = path.join(import.meta.dir, "..", "src", "acp-daemon.ts")
    const quoted = ["bun", daemon].map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
    const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
      env, stdout: "ignore", stderr: "ignore",
    })
    proc.unref()
    const lines = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const c = await connectNdjson(env)
    await c.request("initialize", { protocolVersion: 1 })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("N3c-iii test 5: session/new without isolation -> -32602, and no session is recorded", async () => {
    const e = tempEndpoint("newnoiso"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(env)
    await c.request("initialize", { protocolVersion: 1 })
    await expect(c.request("session/new", { cwd: process.cwd(), mcpServers: [] })) // no _meta at all
      .rejects.toMatchObject({ code: -32602 })
    await expect(c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: {} } })) // isolation absent
      .rejects.toMatchObject({ code: -32602 })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  // maxTokens-passthrough plan (2026-08-08): a PRESENT-but-malformed
  // maxTokens is rejected at the wire boundary rather than silently
  // coerced (e.g. truncated, clamped to 1, or the sign dropped) — same
  // provable-no-call shape as the missing-model case above.
  test.each([0, -1, 1.5, -100])(
    "malformed _meta.kkamak.maxTokens (%p) -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls",
    async (badValue) => {
      const e = tempEndpoint(`maxtokens-bad-${badValue}`); LIVE.push(e)
      const cap = stubServer(() => sseText("SHOULD-NEVER-BE-CALLED"))
      try {
        const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
        await waitForSpawnLog(e.spawnLog, 1, 15_000)
        const c = await connectNdjson(env)
        await c.request("initialize", { protocolVersion: 1 })
        const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
        await expect(c.request("session/prompt", {
          sessionId: s.sessionId,
          prompt: [{ type: "text", text: "hi" }],
          _meta: { kkamak: { model: HAIKU, maxTokens: badValue } },
        })).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
        expect(cap.captured.length).toBe(0)
        c.close()
      } finally { cap.stop() }
    },
    DAEMON_TEST_TIMEOUT_MS,
  )

  // "the part that needs care" (maxTokens-passthrough plan): WarmSession
  // (the agent lane) has no max_tokens equivalent, so a caller-set
  // maxTokens on a non-haiku turn must be REJECTED, not silently ignored —
  // the judgment call this package made, documented in README.
  test("maxTokens set on an agent-lane model -> ACP_ERR_NO_CALL naming the lane, and ZERO model calls", async () => {
    const e = tempEndpoint("maxtokens-agent-lane"); LIVE.push(e)
    const cap = stubServer(() => sseText("SHOULD-NEVER-BE-CALLED"))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      await expect(c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "hi" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL, maxTokens: 500 } },
      })).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      expect(cap.captured.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("N3c-iii test 4: unknown sessionId -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls", async () => {
    const e = tempEndpoint("unknownsession"); LIVE.push(e)
    const cap = stubServer(() => sseText("SHOULD-NEVER-BE-CALLED"))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      // No session/new was ever called for this id -- a fabricated
      // sessionId must never reach the pool, let alone bill a turn (the
      // N3a review's "write-only sessions map" minor: the map is now READ
      // here for the first time).
      await expect(c.request("session/prompt", {
        sessionId: "never-registered-by-session-new",
        prompt: [{ type: "text", text: "hi" }],
        _meta: { kkamak: { model: HAIKU } },
      })).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      expect(cap.captured.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("unknown method -> -32601 and the connection survives", async () => {
    const e = tempEndpoint("unknown"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(env)
    await expect(c.request("totally/bogus", {})).rejects.toMatchObject({ code: -32601 })
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  // websocket-transport swap: a "malformed frame" over a raw unix socket
  // (arbitrary bytes with no message boundary) has no direct analog over
  // WebSocket, where every `.send()` call IS a discrete message — so this
  // now exercises jsonrpc.ts's Parse Error path instead: a WS text message
  // that fails JSON.parse. That path replies with -32700 (unlike a
  // structurally-invalid-but-parseable request, which may or may not get a
  // reply depending on whether it's a notification) — worth asserting the
  // reply shape here, not just "connection survives".
  test("a malformed (non-JSON) WebSocket message gets a Parse Error reply and the connection survives", async () => {
    const e = tempEndpoint("malformed"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const discovery = readDiscovery(env)
    if (!discovery) throw new Error("no discovery file after spawn")
    const ws = new WebSocket(wsUrl(discovery.port))
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")) })
    const parseError = new Promise<any>((resolve) => {
      ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)))
    })
    ws.send("garbage-not-json")
    const reply = await parseError
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } })
    ws.close()
    // Prove the CONNECTION (and the daemon) survived the malformed message,
    // not just that this one reply arrived.
    const c = await connectNdjson(env)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  // RETIRED, not fixed and not re-skipped (websocket-transport plan, Task
  // 3 Step 2): this test's premise — a session/prompt and a session/cancel
  // written in ONE socket write, decoded and dispatched by the daemon in
  // ONE synchronous pass, so the cancel could reach ApiSession before the
  // prompt's send boundary — is UNCONSTRUCTIBLE over WebSocket. Each
  // `ws.send()` call is its own discrete message; the daemon's `message`
  // handler runs once per message, so two sends are unconditionally TWO
  // separate event-loop turns, never one. There is no "same chunk" left to
  // force. The underlying structural finding this test surfaced (traced
  // during the unix-socket CI-fix work: ApiSession.drain has no await
  // between dequeuing a turn and the send boundary, so a same-chunk cancel
  // could never preempt the send) is unaffected by the transport and still
  // true — it's just that this specific test can no longer express the
  // premise it needs to exercise it. See the SCOPED-cancel test's own note
  // below for the second, identical case.

  test("idle reaper drains, exits, and removes the socket", async () => {
    const e = tempEndpoint("idle"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog, {}, "1500")
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const lines = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const pid = Number(lines[0]?.trim().split(/\s+/)[0])
    const c = await connectNdjson(env)
    await c.request("initialize", { protocolVersion: 1 })
    c.close()
    // reaper ticks at min(60s, idleMs/3) = 500ms here; give it comfortable
    // margin over the 1500ms idle budget.
    const gone = await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 8_000)
    expect(gone).toBe(true)
    // websocket-transport swap: "removes the socket" becomes "removes the
    // discovery file" — e.home ITSELF still exists (this test's own
    // mkdtemp'd dir, never removed by the daemon); what the daemon's
    // shutdown deletes is the discovery entry underneath it.
    expect(readDiscovery(env)).toBeUndefined()
  }, DAEMON_TEST_TIMEOUT_MS)

  // A2: ACP_IDLE_MS is the new spelling; KKAMAK_ACP_IDLE_MS keeps working.
  // Here the legacy spelling carries the PRODUCTION (15 min) budget while
  // the new spelling carries the short test budget — the reaper firing
  // quickly proves ACP_IDLE_MS won, not KKAMAK_ACP_IDLE_MS.
  test("ACP_IDLE_MS (new spelling) wins over KKAMAK_ACP_IDLE_MS when both are set", async () => {
    const e = tempEndpoint("idle-new-spelling"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog, { ACP_IDLE_MS: "1500" }, "900000")
    const lines = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const pid = Number(lines[0]?.trim().split(/\s+/)[0])
    const c = await connectNdjson(env)
    await c.request("initialize", { protocolVersion: 1 })
    c.close()
    const gone = await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 8_000)
    expect(gone).toBe(true)
  }, DAEMON_TEST_TIMEOUT_MS)

  // websocket-transport swap: "a dead FILE at the socket path" has no
  // direct analog — a discovery file's payload is a port number, and
  // staleness is "does the daemon connect-probe that port and get nothing
  // back", not "is there a stray file". Simulated here by binding a
  // throwaway server on port 0, closing it immediately (freeing the port
  // with very high probability — the OS does not typically hand out the
  // same ephemeral port again within this test's own short window), then
  // writing a discovery file that CLAIMS a daemon is listening there. The
  // real daemon's own bindWithTakeover must probe that port, get no
  // WebSocket handshake back, and take over — publishing its OWN real
  // port to the SAME discovery path, which is exactly what connectNdjson
  // reads after waitForSpawnLog confirms the takeover succeeded.
  test("a stale discovery file (pointing at a dead port) is taken over under the BIND lock", async () => {
    const e = tempEndpoint("stale"); LIVE.push(e)
    const throwaway = Bun.serve({ port: 0, fetch: () => new Response() })
    const deadPort = throwaway.port
    if (deadPort === undefined) throw new Error("Bun.serve({port:0}) did not assign a port")
    throwaway.stop(true)
    // Compute the EXACT env the daemon will be spawned with, BEFORE
    // spawning it, so the stale entry is seeded at the SAME
    // fingerprint-derived discovery path the real daemon will probe and
    // take over.
    const env = buildDaemonEnv(e.home, e.spawnLog)
    writeDiscovery(env, { port: deadPort, pid: 999_999 })
    spawnDaemon(e.home, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(env)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    // The takeover REPLACED the stale entry with a real one — not the
    // dead port this test seeded.
    expect(readDiscovery(env)?.port).not.toBe(deadPort)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a LIVE daemon is not taken over: the second starter exits 0, writes NO spawn-log line, and the first still answers", async () => {
    const e = tempEndpoint("live"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog)
    const first = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    expect(first.length).toBe(1)
    // Second starter, same socket/spawn-log pair: must see the first as
    // live and refuse to bind, writing nothing.
    spawnDaemon(e.home, e.spawnLog)
    // Settle time for the second starter to probe and exit.
    await new Promise((r) => setTimeout(r, 2_000))
    const lines = fs.readFileSync(e.spawnLog, "utf-8").split("\n").filter((l) => l.trim())
    expect(lines.length).toBe(1)
    const c = await connectNdjson(env)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("ROUND-4 I2: the daemon binds and echoes from the env it was GIVEN, not from an ambient one", async () => {
    const e = tempEndpoint("envcontract"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_MODEL: "probe-value" })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(env)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init._meta.kkamak.envFingerprint).toBe(envFingerprint(env))
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)
})

// ── acp/models/list (A3: renamed from kkamak/models/list; the daemon
// accepts BOTH spellings): stateless model enumeration. Reaches a stub of
// the Models API (GET /v1/models), never messages.create -- no session/new,
// no pool, no ApiSession, on every test below. Zero real spend: the stub
// terminates the HTTP leg locally, same discipline as every other
// real-daemon describe block in this file.
describe("acp-daemon dispatcher — acp/models/list", () => {
  const MODEL_A = {
    type: "model" as const,
    id: "claude-haiku-4-5-20251001",
    display_name: "Claude Haiku 4.5",
    created_at: "2025-10-01T00:00:00Z",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    capabilities: null,
  }

  function pageBody(data: Array<typeof MODEL_A>): Response {
    return Response.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: null })
  }

  /** `GET /v1/models` carries no request body — sdk-stub.ts's `stubServer`
   * treats a bodyless request as a bare connectivity probe (built for
   * `POST /v1/messages`) and never calls its handler for one, so it cannot
   * serve this endpoint. A dedicated minimal stub, matching
   * test/models.test.ts's own pattern for the same reason. */
  function modelsStub(respond: () => Response | Promise<Response>): { url: string; stop: () => void } {
    const server = Bun.serve({ port: 0, fetch: async () => respond() })
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }

  test("ok: returns ModelInfo[] verbatim, with NO session/new ever called — both the new and legacy method spellings work against the SAME daemon", async () => {
    const e = tempEndpoint("models-ok"); LIVE.push(e)
    const cap = modelsStub(() => pageBody([MODEL_A]))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      // Deliberately no session/new call at all -- acp/models/list is
      // stateless metadata, callable right after initialize.
      const models = await c.request("acp/models/list")
      expect(models).toEqual([MODEL_A])
      // A3: the ORIGINAL kkamak-namespaced spelling is still accepted by
      // this same running daemon — a second `case` in the dispatcher, not a
      // separate mechanism.
      const legacyModels = await c.request("kkamak/models/list")
      expect(legacyModels).toEqual([MODEL_A])
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("no-auth: ACP_ERR_MODELS_NO_AUTH (-32004), distinct from the outcome-law codes", async () => {
    const e = tempEndpoint("models-noauth"); LIVE.push(e)
    // Empty string, not omitted: spawnDaemon's ANTHROPIC_API_KEY:"k" would
    // otherwise win. auth.ts treats an empty-string value as absent, so
    // this falls through to the credentials-file lane, which fails under
    // this test's own throwaway (real-credentials-free) HOME.
    const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_API_KEY: "" })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(env)
    await c.request("initialize", { protocolVersion: 1 })
    await expect(c.request("acp/models/list")).rejects.toMatchObject({ code: -32004 })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("upstream error: ACP_ERR_MODELS_UPSTREAM_ERROR (-32005) carries the HTTP status, distinct from -32002's pool-exhausted meaning", async () => {
    const e = tempEndpoint("models-error"); LIVE.push(e)
    const cap = modelsStub(() => new Response("boom", { status: 500 }))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      await expect(c.request("acp/models/list")).rejects.toMatchObject({ code: -32005, data: { status: 500 } })
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)
})

// ── dispatcher-level unit tests against a FAKE SessionPool (a real
// SessionPool with a DI `makeSession`): no daemon process, no CLI, no
// credentials, no real turn timing -- these exist to pin the `outstanding`
// bookkeeping semantics precisely and deterministically (round-2 review
// finding 1, 2026-08-05), which real-CLI timing cannot do reliably.
//
// N3c-iii: `createDispatcher`'s declared parameter is now `SessionPool`, a
// concrete class the pool ALREADY provides a DI seam for (`makeSession`,
// acp-pool.ts), so unlike the pre-pool single-`WarmSession` version this
// needs no cast at the dispatcher boundary -- only `FakeDispatchWarm` itself
// (satisfying `WarmSessionLike` structurally, PLUS the `oneShot`/`cancel`
// pair the daemon's own `DispatchableWarm` cast reaches for) is hand-rolled,
// mirroring acp-pool.test.ts's own `FakeWarm` convention.
class FakeDispatchWarm implements WarmSessionLike {
  private inflight = new Map<string, (o: TurnOutcome) => void>()
  constructor(private readonly calls: string[]) {}
  turnInFlight(): boolean { return false }
  close(): void { this.calls.push("close") }
  oneShot(_text: string, _model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome> {
    const tag = opts.tag!
    this.calls.push(`oneShot:${tag}`)
    return new Promise<TurnOutcome>((resolve) => { this.inflight.set(tag, resolve) })
  }
  cancel(tag: string): CancelResult {
    this.calls.push(`cancel:${tag}`)
    const resolve = this.inflight.get(tag)
    if (resolve) { this.inflight.delete(tag); resolve({ kind: "no-call" }); return "queued-dropped" }
    return "unknown"
  }
  /** Returns false (never throws) when this instance doesn't own `tag`, so
   * a caller with several instances can try each one in turn. */
  trySettle(tag: string, outcome: TurnOutcome): boolean {
    const resolve = this.inflight.get(tag)
    if (!resolve) return false
    this.inflight.delete(tag)
    resolve(outcome)
    return true
  }
}

/** A fresh `FakeDispatchWarm` per pool entry (matching real pool behaviour:
 * concurrent acquires of the same isolation get DIFFERENT entries, acp-pool
 * test 1) sharing one `calls` log for assertion simplicity, plus the raw
 * `instances` array so a test can prove per-entry ("cross-entry")
 * separation directly. */
function fakeDispatchPool() {
  const calls: string[] = []
  const instances: FakeDispatchWarm[] = []
  const pool = new SessionPool({} as Record<string, string | undefined>, {
    makeSession: (_env: Record<string, string | undefined>, _opts: WarmConstructOpts) => {
      const w = new FakeDispatchWarm(calls)
      instances.push(w)
      return w
    },
  })
  return {
    pool,
    calls,
    instances,
    settle(tag: string, outcome: TurnOutcome) {
      for (const w of instances) if (w.trySettle(tag, outcome)) return
      throw new Error(`settle: no in-flight turn for tag ${tag}`)
    },
  }
}

/** Task 4 (api-sdk merge brief) — HAZARD 2's fake-side twin of
 * `FakeDispatchWarm`: the per-session, NEVER-POOLED api-lane backend.
 * Implements `DispatchableSession` in full (not just `WarmSessionLike`),
 * since `createDispatcher`'s api branch calls `oneShot`/`cancel` on it
 * directly, the same way it does on a pool entry's `warm`. */
class FakeDispatchApi implements DispatchableSession {
  readonly isolation: WarmIsolation
  private inflight = new Map<string, (o: TurnOutcome) => void>()
  /** maxTokens-passthrough plan: the last oneShot() call's own maxTokens,
   * for a test to assert the dispatcher actually forwarded it — mirrors
   * `calls`' own "record what arrived, let the test assert" convention. */
  lastMaxTokens: number | undefined
  constructor(private readonly calls: string[], isolation: WarmIsolation) { this.isolation = isolation }
  turnInFlight(): boolean { return this.inflight.size > 0 }
  close(): void { this.calls.push("close") }
  oneShot(_text: string, _model: string, opts: { recycle: boolean; tag?: string; maxTokens?: number }): Promise<TurnOutcome> {
    const tag = opts.tag!
    this.lastMaxTokens = opts.maxTokens
    this.calls.push(`oneShot:${tag}`)
    return new Promise<TurnOutcome>((resolve) => { this.inflight.set(tag, resolve) })
  }
  cancel(tag: string): CancelResult {
    this.calls.push(`cancel:${tag}`)
    const resolve = this.inflight.get(tag)
    if (resolve) { this.inflight.delete(tag); resolve({ kind: "no-call" }); return "queued-dropped" }
    return "unknown"
  }
  trySettle(tag: string, outcome: TurnOutcome): boolean {
    const resolve = this.inflight.get(tag)
    if (!resolve) return false
    this.inflight.delete(tag)
    resolve(outcome)
    return true
  }
}

/** A fresh `FakeDispatchApi` per `makeApiSession(...)` call, sharing one
 * `calls` log — mirrors `fakeDispatchPool()`'s own convention. HAZARD 2
 * means `makeApiSession` should be called AT MOST ONCE per ACP session
 * (never per-turn, never pooled), which is exactly what
 * `instances.length` proves in the tests below. */
function fakeApiFactory() {
  const calls: string[] = []
  const instances: FakeDispatchApi[] = []
  const makeApiSession = (_env: Record<string, string | undefined>, opts: WarmConstructOpts) => {
    const a = new FakeDispatchApi(calls, opts.isolation)
    instances.push(a)
    return a
  }
  return {
    makeApiSession,
    calls,
    instances,
    settle(tag: string, outcome: TurnOutcome) {
      for (const a of instances) if (a.trySettle(tag, outcome)) return
      throw new Error(`settle: no in-flight turn for tag ${tag}`)
    },
  }
}

// ── HAZARD 2/3 (api-sdk merge brief): routing + the per-session,
// never-pooled api backend. Fake pool AND fake api factory, no daemon
// process, no network — proves the DISPATCH decision itself, which the
// real-daemon "reaches the stubbed model" suite (further below) cannot: a
// live daemon's pool is a real SessionPool, opaque from the wire.
describe("acp-daemon dispatcher — HAZARD 2/3 routing (fake pool + fake api factory)", () => {
  test("a haiku model bypasses the pool entirely and uses the api factory (HAZARD 3)", async () => {
    const { pool, calls: poolCalls } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls, instances, settle } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-haiku"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    const p = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hi" }], _meta: { kkamak: { model: HAIKU } },
    } }, write)
    const tag = apiCalls.find((c) => c.startsWith("oneShot:"))!.split(":")[1]!
    expect(poolCalls.filter((c) => c.startsWith("oneShot:")).length).toBe(0)   // pool never touched
    expect(pool.size()).toBe(0)
    settle(tag, { kind: "ok", text: "ANSWER", model: HAIKU, canonicalModel: HAIKU })
    await p
    expect(frames.find((f) => f.id === 1)).toMatchObject({
      result: { stopReason: "end_turn", _meta: { kkamak: { model: HAIKU, canonicalModel: HAIKU, callConsumed: true } } },
    })
    expect(instances.length).toBe(1)
  })

  test("maxTokens-passthrough: a haiku model's _meta.kkamak.maxTokens is forwarded to the api backend's oneShot", async () => {
    const { pool } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls, instances, settle } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-haiku-maxtokens"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const write = () => {}

    const p = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hi" }], _meta: { kkamak: { model: HAIKU, maxTokens: 333 } },
    } }, write)
    const tag = apiCalls.find((c) => c.startsWith("oneShot:"))!.split(":")[1]!
    expect(instances[0]!.lastMaxTokens).toBe(333)
    settle(tag, { kind: "no-call" })
    await p
  })

  test("maxTokens-passthrough: omitted -> the api backend sees maxTokens undefined (its own default applies downstream)", async () => {
    const { pool } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls, instances, settle } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-haiku-no-maxtokens"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const write = () => {}

    const p = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hi" }], _meta: { kkamak: { model: HAIKU } },
    } }, write)
    const tag = apiCalls.find((c) => c.startsWith("oneShot:"))!.split(":")[1]!
    expect(instances[0]!.lastMaxTokens).toBeUndefined()
    settle(tag, { kind: "no-call" })
    await p
  })

  test("maxTokens-passthrough: an agent-lane model with maxTokens set is refused before the pool is ever touched", async () => {
    const { pool, calls: poolCalls } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-agent-maxtokens"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    await dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hi" }], _meta: { kkamak: { model: AGENT_TEST_MODEL, maxTokens: 100 } },
    } }, write)
    expect(frames.find((f) => f.id === 1)).toMatchObject({ error: { code: ACP_ERR_NO_CALL, data: { callConsumed: false } } })
    expect(poolCalls.length).toBe(0)   // pool never touched at all
    expect(apiCalls.length).toBe(0)
  })

  test("a non-haiku model still routes through the pool (agent lane), api factory never called", async () => {
    const { pool, calls: poolCalls, settle } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-agent"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    const p = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hi" }], _meta: { kkamak: { model: AGENT_TEST_MODEL } },
    } }, write)
    const oneShotCalls = poolCalls.filter((c) => c.startsWith("oneShot:"))
    expect(oneShotCalls.length).toBe(1)
    expect(apiCalls.length).toBe(0)
    settle(oneShotCalls[0]!.split(":")[1]!, { kind: "no-call" })
    await p
  })

  test("two prompts in the SAME session reuse the SAME per-session api backend — never a fresh one per turn (HAZARD 2)", async () => {
    const { pool } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls, instances, settle } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-reuse"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const write = () => {}

    const p1 = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "one" }], _meta: { kkamak: { model: HAIKU } },
    } }, write)
    const tag1 = apiCalls.find((c) => c.startsWith("oneShot:"))!.split(":")[1]!
    settle(tag1, { kind: "no-call" })
    await p1
    expect(instances.length).toBe(1)

    const p2 = dispatch({ id: 2, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "two" }], _meta: { kkamak: { model: HAIKU } },
    } }, write)
    const oneShots = apiCalls.filter((c) => c.startsWith("oneShot:"))
    expect(oneShots.length).toBe(2)
    settle(oneShots[1]!.split(":")[1]!, { kind: "no-call" })
    await p2
    expect(instances.length).toBe(1)   // STILL one instance -- never re-minted per turn
  })

  test("session/close closes a per-session api backend directly, never touching the pool (HAZARD 2)", async () => {
    const { pool } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls, settle } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-close"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    const p1 = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "one" }], _meta: { kkamak: { model: HAIKU } },
    } }, write)
    const tag = apiCalls.find((c) => c.startsWith("oneShot:"))!.split(":")[1]!
    settle(tag, { kind: "no-call" })
    await p1

    await dispatch({ id: 2, method: "session/close", params: { sessionId: S } }, write)
    expect(frames.find((f) => f.id === 2)).toMatchObject({ result: { closed: true } })
    expect(apiCalls).toContain("close")
    expect(pool.size()).toBe(0)
  })

  test("session/close refuses while the api backend has a turn in flight — closed:false turn-in-flight", async () => {
    const { pool } = fakeDispatchPool()
    const { makeApiSession, calls: apiCalls } = fakeApiFactory()
    const state = createDaemonState()
    const S = "s-close-busy"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {}, { makeApiSession })
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    const p1 = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hangs" }], _meta: { kkamak: { model: HAIKU } },
    } }, write)
    expect(apiCalls.filter((c) => c.startsWith("oneShot:")).length).toBe(1)

    await dispatch({ id: 2, method: "session/close", params: { sessionId: S } }, write)
    expect(frames.find((f) => f.id === 2)).toMatchObject({ result: { closed: false, reason: "turn-in-flight" } })
    expect(apiCalls).not.toContain("close")

    // Clean up.
    await dispatch({ id: 3, method: "session/cancel", params: { sessionId: S } }, write)
    await p1
  })
})

describe("acp-daemon dispatcher — outstanding-tag bookkeeping (fake SessionPool, no daemon process)", () => {
  test("two same-session prompts in flight: cancel targets the OLDEST tag, and neither turn's cleanup wipes the other's entry", async () => {
    const { pool, calls } = fakeDispatchPool()
    const state = createDaemonState()
    const S = "session-under-test"
    // N3c-iii: session/prompt now looks up state.sessions, so the session
    // must be REGISTERED first -- the exact behaviour the N3a review's
    // "write-only sessions map" minor asked for (test 4 below covers the
    // unregistered case). Seeded directly (white-box) rather than via a
    // session/new dispatch: this test's whole point is the OUTSTANDING
    // bookkeeping, not the session/new flow.
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    // Two session/prompt requests for the SAME session, the second fired
    // before the first has settled -- reproduces the "outstanding[S] gets
    // overwritten" shape finding 1 describes. Each `dispatch(...)` call
    // runs synchronously up to (and including) the fake's synchronous
    // Promise executor before yielding, so by the time each call returns
    // its tag is already recorded -- no microtask flush needed between them.
    const p1 = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "one" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    const p2 = dispatch({ id: 2, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "two" }], _meta: { kkamak: { model: "m" } },
    } }, write)

    const oneShotCalls = calls.filter((c) => c.startsWith("oneShot:"))
    expect(oneShotCalls.length).toBe(2)
    const tag1 = oneShotCalls[0]!.split(":")[1]!
    const tag2 = oneShotCalls[1]!.split(":")[1]!
    expect(tag1).not.toBe(tag2)

    // (a) A cancel while BOTH turns are outstanding must target the OLDER
    // tag (tag1), never overwrite-and-lose it to tag2. The fake's cancel()
    // (like WarmSession.cancel) settles the target turn ITSELF, so p1 is
    // already resolved once this call returns -- no manual settle() needed.
    await dispatch({ id: 3, method: "session/cancel", params: { sessionId: S } }, write)
    expect(calls[calls.length - 1]).toBe(`cancel:${tag1}`)
    await p1

    // (b) turn 2 is STILL outstanding. The buggy `Map<sessionId, tag>`
    // design deletes the WHOLE key in turn 1's `finally`, so a cancel here
    // would find "" and silently no-op (finding 1(b)). The fix must still
    // find tag2.
    await dispatch({ id: 4, method: "session/cancel", params: { sessionId: S } }, write)
    expect(calls[calls.length - 1]).toBe(`cancel:${tag2}`)
    await p2

    // Both prompts settled to a real wire response (not silently dropped).
    const responses = frames.filter((f) => f.id === 1 || f.id === 2)
    expect(responses.length).toBe(2)
  })

  test("cross-session scoping is unaffected by the per-session tag list", async () => {
    const { pool, calls, settle } = fakeDispatchPool()
    const state = createDaemonState()
    state.sessions.set("A", { createdAt: Date.now(), isolation: TEST_ISOLATION })
    state.sessions.set("B", { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {})
    const write = () => {}

    const pA = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: "A", prompt: [{ type: "text", text: "a" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    const pB = dispatch({ id: 2, method: "session/prompt", params: {
      sessionId: "B", prompt: [{ type: "text", text: "b" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    const oneShotCalls = calls.filter((c) => c.startsWith("oneShot:"))
    const tagA = oneShotCalls[0]!.split(":")[1]!
    const tagB = oneShotCalls[1]!.split(":")[1]!
    expect(tagA).not.toBe(tagB)

    // Cancelling B must resolve to B's OWN tag, never A's. The fake's
    // cancel() (like WarmSession.cancel) settles the target turn itself,
    // so pB is already resolved after this -- do not call settle() on it.
    await dispatch({ id: 3, method: "session/cancel", params: { sessionId: "B" } }, write)
    expect(calls[calls.length - 1]).toBe(`cancel:${tagB}`)
    await pB

    settle(tagA, { kind: "no-call" })
    await pA
  })

  // Brief §4 test 6's "cross-ENTRY case": A and B are both in flight and
  // BUSY at the moment the other acquires (self-review (b)) -- pool.acquire
  // never reuses a busy entry (acp-pool.test.ts test 1), so this is exactly
  // the pool's own "two concurrent acquires get DIFFERENT entries" behavior
  // reached through the daemon, made concrete: two DISTINCT
  // FakeDispatchWarm instances, and cancelling B's tag calls `.cancel()`
  // ONLY on B's own instance, never touching A's.
  test("cancel for session B never reaches a different pool entry's WarmSession while A is in flight", async () => {
    const { pool, calls, instances, settle } = fakeDispatchPool()
    const state = createDaemonState()
    state.sessions.set("A", { createdAt: Date.now(), isolation: TEST_ISOLATION })
    state.sessions.set("B", { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {})
    const write = () => {}

    const pA = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: "A", prompt: [{ type: "text", text: "a" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    const pB = dispatch({ id: 2, method: "session/prompt", params: {
      sessionId: "B", prompt: [{ type: "text", text: "b" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    // Two DIFFERENT pool entries were spawned -- both A and B are busy at
    // the moment the other acquires (pool.acquire never reuses a busy
    // entry, acp-pool.test.ts test 1), so the "different entry" premise is
    // concrete here, not merely notional.
    expect(instances.length).toBe(2)
    const oneShotCalls = calls.filter((c) => c.startsWith("oneShot:"))
    const tagA = oneShotCalls[0]!.split(":")[1]!
    const tagB = oneShotCalls[1]!.split(":")[1]!

    await dispatch({ id: 3, method: "session/cancel", params: { sessionId: "B" } }, write)
    // Exactly one cancel call happened, and it named B's own tag.
    expect(calls.filter((c) => c.startsWith("cancel:"))).toEqual([`cancel:${tagB}`])
    await pB

    // A is STILL pending -- proving B's cancel never reached A's entry.
    // Only settling A directly (through its own instance) resolves it.
    let aSettled = false
    void pA.then(() => { aSettled = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(aSettled).toBe(false)

    settle(tagA, { kind: "no-call" })
    await pA
  })
})

// ── session/new isolation validation (fake SessionPool, no daemon process):
// final-review Important 1 — a shallow `typeof === "object"` check let
// `{}`, `[]`, and any partial isolation through, and the accepted value is
// spread RAW into the SDK `query()` options (warm-session.ts:478), so a
// missing field silently un-isolates the session instead of failing
// closed. These pin the fix at the wire boundary: malformed shapes must
// never reach `state.sessions`, and the canonical TEST_ISOLATION must
// still be accepted byte-for-byte.
describe("acp-daemon dispatcher — session/new isolation structural validation", () => {
  test("empty object isolation ({}) is rejected with -32602 and no session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: {} } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("array isolation ([]) is rejected with -32602 and no session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: [] } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("partial isolation (only systemPrompt) is rejected with -32602 and no session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: { systemPrompt: "x" } } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("partial isolation missing only settings.autoMemoryEnabled is rejected with -32602", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const { settings: _omit, ...rest } = TEST_ISOLATION
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: rest } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("full TEST_ISOLATION is accepted and a session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ result: { sessionId: expect.any(String) } })
    expect(state.sessions.size).toBe(1)
  })

  test("full TEST_ISOLATION_2 is accepted and a session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION_2 } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ result: { sessionId: expect.any(String) } })
    expect(state.sessions.size).toBe(1)
  })

  // ── re-review residual (2026-08-05): `settingSources`/`tools` are typed
  // as the LITERAL EMPTY TUPLE `[]` in WarmIsolation, not `string[]` — an
  // `Array.isArray` check alone let a crafted non-empty array through,
  // which is spread raw into `query()` and restores tool access / CLAUDE.md
  // loading. `thinking.type` is the closed union `"disabled" | "enabled"`,
  // not any string.
  test("non-empty tools (e.g. [\"Bash\"]) is rejected with -32602 and no session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const tainted = { ...TEST_ISOLATION, tools: ["Bash"] }
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: tainted } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("non-empty settingSources (e.g. [\"project\"]) is rejected with -32602 and no session is recorded", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const tainted = { ...TEST_ISOLATION, settingSources: ["project"] }
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: tainted } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("thinking.type \"adaptive\" (not in the closed union) is rejected with -32602", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const tainted = { ...TEST_ISOLATION, thinking: { type: "adaptive" } }
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: tainted } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })

  test("thinking.type garbage string is rejected with -32602", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const tainted = { ...TEST_ISOLATION, thinking: { type: "not-a-real-value" } }
    await dispatch({ id: 1, method: "session/new", params: {
      cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: tainted } },
    } }, (m) => frames.push(m as Record<string, unknown>))
    expect(frames[0]).toMatchObject({ error: { code: -32602 } })
    expect(state.sessions.size).toBe(0)
  })
})

// ── session/close (fake SessionPool, no daemon process): review-sensor
// build prerequisite. The daemon reverse-looks-up the pool entry that last
// served this sessionId (state.lastServedBySessionForEntry) and forwards to
// pool.closeEntry(entryId) — always a RESPONSE, never an error frame, so a
// lost close race is a no-op by spec (task-2-brief.md §Interfaces).
describe("acp-daemon dispatcher — session/close", () => {
  test("session/close closes the entry that served the session", async () => {
    const { pool, calls, settle } = fakeDispatchPool()
    const state = createDaemonState()
    const S = "session-under-test"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    // Dispatch a prompt so lastServedBySessionForEntry maps entry->session,
    // then settle it so the entry is released back to the pool (idle) —
    // closeEntry refuses a busy entry (task 1's own guard), so a same-turn
    // close would only ever exercise the busy path, not this one.
    const p1 = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "one" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    const oneShotCalls = calls.filter((c) => c.startsWith("oneShot:"))
    expect(oneShotCalls.length).toBe(1)
    const tag = oneShotCalls[0]!.split(":")[1]!
    settle(tag, { kind: "no-call" })
    await p1
    expect(pool.size()).toBe(1) // still pooled — release, not close

    await dispatch({ id: 2, method: "session/close", params: { sessionId: S } }, write)
    expect(frames.find((f) => f.id === 2)).toMatchObject({ result: { closed: true } })
    expect(calls).toContain("close")
    expect(pool.size()).toBe(0)
  })

  test("session/close for an unknown session responds closed:false unknown-session", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    await dispatch({ id: 1, method: "session/close", params: { sessionId: "never-served-anything" } }, write)
    expect(frames[0]).toMatchObject({ result: { closed: false, reason: "unknown-session" } })
  })

  // Task 4 (api-sdk merge brief), deliberate refinement: the OLD close logic
  // checked ONLY `state.lastServedBySessionForEntry` (a pool-entry reverse
  // lookup) and never consulted `state.sessions` at all, so a REGISTERED
  // session that simply never prompted got the same "unknown-session"
  // reason as one that was never registered — a pre-existing misnomer, only
  // exposed now that HAZARD 2 requires `state.sessions` to be consulted
  // directly (to find a per-session ApiSession). A known session with
  // nothing to close responds `closed:true` (nothing to do, same as
  // `session/cancel`'s own no-op ack), reserving `unknown-session`
  // specifically for a sessionId this daemon never registered.
  test("session/close for a REGISTERED session that never prompted responds closed:true, not unknown-session", async () => {
    const { pool } = fakeDispatchPool()
    const state = createDaemonState()
    state.sessions.set("registered-but-idle", { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    await dispatch({ id: 1, method: "session/close", params: { sessionId: "registered-but-idle" } }, write)
    expect(frames[0]).toMatchObject({ result: { closed: true } })
  })

  test("session/close while the entry is busy responds closed:false busy (pool guard)", async () => {
    const { pool, calls } = fakeDispatchPool()
    const state = createDaemonState()
    const S = "session-under-test-busy"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp", {})
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    // Fire the prompt but never settle it -- the entry stays busy.
    const p1 = dispatch({ id: 1, method: "session/prompt", params: {
      sessionId: S, prompt: [{ type: "text", text: "hangs" }], _meta: { kkamak: { model: "m" } },
    } }, write)
    const oneShotCalls = calls.filter((c) => c.startsWith("oneShot:"))
    expect(oneShotCalls.length).toBe(1)

    await dispatch({ id: 2, method: "session/close", params: { sessionId: S } }, write)
    expect(frames.find((f) => f.id === 2)).toMatchObject({ result: { closed: false, reason: "busy" } })
    expect(calls).not.toContain("close")

    // Clean up the still-outstanding turn so the test doesn't leave a
    // dangling promise -- cancel settles it, same as the sibling
    // outstanding-tag-bookkeeping tests above.
    await dispatch({ id: 3, method: "session/cancel", params: { sessionId: S } }, write)
    await p1
  })
})

// ── model-reaching behaviour: these DO spawn the bundled CLI, so they carry
// the credentials guard.
// Re-enabled (Task 6, gate-debt paydown): skipped from Task 1 through Task
// 5 because it dispatches a real `session/prompt` through a really-spawned
// daemon and needed an actual backend behind `pool.acquire()`. Runs against
// ApiSession + the local stub now — deliberately NOT gated on
// HAS_CLAUDE_CODE_CREDENTIALS: that credential requirement belonged to the
// old agent-SDK-CLI transport, not this backend (see acp-client.test.ts's
// own re-enable note for the full reasoning).
//
// Task 7 (gate-split): SessionPool's default backend is WarmSession since
// this repo's own Task 5, so most of this block's daemon spawns ALSO spawn
// a real `claude` CLI subprocess underneath (AGENT_TEST_MODEL turns) —
// SLOW lane, skipped under ACP_GATE_FAST=1 (gate.json's own `check`); a
// bare `bun test` always runs it.
describe.skipIf(GATE_FAST)("acp-daemon over unix socket (reaches the stubbed model)", () => {
  test("initialize -> session/new -> session/prompt round-trip, fingerprint and PROVEN-model evidence echoed", async () => {
    const e = tempEndpoint("rt"); LIVE.push(e)
    const cap = stubServer(() => okBody("ANSWER", STUB_DECLARED_MODEL))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      const init = await c.request("initialize", { protocolVersion: 1 })
      expect(init.protocolVersion).toBe(1)
      expect(init._meta.kkamak.envFingerprint).toBe(envFingerprint(env))
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      expect(typeof s.sessionId).toBe("string")
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      const r = await c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "classify me" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      expect(r.stopReason).toBe("end_turn")
      // Reality-check (Task 6): the T4·1a comment this replaced was specific
      // to the OLD agent-SDK-CLI transport, whose own modelUsage map keys by
      // the client-requested ALIAS regardless of what the server declared —
      // a CLI-transport quirk, not a general driving-path property. On this
      // backend, sendOne (api-session.ts) returns `response.model` verbatim
      // from the raw API response body (call.test.ts's own "ok path" test
      // pins the same behavior) — so the daemon forwards whatever the stub
      // actually declared, dated or not. Asserting the alias here was simply
      // wrong for this backend; STUB_DECLARED_MODEL is what a real stub (or
      // the real API, which keys modelUsage by the dated snapshot id) sends.
      expect(r._meta.kkamak.model).toBe(STUB_DECLARED_MODEL)
      expect(typeof r._meta.kkamak.canonicalModel).toBe("string")
      expect(r._meta.kkamak.callConsumed).toBe(true)
      expect(updates.join("")).toContain("ANSWER")
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("maxTokens-passthrough: _meta.kkamak.maxTokens reaches the real HTTP request body as max_tokens", async () => {
    const e = tempEndpoint("maxtokens-e2e"); LIVE.push(e)
    const cap = stubServer(() => okBody("ANSWER", STUB_DECLARED_MODEL))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      const r = await c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "hi" }],
        _meta: { kkamak: { model: HAIKU, maxTokens: 256 } },
      })
      expect(r.stopReason).toBe("end_turn")
      expect(cap.captured.length).toBe(1)
      expect(cap.captured[0]!.body.max_tokens).toBe(256)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("N3c-iii test 1: two sessions with DIFFERENT isolations never share a warm entry -- the marker system prompt appears ONLY on the marker-isolation session's captured request bodies", async () => {
    const e = tempEndpoint("isoseg"); LIVE.push(e)
    const CAPTURED: Array<Record<string, unknown>> = []
    // AGENT_TEST_MODEL routes through the pool, whose default backend is now
    // WarmSession (Task 5) -- a real CLI subprocess that always sends
    // `stream:true`. sseText, not okBody: a non-streaming JSON body fails
    // the CLI's own SSE parsing and makes it silently retry non-streaming,
    // doubling CAPTURED (Task 2's own finding, agent-cli-stub.ts).
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })

      const sGauge = await c.request("session/new", {
        cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } },
      })
      await c.request("session/prompt", {
        sessionId: sGauge.sessionId, prompt: [{ type: "text", text: "gauge turn" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })

      const sMarker = await c.request("session/new", {
        cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: MARKER_ISOLATION } },
      })
      await c.request("session/prompt", {
        sessionId: sMarker.sessionId, prompt: [{ type: "text", text: "marker turn" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })

      expect(CAPTURED.length).toBe(2)
      // Isolation segregation observed ON THE WIRE, not inferred: the
      // marker system prompt appears in EXACTLY the marker session's own
      // captured body -- two DIFFERENT pool entries under two DIFFERENT
      // isolations, never one shared warm entry silently switching policy.
      expect(JSON.stringify(CAPTURED[0])).not.toContain("REASONING-MARKER-SYSTEM-PROMPT")
      expect(JSON.stringify(CAPTURED[1])).toContain("REASONING-MARKER-SYSTEM-PROMPT")
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a second SESSION recycles (clean context); a second PROMPT in one session does not", async () => {
    const e = tempEndpoint("recycle"); LIVE.push(e)
    const CAPTURED: Array<Record<string, unknown>> = []
    // sseText, not okBody -- see the isolation-segregation test above.
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })

      const s1 = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      await c.request("session/prompt", {
        sessionId: s1.sessionId, prompt: [{ type: "text", text: "FIRST-MARKER" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })

      const s2 = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      await c.request("session/prompt", {
        sessionId: s2.sessionId, prompt: [{ type: "text", text: "SECOND-MARKER" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })
      expect(CAPTURED.length).toBe(2)
      const m2 = CAPTURED[1] as { messages: unknown[] }
      expect(JSON.stringify(m2.messages)).not.toContain("FIRST-MARKER")
      expect(JSON.stringify(m2.messages)).toContain("SECOND-MARKER")

      // A THIRD prompt reusing the SECOND sessionId: context must NOT be
      // cleared, so the second prompt's marker is still present.
      await c.request("session/prompt", {
        sessionId: s2.sessionId, prompt: [{ type: "text", text: "THIRD-MARKER" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })
      expect(CAPTURED.length).toBe(3)
      const m3 = CAPTURED[2] as { messages: unknown[] }
      expect(JSON.stringify(m3.messages)).toContain("SECOND-MARKER")
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("INTERLEAVED sessions each get a clean context (lastServedSessionId is committed at dispatch)", async () => {
    const e = tempEndpoint("interleave"); LIVE.push(e)
    const CAPTURED: Array<Record<string, unknown>> = []
    // sseText, not okBody -- see the isolation-segregation test above.
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(env)
      const cB = await connectNdjson(env)
      await cA.request("initialize", { protocolVersion: 1 })
      await cB.request("initialize", { protocolVersion: 1 })
      const sA = await cA.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      const sB = await cB.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })

      // Round-2 review finding 3 (2026-08-05): the ORIGINAL version awaited
      // each request before sending the next, which makes dispatch-time and
      // serve-time commit of `lastServedSessionId` INDISTINGUISHABLE (every
      // frame is fully processed, including the underlying WarmSession
      // turn, before the next one is even sent) -- the exact bug this test
      // exists to catch could survive it undetected. Firing all three
      // WITHOUT awaiting between them means all three session/prompt
      // FRAMES reach the daemon's dispatcher -- and run their synchronous
      // recycle/lastServedSessionId commit -- well before any of the
      // underlying model turns settle; WarmSession's single global FIFO
      // still serializes actual EXECUTION in enqueue order, but dispatch
      // itself is immediate and races across the two connections.
      const pA1 = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A-MARKER" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })
      const pB1 = cB.request("session/prompt", {
        sessionId: sB.sessionId, prompt: [{ type: "text", text: "B-MARKER" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })
      const pA2 = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A-MARKER-2" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })
      await Promise.all([pA1, pB1, pA2])

      expect(CAPTURED.length).toBe(3)
      const bodiesText = CAPTURED.map((b) => JSON.stringify((b as { messages: unknown[] }).messages))
      // Every marker landed in EXACTLY one body -- none lost, none
      // duplicated across turns. (Frame/dispatch order across the two
      // connections is not itself guaranteed, so this does not assume
      // array position.)
      expect(bodiesText.filter((s) => s.includes("A-MARKER") && !s.includes("A-MARKER-2")).length).toBe(1)
      expect(bodiesText.filter((s) => s.includes("B-MARKER")).length).toBe(1)
      expect(bodiesText.filter((s) => s.includes("A-MARKER-2")).length).toBe(1)
      // UNCONDITIONAL, bidirectional cross-session isolation: no single
      // captured body may carry BOTH an A-family marker and the B marker
      // -- catches A leaking into B AND B leaking into A, in either
      // dispatch order, not just the one direction the original assertion
      // happened to check.
      for (const s of bodiesText) {
        const sawA = s.includes("A-MARKER")       // matches A-MARKER and A-MARKER-2
        const sawB = s.includes("B-MARKER")
        expect(sawA && sawB).toBe(false)
      }
      cA.close(); cB.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a 500 -> ACP_ERR_CALL_CONSUMED with data.callConsumed true, no update", async () => {
    const e = tempEndpoint("500"); LIVE.push(e)
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : okBody("ANSWER", STUB_DECLARED_MODEL)))
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(env)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      await expect(c.request("session/prompt", {
        sessionId: s.sessionId, prompt: [{ type: "text", text: "boom please" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
      expect(updates.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("an unreachable model endpoint AFTER the push -> ACP_ERR_CALL_CONSUMED, never NO_CALL", async () => {
    const e = tempEndpoint("unreachable"); LIVE.push(e)
    const { env } = spawnDaemon(e.home, e.spawnLog, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      KKAMAK_ACP_TURN_TIMEOUT_MS: String(AUTH_RESOLVE_BUDGET_MS),
    })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(env)
    await c.request("initialize", { protocolVersion: 1 })
    const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
    await expect(c.request("session/prompt", {
      sessionId: s.sessionId, prompt: [{ type: "text", text: "never lands" }],
      _meta: { kkamak: { model: AGENT_TEST_MODEL } },
    })).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  // RETIRED, not fixed and not re-skipped (websocket-transport plan, Task
  // 3 Step 2) — same reason as the cancel-notification test above: this
  // test's premise was B's session/prompt + session/cancel written in ONE
  // socket write so the daemon decoded and dispatched both in ONE
  // synchronous pass, guaranteeing the cancel reached ApiSession before
  // B's send boundary. That premise is unconstructible over WebSocket —
  // each `.send()` is its own message, its own event-loop turn, with no
  // "same chunk" left to force two of them into. The underlying finding
  // (ApiSession.drain has no yield point between dequeuing a turn and the
  // send boundary) is unaffected by the transport and still true; this
  // test just can no longer express the premise it needs to exercise it.
  //
  // Also resolves a knock-on effect from the OLD unix-socket version: that
  // test's own `test.todo` conversion (Task 6) was itself a fix for a
  // dangling-promise leak (`aPromise`, uncaught once an earlier assertion
  // threw first, settling asynchronously mid a LATER test and getting its
  // unhandled rejection misattributed to whoever was running at that
  // moment) — deleting the test outright removes that leak's source
  // entirely, not just its symptom.

  test("N3c-iii test 3: pool-exhausted (cap 1) -> -32002 with data.callConsumed false, and the stub captured exactly one request", async () => {
    const e = tempEndpoint("poolexhausted"); LIVE.push(e)
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    try {
      const { env } = spawnDaemon(e.home, e.spawnLog, {
        ANTHROPIC_BASE_URL: cap.url,
        KKAMAK_ACP_MAX_SESSIONS: "1",
        KKAMAK_ACP_TURN_TIMEOUT_MS: String(AUTH_RESOLVE_BUDGET_MS),
      })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(env)
      const cB = await connectNdjson(env)
      await cA.request("initialize", { protocolVersion: 1 })
      await cB.request("initialize", { protocolVersion: 1 })
      const sA = await cA.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })

      // A's prompt is parked in-flight (the stub's FIRST request never
      // answers) -- the cap-1 pool's ONE entry is now busy.
      const aPromise = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A hangs" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })
      const crossed = await until(() => cap.count() >= 1, 30_000)
      expect(crossed).toBe(true)

      const sB = await cB.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      // The pool has ONE entry, busy with A -- pool.acquire never queues
      // (acp-pool.ts's own contract), so B's session/prompt is refused
      // BEFORE anything is sent: -32002, `data.callConsumed:false` (the
      // load-bearing wire contract §2 hands off to the client's L3 step
      // (i) -- boolean data first).
      await expect(cB.request("session/prompt", {
        sessionId: sB.sessionId, prompt: [{ type: "text", text: "B never sent" }],
        _meta: { kkamak: { model: AGENT_TEST_MODEL } },
      })).rejects.toMatchObject({ code: -32002, data: { callConsumed: false } })
      expect(cap.count()).toBe(1)   // still just A's one request -- B never reached the model

      // Tidy shutdown: cancel A rather than wait out its own turn timeout.
      await cA.request("session/cancel", { sessionId: sA.sessionId })
      await aPromise.catch(() => {})
      cA.close(); cB.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)
})
