// acp-client.ts — §6e ACP client: connect-or-spawn, the three-way outcome
// (`ok` / `no-call` / `call-consumed`), and `ensureDaemon`'s spawn-lock
// sequence. Mirrors WarmSession's TurnOutcome across the wire so §6e's
// send-boundary law survives the process boundary.
//
// Imports ONLY acp-paths.ts and acp-wire.ts — never acp-daemon.ts. Callers
// on hook-cli.ts's eager import path (transport.ts, imported at
// hook-cli.ts:24) must be able to import THIS module without transitively
// pulling in anything that can start a server.
import net from "node:net"
import path from "node:path"
import {
  socketPath, ensureSocketDir, spawnLockPath, envFingerprint,
  acquireAcpLock, releaseAcpLock,
} from "./acp-paths.ts"
import {
  FrameDecoder, encodeFrame, ACP_BUDGET,
  ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_UPDATE, ACP_SESSION_CLOSE,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
  type AcpInitializeResult, type AcpNewSessionParams, type AcpNewSessionResult,
  type AcpPromptParams, type AcpPromptResult, type WarmIsolation,
} from "./acp-wire.ts"

/** Mirrors WarmSession's TurnOutcome across the wire so §6e's law survives
 * the process boundary. `model`/`canonicalModel` are the daemon's EVIDENCE
 * (the modelUsage key and its canonicalModel), forwarded verbatim — the
 * caller reconciles them with modelProvenBy.
 *
 * `sessionId` (review-sensor Task 3, additive — no existing consumer
 * breaks) is set when a session was established over the wire, so a caller
 * can later `closeSession` it (close-not-release). In THIS implementation
 * it is populated ONLY on the `ok` branch: it is a `const` scoped inside
 * `run()`'s nested async fn (below), invisible to the outer promise's
 * ambient handlers (socket error/close, the budget timer) and to
 * `run().catch()`'s post-send error classification — both of those sit
 * outside `run()`'s closure. A `no-call`/`call-consumed` outcome can
 * therefore leave `sessionId` undefined even when a session actually WAS
 * established before the failure; treat its absence there as "not
 * threaded", never as "no session existed". */
export type DaemonOutcome =
  | { kind: "ok"; text: string; model: string; canonicalModel: string; sessionId?: string }
  | { kind: "no-call"; sessionId?: string }
  | { kind: "call-consumed"; sessionId?: string }

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

/** §6e law L3's exact three-step post-send decision procedure, applied to a
 * JSON-RPC error received IN RESPONSE to session/prompt (i.e. AFTER the
 * write callback already reported success — the send boundary has been
 * crossed).
 *
 * Step (i): a boolean `data.callConsumed` wins outright, even against a
 * MISMATCHED code (a daemon claiming NO_CALL but reporting
 * `callConsumed: true` is trusted on the data field).
 * Step (ii): with `data` genuinely ABSENT, a recognized code is honoured.
 * Step (iii): anything else (including `data` PRESENT but malformed — a
 * non-boolean `callConsumed` disqualifies step (ii) too, since a malformed
 * data field means the daemon is not the conforming one step (ii) assumes)
 * falls to L2's default: call-consumed. */
function classifyPostSendError(code: number, data: unknown): DaemonOutcome {
  // `data` genuinely ABSENT is the only shape eligible for step (ii)'s
  // code-based fallback below. A non-object `data` (string/number/etc.) is
  // PRESENT-but-malformed, same as an object missing `callConsumed` — both
  // must fall to step (iii)'s call-consumed default, never skip past it
  // into the recognized-code branch (final-review Important 2: the prior
  // `typeof data === "object"` gate let a non-object `data` slip through as
  // if it were absent, which can launder a post-send call-consumed failure
  // into no-call — the double-spend direction).
  if (data !== undefined) {
    const isWellFormedObject = typeof data === "object" && data !== null
    const cc = isWellFormedObject ? (data as { callConsumed?: unknown }).callConsumed : undefined
    if (typeof cc === "boolean") return cc ? { kind: "call-consumed" } : { kind: "no-call" }
    // `data` present but malformed (non-object, or object without a
    // boolean `callConsumed`): NOT eligible for step (ii) either.
    return { kind: "call-consumed" }
  }
  if (code === ACP_ERR_NO_CALL) return { kind: "no-call" }
  if (code === ACP_ERR_CALL_CONSUMED) return { kind: "call-consumed" }
  return { kind: "call-consumed" }
}

/** One record through the daemon. Connect (never spawn) -> initialize
 * (+ fingerprint check) -> session/new -> session/prompt -> collect the
 * update -> close socket.
 *
 * `opts.isolation` is REQUIRED, never defaulted (N3c-iii) — the same
 * "no magic selection" rule the spec's send-prompt-interface ruling already
 * applies to `model`: the caller names its policy explicitly, this file
 * never substitutes one of its own. Sent as `session/new`'s
 * `_meta.kkamak.isolation`.
 *
 * §6e law, client side: `no-call` for EVERY failure that happens BEFORE the
 * session/prompt frame's write callback reports success (L1: no socket,
 * connect refused, initialize/session-new failure, fingerprint mismatch,
 * write error). `call-consumed` for EVERY ambiguity after it (L2). The
 * post-send decision is L3's exact three steps, applied only to an actual
 * JSON-RPC error response to session/prompt; any other post-send failure
 * (socket close, connection error, budget expiry with no response) is L2's
 * default: call-consumed. NEVER throws. */
export function daemonCall(
  outgoingText: string,
  model: string,
  env: Record<string, string | undefined>,
  opts: { isolation: WarmIsolation; budgetMs?: number },
): Promise<DaemonOutcome> {
  const budgetMs = opts.budgetMs ?? ACP_BUDGET.daemonLegMs
  const sock = socketPath(env)
  const fp = envFingerprint(env)

  return new Promise<DaemonOutcome>((resolve) => {
    let settled = false
    // §6e's client-side send boundary: ONE boolean, assigned ONLY in the
    // prompt frame's write callback below. Nothing else in this file writes
    // to it.
    let sentPrompt = false
    let lastUpdateText: string | undefined
    let nextId = 1
    const pending = new Map<number, PendingEntry>()

    // Construct the socket UNCONNECTED and attach every listener (including
    // 'error') BEFORE calling `.connect()` — measured under `bun test`
    // 1.3.1: `net.connect(path)` to a nonexistent path can deliver its
    // 'error' event before a listener attached on the NEXT line ever
    // registers, which (an EventEmitter 'error' with no listener) throws as
    // an uncaught exception instead of producing a `no-call` outcome. A
    // `new net.Socket()` + listen-then-`.connect()` sequence closes that
    // window; `bun run` alone never showed the race, only `bun test` did.
    const socket = new net.Socket()

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      finish(sentPrompt ? { kind: "call-consumed" } : { kind: "no-call" })
    }, budgetMs)

    function finish(outcome: DaemonOutcome): void {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      try { socket.destroy() } catch { /* ignore */ }
      resolve(outcome)
    }

    // Ambient guard: any connection-level failure at ANY point resolves via
    // the sentPrompt boundary alone — before the boundary that is always
    // no-call (nothing could have been delivered), after it that is always
    // call-consumed (the daemon may already have acted on the bytes).
    socket.once("error", () => finish(sentPrompt ? { kind: "call-consumed" } : { kind: "no-call" }))
    socket.once("close", () => finish(sentPrompt ? { kind: "call-consumed" } : { kind: "no-call" }))

    // The connect-wait promise, registered BEFORE `.connect()` is called
    // below — mirrors `probeOnce`'s ordering. Review finding (round after
    // 420b2ce): this listener used to be attached inside `run()`, AFTER
    // `.connect()` had already run, which is the exact same-tick
    // event-delivery race deviation 1's header comment closes for 'error'
    // — left open here for 'connect'. The ambient `once("error")` above
    // already protects the error half regardless of ordering, so only
    // 'connect' was actually exposed: if bun test 1.3.1 ever delivers
    // 'connect' before a listener attached on a later line, `run()` would
    // await forever and the call would burn the full budget against a
    // HEALTHY daemon before falling back. Attaching here, before
    // `socket.connect(sock)`, closes that window the same way deviation 1
    // closes it for 'error'.
    const connected = new Promise<void>((res, rej) => {
      socket.once("connect", () => res())
      socket.once("error", rej)
    })

    // Second layer over FrameDecoder's own StringDecoder on the
    // split-multibyte hazard, matching the daemon (Task 5).
    socket.setEncoding("utf8")
    const decoder = new FrameDecoder()
    socket.connect(sock)

    function request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej })
        socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }), (err) => {
          if (err) { pending.delete(id); rej(err) }
        })
      })
    }

    socket.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        const msg = f as {
          id?: number | string
          method?: string
          params?: unknown
          result?: unknown
          error?: { code: number; message: string; data?: unknown }
        }
        if (msg.id === undefined && msg.method === ACP_SESSION_UPDATE) {
          const p = msg.params as { update?: { content?: { text?: unknown } } } | undefined
          const text = p?.update?.content?.text
          if (typeof text === "string") lastUpdateText = text
          continue
        }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!
          pending.delete(msg.id)
          if (msg.error) {
            entry.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data }))
          } else {
            entry.resolve(msg.result)
          }
        }
      }
    })

    async function run(): Promise<void> {
      await connected

      const init = (await request(ACP_INITIALIZE, { protocolVersion: 1 })) as AcpInitializeResult | undefined
      if (init?._meta?.kkamak?.envFingerprint !== fp) { finish({ kind: "no-call" }); return }

      const newSessionParams = {
        cwd: "/", mcpServers: [], _meta: { kkamak: { isolation: opts.isolation } },
      } satisfies AcpNewSessionParams
      const sessNew = (await request(ACP_SESSION_NEW, newSessionParams)) as AcpNewSessionResult | undefined
      const sessionId = sessNew?.sessionId
      if (!sessionId) { finish({ kind: "no-call" }); return }

      // Defensive yield, measured on Bun 1.3.1: a `socket.write()` issued in
      // the SAME synchronous tick as the data handler that just delivered
      // session/new's response — immediately after a peer that destroyed
      // itself right after flushing that response — neither throws, nor
      // errors its callback, nor fires 'close'/'error' on this socket: it
      // silently vanishes, and only the overall deadline timer would ever
      // resolve the call. One macrotask tick here lets Bun's own close
      // detection run first, so a truly-dead peer surfaces via the write
      // callback (or a synchronous throw) immediately instead of stalling
      // until budgetMs. Negligible cost against a live daemon.
      await new Promise<void>((res) => setTimeout(res, 0))

      const id = nextId++
      const promptFrame = {
        jsonrpc: "2.0", id, method: ACP_SESSION_PROMPT,
        params: {
          sessionId,
          prompt: [{ type: "text", text: outgoingText }],
          _meta: { kkamak: { model } },
        } satisfies AcpPromptParams,
      }
      const respPromise = new Promise<unknown>((res, rej) => pending.set(id, { resolve: res, reject: rej }))
      try {
        // §6e's client-side send boundary — the ONE write-callback
        // assignment site. A write that errors before the callback cannot
        // have delivered a parseable frame (a partial line sits in the
        // daemon's FrameDecoder buffer and is never dispatched), so it is
        // law L1, no-call.
        await new Promise<void>((res, rej) =>
          socket.write(encodeFrame(promptFrame), (err) => (err ? rej(err) : (sentPrompt = true, res()))))
      } catch (e) {
        pending.delete(id)
        throw e
      }

      const result = (await respPromise) as AcpPromptResult | undefined
      finish({
        kind: "ok",
        text: lastUpdateText ?? "",
        model: result?._meta?.kkamak?.model ?? "",
        canonicalModel: result?._meta?.kkamak?.canonicalModel ?? "",
        sessionId,
      })
    }

    run().catch((e) => {
      const err = e as { code?: unknown; data?: unknown }
      if (sentPrompt && typeof err?.code === "number") {
        finish(classifyPostSendError(err.code, err.data))
        return
      }
      finish(sentPrompt ? { kind: "call-consumed" } : { kind: "no-call" })
    })
  })
}

/** A single connect + `initialize` probe. NEVER throws. Destroys the socket
 * and clears its timer before resolving, on every path. Returns true only
 * when a daemon answered with a MATCHING fingerprint. */
function probeOnce(sock: string, fp: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Construct-then-connect, listeners attached first (see daemonCall's
    // matching comment: closes a `bun test`-only race where net.connect()'s
    // 'error' can fire before a listener attached on the next line).
    const socket = new net.Socket()
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.once("error", () => finish(false))
    socket.setEncoding("utf8")
    const decoder = new FrameDecoder()
    socket.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        const msg = f as { id?: number; result?: AcpInitializeResult }
        if (msg.id === 1 && msg.result) {
          finish(msg.result._meta?.kkamak?.envFingerprint === fp)
        }
      }
    })
    socket.once("connect", () => {
      try {
        socket.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: ACP_INITIALIZE, params: { protocolVersion: 1 } }))
      } catch {
        finish(false)
      }
    })
    socket.connect(sock)
  })
}

const PROBE_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 100

/** Close the pool entry that served `sessionId` (review-sensor spec §2:
 * close-not-release). Follows `probeOnce`'s minimal
 * connect-send-await-response shape exactly: construct-then-connect with
 * every listener attached before `.connect()`, socket destroyed and timer
 * cleared before resolving on every path. Close is best-effort by spec —
 * `session/close` is ALWAYS answered (never a JSON-RPC error, per
 * acp-wire.ts's ACP_SESSION_CLOSE contract), and the pool's own idle reap
 * is the backstop for whatever this call cannot reach. NEVER throws: any
 * transport failure at all (no daemon, connection refused, malformed or
 * missing response, budget expiry) resolves `{closed:false,
 * reason:"unreachable"}` rather than rejecting. */
export function closeSession(
  sessionId: string,
  env: Record<string, string | undefined>,
  opts?: { budgetMs?: number },
): Promise<{ closed: boolean; reason?: string }> {
  const budgetMs = opts?.budgetMs ?? PROBE_TIMEOUT_MS
  const sock = socketPath(env)

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const socket = new net.Socket()
    const finish = (result: { closed: boolean; reason?: string }): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = undefined }
      try { socket.destroy() } catch { /* ignore */ }
      resolve(result)
    }
    timer = setTimeout(() => finish({ closed: false, reason: "unreachable" }), budgetMs)
    socket.once("error", () => finish({ closed: false, reason: "unreachable" }))
    socket.setEncoding("utf8")
    const decoder = new FrameDecoder()
    socket.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        const msg = f as { id?: number; result?: { closed?: unknown; reason?: unknown } }
        if (msg.id === 1 && msg.result) {
          const closed = msg.result.closed === true
          const reason = typeof msg.result.reason === "string" ? msg.result.reason : undefined
          finish(reason === undefined ? { closed } : { closed, reason })
        }
      }
    })
    socket.once("connect", () => {
      try {
        socket.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: ACP_SESSION_CLOSE, params: { sessionId } }))
      } catch {
        finish({ closed: false, reason: "unreachable" })
      }
    })
    socket.connect(sock)
  })
}

async function pollUntil(sock: string, fp: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    if (await probeOnce(sock, fp, Math.max(50, Math.min(PROBE_TIMEOUT_MS, remaining)))) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))))
  }
}

// Sibling resolution, same idiom as spawn.ts:12's REFINER_CLI. NEVER
// resolved against a caller's cwd: ensureDaemon runs from a hook process,
// from `bun -e`, and from a test, and none of them share a cwd.
const DAEMON_ENTRY = path.join(import.meta.dir, "acp-daemon.ts")

/** Spawn idiom (repo-established, hook-cli.ts:147-154), argv and env made
 * explicit (round-4 I2). `env` is the SAME object the caller fingerprinted
 * and derived socketPath() from — a daemon launched with a DIFFERENT env
 * computes a different envFingerprint AND binds a different socketPath, so
 * the client that just started it refuses it forever. */
function spawnDaemonProcess(env: Record<string, string | undefined>): void {
  const cmd = ["bun", DAEMON_ENTRY]
  const quoted = cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    env: childEnv, stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
}

/** Ensure a daemon is reachable. `waitMs` DEFAULTS TO 0 = kick and return
 * false immediately (the SessionStart hook's mode). Otherwise poll-connect
 * up to waitMs. Returns true when a daemon answered `initialize` with a
 * MATCHING fingerprint. NEVER throws — including when ensureSocketDir
 * raises EACCES on an unwritable parent. Destroys every socket it opens
 * and clears every timer before resolving.
 *
 * `held` is tracked explicitly and NOTHING is released that was not
 * acquired — `releaseAcpLock` is an unlink; releasing a lock this caller
 * never held would delete the winner's lock and let the next caller spawn
 * a duplicate. */
export async function ensureDaemon(
  env: Record<string, string | undefined>,
  opts?: { waitMs?: number },
): Promise<boolean> {
  const waitMs = opts?.waitMs ?? 0
  try {
    const sock = socketPath(env)
    const fp = envFingerprint(env)

    // 1. probe: a daemon may already be serving.
    if (await probeOnce(sock, fp, PROBE_TIMEOUT_MS)) return true

    // 2. take the CLIENT spawn lock (distinct from the daemon's bind lock).
    ensureSocketDir(sock)
    const lockPath = spawnLockPath(env)
    const held = acquireAcpLock(lockPath, Date.now())

    if (held) {
      // 3. re-probe: a winner may have finished between steps 1 and 2.
      if (await probeOnce(sock, fp, PROBE_TIMEOUT_MS)) {
        releaseAcpLock(lockPath)
        return true
      }
      spawnDaemonProcess(env)
    }
    // 4. !held: another caller is mid-spawn — do NOT spawn, do NOT touch
    //    the lock file.

    // 5.
    if (waitMs === 0) {
      if (held) releaseAcpLock(lockPath)
      return false
    }
    try {
      return await pollUntil(sock, fp, waitMs)
    } finally {
      if (held) releaseAcpLock(lockPath)
    }
  } catch {
    return false
  }
}
