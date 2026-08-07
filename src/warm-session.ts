// §6e WarmSession: one streaming-input Query, ONE persistent message pump
// BOUND TO ITS QUERY GENERATION, a lossless pushable input queue, /clear
// recycling SEQUENCED on the SDK's own conversation_reset message, FIFO
// turns, every wait capped, close() observed at every suspension point,
// and three-way outcomes that implement §6e's wire-send boundary law
// mechanically.
//
// Isolation options are the §6d set (agent-transport.ts:119-132) with TWO
// registered deltas (§6e):
//  (a) REMOVED `maxTurns: 1` + `abortController` — query-scoped, cannot
//      transfer to a many-turn session (maxTurns, sdk.d.ts:1674-1678, would
//      stop the whole Query after record #1; aborting the shared controller
//      would kill every later turn). Replaced by per-turn call accounting +
//      interrupt().
//  (b) ADDED a neutral `cwd` — §6d measured it payload-neutral (spec line
//      690) and agent-transport.ts:41-44 omits it as redundant for a
//      one-shot; for a host-global daemon it is what stops the instrument
//      varying with whichever session spawned it.
//
// Lazy SDK VALUE import (hook processes must not pay the ~84 ms package
// load; same finding as agent-transport.ts:102-108). The `import type`
// below is erased and costs nothing.
import os from "node:os"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ACP_BUDGET, CLI_SPAWN_BUDGET_MS, GAUGE_ISOLATION, type WarmIsolation, modelProvenBy } from "./acp-wire.ts"

export type TurnOutcome =
  | { kind: "ok"; text: string; model: string; canonicalModel: string }
  | { kind: "no-call" }
  | { kind: "call-consumed" }

export type CancelResult = "queued-dropped" | "unsent-dropped" | "interrupted" | "unknown"

interface Turn {
  text: string
  model: string
  recycle: boolean
  /** MUST be globally unique across callers. Task 5 mints a UUID; a
   * per-connection JSON-RPC request id would collide across connections and
   * let one caller's cancel interrupt another caller's billed turn. */
  tag: string | undefined
  /** THE §6e send boundary, daemon-side, and the WHOLE classification:
   * `consumed(t) === t.sent`. True once this turn's prompt frame has been
   * pushed into the CLI's input stream. */
  sent: boolean
  /** DIAGNOSTIC ONLY (progress notes / strayMessages triage). These used to
   * feed the outcome via a `connectionOnly` carve-out; round 3 removed it
   * because sdk.d.ts:2839-2841's `error_status: null` covers billed
   * timeouts as well as refused connects. Do not reintroduce them into
   * `consumed()`. */
  sawModelActivity: boolean
  sawApiResponse: boolean
  /** interrupted / retry-cancelled: settle from the TERMINAL result, never
   * `ok`, and never at the moment of cancellation (law L7) */
  doomed: boolean
  done: boolean
  /** EVIDENCE, not a verdict: the modelUsage KEY this turn ran under, and
   * that entry's canonicalModel. The CALLER reconciles them against its
   * requested id with modelProvenBy — the key is routinely a DATED snapshot
   * of the requested alias (round-4 C1). */
  observedModel: string
  observedCanonical: string
  /** assistant `message.model`. DIAGNOSTIC ONLY — never promoted to a
   * stamp, or the provenance rule becomes an echo again. */
  corroboratedModel: string
  /** resolves this caller's oneShot(). Written ONCE, at enqueue. */
  notifyCaller: (o: TurnOutcome) => void
  /** resolves execute()'s internal wait. Written ONCE, by execute().
   * DELIBERATELY a different field from notifyCaller: one shared slot loses
   * the queued caller's resolver and deadlocks that caller forever. */
  settle: (o: TurnOutcome) => void
  queueTimer?: ReturnType<typeof setTimeout>
  timer?: ReturnType<typeof setTimeout>
  hardTimer?: ReturnType<typeof setTimeout>
}

/** Lossless pushable async iterable. N pushes in one synchronous tick all
 * land; a single re-armed promise resolver would drop every push after the
 * first (this is the defect that killed the first draft of this design). */
class Pushable {
  private queue: SDKUserMessage[] = []
  private waiter: ((m: SDKUserMessage | undefined) => void) | undefined
  private closed = false

  push(m: SDKUserMessage): void {
    if (this.closed) return
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w(m)
      return
    }
    this.queue.push(m)
  }

  close(): void {
    this.closed = true
    // Round-4 M12: DROP anything still queued. The stream() loop drains the
    // queue before it consults `closed`, so leaving items here would feed a
    // Query that is being torn down.
    this.queue.length = 0
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w(undefined)
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      const m = await new Promise<SDKUserMessage | undefined>((res) => {
        this.waiter = res
      })
      if (m === undefined) return
      yield m
    }
  }
}

function userMsg(text: string): SDKUserMessage {
  // sdk.d.ts:4583-4586 — `type`, `message` and `parent_tool_use_id` are the
  // only required fields; `uuid`/`session_id` are optional (:4617-4618).
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
}

/** DIAGNOSTIC model id off an assistant message (`message.model`). The ONLY
 * evidence channel is the terminal result's `modelUsage` keys
 * (sdk.d.ts:4312 success / :4279 error) — see route(). */
function assistantModel(m: SDKMessage): string {
  const model = (m as { message?: { model?: unknown } }).message?.model
  return typeof model === "string" ? model : ""
}

export interface ModelEvidence {
  /** the modelUsage KEY that PROVES the requested model, or "" if none does */
  model: string
  canonicalModel: string
}

/** Pure §6e model-evidence selection, extracted (review finding 3,
 * 2026-08-04) so `route()`'s USE of `modelProvenBy` — including the
 * multi-key branch — can be fixture-tested without a CLI spawn. The
 * multi-key branch is structurally unreachable through any local stub on
 * the streaming-input driving path these tests use (Step 1a: modelUsage's
 * key tracks the client-requested model verbatim, regardless of what the
 * stub declares), so a pure function is the only way to cover it at all.
 *
 * `usage` is EVIDENCE, never a verdict (§6e provenance rule): a key that
 * does not prove `requestedModel` under `modelProvenBy` is never reported,
 * single-key or multi-key alike — "A successful turn whose result carries
 * no key proving the requested model under modelProvenBy reports
 * call-consumed" (§6e design). Single- and multi-key cases are unified
 * under the same rule rather than trusting an unprovable single key
 * verbatim, so `route()`'s `!t.observedModel ⇒ call-consumed` gate is the
 * ONLY place §6e's provenance rule is enforced, not split across two
 * branches with different strictness. */
export function selectEvidence(
  usage: Record<string, { outputTokens?: number; output_tokens?: number; canonicalModel?: string }> | undefined,
  requestedModel: string,
): ModelEvidence {
  const u = usage ?? {}
  const keys = Object.keys(u)
  const outOf = (k: string): number => {
    const e = u[k]
    return Number(e?.outputTokens ?? e?.output_tokens ?? 0)
  }
  if (keys.length === 1 && keys[0]) {
    const k = keys[0]
    if (modelProvenBy(k, requestedModel, u[k]?.canonicalModel)) {
      return { model: k, canonicalModel: u[k]?.canonicalModel ?? "" }
    }
    return { model: "", canonicalModel: "" }
  }
  if (keys.length > 1) {
    // An auxiliary model (title/summarizer) must not make an honest turn
    // unprovable. Pick the key that PROVES the requested model under §6e's
    // matching rule, and accept it only if every OTHER key recorded zero
    // output tokens — the evidence still comes from the result, never from
    // the request.
    const own = keys.find((k) => modelProvenBy(k, requestedModel, u[k]?.canonicalModel))
    if (own && keys.filter((k) => k !== own).every((k) => outOf(k) === 0)) {
      return { model: own, canonicalModel: u[own]?.canonicalModel ?? "" }
    }
  }
  return { model: "", canonicalModel: "" }
}

/** Race `p` against `ms`; resolves false on timeout, false on rejection.
 * Used for setModel, which the SDK exposes as an UN-TIMED control
 * round-trip (sdk.d.ts:2327): without a cap a wedged subprocess hangs
 * execute() with no timer armed, the turn never settles, turnInFlight()
 * stays true forever, and the host-global daemon is permanently dead. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p.then(() => true, () => false),
      new Promise<boolean>((res) => { t = setTimeout(() => res(false), ms) }),
    ])
  } finally {
    if (t) clearTimeout(t)
  }
}

export class WarmSession {
  private q: Query | undefined
  private feed: Pushable | undefined
  private pump: Promise<void> | undefined
  private pending: Turn[] = []
  private draining = false
  private current: Turn | undefined
  private resetWaiter: ((ok: boolean) => void) | undefined
  /** True from `conversation_reset` until `/clear`'s OWN synthetic local
   * `result` (num_turns: 0, modelUsage: {}) has also been consumed —
   * measured 2026-08-04, Step 1a. `resetWaiter` does not resolve while
   * this is true, so awaitClear() cannot return before BOTH frames have
   * landed. */
  private clearResultPending = false
  private fresh = true
  private closed = false
  private currentModel = ""
  private lastActivity = Date.now()
  /** diagnostics only: messages that arrived with no turn to own them */
  strayMessages = 0
  private readonly turnTimeoutMs: number
  private readonly queueWaitMs: number
  private readonly clearTimeoutMs: number
  private readonly setModelMs: number
  private readonly hardGraceMs: number
  private readonly cwd: string
  /** The isolation set this session will spawn under. READONLY and declared
   * (review finding I5): S2's wiring test and S0's default test both need to
   * read it, and an undeclared test-only accessor bolted onto a hardened file
   * is how that file starts drifting. Not a getter for mutation — the value
   * is fixed at construction. */
  readonly isolation: WarmIsolation

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: {
      turnTimeoutMs?: number
      queueWaitMs?: number
      clearTimeoutMs?: number
      setModelMs?: number
      hardGraceMs?: number
      cwd?: string
      isolation?: WarmIsolation
    } = {},
  ) {
    // §6e instrument invariant / round-4 C3: a turn's timers start at the
    // PUSH while the CLI subprocess is still booting (§6d measured
    // 1.25-1.46 s). Clamping here rather than trusting callers means no
    // configuration, test seam or future caller can create a session that
    // cannot tell "generation failed" from "not started yet".
    this.turnTimeoutMs = Math.max(CLI_SPAWN_BUDGET_MS, opts.turnTimeoutMs ?? ACP_BUDGET.turnTimeoutMs)
    this.queueWaitMs = opts.queueWaitMs ?? ACP_BUDGET.queueWaitMs
    this.clearTimeoutMs = opts.clearTimeoutMs ?? ACP_BUDGET.clearTimeoutMs
    this.setModelMs = opts.setModelMs ?? ACP_BUDGET.setModelMs
    this.hardGraceMs = opts.hardGraceMs ?? ACP_BUDGET.hardGraceMs
    this.cwd = opts.cwd ?? os.tmpdir()
    this.isolation = opts.isolation ?? GAUGE_ISOLATION
  }

  oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolveCaller) => {
      const turn: Turn = {
        text: messageText,
        model,
        recycle: opts.recycle,
        tag: opts.tag,
        sent: false,
        sawModelActivity: false,
        sawApiResponse: false,
        doomed: false,
        done: false,
        observedModel: "",
        observedCanonical: "",
        corroboratedModel: "",
        notifyCaller: resolveCaller,   // written ONCE, here, never again
        settle: () => {},
      }
      if (this.closed) {
        this.finish(turn, { kind: "no-call" })
        return
      }
      this.pending.push(turn)
      // Law L4: a turn still PENDING when this fires never reached
      // execute(), so nothing was pushed — a PROVABLE no-call. This is what
      // keeps FIFO contention on the SAFE side of the fallback rule.
      turn.queueTimer = setTimeout(() => {
        const i = this.pending.indexOf(turn)
        if (i < 0) return                       // already started; its own timers own it
        this.pending.splice(i, 1)
        this.finish(turn, { kind: "no-call" })
      }, this.queueWaitMs)
      void this.drain()
    })
  }

  cancel(tag: string): CancelResult {
    const i = this.pending.findIndex((t) => t.tag === tag)
    if (i >= 0) {
      const [t] = this.pending.splice(i, 1)
      if (t) this.finish(t, { kind: "no-call" })   // never sent -> provable no-call
      return "queued-dropped"
    }
    const c = this.current
    if (c && !c.done && c.tag !== undefined && c.tag === tag) {
      if (!c.sent) {
        // §6e L4/L7, round-4 I11: the turn is CURRENT but has not crossed
        // the send boundary — it is inside ensure/setModel/awaitClear.
        // DROP it. Interrupting here would abort the in-flight /clear
        // rather than a turn, leave `done` false, and let execute() push
        // the prompt a moment later: the cancel would CAUSE the model call
        // it was asked to prevent. finish() sets `done`, and execute()'s
        // post-await `turn.done` check makes the push unreachable.
        this.finish(c, { kind: "no-call" })
        return "unsent-dropped"
      }
      c.doomed = true
      this.interruptCurrent(c)
      return "interrupted"
    }
    // A cancel that names nobody must NEVER interrupt whoever happens to be
    // in flight — with one global FIFO that would be another caller's turn,
    // and that caller's model call is already billed.
    return "unknown"
  }

  isWarm(): boolean { return this.q !== undefined }
  /** Includes the shift->execute window (`draining`), so the idle reaper
   * cannot exit between a turn leaving the queue and becoming `current`. */
  turnInFlight(): boolean { return this.current !== undefined || this.pending.length > 0 || this.draining }
  idleMs(): number { return Date.now() - this.lastActivity }

  close(): void {
    this.closed = true
    this.hardReset()
    const c = this.current
    if (c && !c.done) this.finish(c, { kind: this.consumed(c) ? "call-consumed" : "no-call" })
    const queued = this.pending.splice(0, this.pending.length)
    for (const t of queued) this.finish(t, { kind: "no-call" })   // provably unsent
    // NOTE: a turn suspended inside ensure()/setModel()/awaitClear() is not
    // `current` yet or is current-but-unsettled; every one of those awaits
    // re-checks `this.closed` on resume and settles itself (round-4 I3), so
    // no caller is left hanging and no post-close spawn or push happens.
  }

  // ── internals ────────────────────────────────────────────────────────

  /** §6e law L4/L5, mechanically and completely: the send boundary IS the
   * classification. A turn that pushed its prompt consumed a call; a turn
   * that did not, did not. Round 3 removed the `connectionOnly` carve-out —
   * sdk.d.ts:2839-2841's `error_status: null` covers billed timeouts as
   * well as refused connects, so the carve-out could spend a second model
   * call on one record. Do not reintroduce it. */
  private consumed(t: Turn): boolean {
    return t.sent
  }

  /** The ONE settle funnel. `done`-guarded, so double-settle is impossible,
   * and it fires BOTH resolver slots so no caller can ever hang. */
  private finish(turn: Turn, outcome: TurnOutcome): void {
    if (turn.done) return
    turn.done = true
    if (turn.queueTimer) clearTimeout(turn.queueTimer)
    if (turn.timer) clearTimeout(turn.timer)
    if (turn.hardTimer) clearTimeout(turn.hardTimer)
    if (this.current === turn) this.current = undefined
    this.lastActivity = Date.now()
    turn.notifyCaller(outcome)
    turn.settle(outcome)
  }

  /** Fire-and-forget `interrupt()` on the CURRENT generation, but only
   * `hardReset()` if BOTH (a) we are STILL on that generation, AND (b) the
   * turn that asked for the interrupt hasn't already settled some other
   * way, when the interrupt promise finally rejects. Found live in this
   * task, same class as runPump's `this.q !== q` guard (§6e law L7) but a
   * DIFFERENT call path: a turn's `interrupt()` is called on `this.q` as
   * read AT THAT MOMENT (say Q1), but its `.catch()` only fires later,
   * asynchronously.
   *
   * The `this.q === q` guard alone is NOT enough (review finding 1,
   * 2026-08-04): it protects against a hardReset()-then-respawn in
   * between, but on the WARM path Q1 never dies — turn A's `api_retry`
   * calls this, A's terminal `result` settles A normally on the SAME Q1,
   * `drain()` starts turn B which reuses Q1 and pushes (`sent = true`),
   * and only THEN does A's stale `interrupt()` reject. `this.q === q`
   * still holds (nobody reset it), so without the second check the delayed
   * `.catch()` would `hardReset()` Q1 out from under B's live, in-flight
   * turn — a billed call and a lost record caused by A's own cancel/retry,
   * with settlement pushed all the way out to B's `hardTimer`
   * (`turnTimeoutMs + hardGraceMs`) instead of happening promptly.
   * Regression-locked by "a hardReset with a turn QUEUED behind it does
   * not kill the replacement session" (the hardReset()-path case) —  the
   * live-Query case above is plausible but unmeasured, per the finding;
   * the guard exists because the timing isn't ours to control either way. */
  private interruptCurrent(t: Turn | undefined): void {
    const q = this.q
    void q?.interrupt().catch(() => {
      if (this.q === q && t && !t.done) this.hardReset()
    })
  }

  private hardReset(): void {
    try { this.q?.close() } catch { /* idempotent */ }
    this.feed?.close()
    const w = this.resetWaiter
    this.resetWaiter = undefined
    w?.(false)
    this.q = undefined
    this.feed = undefined
    this.pump = undefined
    this.fresh = true
    this.currentModel = ""
  }

  /** FIFO driver. Exactly one drain runs at a time and it resolves NOBODY —
   * every caller is resolved by finish(), which is why the queued caller's
   * resolver can never be clobbered. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const turn = this.pending.shift()
        if (turn === undefined) break
        if (turn.done) continue                // queue-wait cap or cancel got it first
        if (turn.queueTimer) { clearTimeout(turn.queueTimer); turn.queueTimer = undefined }
        if (this.closed) {                     // round-4 I3
          this.finish(turn, { kind: "no-call" })
          continue
        }
        await this.execute(turn)               // ALWAYS resolves, via finish()
      }
    } finally {
      this.draining = false
    }
  }

  /** Ensure a live Query + pump. Returns false when the session cannot be
   * started at all (law L4 — nothing was pushed).
   *
   * The `this.closed` check appears TWICE, deliberately (round-4 I3): once
   * at entry, and once after the package import resolves. With only the
   * entry check, a close() landing inside that ~84 ms window is followed by
   * a Query construction, a CLI subprocess spawn and — via execute() — a
   * real prompt push: a leaked subprocess and a spent model call on a
   * session the caller already terminated, with isWarm() reporting true
   * after close(). §6e law L7's last paragraph names this. */
  private async ensure(model: string): Promise<boolean> {
    if (this.closed) return false
    if (this.q) return true
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk")
      if (this.closed) return false            // closed during the import: build nothing
      const subprocessEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(this.env)) if (v !== undefined) subprocessEnv[k] = v
      const feed = new Pushable()
      const q = query({
        prompt: feed.stream(),
        // this.isolation defaults to GAUGE_ISOLATION (acp-wire.ts), the
        // tested, shared §6d/§6e isolation set (review finding 4,
        // 2026-08-04) — acp-wire.test.ts locks its value AND proves it is
        // as-const-safe to spread into an SDK options literal. Every
        // existing caller constructs WarmSession without `isolation`, so
        // this spread is byte-identical to the GAUGE_ISOLATION literal that
        // was inlined here before (S0). A caller that DOES pass `isolation`
        // (e.g. a `reasoning` profile) gets its own policy without
        // disturbing the gauge lane.
        options: { ...this.isolation, model, cwd: this.cwd, env: subprocessEnv },
      })
      if (this.closed) {                       // closed during construction
        try { q.close() } catch { /* nothing more to do */ }
        feed.close()
        return false
      }
      this.q = q
      this.feed = feed
      this.currentModel = model
      this.fresh = true
      this.pump = this.runPump(q)
      return true
    } catch {
      this.hardReset()
      return false
    }
  }

  /** THE ONE PUMP, BOUND TO ITS GENERATION. `Query` is an AsyncGenerator
   * (sdk.d.ts:2279), so exiting a `for await` calls `.return()` and
   * terminates it — a per-turn loop would kill the warm session at the end
   * of record #1.
   *
   * The `this.q !== q` guards are §6e law L7's other half, and they are NOT
   * defensive padding: `close()` is synchronous (sdk.d.ts:2584) but this
   * generator only unwinds on the subprocess exit event, an I/O tick later.
   * By then finish() has resolved execute()'s wait, drain() has shifted the
   * NEXT turn, and ensure() has built a NEW Query. An unguarded teardown
   * would settle that fresh turn as call-consumed and destroy its session —
   * a lost record and a lost model call, mid-batch. */
  private async runPump(q: Query): Promise<void> {
    try {
      for await (const m of q) {
        if (this.q !== q) return           // superseded: never route into a newer generation
        this.route(m)
      }
    } catch {
      /* the query died; settled below */
    } finally {
      if (this.q === q) {
        const w = this.resetWaiter
        this.resetWaiter = undefined
        w?.(false)
        const t = this.current
        if (t && !t.done) this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })
        this.hardReset()
      }
    }
  }

  private route(m: SDKMessage): void {
    // /clear confirmation. SDKConversationResetMessage (sdk.d.ts:3838-3846:
    // "Emitted by /clear, plan-mode exit, and fresh-session flows"; in the
    // SDKMessage union at sdk.d.ts:4019) is the SDK's OWN typed proof the
    // recycle landed. Step 1a (2026-08-04, token-free gate probe) measured
    // that /clear ALSO emits its OWN synthetic local `result` (num_turns: 0,
    // duration_api_ms: 0, modelUsage: {}) immediately after this message —
    // three `result` frames per recycle, not two — so we do NOT resolve
    // resetWaiter here. We only mark the reset seen and keep waiting; the
    // synthetic result is consumed below, and THAT is what lets awaitClear()
    // return. This guarantees the synthetic frame is always absorbed while
    // turn.sent === false, never after the next push.
    //
    // Guarded on `this.resetWaiter` (review finding 6, 2026-08-04):
    // sdk.d.ts:3838-3840 documents conversation_reset as emitted by
    // `/clear`, plan-mode exit, AND fresh-session flows — not just our own
    // `/clear` push. `awaitClear()` installs `resetWaiter` before pushing,
    // so it is set iff we are actually waiting on THIS signal; an
    // unsolicited reset (nobody awaiting) must not latch
    // `clearResultPending`, or the next unrelated `result` gets silently
    // absorbed as stray and a live turn strands until its own timer.
    if (m.type === "conversation_reset") {
      if (this.resetWaiter) this.clearResultPending = true
      return
    }

    if (this.clearResultPending) {
      // Absorb /clear's own synthetic turn (its system/init, assistant, and
      // finally its result) here, never as any turn's terminal result. Only
      // the result frame resolves awaitClear() — the BINDING sequencing
      // rule (§6e, 2026-08-04): consume BOTH conversation_reset and this
      // synthetic result before the prompt is pushed. Field-sniffing this
      // frame (e.g. on num_turns === 0) was explicitly rejected as pinning
      // the design to undocumented fields; ordering is the only signal used.
      this.strayMessages++
      if (m.type === "result") {
        this.clearResultPending = false
        const w = this.resetWaiter
        this.resetWaiter = undefined
        w?.(true)
      }
      return
    }

    const t = this.current
    if (!t || t.done) { this.strayMessages++; return }

    // §6e L6/L7 + round-4 M11: NOTHING below may act on a turn that has not
    // crossed the send boundary. Messages arriving in that window belong to
    // the /clear leg or to a previous turn's tail; letting them mark an
    // unsent turn `doomed` or fire interrupt() would poison a turn that has
    // spent nothing and could abort an in-flight /clear.
    if (!t.sent) { this.strayMessages++; return }

    if (m.type === "assistant") {
      t.sawModelActivity = true                  // diagnostic only
      const am = assistantModel(m)
      if (am) t.corroboratedModel = am           // DIAGNOSTIC — never a stamp
    }

    if (m.type === "system" && (m as { subtype?: string }).subtype === "api_retry") {
      // sdk.d.ts:2842-2852. `error_status !== null` => the API answered =>
      // law L6. `error_status === null` => a connection error with no HTTP
      // response, which sdk.d.ts:2839-2841 says includes TIMEOUTS — i.e.
      // possibly a billed call — so once the prompt was pushed it is law
      // L5, consumed, exactly like the non-null case. The status is
      // recorded for diagnostics and changes NOTHING about the outcome.
      const status = (m as { error_status?: number | null }).error_status
      if (status !== null && status !== undefined) t.sawApiResponse = true
      // The CLI auto-retries internally; that retry would be call #2 (§6d
      // finding, agent-transport.ts:135-145). Cancel now — but DO NOT
      // settle: law L7 settles from the turn's OWN terminal result, so no
      // trailing message can ever be attributed to the NEXT turn.
      t.doomed = true
      this.interruptCurrent(t)
      return
    }

    if (m.type === "result") {
      const r = m as {
        subtype?: string
        is_error?: boolean
        result?: unknown
        modelUsage?: Record<string, { outputTokens?: number; output_tokens?: number; canonicalModel?: string }>
      }
      // EVIDENCE (§6e provenance): the keys of `modelUsage` on the terminal
      // result (sdk.d.ts:4312 success, :4279 error) plus each entry's
      // `canonicalModel` (sdk.d.ts:1274-1277), reconciled against the
      // requested model by the pure `selectEvidence()` (review finding 3 —
      // extracted so its multi-key branch, structurally unreachable
      // through any local stub on this driving path, can still be
      // fixture-tested). `corroboratedModel` is NEVER consulted here —
      // promoting corroboration to proof when usage is missing would
      // quietly restore the tautology the rule exists to remove.
      //
      // The match is modelProvenBy, NOT equality: the real API keys this by
      // the DATED snapshot id while the deriver requests the undated alias
      // (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22),
      // so an equality test would report call-consumed for every honest
      // turn and spend a whole sized go for zero records (round-4 C1).
      const evidence = selectEvidence(r.modelUsage, t.model)
      t.observedModel = evidence.model
      t.observedCanonical = evidence.canonicalModel

      const success = r.subtype === "success" && r.is_error !== true && !t.doomed
      if (success && typeof r.result === "string" && r.result) {
        if (!t.observedModel) {
          // The call happened but the result carries no usable model
          // evidence; an unprovable stamp is worse than a retryable record.
          this.finish(t, { kind: "call-consumed" })
          return
        }
        this.finish(t, {
          kind: "ok",
          text: r.result,
          model: t.observedModel,
          canonicalModel: t.observedCanonical,
        })
        return
      }
      // SDKResultError carries no `result` (sdk.d.ts:4269-4288) and an
      // interrupted assistant message is `aborted` (sdk.d.ts:2870-2873) —
      // no partial text is ever accumulated here, let alone persisted.
      this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })
    }
  }

  /** Push `/clear` and WAIT for BOTH `conversation_reset` AND the synthetic
   * `result` /clear emits on its own heels (measured 2026-08-04, Step 1a —
   * see route()'s comment on `clearResultPending`). Nothing has been sent
   * to the model at this point, so every failure here is law L4. Resolving
   * on `conversation_reset` alone would let that synthetic `result` land
   * AFTER the caller pushes the next prompt, where `route()` could mistake
   * it for that turn's real terminal result — the ordering this function
   * exists to pin down. */
  private async awaitClear(): Promise<boolean> {
    const feed = this.feed
    if (!feed) return false
    this.clearResultPending = false           // defensive: no stale wait carried over
    const done = new Promise<boolean>((res) => { this.resetWaiter = res })
    const timer = setTimeout(() => {
      const w = this.resetWaiter
      this.resetWaiter = undefined
      this.clearResultPending = false
      w?.(false)
    }, this.clearTimeoutMs)
    feed.push(userMsg("/clear"))
    try {
      return await done
    } finally {
      clearTimeout(timer)
    }
  }

  /** ONE turn, start to settle.
   *
   * ORDER IS LOAD-BEARING: `this.current` assignment -> ensure -> setModel
   * cap -> awaitClear -> push -> timers. `this.current` is assigned FIRST,
   * before `ensure()` even runs (review finding 2, 2026-08-04) — not just
   * before the recycle leg as an earlier draft had it — so a
   * `session/cancel` naming this turn can find it for the WHOLE
   * ensure->setModel->awaitClear window, not only from awaitClear onward.
   * `void this.drain()` runs synchronously inside `oneShot`'s executor, so
   * by the time `oneShot()` returns to its caller the turn is already out
   * of `pending` and into `execute()` — a cancel arriving in the
   * ensure/setModel gap (~84 ms cold, up to `setModelMs` = 2 000 ms on a
   * model switch) used to find the tag NOWHERE (not in `pending`, not yet
   * `current`) and answer `"unknown"`, after which the turn still pushed
   * and billed. Assigning `this.current` up front is exactly why
   * `cancel()` must DROP an unsent current turn rather than interrupt it
   * (round-4 I11), and why `route()` ignores every message while
   * `sent === false` (round-4 M11) — both already tolerate `current` being
   * set long before the turn sends.
   *
   * EVERY await is followed by a `this.closed || turn.done` re-check
   * (round-4 I3). Without them a close() landing inside the SDK import is
   * followed by a fresh subprocess and a real push, and a cancel landing
   * inside awaitClear() is followed by the push it was asked to prevent. */
  private async execute(turn: Turn): Promise<void> {
    // execute()'s OWN wait slot — never the caller's.
    const settled = new Promise<TurnOutcome>((res) => { turn.settle = res })
    this.current = turn

    if (!(await this.ensure(turn.model))) { this.finish(turn, { kind: "no-call" }); return }
    // Resumed after the package import / Query construction: a close() or a
    // cancel may have landed. finish() is done-guarded, so re-finishing an
    // already-settled turn is a no-op and the early return is safe.
    if (this.closed || turn.done) { this.finish(turn, { kind: "no-call" }); return }

    if (turn.model !== this.currentModel) {
      // setModel is streaming-only (sdk.d.ts:2327) and UN-TIMED. Cap it, or
      // one wedged subprocess hangs this await forever with no timer armed.
      const ok = await within(this.q!.setModel(turn.model), this.setModelMs)
      if (!ok || this.closed || turn.done) {
        this.hardReset()
        this.finish(turn, { kind: "no-call" })   // nothing pushed => law L4
        return
      }
      this.currentModel = turn.model
    }

    // Recycle FIRST and SEQUENCED. Recycle is the CALLER's decision so a
    // multi-prompt ACP session keeps its context.
    if (turn.recycle && !this.fresh) {
      const cleared = await this.awaitClear()
      if (turn.done) return                      // cancel/close settled it already
      if (this.closed) {
        this.hardReset()
        this.finish(turn, { kind: "no-call" })
        return
      }
      if (!cleared) {
        // Never derive on a possibly-half-cleared context. Destroying the
        // Query is the strictly safer failure: the next turn respawns, which
        // is a clean context by construction, and nothing was sent.
        this.hardReset()
        this.finish(turn, { kind: "no-call" })
        return
      }
    }
    this.fresh = false

    const feed = this.feed
    if (!feed || this.closed || turn.done) {
      if (!turn.done) this.finish(turn, { kind: "no-call" })
      return
    }
    feed.push(userMsg(turn.text))
    turn.sent = true                             // THE send boundary crosses here

    // Timers start AFTER the push, so the generation budget measures
    // generation and the /clear + setModel legs have their own caps
    // (§6e budget rule; all five legs sum to daemonWorstCaseMs). The CLI
    // subprocess spawn (1.25-1.46 s, §6d) also falls inside this window,
    // which is why `turnTimeoutMs` is clamped to CLI_SPAWN_BUDGET_MS in the
    // constructor (round-4 C3).
    turn.timer = setTimeout(() => {
      turn.doomed = true
      this.interruptCurrent(turn)
    }, this.turnTimeoutMs)
    turn.hardTimer = setTimeout(() => {
      // interrupt() itself hung. Destroy the Query + subprocess; the pump's
      // generation guard is what stops the dying pump from reaching the
      // NEXT turn (law L7).
      const consumed = this.consumed(turn)
      this.hardReset()
      this.finish(turn, { kind: consumed ? "call-consumed" : "no-call" })
    }, this.turnTimeoutMs + this.hardGraceMs)

    await settled
  }
}
