// api-session.ts — the @anthropic-ai/sdk backend for the ACP daemon.
//
// Structural twin of meta-harness src/acp/warm-session.ts: same
// DispatchableSession contract, same §6e outcome law, same FIFO. What it is
// NOT is warm — there is no subprocess holding state. "Warm" here means the
// session owns the accumulated conversation array; the HTTP connection is
// pooled by the SDK and nothing else persists between turns.
import { sendOne } from "./call.ts"
import type { AuthDeps } from "./auth.ts"
import { ACP_BUDGET, AUTH_RESOLVE_BUDGET_MS, type WarmIsolation } from "./acp-wire.ts"
import type { WarmConstructOpts } from "./acp-pool.ts"
import type { DispatchableSession, TurnOutcome, CancelResult } from "./session-contract.ts"

interface PendingTurn {
  text: string
  model: string
  tag: string | undefined
  /** THE §6e send boundary. True once messages.create has been ENTERED for
   * this turn. `consumed(t) === t.sent` — the whole classification. */
  sent: boolean
  /** Cancelled before dispatch; settles as no-call, never ok. */
  dropped: boolean
  controller: AbortController | undefined
  settle: (o: TurnOutcome) => void
}

export class ApiSession implements DispatchableSession {
  readonly isolation: WarmIsolation
  private readonly turnTimeoutMs: number
  private readonly queueWaitMs: number
  private readonly hardGraceMs: number
  private readonly authDeps: AuthDeps | undefined
  private pending: PendingTurn[] = []
  private current: PendingTurn | undefined
  private draining = false
  private closed = false
  /** The accumulated conversation. `messages.create` is stateless, so
   * continuity across session/prompt calls is THIS object's job — the one
   * place the swap is genuinely new code rather than a port. */
  private history: Array<{ role: "user" | "assistant"; content: string }> = []

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: WarmConstructOpts & { cwd?: string; authDeps?: AuthDeps },
  ) {
    // Floored by auth resolution for the reason the upstream floor existed
    // for CLI spawn: a turn's timer starts at the push, and without the
    // floor the session cannot tell "generation failed" from "auth had not
    // resolved yet". `clearTimeoutMs` and `setModelMs` are accepted and
    // ignored — no /clear, no setModel round-trip on this backend.
    this.turnTimeoutMs = Math.max(AUTH_RESOLVE_BUDGET_MS, opts.turnTimeoutMs ?? ACP_BUDGET.turnTimeoutMs)
    this.queueWaitMs = opts.queueWaitMs ?? ACP_BUDGET.queueWaitMs
    this.hardGraceMs = opts.hardGraceMs ?? ACP_BUDGET.hardGraceMs
    this.isolation = opts.isolation
    this.authDeps = opts.authDeps
  }

  turnInFlight(): boolean {
    return this.current !== undefined || this.pending.length > 0 || this.draining
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    // A turn already sent MAY have spent — abort the HTTP request but settle
    // call-consumed, never no-call. An unsent turn provably spent nothing.
    this.current?.controller?.abort()
    for (const t of [this.current, ...this.pending]) {
      if (t) t.settle({ kind: t.sent ? "call-consumed" : "no-call" })
    }
    this.current = undefined
    this.pending = []
    this.history = []
  }

  oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      if (this.closed) { resolve({ kind: "no-call" }); return }
      if (opts.recycle) this.history = []
      let settled = false
      const turn: PendingTurn = {
        text: messageText, model, tag: opts.tag, sent: false, dropped: false,
        controller: undefined,
        settle: (o) => { if (!settled) { settled = true; resolve(o) } },
      }
      // The queue-wait timer arms at the PUSH, matching upstream: a turn
      // still queued when it fires provably never reached the wire.
      const queueTimer = setTimeout(() => {
        if (!turn.sent && this.current !== turn) {
          turn.dropped = true
          this.pending = this.pending.filter((t) => t !== turn)
          turn.settle({ kind: "no-call" })
        }
      }, this.queueWaitMs)
      const settleOnce = turn.settle
      turn.settle = (o) => { clearTimeout(queueTimer); settleOnce(o) }
      this.pending.push(turn)
      void this.drain()
    })
  }

  /** Strict FIFO, one turn on the wire at a time. Never throws — a rejection
   * escaping here would surface as an unhandled rejection in the daemon
   * process, killing the host-global singleton. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pending.length > 0 && !this.closed) {
        const turn = this.pending.shift()!
        if (turn.dropped) continue
        this.current = turn
        const controller = new AbortController()
        turn.controller = controller
        const deadline = setTimeout(() => controller.abort(), this.turnTimeoutMs)
        // THE SEND BOUNDARY. Everything after this point is call-consumed.
        turn.sent = true
        const messages = [...this.history, { role: "user" as const, content: turn.text }]
        const outcome = await sendOne(turn.text, turn.model, this.env, {
          isolation: this.isolation,
          budgetMs: this.turnTimeoutMs,
          authDeps: this.authDeps,
          signal: controller.signal,
          messages,
        })
        clearTimeout(deadline)
        // History advances ONLY on a proven-ok turn: a failed or aborted turn
        // must not leave a dangling user message that every later turn
        // re-sends and re-pays for.
        if (outcome.kind === "ok") {
          this.history = [...messages, { role: "assistant", content: outcome.text }]
        }
        this.current = undefined
        turn.settle(outcome)
      }
    } finally {
      this.draining = false
      this.current = undefined
    }
  }

  /** Never settles the turn as `ok`, and never settles it AT the moment of
   * cancellation for an in-flight turn — the abort propagates and `drain`
   * settles from the terminal outcome (upstream law L7). `unsent-dropped`
   * is unreachable on this backend: a turn is either still queued (never
   * dispatched) or already past the send boundary, with no window between
   * dequeue and send. It stays in CancelResult for contract parity. */
  cancel(tag: string): CancelResult {
    if (this.current?.tag === tag) {
      this.current.controller?.abort()
      return "interrupted"
    }
    const queued = this.pending.find((t) => t.tag === tag)
    if (queued) {
      queued.dropped = true
      this.pending = this.pending.filter((t) => t !== queued)
      queued.settle({ kind: "no-call" })
      return "queued-dropped"
    }
    return "unknown"
  }
}
