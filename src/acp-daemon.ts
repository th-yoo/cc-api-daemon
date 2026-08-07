// acp-daemon.ts — §6e ACP daemon: a SessionPool (acp-pool.ts) of WarmSessions
// behind the ACP wire subset, implementing the §6e wire-send boundary law.
//
// N3c-iii (2026-08-04): rewired off a single `WarmSession` onto the pool.
// The daemon still mints one ACP session id per REQUEST (session/new is
// cheap: a UUID plus recording the caller's isolation), but the keep-alive
// underneath is now a pool of WarmSessions keyed by isolation VALUE — a
// caller-chosen isolation crosses the wire on session/new instead of the
// daemon defaulting every session to the one hardcoded gauge isolation.
//
// THE ENV CONTRACT (round-4 I2): this process fingerprints and binds from
// its OWN process.env — envFingerprint(process.env) is what `initialize`
// echoes and socketPath(process.env) is what it listens on. Whoever spawns
// it MUST pass, explicitly, the same env object it fingerprinted. The repo's
// established detached-spawn idiom (hook-cli.ts:147-154) passes no `env` and
// inherits, which is correct only when the spawner fingerprinted
// process.env itself. acp-client.ts's ensureDaemon (a later node) passes it
// explicitly.
//
// session/new is cheap (UUID mint + a well-formedness check on the caller's
// isolation) and its `cwd` is accepted-and-IGNORED (the instrument pins a
// neutral cwd, §6e delta (b)); the /clear recycle happens when a prompt
// lands on a pool entry whose last DISPATCH-time occupant was a DIFFERENT
// session — so a multi-prompt ACP session keeps its context while the
// deriver (fresh session per record) always gets a clean one, exactly as
// before, just tracked per pool entry (`lastServedBySessionForEntry`) now
// that more than one warm entry can exist. Committed at DISPATCH time, not
// serve time, or interleaved sessions leak context into each other — same
// reasoning as the pre-pool `lastServedSessionId`, just re-scoped.
//
// Cancel tags are DAEMON-MINTED UUIDs, never the client's JSON-RPC id: two
// clients both start their id counters at 1, and a colliding tag would let
// one caller's cancel interrupt another caller's already-billed turn.
//
// Failure is a JSON-RPC ERROR carrying data.callConsumed (law L3 step (i)'s
// authoritative channel), never a fake stopReason, and the outcome is passed
// straight through from TurnOutcome.kind — the daemon adds no classification
// of its own.
//
// The MODEL fields are forwarded VERBATIM from TurnOutcome (the modelUsage
// KEY and its canonicalModel) and are NEVER compared here: the real API keys
// usage by the dated snapshot id while callers request the undated alias
// (round-4 C1), and reconciliation via modelProvenBy belongs at the caller,
// which is the only party that knows what it asked for.
//
// `_meta` is namespaced under `kkamak` throughout (T2n) — the ACP
// extensibility rule reserves bare `_meta` root keys for the protocol
// itself; acp-wire.ts's Acp* types are the authority, this file just
// produces/consumes literals shaped like them.
//
// EVERY runtime side effect below is behind `import.meta.main`. acp-client
// imports NOTHING from this file (see acp-paths.ts's own header for why the
// path helpers live in a separate module the hook can safely import).
import net from "node:net"
import fs from "node:fs"
import crypto from "node:crypto"
import type { TurnOutcome, DispatchableSession } from "./session-contract.ts"
import { SessionPool } from "./acp-pool.ts"
import {
  socketPath, ensureSocketDir, bindLockPath, envFingerprint, isPipe,
  acquireAcpLock, releaseAcpLock,
} from "./acp-paths.ts"
import {
  FrameDecoder, encodeFrame,
  ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_CANCEL, ACP_SESSION_UPDATE,
  ACP_SESSION_CLOSE,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
  type WarmIsolation,
} from "./acp-wire.ts"

/** Production idle budget: 15 minutes. `KKAMAK_ACP_IDLE_MS` overrides for
 * tests (a few seconds) — acp-paths.ts's denylist note is explicit that
 * this is a daemon OPERATING parameter, not an instrument parameter, so it
 * never enters the fingerprint. */
const DEFAULT_IDLE_MS = 900_000

type Write = (msg: object) => void

/** The daemon's own view of a pooled entry's warm session — SessionPool's
 * own `WarmSessionLike` (acp-pool.ts) is deliberately narrow to exactly what
 * the POOL itself calls (reap/quiescent/closeAll); `oneShot`/`cancel` are
 * never called BY the pool, only by whichever caller acquired the entry,
 * which from here on is this daemon (acp-pool.ts's own header comment says
 * as much: "the pool itself never calls" them). `DispatchableSession`
 * (session-contract.ts) states that wider contract once, checked against
 * every backend, rather than borrowing signatures off one concrete class —
 * with two backends there is no single class to borrow from anymore.
 * `PoolEntry.warm` is statically typed `WarmSessionLike`; every real entry
 * (default `makeSession`, or a DI fake built to match) satisfies this wider
 * shape structurally at runtime, so the cast at the dispatch site below is
 * safe — the same interface-segregation cast already established in
 * acp-daemon.test.ts's own `fakeWarmSession` cast to the concrete class. */

export interface DaemonState {
  sessions: Map<string, { createdAt: number; isolation: WarmIsolation }>
  /** sessionId -> the ordered (oldest-first) list of {tag, warm} pairs for
   * that session's turns CURRENTLY outstanding (queued or in flight).
   * Round-2 review finding 1 (2026-08-05): a single Map<sessionId, tag>
   * mishandles two same-session prompts in flight at once — the second
   * prompt's tag would overwrite the first's (a cancel would then hit the
   * WRONG turn), and the first prompt's `finally` would delete the key
   * outright, so a cancel arriving while the second turn is still
   * outstanding would find nothing and silently no-op. An array per
   * session, with `session/cancel` targeting the OLDEST live tag and each
   * turn removing only ITS OWN tag on completion, keeps both turns
   * independently cancellable and never wipes a sibling's entry.
   *
   * N3c-iii: each entry now also carries WHICH warm (pool entry) the tag
   * belongs to — with a pool of entries instead of one singleton
   * WarmSession, a cancel must resolve against the SAME warm the dispatch
   * that minted the tag used, never a different pool entry's WarmSession
   * (self-review (b)). */
  outstanding: Map<string, Array<{ tag: string; warm: DispatchableSession }>>
  /** pool entry id -> the sessionId that last DISPATCHED a turn on it.
   * Replaces the pre-pool `lastServedSessionId` global: with more than one
   * warm entry alive at once, "was the LAST session to use THIS SPECIFIC
   * entry the same one asking now" has to be tracked per entry, not
   * globally, or a second entry's first-ever use would spuriously compare
   * against an unrelated entry's last session. */
  lastServedBySessionForEntry: Map<string, string>
}

export function createDaemonState(): DaemonState {
  return { sessions: new Map(), outstanding: new Map(), lastServedBySessionForEntry: new Map() }
}

function readModel(params: unknown): string | undefined {
  const m = (params as { _meta?: { kkamak?: { model?: unknown } } } | undefined)?._meta?.kkamak?.model
  return typeof m === "string" && m.length > 0 ? m : undefined
}

/** Full structural validation against the `WarmIsolation` interface
 * (acp-wire.ts), field-for-field. A shallow `typeof iso === "object"` check
 * (the prior implementation) accepts `{}`, `[]`, and any partial object —
 * and the accepted value is spread RAW into the session backend's own
 * construction options, so a missing `tools`/`settingSources`/`settings`/
 * `strictMcpConfig` field does not fail closed, it silently restores the
 * FULL claude-code harness (tools, CLAUDE.md, auto-memory, MCP) — exactly
 * the instrument contamination §6e isolation exists to prevent (final-review
 * Important 1). This is therefore a security boundary, not a convenience
 * check: every field the wider system trusts to be present and pinned must
 * be verified present and correctly shaped here, not deferred to whatever
 * happens to read the object next. `Array.isArray` is rejected explicitly
 * because arrays are `typeof "object"` and satisfy no field access at all
 * (every property read below would be `undefined`, tripping the same
 * failure this function exists to catch — checked first for a clearer
 * reason to reject). */
function isWellFormedIsolation(iso: unknown): iso is WarmIsolation {
  if (iso === null || typeof iso !== "object" || Array.isArray(iso)) return false
  const o = iso as Record<string, unknown>
  if (typeof o.systemPrompt !== "string") return false
  // `settingSources` and `tools` are typed as the LITERAL empty tuple `[]`
  // in WarmIsolation (acp-wire.ts:137-146), not `string[]` — an
  // `Array.isArray` check alone accepts a crafted `tools: ["Bash"]` or
  // `settingSources: ["project"]`, which is spread raw into `query()` and
  // restores tool access / CLAUDE.md loading (per the SDK: `tools: []` is
  // what disables the built-ins, `settingSources` including `"project"` is
  // what loads CLAUDE.md) — the exact contamination class this validator
  // exists to close (re-review residual on final-review Important 1).
  // Length, not just shape, must be checked.
  if (!Array.isArray(o.settingSources) || o.settingSources.length !== 0) return false
  if (o.settings === null || typeof o.settings !== "object" || Array.isArray(o.settings)) return false
  if ((o.settings as Record<string, unknown>).autoMemoryEnabled !== false) return false
  if (o.persistSession !== false) return false
  if (o.strictMcpConfig !== true) return false
  if (!Array.isArray(o.tools) || o.tools.length !== 0) return false
  if (typeof o.title !== "string") return false
  if (o.thinking === null || typeof o.thinking !== "object" || Array.isArray(o.thinking)) return false
  // `thinking.type` is the closed union `"disabled" | "enabled"`
  // (acp-wire.ts:145) — a bare `typeof === "string"` check let any string
  // ("adaptive", garbage) through.
  const thinkingType = (o.thinking as Record<string, unknown>).type
  if (thinkingType !== "disabled" && thinkingType !== "enabled") return false
  return true
}

function readIsolation(params: unknown): WarmIsolation | undefined {
  const iso = (params as { _meta?: { kkamak?: { isolation?: unknown } } } | undefined)?._meta?.kkamak?.isolation
  return isWellFormedIsolation(iso) ? iso : undefined
}

function readSessionId(params: unknown): string | undefined {
  const s = (params as { sessionId?: unknown } | undefined)?.sessionId
  return typeof s === "string" && s.length > 0 ? s : undefined
}

function readPromptText(params: unknown): string {
  const prompt = (params as { prompt?: Array<{ text?: unknown }> } | undefined)?.prompt
  if (!Array.isArray(prompt)) return ""
  return prompt.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
}

/** ONE dispatcher per daemon, not per connection: `state` is shared across
 * every accepted socket because ACP session ids are globally unique
 * (session/new mints a UUID) and there is exactly one SessionPool behind
 * the whole process, so `lastServedBySessionForEntry` and `outstanding` must
 * be daemon-global — a per-connection copy would let two connections each
 * believe they own the "last served" slot for a shared pool entry. `write`
 * IS per-connection: notifications and the eventual response for a given
 * request always go back down the connection that sent it.
 *
 * STRUCTURAL RULE: this function must never throw across a connection
 * handler — every branch answers a JSON-RPC result or error frame (or, for
 * a bare notification, nothing) instead of raising. */
export function createDispatcher(pool: SessionPool, state: DaemonState, fingerprint: string) {
  return async function handle(frame: unknown, write: Write): Promise<void> {
    const req = frame as { id?: number | string; method?: unknown; params?: unknown }
    const id = req.id
    const method = typeof req.method === "string" ? req.method : ""
    const params = req.params

    // A notification (no id) is NEVER answered — JSON-RPC 2.0. This single
    // guard is why session/cancel can serve both the ACP-proper
    // notification shape and our own client's request-with-ack shape
    // without special-casing either.
    const respond = (result: unknown): void => {
      if (id === undefined) return
      write({ jsonrpc: "2.0", id, result })
    }
    const respondError = (code: number, message: string, data?: { callConsumed: boolean }): void => {
      if (id === undefined) return
      write({ jsonrpc: "2.0", id, error: data ? { code, message, data } : { code, message } })
    }

    // Defense-in-depth for the catch-all below (WarmSession's own contract
    // is to never throw, so this flag should never matter in practice):
    // once we are past the L4 sessionId/model guard and about to call
    // warm.oneShot, an unexpected exception can no longer be PROVEN
    // unsent, so the fallback must not claim callConsumed:false and risk
    // a caller retrying an already-billed turn.
    let mayHaveConsumed = false

    try {
      switch (method) {
        case ACP_INITIALIZE: {
          respond({
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
            _meta: { kkamak: { envFingerprint: fingerprint } },
          })
          return
        }

        case ACP_SESSION_NEW: {
          // params.cwd is ACCEPTED AND IGNORED (§6e delta (b): the
          // instrument pins a neutral cwd). Isolation is REQUIRED: full
          // structural validation against WarmIsolation, field-for-field
          // (isWellFormedIsolation's own comment) — a missing/malformed
          // isolation means nothing CAN be pushed under any policy, so this
          // is invalid params (-32602), not a model-call error class:
          // nothing was spent, no `data.callConsumed` to report. Cheap
          // otherwise — no model work, no recycle — so an abandoned
          // session/new costs nothing.
          const isolation = readIsolation(params)
          if (!isolation) {
            respondError(-32602, "session/new requires a well-formed _meta.kkamak.isolation")
            return
          }
          const sessionId = crypto.randomUUID()
          state.sessions.set(sessionId, { createdAt: Date.now(), isolation })
          respond({ sessionId })
          return
        }

        case ACP_SESSION_PROMPT: {
          const sessionId = readSessionId(params)
          const model = readModel(params)
          // Law L4: a missing/non-string sessionId or model means nothing
          // CAN be pushed — refuse before the pool is touched at all, so
          // this is a provably zero-model-call no-call.
          if (!sessionId || !model) {
            respondError(
              ACP_ERR_NO_CALL,
              "session/prompt requires sessionId and a non-empty _meta.kkamak.model",
              { callConsumed: false },
            )
            return
          }
          // An UNKNOWN sessionId (never minted by THIS daemon's session/new,
          // or already forgotten) is likewise a provable no-call — nothing
          // was ever spent under a session id nobody registered. Fixes the
          // N3a review's "write-only sessions map" minor: the map is now
          // read here, for the first time, and a fabricated sessionId no
          // longer reaches the pool at all, let alone bills a turn.
          const session = state.sessions.get(sessionId)
          if (!session) {
            respondError(ACP_ERR_NO_CALL, "unknown sessionId", { callConsumed: false })
            return
          }
          const text = readPromptText(params)

          const acquired = pool.acquire(session.isolation, Date.now())
          if (!acquired.ok) {
            // Pool exhaustion: NOTHING was sent to any warm entry, so this
            // is a provable no-call, same law as every other pre-send
            // refusal above — just a different JSON-RPC code (§6e's L3 step
            // (i), `data.callConsumed` boolean, is what the client actually
            // keys its classification on; the code here is diagnostic).
            respondError(
              -32002,
              "no warm session available (KKAMAK_ACP_MAX_SESSIONS reached)",
              { callConsumed: false },
            )
            return
          }
          const { entry, mustRecycle } = acquired
          const warm = entry.warm as unknown as DispatchableSession

          // §6e: recycle and lastServedBySessionForEntry are computed and
          // committed in the SAME synchronous step, at dispatch time,
          // BEFORE warm.oneShot is called. Committing at serve time instead
          // is a context-leak bug across interleaved sessions (see this
          // file's header and the brief's worked example).
          //
          // `mustRecycle` alone is the pool's OWN signal ("this entry has
          // served some turn before, whoever it was") — it says nothing
          // about WHICH session last used THIS entry, so on its own it
          // would recycle a session's own SECOND sequential prompt against
          // itself (the entry it gets back was, of course, "used before").
          // Recycle only when the entry's history belongs to a DIFFERENT
          // session than this one; a session picking up its own
          // just-released entry keeps growing its own context untouched.
          const lastSessionForEntry = state.lastServedBySessionForEntry.get(entry.id)
          const recycle = mustRecycle && lastSessionForEntry !== sessionId
          state.lastServedBySessionForEntry.set(entry.id, sessionId)

          // The cancel tag is DAEMON-MINTED and globally unique — never
          // the client's JSON-RPC id, which every client starts counting
          // from 1, so two concurrent callers' ids collide routinely.
          const tag = crypto.randomUUID()
          const outstandingForSession = state.outstanding.get(sessionId) ?? []
          outstandingForSession.push({ tag, warm })
          state.outstanding.set(sessionId, outstandingForSession)
          mayHaveConsumed = true
          try {
            const outcome: TurnOutcome = await warm.oneShot(text, model, { recycle, tag })
            if (outcome.kind === "ok") {
              // ONE session/update notification carrying the full text,
              // THEN the result — never the other order, or a client
              // racing on the result could miss the chunk.
              write({
                jsonrpc: "2.0",
                method: ACP_SESSION_UPDATE,
                params: {
                  sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: outcome.text } },
                },
              })
              respond({
                stopReason: "end_turn",
                _meta: { kkamak: { model: outcome.model, canonicalModel: outcome.canonicalModel, callConsumed: true } },
              })
              return
            }
            if (outcome.kind === "no-call") {
              respondError(ACP_ERR_NO_CALL, "no model call was made", { callConsumed: false })
              return
            }
            // outcome.kind === "call-consumed"
            respondError(ACP_ERR_CALL_CONSUMED, "a model call was made but the turn did not complete", { callConsumed: true })
            return
          } finally {
            // Release the entry back to the pool on EVERY path through this
            // turn (self-review (c)) — the pool cannot know a turn has
            // settled any other way, and an entry never released is an
            // entry the pool can never hand to anyone else again.
            pool.release(entry.id, Date.now())
            // Remove ONLY this turn's own tag — never the whole key — so a
            // sibling turn for the same session (still queued/in flight)
            // stays independently cancellable after this one settles.
            const remaining = state.outstanding.get(sessionId)
            if (remaining) {
              const i = remaining.findIndex((o) => o.tag === tag)
              if (i >= 0) remaining.splice(i, 1)
              if (remaining.length === 0) state.outstanding.delete(sessionId)
            }
          }
        }

        case ACP_SESSION_CANCEL: {
          const sessionId = readSessionId(params)
          const outstandingForSession = sessionId ? state.outstanding.get(sessionId) : undefined
          // Target the OLDEST outstanding {tag, warm} for this session —
          // the turn closest to (or already) running, and the one a caller
          // sending a bare "cancel my session" almost always means. The
          // `warm` reference here is exactly the one THAT dispatch acquired
          // from the pool — self-review (b): a cancel for this session can
          // therefore never reach a DIFFERENT pool entry's WarmSession, by
          // construction, regardless of what the pool has done with any
          // OTHER entry since.
          const oldest = outstandingForSession && outstandingForSession.length > 0 ? outstandingForSession[0] : undefined
          // All four CancelResult values are treated identically on the
          // wire — the caller learns the real outcome from its
          // session/prompt reply (§6e L4/L7 guarantee it lands on the
          // right code), never from this ack. A cancel naming an
          // unknown/finished session is a no-op (nothing outstanding to
          // find) that still answers `{}` when an id was present.
          if (oldest) oldest.warm.cancel(oldest.tag)
          respond({})
          return
        }

        case ACP_SESSION_CLOSE: {
          // review-sensor build prerequisite: reverse-lookup the pool entry
          // that last DISPATCHED a turn for this sessionId
          // (state.lastServedBySessionForEntry, entryId -> sessionId) and
          // hand it to the pool's own close-not-release guard
          // (SessionPool.closeEntry, task 1). An unknown sessionId — never
          // served by this daemon, or already closed — is a no-op by the
          // same law as session/cancel's own ack: ALWAYS a response, never
          // an error frame.
          const sessionId = readSessionId(params)
          let entryId: string | undefined
          for (const [eid, sid] of state.lastServedBySessionForEntry) {
            if (sid === sessionId) { entryId = eid; break }
          }
          const result = entryId === undefined
            ? { closed: false, reason: "unknown-session" }
            : pool.closeEntry(entryId)
          if (result.closed && entryId !== undefined) {
            state.lastServedBySessionForEntry.delete(entryId)
          }
          respond(result)
          return
        }

        default:
          respondError(-32601, `unknown method: ${method}`)
          return
      }
    } catch (e) {
      // Structural rule: the dispatcher must never throw across a
      // connection handler. warm.oneShot()/warm.cancel() are designed to
      // always resolve/return without throwing, so this branch is a
      // second layer, not the primary contract — but it is what keeps a
      // dispatcher bug from taking the whole daemon down. `callConsumed`
      // follows `mayHaveConsumed`, not a blanket `false`: a lie in the
      // no-call direction here would tell a caller it is safe to retry a
      // turn that may already have been billed.
      respondError(-32603, e instanceof Error ? e.message : "internal dispatcher error", { callConsumed: mayHaveConsumed })
    }
  }
}

// ── import.meta.main only, below this line ─────────────────────────────

// No session backend is wired at this layer yet — this is Task 1 of the
// api-sdk-swap plan (agnostic core only, backend absent by design; see
// acp-pool.ts's now-required `makeSession`). Task 5 threads a real
// makeSession (ApiSession by default) into these two entry points. Until
// then this placeholder makes an accidental CLI invocation fail loudly
// rather than silently defaulting to a backend that doesn't exist yet —
// unreachable from any test (both call sites are behind `import.meta.main`).
function backendNotWiredYet(): never {
  throw new Error("cc-api-daemon: no session backend wired yet (Task 5 of the api-sdk-swap plan)")
}

// N3c-iii: the direct `new WarmSession(env, warmBudgetOpts(env))` + its
// env-overridable `turnTimeoutMs` leg are GONE from this file — SessionPool
// (acp-pool.ts) now owns budget construction for every WarmSession it spawns,
// including honoring `KKAMAK_ACP_TURN_TIMEOUT_MS` itself (mirrored
// byte-for-byte off this file's old `warmBudgetOpts`, acp-pool.ts's
// `parseTurnTimeoutMs`), so a `new SessionPool(env)` here is a complete
// replacement, not an approximation.

/** DEVIATION FROM THE PLAN TEXT, MEASURED (documented in the N3a report):
 * the brief's sequence is "listen → on EADDRINUSE, probe". Measured on this
 * runtime (Bun 1.3.1, node:net): `server.listen(path)` does NOT raise
 * EADDRINUSE when another live process already owns that Unix socket path
 * — it silently rebinds and steals the path out from under the first
 * listener (isolated repro: two `net.createServer().listen(sameSock)`
 * calls both report "listening", and new connections go to the SECOND —
 * the first is silently orphaned, never receiving another connection
 * again). Relying on EADDRINUSE here is therefore not a race-safety
 * problem, it is DEAD CODE: the signal this file's takeover logic is
 * supposed to react to never fires on this runtime, so a starter would
 * always "successfully" steal a live daemon's path.
 *
 * Fix: probe FIRST, always, before ever calling `listen`, and keep the
 * whole probe→(unlink)→listen sequence inside the caller's bind-lock
 * critical section exactly as the plan requires — the lock (a `wx`-created
 * file, unrelated to net.Server and unaffected by this quirk) is what
 * actually serializes two starters; the EADDRINUSE branch was only ever an
 * optimization to skip the probe on the uncontended path, and skipping it
 * is unconditionally safe, just marginally slower. An EADDRINUSE handler
 * is kept as a defensive fallback in case this Bun behavior changes. */
function bindWithTakeover(server: net.Server, sock: string): Promise<"bound" | "already-live"> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(sock)
    let settled = false
    const settle = (live: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      probe.removeAllListeners()
      try { probe.destroy() } catch { /* ignore */ }
      if (live) { resolve("already-live"); return }
      // ECONNREFUSED / ENOENT / any other probe failure: the path is
      // stale or absent. Unlink (ENOENT-tolerant) and make ONE listen
      // attempt.
      try {
        fs.unlinkSync(sock)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") { reject(e); return }
      }
      server.once("error", (err: NodeJS.ErrnoException) => {
        // Defensive fallback: if EADDRINUSE ever DOES fire (e.g. a future
        // Bun version fixes this), treat it the same as a live probe
        // rather than crashing.
        if (err.code === "EADDRINUSE") { resolve("already-live"); return }
        reject(err)
      })
      server.listen(sock, () => resolve("bound"))
    }
    // A hung probe on an orphaned path is functionally "not live" — do not
    // let it block the takeover forever.
    const timer = setTimeout(() => settle(false), 2_000)
    probe.once("connect", () => settle(true))
    probe.once("error", () => settle(false))
  })
}

async function runSocket(env: Record<string, string | undefined>): Promise<void> {
  const sock = socketPath(env)
  const bindLock = bindLockPath(env)
  const fingerprint = envFingerprint(env)
  const idleMs = Number(env.KKAMAK_ACP_IDLE_MS) || DEFAULT_IDLE_MS

  // MAY throw (EACCES on an unwritable parent) — a daemon that cannot even
  // create its own socket directory has nothing safe left to do. The
  // client's ensureDaemon (a later node) owns the fail-open wrapping around
  // SPAWNING this file, not this file itself.
  ensureSocketDir(sock)

  // Stale-socket takeover, race-free: the WHOLE probe→unlink→rebind
  // sequence below runs while holding the bind lock. Losing the lock race
  // is a refusal, never an assumed ownership — another starter is either
  // actively mid-bind (will finish the job) or, if its lock is stale, will
  // be taken over by the NEXT starter's acquireAcpLock call.
  if (!acquireAcpLock(bindLock, Date.now())) {
    process.exit(0)
    return
  }

  const pool = new SessionPool(env, { makeSession: backendNotWiredYet })
  const state = createDaemonState()
  const dispatch = createDispatcher(pool, state, fingerprint)
  const sockets = new Set<net.Socket>()
  // Daemon-level activity clock (N3c-iii): the single WarmSession's own
  // `idleMs()` gate no longer exists — a pool can hold several entries, each
  // with its own idle clock the pool's own `reap()` already owns. Self-exit
  // is a DAEMON-level decision (nobody has asked it for anything in a
  // while), tracked here and updated on every dispatched frame, regardless
  // of which connection or session it belongs to.
  let lastActivityAt = Date.now()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    // Second layer on FrameDecoder's own UTF-8-boundary safety (its
    // header comment explains why both exist).
    socket.setEncoding("utf8")
    const decoder = new FrameDecoder()
    const write: Write = (msg) => {
      try { socket.write(encodeFrame(msg)) } catch { /* peer gone */ }
    }
    socket.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        lastActivityAt = Date.now()
        void dispatch(f, write)
      }
    })
    socket.on("close", () => { sockets.delete(socket) })
    socket.on("error", () => { /* a peer reset must never crash the daemon */ })
  })

  let outcome: "bound" | "already-live"
  try {
    outcome = await bindWithTakeover(server, sock)
  } catch (e) {
    releaseAcpLock(bindLock)
    throw e
  }
  if (outcome === "already-live") {
    releaseAcpLock(bindLock)
    process.exit(0)
    return
  }

  // Filesystem hygiene is Unix-only — named pipes carry no file mode.
  if (!isPipe(sock)) {
    try { fs.chmodSync(sock, 0o600) } catch { /* best-effort */ }
  }
  // Released immediately after a successful listen (+ chmod): the lock
  // only needs to cover the racy probe→unlink→rebind window, not the
  // daemon's whole lifetime.
  releaseAcpLock(bindLock)

  // Test seam: exactly one line here means exactly one daemon is serving.
  // Written AFTER listen+chmod succeed — never at boot — so a starter that
  // lost the bind race (exited above) writes nothing.
  if (env.KKAMAK_ACP_TEST_SPAWN_LOG) {
    try {
      fs.appendFileSync(env.KKAMAK_ACP_TEST_SPAWN_LOG, `${process.pid} ${new Date().toISOString()}\n`)
    } catch { /* best-effort */ }
  }

  // Post-bind runtime errors (e.g. EMFILE on accept) must never crash the
  // process — the daemon dying on a transient error is a fail-open
  // violation just as much as dying on a bad frame.
  server.on("error", () => { /* ignore */ })

  let reaper: ReturnType<typeof setInterval> | undefined
  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    if (reaper) clearInterval(reaper)
    // Stop accepting new connections FIRST, then close what is open, then
    // tear down the session, then RE-ACQUIRE the bind lock before
    // unlinking, then release it, then exit. Unlinking before draining
    // races a client that has already written a session/prompt; a client
    // torn down between session/new and session/prompt instead sees its
    // socket close before the prompt frame was written — law L1, no-call,
    // safe to fall back.
    //
    // Round-2 review finding 4 (2026-08-05, user ruling): the naive
    // "release lock (already done at listen-time), then unlink" order is
    // internally inconsistent with this Bun runtime's takeover design
    // (bindWithTakeover, above) — a starter that wins the bind-lock race
    // while THIS daemon is draining has its OWN, brand-new, LIVE socket
    // already bound by the time it releases the lock; this daemon must not
    // unlink out from under it. Re-acquiring the SAME lock here makes this
    // daemon's shutdown-unlink just another lock-holder, serialized against
    // every starter exactly like bindWithTakeover's probe→unlink→rebind is.
    // Best-effort: if another starter currently holds a FRESH lock, it is
    // mid-bind — skip the unlink entirely; that starter's own probe (which
    // will now correctly see this daemon as dead) or a later starter's
    // takeover handles the stale path.
    server.close()
    for (const s of sockets) { try { s.destroy() } catch { /* ignore */ } }
    pool.closeAll()
    // Review finding: `acquireAcpLock` is not "never throws" — a rethrown
    // non-EEXIST error (e.g. EACCES on the lock dir) must not skip
    // `process.exit` below and become an unhandled rejection. Wrapping the
    // whole acquire+unlink+release block preserves the exact semantics:
    // lock acquired -> unlink -> release; acquisition failed (false, no
    // throw) -> skip unlink (unchanged, the `if` is simply not entered);
    // acquisition throws -> caught here, also skip unlink, shutdown still
    // proceeds to exit.
    if (!isPipe(sock)) {
      try {
        if (acquireAcpLock(bindLock, Date.now())) {
          try { fs.unlinkSync(sock) } catch { /* ignore */ }
          releaseAcpLock(bindLock)
        }
      } catch { /* ignore — shutdown must still reach process.exit below */ }
    }
    process.exit(code)
  }

  // A fixed 60s tick could never observe a short KKAMAK_ACP_IDLE_MS (tests
  // use 1.5-8s) and would make the reaper untestable.
  const tickMs = Math.max(250, Math.min(60_000, idleMs / 3))
  reaper = setInterval(() => {
    // Evict idle POOL ENTRIES first (same cadence, the pool's own idle
    // budget), THEN decide whether the whole DAEMON should self-exit — same
    // drain order as before (idle work, then self-exit gate), just with
    // `pool.quiescent()` replacing the single `!warm.turnInFlight()`.
    pool.reap(Date.now())
    if (Date.now() - lastActivityAt > idleMs && pool.quiescent()) void shutdown(0)
  }, tickMs)

  process.on("SIGTERM", () => void shutdown(0))
  process.on("SIGINT", () => void shutdown(0))
}

/** `--stdio`: the SAME dispatcher bound to stdin/stdout, for our own
 * tooling only (Task 2's scope note — NOT for off-the-shelf editors). No
 * idle reaper: the process's lifetime is tied to stdin, and closing stdin
 * (EOF) tears the session down directly. */
async function runStdio(env: Record<string, string | undefined>): Promise<void> {
  const fingerprint = envFingerprint(env)
  const pool = new SessionPool(env, { makeSession: backendNotWiredYet })
  const state = createDaemonState()
  const dispatch = createDispatcher(pool, state, fingerprint)
  const decoder = new FrameDecoder()
  const write: Write = (msg) => {
    try { process.stdout.write(encodeFrame(msg)) } catch { /* peer gone (e.g. EPIPE) */ }
  }

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    for (const f of decoder.push(chunk)) void dispatch(f, write)
  })
  process.stdin.on("end", () => {
    pool.closeAll()
    process.exit(0)
  })
}

if (import.meta.main) {
  const env = process.env as Record<string, string | undefined>
  const run = process.argv.includes("--stdio") ? runStdio(env) : runSocket(env)
  run.catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
