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
import net from "node:net"
import path from "node:path"
import { tmpdir } from "node:os"
import { sseText, hangFirstServer, until } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"
import {
  FrameDecoder, encodeFrame, ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED, AUTH_RESOLVE_BUDGET_MS,
  type WarmIsolation,
} from "../src/acp-wire.ts"
import { envFingerprint } from "../src/acp-paths.ts"
import { createDaemonState, createDispatcher } from "../src/acp-daemon.ts"
import { shortBase } from "./sock-path.ts"
import { SessionPool, type WarmSessionLike, type WarmConstructOpts } from "../src/acp-pool.ts"
import type { TurnOutcome, CancelResult } from "../src/session-contract.ts"

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
// Same split as warm-session.test.ts (T4·1a, measured 2026-08-04): the stub
// DECLARES a dated snapshot id in message_start, but on this streaming-input
// driving path modelUsage's key is actually keyed by the client-requested
// (undated) model, verbatim. Assertions on the daemon's forwarded
// `_meta.kkamak.model` use HAIKU_OBSERVED_KEY, never STUB_DECLARED_MODEL.
const STUB_DECLARED_MODEL = "claude-haiku-4-5-20251001"
const HAIKU_OBSERVED_KEY = HAIKU

/** Every test builds its OWN socket/spawn-log pair under tmpdir. NO TEST MAY
 * EVER TOUCH ~/.config/kkamak/acp-*.sock — the afterEach below asserts it. */
function tempEndpoint(tag: string) {
  // Short base via sock-path.ts: darwin sun_path caps the socket path at 104B.
  const base = shortBase(`d-${tag}`)
  return { sock: `${base}.sock`, spawnLog: `${base}.spawnlog` }
}

/** Spawn the REAL daemon as a detached child.
 *
 * `env` is passed EXPLICITLY and is the SAME object the caller fingerprints
 * (round-4 I2): the daemon computes envFingerprint(process.env) and
 * socketPath(process.env) from what it inherits, so a spawner that
 * fingerprints one env and launches with another gets a daemon on a
 * different path echoing a different fingerprint — mutual refusal forever.
 *
 * KKAMAK_ACP_IDLE_MS is ALWAYS set to a few seconds here (round-4 M8): the
 * production default is 900 000 ms, and a test daemon that survives an
 * afterEach failure would sit on the host for fifteen minutes. */
function spawnDaemon(sock: string, spawnLog: string, extra: Record<string, string> = {}, idleMs = "8000") {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KKAMAK_ACP_SOCKET: sock,
    KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
    KKAMAK_ACP_IDLE_MS: idleMs,
    ...extra,
  }
  const daemon = path.join(import.meta.dir, "..", "src", "acp-daemon.ts")
  const quoted = ["bun", daemon].map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    env, stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  return { env }
}

/** Read the POST-LISTEN pids out of the spawn log and SIGTERM each one, then
 * unlink the socket and both locks. Pid-scoped, never `pkill -f` — §6e
 * forbids host-wide teardown (round-4 I9), and the Bun.spawn handle is the
 * `bash -c nohup` shell, not the daemon. */
function killDaemon(sock: string, spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
  for (const p of [sock, `${sock}.spawn.lock`, `${sock}.bind.lock`, spawnLog]) {
    try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
  }
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

/** Minimal NDJSON ACP client: net.connect + setEncoding + FrameDecoder,
 * matching the framing acp-wire.ts's tests already lock. Each connection
 * gets its OWN request-id counter starting at 1 — the real-world shape, and
 * the reason cancel-scoping must be tag-based (round-3 C2). */
function connectNdjson(sock: string): Promise<{
  request: (method: string, params?: unknown) => Promise<any>
  /** Writes every frame in ONE `socket.write()` call (2026-08-04 review
   * finding, same-chunk-cancel fix). Two SEPARATE `request()`/`notify()`
   * calls in the same synchronous JS tick still issue two SEPARATE socket
   * writes -- the OS/loopback stack is NOT obligated to deliver them to
   * the daemon's `data` handler as one chunk, so a caller relying on
   * "fired back-to-back" for determinism (e.g. a cancel racing a prompt's
   * send boundary) gets a race, not a guarantee -- measured flaky under
   * load post-N3c-iii, once a session's own turn spawns its own CLI
   * subprocess immediately instead of sitting behind a shared queue.
   * Concatenating the encoded frames into a SINGLE write guarantees they
   * land in the SAME `data` chunk, hence the SAME synchronous
   * `decoder.push(chunk)` for-loop pass on the daemon side -- the daemon
   * never yields to I/O between dispatching frame N and frame N+1 from one
   * chunk, so ordering (and therefore "cancel sees the still-unsent turn")
   * is deterministic, not timing-dependent. */
  requestBatch: (frames: Array<{ method: string; params?: unknown }>) => Array<Promise<any>>
  notify: (method: string, params?: unknown) => void
  onNotification: (method: string, cb: (params: any) => void) => void
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock)
    socket.setEncoding("utf8")
    const decoder = new FrameDecoder()
    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
    const notifHandlers = new Map<string, (p: any) => void>()

    socket.once("connect", () => {
      socket.removeListener("error", reject)
      socket.on("error", () => { /* connection torn down mid-test: never crash the test process */ })
      resolve({
        request(method: string, params?: unknown) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej })
            socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }))
          })
        },
        requestBatch(frames: Array<{ method: string; params?: unknown }>) {
          let payload = ""
          const promises = frames.map(({ method, params }) => {
            const id = nextId++
            const p = new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }) })
            payload += encodeFrame({ jsonrpc: "2.0", id, method, params })
            return p
          })
          socket.write(payload)   // ONE write -- see the method's own doc comment above
          return promises
        },
        notify(method: string, params?: unknown) {
          socket.write(encodeFrame({ jsonrpc: "2.0", method, params }))
        },
        onNotification(method: string, cb: (params: any) => void) { notifHandlers.set(method, cb) },
        close() { socket.destroy() },
      })
    })
    socket.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        const msg = f as JsonRpcReply & { method?: string; params?: unknown }
        if (msg.id === undefined && typeof msg.method === "string") {
          const h = notifHandlers.get(msg.method)
          if (h) h(msg.params)
          continue
        }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const p = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
          else p.resolve(msg.result)
        }
      }
    })
    socket.once("error", reject)
  })
}

const LIVE: Array<{ sock: string; spawnLog: string }> = []

const acpDir = () => path.join(process.env.HOME ?? "", ".config", "kkamak")
const acpSocksNow = (): string[] =>
  fs.existsSync(acpDir()) ? fs.readdirSync(acpDir()).filter((f) => f.startsWith("acp-")) : []
const PRE_EXISTING = new Set(acpSocksNow())
const newAcpSocks = (): string[] => acpSocksNow().filter((f) => !PRE_EXISTING.has(f))

afterEach(() => {
  while (LIVE.length) { const e = LIVE.pop()!; killDaemon(e.sock, e.spawnLog) }
  // The hygiene invariant, asserted rather than hoped for — as a DELTA
  // against what was already listening, not absolute emptiness.
  // `~/.config/kkamak` is shared with the live host, and since the
  // review-sensor was armed (2026-08-06, ledger ts 1785996709580) it drives
  // the ACP warm lane, so a real `acp-<fp>.sock` is routinely present while
  // tests run. Absolute emptiness fails every test here on an armed host and
  // wedges the gate that runs them. A genuine leak is still a NEW file.
  expect(newAcpSocks()).toEqual([])
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
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
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

  test("N3c-iii test 5: session/new without isolation -> -32602, and no session is recorded", async () => {
    const e = tempEndpoint("newnoiso"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    await c.request("initialize", { protocolVersion: 1 })
    await expect(c.request("session/new", { cwd: process.cwd(), mcpServers: [] })) // no _meta at all
      .rejects.toMatchObject({ code: -32602 })
    await expect(c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: {} } })) // isolation absent
      .rejects.toMatchObject({ code: -32602 })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("N3c-iii test 4: unknown sessionId -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls", async () => {
    const e = tempEndpoint("unknownsession"); LIVE.push(e)
    const cap = stubServer(() => sseText("SHOULD-NEVER-BE-CALLED"))
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
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
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    await expect(c.request("totally/bogus", {})).rejects.toMatchObject({ code: -32601 })
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a malformed frame does not kill the daemon", async () => {
    const e = tempEndpoint("malformed"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const socket = net.connect(e.sock)
    await new Promise<void>((res, rej) => { socket.once("connect", () => res()); socket.once("error", rej) })
    socket.setEncoding("utf8")
    socket.write("garbage-not-json\n")
    // give the daemon a moment to (not) choke on it, then prove it is alive.
    await new Promise((r) => setTimeout(r, 200))
    socket.destroy()
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  // Unlike its neighbors in this describe block, this test is NOT
  // backend-independent despite the block's name: it relies on the race
  // between dispatch registering the turn as outstanding and
  // `warm.cancel(tag)` reaching it BEFORE `warm.oneShot()` settles — i.e.
  // on the backend implementing real queue/cancel semantics (Task 4's
  // ApiSession.oneShot/cancel), not just "provably nothing was sent yet".
  // Task 1's placeholder backend (`backendNotWiredYet`) throws synchronously
  // with no queue to cancel out of, so the prompt settles via the daemon's
  // generic internal-error path (-32603) before the cancel notification is
  // even processed, not via ACP_ERR_NO_CALL. Skipped until Task 4/5 land a
  // cancel-aware backend; re-enable then.
  test.skip("session/cancel sent as a NOTIFICATION (no id) is honoured and NOT answered", async () => {
    const e = tempEndpoint("cancelnotif"); LIVE.push(e)
    const cap = stubServer(() => sseText("ANSWER", STUB_DECLARED_MODEL))
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)

      // Round-2 review finding 2 (2026-08-05): the ORIGINAL version of this
      // test used `connectNdjson`, whose dispatch silently discards any
      // frame matching neither its "has a numeric id" (response) nor "has
      // no id AND a registered method handler" (notification) paths -- so
      // `sawUnexpectedFrame` above was declared, never assigned, and the
      // `expect` was a tautology that could not fail no matter what the
      // daemon did. This version watches the RAW decoded frame stream
      // directly. The one shape that must never appear is a frame with
      // NEITHER `id` NOR `method`: that is exactly what "answering a
      // notification" would produce on the wire (JSON.stringify drops an
      // `id: undefined` key entirely, and a response has no `method`) --
      // it is not a legal frame under any other circumstance (every
      // legitimate response carries an id, every legitimate notification
      // carries a method).
      const socket = net.connect(e.sock)
      await new Promise<void>((res, rej) => { socket.once("connect", () => res()); socket.once("error", rej) })
      socket.setEncoding("utf8")
      const decoder = new FrameDecoder()
      let nextId = 1
      const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
      let illegalFrame: unknown

      socket.on("data", (chunk) => {
        for (const f of decoder.push(chunk)) {
          const msg = f as { id?: unknown; method?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
          if (msg.id === undefined && msg.method === undefined) illegalFrame = f
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            const p = pending.get(msg.id)!
            pending.delete(msg.id)
            if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
            else p.resolve(msg.result)
          }
        }
      })
      const request = (method: string, params?: unknown): Promise<any> => {
        const id = nextId++
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }))
        })
      }
      await request("initialize", { protocolVersion: 1 })
      const s = await request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })

      // 2026-08-04 review finding (same class as the "SAME JSON-RPC id"
      // cancel-scoping test below): `request()` then `notify()` as two
      // SEPARATE `socket.write()` calls is not a same-chunk guarantee, and
      // post-N3c-iii this session's turn spawns its OWN CLI subprocess
      // immediately (no shared-warm-session queue to hide behind) -- a
      // split delivery can let the cancel notification land AFTER the send
      // boundary crosses, flipping this test's expected ACP_ERR_NO_CALL to
      // ACP_ERR_CALL_CONSUMED nondeterministically. Write BOTH frames in
      // ONE `socket.write()` so the daemon decodes and dispatches them in
      // the SAME synchronous for-loop pass -- the cancel is then
      // guaranteed to run before the turn ever reaches its first real
      // await (the SDK's dynamic import), long before it sends.
      const promptId = nextId++
      const promptPromise = new Promise<any>((resolve, reject) => {
        pending.set(promptId, { resolve, reject })
      })
      const promptFrame = encodeFrame({
        jsonrpc: "2.0", id: promptId, method: "session/prompt",
        params: { sessionId: s.sessionId, prompt: [{ type: "text", text: "cancel me" }], _meta: { kkamak: { model: HAIKU } } },
      })
      const cancelFrame = encodeFrame({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s.sessionId } })
      socket.write(promptFrame + cancelFrame)

      await expect(promptPromise).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      // Give a buggy "answer the notification" frame a moment to arrive.
      await new Promise((r) => setTimeout(r, 200))
      expect(illegalFrame).toBeUndefined()
      socket.destroy()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("idle reaper drains, exits, and removes the socket", async () => {
    const e = tempEndpoint("idle"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog, {}, "1500")
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const lines = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const pid = Number(lines[0]?.trim().split(/\s+/)[0])
    const c = await connectNdjson(e.sock)
    await c.request("initialize", { protocolVersion: 1 })
    c.close()
    // reaper ticks at min(60s, idleMs/3) = 500ms here; give it comfortable
    // margin over the 1500ms idle budget.
    const gone = await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 8_000)
    expect(gone).toBe(true)
    expect(fs.existsSync(e.sock)).toBe(false)
  }, DAEMON_TEST_TIMEOUT_MS)

  test("stale socket file is taken over under the BIND lock", async () => {
    const e = tempEndpoint("stale"); LIVE.push(e)
    fs.mkdirSync(path.dirname(e.sock), { recursive: true })
    fs.writeFileSync(e.sock, "")   // a dead file, not a live listener
    spawnDaemon(e.sock, e.spawnLog)
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a LIVE socket is not taken over: the second starter exits 0, writes NO spawn-log line, and the first still answers", async () => {
    const e = tempEndpoint("live"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog)
    const first = await waitForSpawnLog(e.spawnLog, 1, 15_000)
    expect(first.length).toBe(1)
    // Second starter, same socket/spawn-log pair: must see the first as
    // live and refuse to bind, writing nothing.
    spawnDaemon(e.sock, e.spawnLog)
    // Settle time for the second starter to probe and exit.
    await new Promise((r) => setTimeout(r, 2_000))
    const lines = fs.readFileSync(e.spawnLog, "utf-8").split("\n").filter((l) => l.trim())
    expect(lines.length).toBe(1)
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("ROUND-4 I2: the daemon binds and echoes from the env it was GIVEN, not from an ambient one", async () => {
    const e = tempEndpoint("envcontract"); LIVE.push(e)
    const { env } = spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_MODEL: "probe-value" })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    const init = await c.request("initialize", { protocolVersion: 1 })
    expect(init._meta.kkamak.envFingerprint).toBe(envFingerprint(env))
    c.close()
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
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
    const dispatch = createDispatcher(pool, state, "fp")
    const frames: Array<Record<string, unknown>> = []
    const write = (m: object) => frames.push(m as Record<string, unknown>)

    await dispatch({ id: 1, method: "session/close", params: { sessionId: "never-served-anything" } }, write)
    expect(frames[0]).toMatchObject({ result: { closed: false, reason: "unknown-session" } })
  })

  test("session/close while the entry is busy responds closed:false busy (pool guard)", async () => {
    const { pool, calls } = fakeDispatchPool()
    const state = createDaemonState()
    const S = "session-under-test-busy"
    state.sessions.set(S, { createdAt: Date.now(), isolation: TEST_ISOLATION })
    const dispatch = createDispatcher(pool, state, "fp")
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
// Task 1 of the api-sdk-swap plan ports the agnostic core with NO session
// backend (see acp-pool.ts's now-required `makeSession`; src/acp-daemon.ts's
// `backendNotWiredYet` placeholder). Every test below dispatches a real
// `session/prompt` through a really-spawned daemon and expects the stubbed
// model's answer to come back — that requires an actual backend behind
// `pool.acquire()`, which does not exist until ApiSession lands (Task 4) and
// is wired in as the pool's default (Task 5). Unconditionally skipped until
// then; re-enable (drop `.skip`, restore `describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)`
// for the CLI-credentials gate this block also needs) as part of Task 5.
describe.skip("acp-daemon over unix socket (reaches the stubbed model)", () => {
  test("initialize -> session/new -> session/prompt round-trip, fingerprint and PROVEN-model evidence echoed", async () => {
    const e = tempEndpoint("rt"); LIVE.push(e)
    const cap = stubServer(() => sseText("ANSWER", STUB_DECLARED_MODEL))
    try {
      const { env } = spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
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
      // ROUND-4 C1: the daemon forwards the modelUsage KEY VERBATIM -- on
      // THIS driving path that key is the client-requested model, verbatim
      // (T4·1a). Never assert STUB_DECLARED_MODEL here.
      expect(r._meta.kkamak.model).toBe(HAIKU_OBSERVED_KEY)
      expect(typeof r._meta.kkamak.canonicalModel).toBe("string")
      expect(r._meta.kkamak.callConsumed).toBe(true)
      expect(updates.join("")).toContain("ANSWER")
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("N3c-iii test 1: two sessions with DIFFERENT isolations never share a warm entry -- the marker system prompt appears ONLY on the marker-isolation session's captured request bodies", async () => {
    const e = tempEndpoint("isoseg"); LIVE.push(e)
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })

      const sGauge = await c.request("session/new", {
        cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } },
      })
      await c.request("session/prompt", {
        sessionId: sGauge.sessionId, prompt: [{ type: "text", text: "gauge turn" }],
        _meta: { kkamak: { model: HAIKU } },
      })

      const sMarker = await c.request("session/new", {
        cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: MARKER_ISOLATION } },
      })
      await c.request("session/prompt", {
        sessionId: sMarker.sessionId, prompt: [{ type: "text", text: "marker turn" }],
        _meta: { kkamak: { model: HAIKU } },
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
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })

      const s1 = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      await c.request("session/prompt", {
        sessionId: s1.sessionId, prompt: [{ type: "text", text: "FIRST-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })

      const s2 = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      await c.request("session/prompt", {
        sessionId: s2.sessionId, prompt: [{ type: "text", text: "SECOND-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      expect(CAPTURED.length).toBe(2)
      const m2 = CAPTURED[1] as { messages: unknown[] }
      expect(JSON.stringify(m2.messages)).not.toContain("FIRST-MARKER")
      expect(JSON.stringify(m2.messages)).toContain("SECOND-MARKER")

      // A THIRD prompt reusing the SECOND sessionId: context must NOT be
      // cleared, so the second prompt's marker is still present.
      await c.request("session/prompt", {
        sessionId: s2.sessionId, prompt: [{ type: "text", text: "THIRD-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
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
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_DECLARED_MODEL) })
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(e.sock)
      const cB = await connectNdjson(e.sock)
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
        _meta: { kkamak: { model: HAIKU } },
      })
      const pB1 = cB.request("session/prompt", {
        sessionId: sB.sessionId, prompt: [{ type: "text", text: "B-MARKER" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      const pA2 = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A-MARKER-2" }],
        _meta: { kkamak: { model: HAIKU } },
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
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER", STUB_DECLARED_MODEL)))
    try {
      spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const c = await connectNdjson(e.sock)
      await c.request("initialize", { protocolVersion: 1 })
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      await expect(c.request("session/prompt", {
        sessionId: s.sessionId, prompt: [{ type: "text", text: "boom please" }],
        _meta: { kkamak: { model: HAIKU } },
      })).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
      expect(updates.length).toBe(0)
      c.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("an unreachable model endpoint AFTER the push -> ACP_ERR_CALL_CONSUMED, never NO_CALL", async () => {
    const e = tempEndpoint("unreachable"); LIVE.push(e)
    spawnDaemon(e.sock, e.spawnLog, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      KKAMAK_ACP_TURN_TIMEOUT_MS: String(AUTH_RESOLVE_BUDGET_MS),
    })
    await waitForSpawnLog(e.spawnLog, 1, 15_000)
    const c = await connectNdjson(e.sock)
    await c.request("initialize", { protocolVersion: 1 })
    const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
    await expect(c.request("session/prompt", {
      sessionId: s.sessionId, prompt: [{ type: "text", text: "never lands" }],
      _meta: { kkamak: { model: HAIKU } },
    })).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
    c.close()
  }, DAEMON_TEST_TIMEOUT_MS)

  test("session/cancel is SCOPED even when BOTH clients use the SAME JSON-RPC id", async () => {
    const e = tempEndpoint("scoped-cancel"); LIVE.push(e)
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    try {
      spawnDaemon(e.sock, e.spawnLog, {
        ANTHROPIC_BASE_URL: cap.url,
        KKAMAK_ACP_TURN_TIMEOUT_MS: String(AUTH_RESOLVE_BUDGET_MS),
      })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(e.sock)
      const cB = await connectNdjson(e.sock)
      await cA.request("initialize", { protocolVersion: 1 })
      await cB.request("initialize", { protocolVersion: 1 })
      const sA = await cA.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })

      // A's prompt hangs (the stub's FIRST request never answers). Both
      // connections start their own id counter at 1, so A's session/prompt
      // (id=2, after initialize+session/new) and B's FIRST request will
      // legitimately collide in id-space -- the scoping must come from the
      // daemon-minted tag, never the wire id.
      const aPromise = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A hangs" }],
        _meta: { kkamak: { model: HAIKU } },
      })
      // A has provably crossed the send boundary once the stub observed a
      // request (round-4 C3/I11) -- only then is B's cancel meaningful.
      const crossed = await until(() => cap.count() >= 1, 30_000)
      expect(crossed).toBe(true)

      const sB = await cB.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })
      // 2026-08-04 review finding: post-N3c-iii, B's prompt no longer
      // queues behind a shared single WarmSession (that used to be an
      // unbounded window a plain `request()`-then-`request()` pair could
      // exploit for free) -- B now acquires its OWN pool entry and its OWN
      // CLI subprocess starts spawning immediately (~1.3s window,
      // measured). Two SEPARATE socket writes racing that window are not
      // deterministic under load (measured: 1016/1 in an independent run,
      // B landing ACP_ERR_CALL_CONSUMED instead of the asserted no-call).
      // `requestBatch` writes B's session/prompt AND session/cancel in ONE
      // socket write, so the daemon decodes and dispatches both in the
      // SAME synchronous for-loop pass -- cancel is guaranteed to run
      // before B's turn ever reaches its first real await (the SDK's
      // dynamic import), long before the send boundary. B's own id
      // counter is still whatever it is at this point (which, by
      // construction, may equal one of A's ids) -- the scoping must come
      // from the daemon-minted tag, never the wire id, same as before.
      const [bPromise, bCancelAckPromise] = cB.requestBatch([
        { method: "session/prompt", params: {
          sessionId: sB.sessionId, prompt: [{ type: "text", text: "B cancelled pre-send" }],
          _meta: { kkamak: { model: HAIKU } },
        } },
        { method: "session/cancel", params: { sessionId: sB.sessionId } },
      ])
      await bCancelAckPromise

      await expect(bPromise).rejects.toMatchObject({ code: ACP_ERR_NO_CALL, data: { callConsumed: false } })
      // A must never be cancelled by B -- it ends on its OWN turn timeout.
      await expect(aPromise).rejects.toMatchObject({ code: ACP_ERR_CALL_CONSUMED, data: { callConsumed: true } })
      cA.close(); cB.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("N3c-iii test 3: pool-exhausted (cap 1) -> -32002 with data.callConsumed false, and the stub captured exactly one request", async () => {
    const e = tempEndpoint("poolexhausted"); LIVE.push(e)
    const cap = hangFirstServer("ANSWER", STUB_DECLARED_MODEL)
    try {
      spawnDaemon(e.sock, e.spawnLog, {
        ANTHROPIC_BASE_URL: cap.url,
        KKAMAK_ACP_MAX_SESSIONS: "1",
        KKAMAK_ACP_TURN_TIMEOUT_MS: String(AUTH_RESOLVE_BUDGET_MS),
      })
      await waitForSpawnLog(e.spawnLog, 1, 15_000)
      const cA = await connectNdjson(e.sock)
      const cB = await connectNdjson(e.sock)
      await cA.request("initialize", { protocolVersion: 1 })
      await cB.request("initialize", { protocolVersion: 1 })
      const sA = await cA.request("session/new", { cwd: process.cwd(), mcpServers: [], _meta: { kkamak: { isolation: TEST_ISOLATION } } })

      // A's prompt is parked in-flight (the stub's FIRST request never
      // answers) -- the cap-1 pool's ONE entry is now busy.
      const aPromise = cA.request("session/prompt", {
        sessionId: sA.sessionId, prompt: [{ type: "text", text: "A hangs" }],
        _meta: { kkamak: { model: HAIKU } },
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
        _meta: { kkamak: { model: HAIKU } },
      })).rejects.toMatchObject({ code: -32002, data: { callConsumed: false } })
      expect(cap.count()).toBe(1)   // still just A's one request -- B never reached the model

      // Tidy shutdown: cancel A rather than wait out its own turn timeout.
      await cA.request("session/cancel", { sessionId: sA.sessionId })
      await aPromise.catch(() => {})
      cA.close(); cB.close()
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)
})
