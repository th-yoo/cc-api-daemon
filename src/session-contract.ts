// session-contract.ts — the backend-neutral dispatch contract.
//
// acp-daemon.ts previously typed dispatch as
// `WarmSessionLike & Pick<WarmSession, "oneShot" | "cancel">`, borrowing
// signatures off the concrete agent-SDK class so the type could not drift
// from it. With two backends there is no single concrete class to borrow
// from, so the contract is stated once here and BOTH implementations are
// checked against it.
import type { WarmIsolation } from "./acp-wire.ts"
import type { WarmSessionLike } from "./acp-pool.ts"

/** §6e send-boundary law, unchanged across backends. `model`/`canonicalModel`
 * are EVIDENCE the caller reconciles with `modelProvenBy` — never a verdict. */
export type TurnOutcome =
  | { kind: "ok"; text: string; model: string; canonicalModel: string }
  | { kind: "no-call" }
  | { kind: "call-consumed" }

/** `queued-dropped` — never reached the wire, nothing spent.
 *  `unsent-dropped` — dequeued but the request was not yet entered.
 *  `interrupted`    — the request was in flight and was aborted; MAY have spent.
 *  `unknown`        — no turn matched the tag. */
export type CancelResult = "queued-dropped" | "unsent-dropped" | "interrupted" | "unknown"

/** What the DAEMON needs off a session. Wider than `WarmSessionLike`, which
 * is deliberately narrow to what the POOL itself calls (reap / quiescent /
 * closeAll); `oneShot` and `cancel` are called only by whoever acquired the
 * entry, which from the pool onward is the daemon. */
export interface DispatchableSession extends WarmSessionLike {
  oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome>
  cancel(tag: string): CancelResult
  readonly isolation: WarmIsolation
}
