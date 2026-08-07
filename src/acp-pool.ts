// §6e ACP warm lane — SessionPool: a pool of long-lived WarmSessions keyed
// by isolation VALUE, not by profile id or session id.
//
// Reshaped by the 2026-08-04 send-prompt-interface ruling
// (docs/superpowers/specs/2026-08-04-send-prompt-interface.md): callers
// never see sessions, so the S1 profile registry the session-pool plan's S2
// assumed is CANCELLED. The daemon mints an ACP session id per REQUEST; the
// keep-alive underneath is this pool of WarmSessions. One WarmSession = one
// CLI subprocess + one transcript (~330 MB RSS measured, see the cap
// default below). CONCURRENT requests must get separate WarmSessions;
// SEQUENTIAL requests REUSE a warm one via /clear recycle — hence
// acquire/release, not the plan's open-by-profile/get/close-by-session-id.
//
// node-n3c-ii-brief.md governs over the plan's S2 text where they differ.
import { ACP_BUDGET, type WarmIsolation } from "./acp-wire.ts"
import { ApiSession } from "./api-session.ts"

/** The minimal structural interface the pool needs off a warm session —
 * derived from actual pool usage (reap/quiescent/closeAll), so the
 * dependency-injected test fake is honest: it does not have to also
 * implement oneShot/cancel/isolation/etc., which the pool itself never
 * calls. Every real backend (`DispatchableSession`, session-contract.ts)
 * satisfies this structurally. */
export interface WarmSessionLike {
  turnInFlight(): boolean
  close(): void
}

/** The exact option shape the pool passes to `makeSession` — isolation plus
 * the five explicit ACP_BUDGET legs, mirroring acp-daemon.ts's
 * `warmBudgetOpts` (never defaults-by-omission: every leg is named here,
 * not left for WarmSession's own constructor defaults to fill in). No
 * `cwd`: neither this pool's constructor nor `acquire()` has a cwd input in
 * the brief's surface, and acp-daemon.ts's own `warmBudgetOpts` construction
 * — the thing this is told to mirror — omits it too; WarmSession's own
 * `os.tmpdir()` default applies, same as the daemon's singleton today. */
export interface WarmConstructOpts {
  isolation: WarmIsolation
  turnTimeoutMs: number
  queueWaitMs: number
  clearTimeoutMs: number
  setModelMs: number
  hardGraceMs: number
}

export interface PoolEntry {
  id: string // pool-internal id, never crosses any wire
  isolation: WarmIsolation
  warm: WarmSessionLike
  busy: boolean
  usedBefore: boolean // true after first release => next acquire must recycle
  lastReleasedAt: number
  createdAt: number
}

/** `PoolEntry` plus the pool's own canonical isolation key, carried
 * alongside (not part of the public `PoolEntry` shape the brief specifies)
 * so isolation-equality lookups in `acquire()` never re-derive it. */
interface InternalEntry extends PoolEntry {
  readonly key: string
}

/** Cap default 4 — MEASURED, not asserted (2026-08-05 controller ruling;
 * RSS report (meta-harness cc-gate-plugin docs/2026-08-05, session-backend measurement) — marginal ~330 MB/session,
 * so 4 sessions ≈ 1.4 GB ≈ 10% of the measurement host's MemAvailable,
 * matching the seat count; 8 is memory-permissible on that host class too,
 * reachable via the env override below rather than a raised default). A
 * different host (see CLAUDE.md's cross-host note) needs its own
 * measurement before trusting this number — the doc's method travels, the
 * number does not. Env-tunable via KKAMAK_ACP_MAX_SESSIONS — see
 * `parseMaxSessions` for the exact parsing rule. */
const DEFAULT_MAX_SESSIONS = 4

/** Mirrors acp-daemon.ts's own `DEFAULT_IDLE_MS` (15 min production idle
 * budget for its singleton WarmSession). The pool has no opinion beyond
 * that precedent; the daemon (next node) may pass a shorter value, same as
 * it does today via KKAMAK_ACP_IDLE_MS. */
const DEFAULT_SESSION_IDLE_MS = 900_000

/** Parse `KKAMAK_ACP_MAX_SESSIONS` from the given env (never `process.env`
 * directly — the pool's env is passed explicitly by its constructor, same
 * discipline as the rest of the ACP lane). Chosen rule, stated because the
 * brief requires it: absent OR not a finite number (garbage, e.g. "abc")
 * falls back to the default; a finite number is CLAMPED to >= 1 (so "0" or
 * a negative value becomes 1 — the pool must always be able to serve at
 * least one session — while a garbage string is DEFAULTED, not clamped,
 * since there is no number to clamp). */
function parseMaxSessions(env: Record<string, string | undefined>): number {
  const raw = env.KKAMAK_ACP_MAX_SESSIONS
  if (raw === undefined) return DEFAULT_MAX_SESSIONS
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_MAX_SESSIONS
  return Math.max(1, Math.trunc(n))
}

/** N3c-iii ruling (2026-08-04, reopening this file): the pool owns
 * `KKAMAK_ACP_TURN_TIMEOUT_MS`, not a daemon-side factory — the same class
 * of env-driven construction policy as `KKAMAK_ACP_MAX_SESSIONS` above, and
 * a fingerprint-pinned instrument knob (acp-paths.test.ts:69-71). A
 * daemon-side `makeSession` override was considered and rejected: it would
 * split budget construction into two authorities (pool default vs. daemon
 * factory), the exact divergence class the explicit-budgets rule (every leg
 * named here, never left to a caller's own defaulting) exists to prevent.
 *
 * Mirrors acp-daemon.ts's (now-removed) `warmBudgetOpts` EXACTLY,
 * byte-for-byte in behavior, not `parseMaxSessions`'s stricter
 * finite-then-clamp rule: `Number(raw) || ACP_BUDGET.turnTimeoutMs`. Unset,
 * `"0"`, and non-numeric garbage all coerce to a falsy `Number(...)` and
 * fall through the `||` to the raw constant; any other numeric string is
 * honored VERBATIM, deliberately unclamped and unvalidated here — that is
 * `warmBudgetOpts`'s own existing behavior (it never floors to
 * `CLI_SPAWN_BUDGET_MS` either), and the session backend's own constructor
 * already owns that floor (`Math.max(CLI_SPAWN_BUDGET_MS, ...)`), so
 * re-validating here would be a second, potentially divergent authority
 * on the exact same floor. */
function parseTurnTimeoutMs(env: Record<string, string | undefined>): number {
  return Number(env.KKAMAK_ACP_TURN_TIMEOUT_MS) || ACP_BUDGET.turnTimeoutMs
}

/** Recursive sorted-keys canonicalization, so two separately-constructed
 * `WarmIsolation` literals with different key insertion orders compare
 * equal. Plain `JSON.stringify` is key-order-dependent and would treat
 * deep-equal isolation objects as distinct pool keys, defeating reuse for
 * no reason tied to the actual policy. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k])
    }
    return sorted
  }
  return value
}

/** The pool key AND the equality test for isolation (brief: "Isolation
 * equality = canonical deep equality"). A reused entry must NEVER serve a
 * different isolation than it was constructed with — the plan's C4 hazard
 * in new clothes: an isolation mismatch silently runs a turn under the
 * wrong system prompt, and nothing downstream would catch it. */
function isolationKey(isolation: WarmIsolation): string {
  return JSON.stringify(canonicalize(isolation))
}

export class SessionPool {
  private entries: InternalEntry[] = []
  private readonly max: number
  private readonly sessionIdleMs: number
  private readonly makeSession: (
    env: Record<string, string | undefined>,
    warmOpts: WarmConstructOpts,
  ) => WarmSessionLike

  constructor(
    private readonly env: Record<string, string | undefined>,
    // `makeSession` defaults to `ApiSession` (Task 5) — Task 1 left it
    // required-with-no-default because no backend existed yet; now one
    // does. A host wanting a different backend (e.g. meta-harness keeping
    // its agent-SDK WarmSession) still injects one here, or via the
    // daemon's own `makeSession` option, threaded straight through
    // (acp-daemon.ts).
    opts: {
      max?: number
      sessionIdleMs?: number
      makeSession?: (env: Record<string, string | undefined>, warmOpts: WarmConstructOpts) => WarmSessionLike
    } = {},
  ) {
    // Same finiteness standard as parseMaxSessions' env path (review
    // finding, 2026-08-04): an explicit `opts.max: NaN` — easy for the next
    // node to produce via `Number(someVar)` on a bad config value — must
    // fall back to the default, not survive. Unguarded, `Math.trunc(NaN)`
    // and `Math.max(1, NaN)` are both `NaN`, and every `entries.length >=
    // this.max` cap check is then unconditionally false: the cap silently
    // disables and session-backend growth goes unbounded — the exact hazard
    // the cap exists to prevent.
    this.max = opts.max !== undefined && Number.isFinite(opts.max) ? Math.max(1, Math.trunc(opts.max)) : parseMaxSessions(env)
    this.sessionIdleMs = opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS
    this.makeSession = opts.makeSession ?? ((e, warmOpts) => new ApiSession(e, warmOpts))
  }

  /** Never queues, never blocks. An idle entry with DEEP-EQUAL isolation is
   * reused (recycle owed); else a new one is spawned under the cap; else
   * refusal. A busy entry is invisible here even if isolation-equal —
   * WarmSession has its own internal FIFO, but cross-caller queueing
   * through it is exactly the failure this pool design removes (a caller
   * blocked behind an unrelated session). */
  acquire(
    isolation: WarmIsolation,
    now: number,
  ): { ok: true; entry: PoolEntry; mustRecycle: boolean } | { ok: false; reason: "pool-exhausted" } {
    const key = isolationKey(isolation)
    const idle = this.entries.find((e) => !e.busy && e.key === key)
    if (idle) {
      idle.busy = true
      // `usedBefore` is owed exactly on reuse: it was set true by the
      // release() that made this entry findable here, never by acquire()
      // itself, so a brand-new entry (which has never been released) can
      // never read `mustRecycle: true` on its first use.
      return { ok: true, entry: idle, mustRecycle: idle.usedBefore }
    }
    if (this.entries.length >= this.max) return { ok: false, reason: "pool-exhausted" }

    const warm = this.makeSession(this.env, {
      isolation,
      turnTimeoutMs: parseTurnTimeoutMs(this.env),
      queueWaitMs: ACP_BUDGET.queueWaitMs,
      clearTimeoutMs: ACP_BUDGET.clearTimeoutMs,
      setModelMs: ACP_BUDGET.setModelMs,
      hardGraceMs: ACP_BUDGET.hardGraceMs,
    })
    const entry: InternalEntry = {
      id: crypto.randomUUID(),
      isolation,
      warm,
      busy: true,
      usedBefore: false,
      lastReleasedAt: now,
      createdAt: now,
      key,
    }
    this.entries.push(entry)
    return { ok: true, entry, mustRecycle: false }
  }

  /** Marks idle; the entry survives for reuse. Unknown ids are ignored
   * (defensive: a double-release or a release racing closeAll() must never
   * throw into the daemon's dispatch path). */
  release(id: string, now: number): void {
    const e = this.entries.find((e) => e.id === id)
    if (!e) return
    e.busy = false
    e.usedBefore = true
    e.lastReleasedAt = now
  }

  /** Close ONE idle entry and remove it (sensor close-not-release,
   * review-sensor spec §2): refuses busy or turn-in-flight entries —
   * same ground-truth guards as reap(); a refusal degrades to the 900 s
   * reap backstop. Unknown ids are a safe no-op (double-close must never
   * throw into the daemon's dispatch path). */
  closeEntry(id: string): { closed: boolean; reason?: "unknown-id" | "busy" | "turn-in-flight" } {
    const e = this.entries.find((e) => e.id === id)
    if (!e) return { closed: false, reason: "unknown-id" }
    if (e.busy) return { closed: false, reason: "busy" }
    if (e.warm.turnInFlight()) return { closed: false, reason: "turn-in-flight" }
    e.warm.close()
    this.entries = this.entries.filter((x) => x.id !== id)
    return { closed: true }
  }

  /** Evict idle entries past `sessionIdleMs` (warm.close()); NEVER one with
   * `warm.turnInFlight()` — a busy entry is skipped by the `!e.busy` check
   * alone under the pool's own protocol (acquire sets busy, release clears
   * it only once the caller's turn has settled), but `turnInFlight()` is
   * checked too, in depth: it is the daemon's own ground truth for
   * "a turn is still running," and reap must never race ahead of it. */
  reap(now: number): string[] {
    const evicted: string[] = []
    this.entries = this.entries.filter((e) => {
      if (e.busy) return true
      if (e.warm.turnInFlight()) return true
      if (now - e.lastReleasedAt < this.sessionIdleMs) return true
      e.warm.close()
      evicted.push(e.id)
      return false
    })
    return evicted
  }

  size(): number {
    return this.entries.length
  }

  /** No entry busy AND no warm turn in flight — the daemon's self-exit
   * gate. An empty pool is quiescent by definition (`every` on `[]`). */
  quiescent(): boolean {
    return this.entries.every((e) => !e.busy && !e.warm.turnInFlight())
  }

  /** Closes every warm session exactly once, including busy ones. This is
   * the daemon's shutdown path — closing a busy entry may interrupt a
   * turn-in-flight; that is expected and correct at shutdown, not a bug to
   * guard against here (unlike `reap`, which must never touch a busy or
   * in-flight entry). */
  closeAll(): void {
    for (const e of this.entries) e.warm.close()
    this.entries = []
  }
}
