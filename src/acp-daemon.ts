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
// echoes and discoveryPath(process.env) is where it publishes {port, pid}
// after binding. Whoever spawns it MUST pass, explicitly, the same env
// object it fingerprinted. The repo's
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
//
// websocket-transport swap: `runSocket`'s unix-domain-socket + FrameDecoder
// framing is replaced by an `http.createServer()` + `WebSocketServer({
// noServer:true})` pair, following chronos-api-0.4.5's src/index.ts:59-161
// wiring (minus Koa — this package serves no HTTP routes, so `createServer()`
// takes no request-handler argument at all; the only thing the bare HTTP
// server exists for is `.on("upgrade", ...)`). `runStdio` is UNCHANGED and
// keeps `FrameDecoder`/`encodeFrame` (imported from acp-wire.ts, which
// keeps exporting them for exactly this) — stdin/stdout is a raw byte
// stream with no message boundaries of its own, unlike a WebSocket
// connection where each `message` event is already a discrete frame; the
// websocket-transport plan is silent on `--stdio` (it has no unix-socket
// analog to swap), so this is a deliberate scope note, not an oversight:
// deleting the framing helpers outright (as the plan's Task 3 Step 2
// literally says) would have broken a real, still-used entry point that
// transport swap never touches.
import http from "node:http"
import fs from "node:fs"
import crypto from "node:crypto"
import { WebSocketServer, type WebSocket as WsConnection } from "ws"
import type { TurnOutcome, DispatchableSession } from "./session-contract.ts"
import { SessionPool, type WarmConstructOpts, parseTurnTimeoutMs } from "./acp-pool.ts"
import { ApiSession } from "./api-session.ts"
import { routeBackend } from "./route.ts"
import {
  discoveryPath, writeDiscovery, readDiscovery, wsUrl, bindLockPath, envFingerprint,
  acquireAcpLock, releaseAcpLock,
} from "./acp-paths.ts"
import {
  FrameDecoder, encodeFrame,
  ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_CANCEL, ACP_SESSION_UPDATE,
  ACP_SESSION_CLOSE, ACP_MODELS_LIST, ACP_MODELS_LIST_LEGACY,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED, ACP_ERR_MODELS_NO_AUTH, ACP_ERR_MODELS_UPSTREAM_ERROR,
  ACP_BUDGET,
  type WarmIsolation,
} from "./acp-wire.ts"
import { validateJsonRpc, createErrorResponse, JSON_RPC_PARSE_ERROR } from "./jsonrpc.ts"
import { listModels } from "./models.ts"

/** Production idle budget: 15 minutes. `ACP_IDLE_MS` (legacy
 * `KKAMAK_ACP_IDLE_MS` still honored) overrides for tests (a few seconds) —
 * acp-paths.ts's denylist note is explicit that this is a daemon OPERATING
 * parameter, not an instrument parameter, so it never enters the
 * fingerprint (both spellings are denylisted for exactly that reason). */
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
  /** `apiSession` (HAZARD 2, api-sdk merge brief): a per-session `ApiSession`
   * is minted lazily on that session's FIRST api-lane (`*haiku*`) prompt and
   * held here — NEVER pooled, NEVER shared across sessions. Absent for a
   * session that has only ever taken the agent (pool) lane, or hasn't
   * prompted at all yet. */
  sessions: Map<string, { createdAt: number; isolation: WarmIsolation; apiSession?: DispatchableSession }>
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

/** HAZARD 2: per-session ApiSessions are never pooled, so `pool.quiescent()`
 * cannot see them — the daemon-level self-exit gate (below) and shutdown()
 * both need their OWN check across `state.sessions` for a turn in flight on
 * that lane. */
function anyApiSessionBusy(state: DaemonState): boolean {
  for (const s of state.sessions.values()) {
    if (s.apiSession?.turnInFlight()) return true
  }
  return false
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
 * a bare notification, nothing) instead of raising.
 *
 * `env` (added for `kkamak/models/list`): the SAME env this daemon was
 * spawned with, threaded through so a stateless-metadata method can call
 * `listModels(env)` directly — no session, no pool, no ApiSession. */
export function createDispatcher(
  pool: SessionPool,
  state: DaemonState,
  fingerprint: string,
  env: Record<string, string | undefined>,
  // `makeApiSession` (HAZARD 2, api-sdk merge brief): the api lane's own DI
  // seam, mirroring the pool's own `makeSession` (acp-pool.ts) — a fake here
  // lets dispatcher-level tests prove the ROUTING decision and the
  // never-pooled reuse-per-session contract without a real daemon process or
  // network. Defaults to the real `ApiSession`.
  opts?: { makeApiSession?: (env: Record<string, string | undefined>, warmOpts: WarmConstructOpts) => DispatchableSession },
) {
  const makeApiSession = opts?.makeApiSession ?? ((e, warmOpts) => new ApiSession(e, warmOpts))
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
    // `data` is `unknown`, not narrowed to `{callConsumed: boolean}` — the
    // outcome-law errors (no-call/call-consumed) are the ONLY ones that
    // field belongs to; kkamak/models/list's errors (below) carry their
    // own, unrelated data shape and share this same helper.
    const respondError = (code: number, message: string, data?: unknown): void => {
      if (id === undefined) return
      write({ jsonrpc: "2.0", id, error: data !== undefined ? { code, message, data } : { code, message } })
    }

    // Defense-in-depth for the catch-all below (WarmSession's own contract
    // is to never throw, so this flag should never matter in practice):
    // once we are past the L4 sessionId/model guard and about to call
    // warm.oneShot, an unexpected exception can no longer be PROVEN
    // unsent, so the fallback must not claim callConsumed:false and risk
    // a caller retrying an already-billed turn.
    let mayHaveConsumed = false

    // HAZARD 3/api-sdk merge brief Task 4: the ok/no-call/call-consumed
    // response shape is IDENTICAL for both backends (§6e's outcome law is
    // backend-agnostic) — factored into ONE helper so the agent (pool) and
    // api (per-session) branches below cannot drift from each other.
    const respondOutcome = (outcome: TurnOutcome, sessionId: string): void => {
      if (outcome.kind === "ok") {
        // ONE session/update notification carrying the full text, THEN the
        // result — never the other order, or a client racing on the result
        // could miss the chunk.
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
    }

    try {
      switch (method) {
        case ACP_INITIALIZE: {
          respond({
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
            _meta: { kkamak: { envFingerprint: fingerprint, daemonWorstCaseMs: ACP_BUDGET.daemonWorstCaseMs } },
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

          // HAZARD 3 (api-sdk merge brief): route by model, not preference.
          // *haiku* -> the api (bare-SDK) lane; everything else, including
          // any unrecognized model, defaults to agent (the CLI lane serves
          // every model measured 429 on bare-SDK) — degrading to "heavier
          // than necessary" is safe, degrading to a 429 is not.
          if (routeBackend(model) === "api") {
            // HAZARD 2: NEVER pooled. One ApiSession per ACP session, minted
            // lazily on this session's first api-lane prompt and held on the
            // session record; a later prompt on the SAME session (even a
            // later agent-lane one) reuses it unchanged.
            let apiSession = session.apiSession
            if (!apiSession) {
              apiSession = makeApiSession(env, {
                isolation: session.isolation,
                turnTimeoutMs: parseTurnTimeoutMs(env),
                queueWaitMs: ACP_BUDGET.queueWaitMs,
                clearTimeoutMs: ACP_BUDGET.clearTimeoutMs,
                setModelMs: ACP_BUDGET.setModelMs,
                hardGraceMs: ACP_BUDGET.hardGraceMs,
              })
              session.apiSession = apiSession
            }
            // Never recycle: this instance is EXCLUSIVE to this session (no
            // other caller can ever reuse it, unlike a pool entry), so a
            // second prompt on the same session should keep growing its own
            // context, same as a pool entry picking up its OWN prior
            // session (see the agent branch's `lastSessionForEntry` comment
            // below for the pool's equivalent reasoning).
            const tag = crypto.randomUUID()
            const outstandingForSession = state.outstanding.get(sessionId) ?? []
            outstandingForSession.push({ tag, warm: apiSession })
            state.outstanding.set(sessionId, outstandingForSession)
            mayHaveConsumed = true
            try {
              const outcome: TurnOutcome = await apiSession.oneShot(text, model, { recycle: false, tag })
              respondOutcome(outcome, sessionId)
              return
            } finally {
              const remaining = state.outstanding.get(sessionId)
              if (remaining) {
                const i = remaining.findIndex((o) => o.tag === tag)
                if (i >= 0) remaining.splice(i, 1)
                if (remaining.length === 0) state.outstanding.delete(sessionId)
              }
            }
          }

          const acquired = pool.acquire(session.isolation, Date.now())
          if (!acquired.ok) {
            // Pool exhaustion: NOTHING was sent to any warm entry, so this
            // is a provable no-call, same law as every other pre-send
            // refusal above — just a different JSON-RPC code (§6e's L3 step
            // (i), `data.callConsumed` boolean, is what the client actually
            // keys its classification on; the code here is diagnostic).
            respondError(
              -32002,
              "no warm session available (ACP_MAX_SESSIONS reached)",
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
            respondOutcome(outcome, sessionId)
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
          const session = sessionId ? state.sessions.get(sessionId) : undefined
          if (!session) {
            respond({ closed: false, reason: "unknown-session" })
            return
          }

          // HAZARD 2: the per-session ApiSession is never pooled, so it
          // needs its OWN close path here — refusing (never erroring, same
          // "always a response" law) while a turn is still in flight, the
          // same guard shape as the pool's own closeEntry busy/turn-in-
          // flight refusal.
          if (session.apiSession?.turnInFlight()) {
            respond({ closed: false, reason: "turn-in-flight" })
            return
          }
          if (session.apiSession) {
            session.apiSession.close()
            session.apiSession = undefined
          }

          let entryId: string | undefined
          for (const [eid, sid] of state.lastServedBySessionForEntry) {
            if (sid === sessionId) { entryId = eid; break }
          }
          // A known session with no pool entry to its name (api-lane only,
          // or never prompted at all) has nothing further to close — unlike
          // the pre-HAZARD-2 version of this code, `entryId === undefined`
          // no longer implies "unknown session": `state.sessions` is
          // consulted directly now (above), so that ambiguity is gone.
          const result = entryId === undefined ? { closed: true } : pool.closeEntry(entryId)
          if (result.closed && entryId !== undefined) {
            state.lastServedBySessionForEntry.delete(entryId)
          }
          respond(result)
          return
        }

        case ACP_MODELS_LIST_LEGACY:
        case ACP_MODELS_LIST: {
          // Stateless metadata, not a turn: no session/new, no pool.acquire,
          // no ApiSession — answered directly. budgetMs omitted deliberately:
          // listModels(env) already defaults to DEFAULT_MODELS_BUDGET_MS
          // (models.ts) when not given one, which IS this method's timeout
          // leg; no reason to re-export that constant just to hand it back.
          const outcome = await listModels(env)
          if (outcome.kind === "ok") {
            // RESULT IS ModelInfo[] VERBATIM — the daemon is a pipe here,
            // not a curator, consistent with models.ts re-exporting the
            // SDK's own ModelInfo rather than trimming it.
            respond(outcome.models)
            return
          }
          if (outcome.kind === "no-auth") {
            respondError(ACP_ERR_MODELS_NO_AUTH, "no resolvable credentials")
            return
          }
          // outcome.kind === "error"
          respondError(
            ACP_ERR_MODELS_UPSTREAM_ERROR,
            outcome.message ?? "upstream error",
            outcome.status !== undefined ? { status: outcome.status } : undefined,
          )
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

// N3c-iii: the direct `new WarmSession(env, warmBudgetOpts(env))` + its
// env-overridable `turnTimeoutMs` leg are GONE from this file — SessionPool
// (acp-pool.ts) now owns budget construction for every WarmSession it spawns,
// including honoring `ACP_TURN_TIMEOUT_MS` itself (mirrored
// byte-for-byte off this file's old `warmBudgetOpts`, acp-pool.ts's
// `parseTurnTimeoutMs`), so a `new SessionPool(env)` here is a complete
// replacement, not an approximation.

/** websocket-transport swap: replaces the unix-socket `bindWithTakeover`.
 * "Is a daemon already live for this env" is no longer answerable by
 * connecting to a fixed path — it now means "does `readDiscovery(env)`
 * point at a port that answers a WebSocket handshake". A stale discovery
 * file pointing at a DEAD port and one pointing at a REUSED port (a
 * different, unrelated process now bound to that port number by the OS)
 * are new failure modes the socket path never had — both collapse to the
 * same `false` here: the probe either upgrades to a WebSocket (live, ours
 * or not — see below) or it doesn't. A REUSED port answering some
 * unrelated non-WebSocket service fails the handshake exactly like a dead
 * port does, so it correctly falls through to takeover; only a port reused
 * by some OTHER live WebSocket server would be mistaken for "already
 * live" here, the same low-probability residual risk the old unix-socket
 * probe had for a reused path. */
function probePort(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (live: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      resolve(live)
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    // The GLOBAL, browser-standard WebSocket (Bun/Node both implement it
    // natively) — deliberately not `ws`'s own client class, so this
    // self-probe exercises the exact same constructor Task 4's real client
    // (acp-client.ts) uses, per the plan's own `new WebSocket(url)`.
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl(port))
    } catch {
      clearTimeout(timer)
      resolve(false)
      return
    }
    ws.onopen = () => settle(true)
    ws.onerror = () => settle(false)
  })
}

/** Race-free the same way the old unix-socket takeover was: the WHOLE
 * probe→bind sequence runs while holding the bind lock. Losing the lock
 * race is a refusal, never an assumed ownership — another starter is
 * either actively mid-bind (will finish the job) or, if its lock is
 * stale, will be taken over by the NEXT starter's `acquireAcpLock` call. */
async function bindWithTakeover(
  server: http.Server,
  env: Record<string, string | undefined>,
): Promise<{ outcome: "already-live" } | { outcome: "bound"; port: number }> {
  const existing = readDiscovery(env)
  if (existing && (await probePort(existing.port))) {
    return { outcome: "already-live" }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server.address() returned no port after listen")
  }
  return { outcome: "bound", port: address.port }
}

async function runServer(
  env: Record<string, string | undefined>,
  opts?: {
    makeSession?: (env: Record<string, string | undefined>, warmOpts: WarmConstructOpts) => DispatchableSession
    makeApiSession?: (env: Record<string, string | undefined>, warmOpts: WarmConstructOpts) => DispatchableSession
  },
): Promise<void> {
  const bindLock = bindLockPath(env)
  const fingerprint = envFingerprint(env)
  const idleMs = Number(env.ACP_IDLE_MS ?? env.KKAMAK_ACP_IDLE_MS) || DEFAULT_IDLE_MS

  // Stale-discovery takeover, race-free: the WHOLE probe→bind sequence
  // below runs while holding the bind lock. MAY throw (EACCES on an
  // unwritable parent) — same fail-open contract as before: the client's
  // ensureDaemon (a later node) owns the fail-open wrapping around
  // SPAWNING this file, not this file itself.
  if (!acquireAcpLock(bindLock, Date.now())) {
    process.exit(0)
    return
  }

  // No makeSession override -> the pool's own default (ApiSession, Task 5).
  const pool = new SessionPool(env, opts?.makeSession ? { makeSession: opts.makeSession } : {})
  const state = createDaemonState()
  const dispatch = createDispatcher(pool, state, fingerprint, env, { makeApiSession: opts?.makeApiSession })
  const clients = new Set<WsConnection>()
  // Daemon-level activity clock (N3c-iii): the single WarmSession's own
  // `idleMs()` gate no longer exists — a pool can hold several entries, each
  // with its own idle clock the pool's own `reap()` already owns. Self-exit
  // is a DAEMON-level decision (nobody has asked it for anything in a
  // while), tracked here and updated on every dispatched frame, regardless
  // of which connection or session it belongs to.
  let lastActivityAt = Date.now()

  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer()   // no Koa — this package serves no HTTP routes

  server.on("upgrade", (req, socket, head) => {
    // RULING 2026-08-07 (user, recorded verbatim in the websocket-transport
    // plan's own RULING section): no Origin check, no token — every
    // upgrade is accepted. The unix socket got authorization from the
    // filesystem (0700 dir) for free; TCP has no equivalent, and the
    // ruling declines to re-create one. See CLAUDE.md's Security section.
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
  })

  wss.on("connection", (ws: WsConnection) => {
    clients.add(ws)
    // ONE write closure per connection — the same per-connection response
    // routing the unix socket had via its own per-socket `write`. This is
    // what makes (connection, id) sufficient to correlate responses; it is
    // not new behaviour.
    const write: Write = (msg) => {
      try { ws.send(JSON.stringify(msg)) } catch { /* peer gone */ }
    }
    ws.on("message", (data) => {
      lastActivityAt = Date.now()
      let parsed: unknown
      try {
        parsed = JSON.parse(String(data))
      } catch {
        write(createErrorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error"))
        return
      }
      const v = validateJsonRpc(parsed)
      if (!v.ok) {
        // Per JSON-RPC 2.0 (jsonrpc.ts's own rule, ported from chronos): a
        // notification never gets a reply, even a malformed one.
        if (v.isNotification) return
        write(createErrorResponse(v.id, v.code, v.message))
        return
      }
      void dispatch(v.value, write)
    })
    ws.on("close", () => { clients.delete(ws) })
    ws.on("error", () => { /* a peer reset must never crash the daemon */ })
  })

  let bindOutcome: { outcome: "already-live" } | { outcome: "bound"; port: number }
  try {
    bindOutcome = await bindWithTakeover(server, env)
  } catch (e) {
    releaseAcpLock(bindLock)
    throw e
  }
  if (bindOutcome.outcome === "already-live") {
    releaseAcpLock(bindLock)
    process.exit(0)
    return
  }

  // Publish AFTER a successful bind, never at boot — a discovery file
  // means "someone IS listening here", not "someone is about to". 0600 /
  // dir 0700 (writeDiscovery's own doc comment) — the RULING declines to
  // authenticate the WebSocket handshake, but there is no reason to make
  // the port world-readable when the socket dir never was.
  writeDiscovery(env, { port: bindOutcome.port, pid: process.pid })
  // Released immediately after a successful listen (+ publish): the lock
  // only needs to cover the racy probe→bind window, not the daemon's whole
  // lifetime.
  releaseAcpLock(bindLock)

  // Test seam: exactly one line here means exactly one daemon is serving.
  // Written AFTER bind+publish succeed — never at boot — so a starter that
  // lost the bind race (exited above) writes nothing.
  const testSpawnLog = env.ACP_TEST_SPAWN_LOG ?? env.KKAMAK_ACP_TEST_SPAWN_LOG
  if (testSpawnLog) {
    try {
      fs.appendFileSync(testSpawnLog, `${process.pid} ${new Date().toISOString()}\n`)
    } catch { /* best-effort */ }
  }

  // Post-bind runtime errors must never crash the process — the daemon
  // dying on a transient error is a fail-open violation just as much as
  // dying on a bad frame.
  server.on("error", () => { /* ignore */ })

  let reaper: ReturnType<typeof setInterval> | undefined
  let shuttingDown = false
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    if (reaper) clearInterval(reaper)
    // Stop accepting new connections FIRST, then close what is open, then
    // tear down the session, then RE-ACQUIRE the bind lock before deleting
    // the discovery file, then release it, then exit. Deleting before
    // draining races a client that has already sent a session/prompt
    // message; a client torn down between session/new and session/prompt
    // instead sees its connection close before the prompt frame was sent —
    // law L1, no-call, safe to fall back.
    //
    // Round-2 review finding 4 (2026-08-05, user ruling, carried over from
    // the unix-socket design): the naive "release lock (already done at
    // listen-time), then delete" order is internally inconsistent with
    // this file's takeover design (bindWithTakeover, above) — a starter
    // that wins the bind-lock race while THIS daemon is draining has its
    // OWN, brand-new, LIVE discovery entry already published by the time
    // it releases the lock; this daemon must not delete out from under it.
    // Re-acquiring the SAME lock here makes this daemon's shutdown-delete
    // just another lock-holder, serialized against every starter exactly
    // like bindWithTakeover's probe→bind is. Best-effort: if another
    // starter currently holds a FRESH lock, it is mid-bind — skip the
    // delete entirely; that starter's own probe (which will now correctly
    // see this daemon as dead) or a later starter's takeover handles the
    // stale entry.
    server.close()
    for (const ws of clients) { try { ws.terminate() } catch { /* ignore */ } }
    pool.closeAll()
    // HAZARD 2: per-session ApiSessions are never in `pool` at all —
    // shutdown must close them directly, same "close busy ones too, that's
    // expected at shutdown" contract as `pool.closeAll()` above.
    for (const s of state.sessions.values()) { s.apiSession?.close() }
    // Review finding: `acquireAcpLock` is not "never throws" — a rethrown
    // non-EEXIST error (e.g. EACCES on the lock dir) must not skip
    // `process.exit` below and become an unhandled rejection. Wrapping the
    // whole acquire+delete+release block preserves the exact semantics:
    // lock acquired -> delete -> release; acquisition failed (false, no
    // throw) -> skip delete (unchanged, the `if` is simply not entered);
    // acquisition throws -> caught here, also skip delete, shutdown still
    // proceeds to exit.
    try {
      if (acquireAcpLock(bindLock, Date.now())) {
        try { fs.rmSync(discoveryPath(env), { force: true }) } catch { /* ignore */ }
        releaseAcpLock(bindLock)
      }
    } catch { /* ignore — shutdown must still reach process.exit below */ }
    process.exit(code)
  }

  // A fixed 60s tick could never observe a short ACP_IDLE_MS (tests
  // use 1.5-8s) and would make the reaper untestable.
  const tickMs = Math.max(250, Math.min(60_000, idleMs / 3))
  reaper = setInterval(() => {
    // Evict idle POOL ENTRIES first (same cadence, the pool's own idle
    // budget), THEN decide whether the whole DAEMON should self-exit — same
    // drain order as before (idle work, then self-exit gate), just with
    // `pool.quiescent()` replacing the single `!warm.turnInFlight()`. HAZARD
    // 2: `pool.quiescent()` alone cannot see a per-session ApiSession's turn
    // (never pooled) — `anyApiSessionBusy` is the same ground-truth check
    // for that lane, so self-exit never lands mid an api-lane turn.
    pool.reap(Date.now())
    if (Date.now() - lastActivityAt > idleMs && pool.quiescent() && !anyApiSessionBusy(state)) void shutdown(0)
  }, tickMs)

  process.on("SIGTERM", () => void shutdown(0))
  process.on("SIGINT", () => void shutdown(0))
}

/** `--stdio`: the SAME dispatcher bound to stdin/stdout, for our own
 * tooling only (Task 2's scope note — NOT for off-the-shelf editors). No
 * idle reaper: the process's lifetime is tied to stdin, and closing stdin
 * (EOF) tears the session down directly. */
async function runStdio(
  env: Record<string, string | undefined>,
  opts?: {
    makeSession?: (env: Record<string, string | undefined>, warmOpts: WarmConstructOpts) => DispatchableSession
    makeApiSession?: (env: Record<string, string | undefined>, warmOpts: WarmConstructOpts) => DispatchableSession
  },
): Promise<void> {
  const fingerprint = envFingerprint(env)
  // No makeSession override -> the pool's own default (ApiSession, Task 5).
  const pool = new SessionPool(env, opts?.makeSession ? { makeSession: opts.makeSession } : {})
  const state = createDaemonState()
  const dispatch = createDispatcher(pool, state, fingerprint, env, { makeApiSession: opts?.makeApiSession })
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
    // HAZARD 2: per-session ApiSessions are never in `pool`.
    for (const s of state.sessions.values()) { s.apiSession?.close() }
    process.exit(0)
  })
}

if (import.meta.main) {
  const env = process.env as Record<string, string | undefined>
  const run = process.argv.includes("--stdio") ? runStdio(env) : runServer(env)
  run.catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
