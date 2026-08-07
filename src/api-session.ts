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
import type { TurnOutcome } from "./session-contract.ts"

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

// Not `implements DispatchableSession` yet: the interface requires
// oneShot AND cancel, and TS's `implements` check is all-or-nothing — a
// class missing either one fails to compile, not just to satisfy the
// contract at the missing methods. Task 4b lands `close`/`turnInFlight`
// only, 4c adds `oneShot`, 4d adds `cancel`; the gate requires tsc clean at
// every commit, so the `implements` clause moves to 4d, once every member
// the interface requires actually exists. (The plan's own Step 3 template
// declares `implements DispatchableSession` at this same partial point —
// verified against reality: it does not compile.)
export class ApiSession {
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
}
