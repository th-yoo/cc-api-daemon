// test/acp-pool.test.ts — N3c-ii: SessionPool over a DEPENDENCY-INJECTED
// fake WarmSession. No CLI, no credentials, zero spend — the pool never
// drives a turn itself, it only hands out entries and tracks idle/busy.
//
// node-n3c-ii-brief.md governs. The 9-test sketch there is adapted 1:1
// below (numbered in each test's describe/name). Every test here still uses
// an explicit DI fake (makeSession) except the "default backend" describe
// block at the bottom (Task 5), which pins the real ApiSession default.
import { describe, expect, test } from "bun:test"
import { ACP_BUDGET, type WarmIsolation } from "../src/acp-wire.ts"
import { SessionPool, type WarmConstructOpts, type WarmSessionLike } from "../src/acp-pool.ts"
import { WarmSession } from "../src/warm-session.ts"

// Two distinct fixture isolations for segregation tests — arbitrary
// content, deliberately different from each other. Replaces the gauge's
// own GAUGE_ISOLATION/REASONING_ISOLATION constants, which were
// caller-side and this general ACP package no longer ships (Task 1 Step 2).
const TEST_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "acp-pool-test-a",
  thinking: { type: "disabled" },
}

const TEST_ISOLATION_2: WarmIsolation = {
  systemPrompt: "reason carefully",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "acp-pool-test-b",
  thinking: { type: "disabled" },
}

const ENV: Record<string, string | undefined> = { ...process.env, KKAMAK_ACP_TEST_MARKER: "acp-pool-test" }

/** The DI fake: no CLI, no Query, no network. `turnInFlight` is
 * test-controlled via `setTurnInFlight` so reap/quiescent tests can force
 * the "still finishing a pumped turn" state independently of the pool's own
 * busy/idle bookkeeping (self-review item (d): reap must never close a
 * turn-in-flight session, checked as its OWN signal, not derived from
 * busy). */
class FakeWarm implements WarmSessionLike {
  closedCount = 0
  private inFlight = false
  constructor(
    readonly env: Record<string, string | undefined>,
    readonly opts: WarmConstructOpts,
  ) {}
  turnInFlight(): boolean {
    return this.inFlight
  }
  setTurnInFlight(v: boolean): void {
    this.inFlight = v
  }
  close(): void {
    this.closedCount++
  }
}

function fakeMakeSession(env: Record<string, string | undefined>, opts: WarmConstructOpts): FakeWarm {
  return new FakeWarm(env, opts)
}

function asFake(warm: WarmSessionLike): FakeWarm {
  return warm as FakeWarm
}

describe("SessionPool.acquire — concurrency and reuse", () => {
  test("1. two concurrent acquires (same isolation) get DIFFERENT entries with DIFFERENT warm instances", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const now = Date.now()
    const a = pool.acquire(TEST_ISOLATION, now)
    const b = pool.acquire(TEST_ISOLATION, now)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    // separate transcripts — the whole point of the pool
    expect(a.entry.id).not.toBe(b.entry.id)
    expect(a.entry.warm).not.toBe(b.entry.warm)
  })

  test("2. acquire -> release -> acquire (same isolation) reuses the SAME warm instance with mustRecycle:true; a brand-new entry has mustRecycle:false", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const first = pool.acquire(TEST_ISOLATION, t0)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // never-used entry: no /clear owed on its first turn (T4's awaitClear
    // cost is real and must not be paid for nothing)
    expect(first.mustRecycle).toBe(false)

    pool.release(first.entry.id, t0 + 1)
    const second = pool.acquire(TEST_ISOLATION, t0 + 2)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry.warm).toBe(first.entry.warm)
    expect(second.mustRecycle).toBe(true)
  })
})

describe("SessionPool.acquire — isolation segregation (C4)", () => {
  test("3. REASONING and GAUGE acquires never share an entry; the entry handed back always carries the requested isolation", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const g = pool.acquire(TEST_ISOLATION, t0)
    const r = pool.acquire(TEST_ISOLATION_2, t0)
    expect(g.ok).toBe(true)
    expect(r.ok).toBe(true)
    if (!g.ok || !r.ok) return
    expect(g.entry.id).not.toBe(r.entry.id)
    expect(g.entry.warm).not.toBe(r.entry.warm)
    expect(g.entry.isolation).toEqual(TEST_ISOLATION)
    expect(r.entry.isolation).toEqual(TEST_ISOLATION_2)

    // release both, then prove a GAUGE re-acquire never comes back as the
    // REASONING entry (a reused entry silently serving a different
    // isolation is the silent-wrong-system-prompt failure).
    pool.release(g.entry.id, t0 + 1)
    pool.release(r.entry.id, t0 + 1)
    const g2 = pool.acquire(TEST_ISOLATION, t0 + 2)
    expect(g2.ok).toBe(true)
    if (!g2.ok) return
    expect(g2.entry.id).toBe(g.entry.id)
    expect(g2.entry.id).not.toBe(r.entry.id)
    expect(g2.entry.isolation).toEqual(TEST_ISOLATION)
  })

  test("4. key-order robustness: two deep-equal isolation objects built with different key insertion orders hit the SAME pool key (reuse happens)", () => {
    const isoA: WarmIsolation = {
      systemPrompt: "same-policy",
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      persistSession: false,
      strictMcpConfig: true,
      tools: [],
      title: "kkamak-test",
      thinking: { type: "disabled" },
    }
    // same fields, deliberately different insertion order, and a
    // structurally-fresh object (not the same reference as isoA)
    const isoB: WarmIsolation = {
      thinking: { type: "disabled" },
      tools: [],
      title: "kkamak-test",
      strictMcpConfig: true,
      persistSession: false,
      settings: { autoMemoryEnabled: false },
      settingSources: [],
      systemPrompt: "same-policy",
    }
    expect(isoA).toEqual(isoB)
    expect(isoA).not.toBe(isoB)

    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const first = pool.acquire(isoA, t0)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    pool.release(first.entry.id, t0 + 1)

    const second = pool.acquire(isoB, t0 + 2)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry.warm).toBe(first.entry.warm)
    expect(second.mustRecycle).toBe(true)
  })
})

describe("SessionPool.acquire — cap", () => {
  test("5. max entries reached + all busy => pool-exhausted; releasing one makes acquire succeed again", () => {
    const pool = new SessionPool(ENV, { max: 2, makeSession: fakeMakeSession })
    const t0 = Date.now()
    const a = pool.acquire(TEST_ISOLATION, t0)
    const b = pool.acquire(TEST_ISOLATION_2, t0)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const c = pool.acquire(TEST_ISOLATION, t0)
    expect(c).toEqual({ ok: false, reason: "pool-exhausted" })

    pool.release(a.entry.id, t0 + 1)
    const d = pool.acquire(TEST_ISOLATION, t0 + 2)
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.entry.id).toBe(a.entry.id) // the freed slot, reused
  })
})

describe("KKAMAK_ACP_MAX_SESSIONS parsing (6)", () => {
  test("'2' is honored — a 3rd concurrent acquire is refused", () => {
    const pool = new SessionPool({ ...ENV, KKAMAK_ACP_MAX_SESSIONS: "2" }, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    expect(pool.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(pool.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(pool.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })
  })

  test("absent => default 4 — a 5th concurrent acquire is refused, a 4th is not", () => {
    const env = { ...ENV }
    delete env.KKAMAK_ACP_MAX_SESSIONS
    const pool = new SessionPool(env, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    for (let i = 0; i < 4; i++) expect(pool.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(pool.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })
  })

  test("chosen rule: '0' CLAMPS to 1 (a pool must always serve at least one session); non-numeric garbage DEFAULTS to 4 (nothing to clamp)", () => {
    const zeroPool = new SessionPool({ ...ENV, KKAMAK_ACP_MAX_SESSIONS: "0" }, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    expect(zeroPool.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(zeroPool.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })

    const garbagePool = new SessionPool({ ...ENV, KKAMAK_ACP_MAX_SESSIONS: "banana" }, { makeSession: fakeMakeSession })
    for (let i = 0; i < 4; i++) expect(garbagePool.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(garbagePool.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })
  })

  test("explicit opts.max: NaN falls back to a FINITE cap (parseMaxSessions(env)), never disables the cap", () => {
    // Review finding (2026-08-04): Math.trunc(NaN) and Math.max(1, NaN) are
    // both NaN, so an unguarded opts.max path would make every
    // `entries.length >= this.max` check unconditionally false — unbounded
    // WarmSession growth, the exact hazard the cap exists to prevent. NaN
    // is easy for the next node to produce via `Number(someVar)` on a bad
    // config value, so this pins the explicit-opts path to the SAME
    // finiteness standard as the env-parsing path (parseMaxSessions),
    // rather than trusting the caller's number verbatim.
    const env = { ...ENV }
    delete env.KKAMAK_ACP_MAX_SESSIONS
    const pool = new SessionPool(env, { max: NaN, makeSession: fakeMakeSession })
    const t0 = Date.now()
    // falls back to parseMaxSessions(env): KKAMAK_ACP_MAX_SESSIONS is unset,
    // so the default of 4 applies — a finite, enforced cap.
    for (let i = 0; i < 4; i++) expect(pool.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(pool.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })
  })

  test("A2: ACP_MAX_SESSIONS (new spelling) is honored, and wins over KKAMAK_ACP_MAX_SESSIONS when both are set", () => {
    const newOnly = new SessionPool({ ...ENV, ACP_MAX_SESSIONS: "2" }, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    expect(newOnly.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(newOnly.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(newOnly.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })

    const bothSet = new SessionPool(
      { ...ENV, ACP_MAX_SESSIONS: "1", KKAMAK_ACP_MAX_SESSIONS: "4" },
      { makeSession: fakeMakeSession },
    )
    expect(bothSet.acquire(TEST_ISOLATION, t0).ok).toBe(true)
    expect(bothSet.acquire(TEST_ISOLATION, t0)).toEqual({ ok: false, reason: "pool-exhausted" })
  })
})

describe("SessionPool.reap (7)", () => {
  test("evicts only idle-past-deadline entries, never one with turnInFlight(), and calls warm.close() exactly once per evicted entry", () => {
    const pool = new SessionPool(ENV, { sessionIdleMs: 1_000, makeSession: fakeMakeSession })
    const t0 = 0
    const a = pool.acquire(TEST_ISOLATION, t0)
    const b = pool.acquire(TEST_ISOLATION_2, t0)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    pool.release(a.entry.id, t0 + 10)
    pool.release(b.entry.id, t0 + 10)
    // b's warm reports a turn still finishing (e.g. a stray pump tail) even
    // though the pool itself has marked the entry idle.
    asFake(b.entry.warm).setTurnInFlight(true)

    // before sessionIdleMs has elapsed for either: nothing evicted yet
    expect(pool.reap(t0 + 500)).toEqual([])

    // now a is idle-past-deadline; b is idle-past-deadline TOO by elapsed
    // time, but its warm still reports turnInFlight() => must survive
    const evicted = pool.reap(t0 + 2_000)
    expect(evicted).toEqual([a.entry.id])
    expect(asFake(a.entry.warm).closedCount).toBe(1)
    expect(asFake(b.entry.warm).closedCount).toBe(0)
    expect(pool.size()).toBe(1)

    // once b's turn settles, a later reap evicts it too, closed exactly once
    asFake(b.entry.warm).setTurnInFlight(false)
    const evicted2 = pool.reap(t0 + 3_000)
    expect(evicted2).toEqual([b.entry.id])
    expect(asFake(b.entry.warm).closedCount).toBe(1)
    expect(pool.size()).toBe(0)

    // reaping again touches nothing (already evicted, no double-close)
    expect(pool.reap(t0 + 4_000)).toEqual([])
    expect(asFake(a.entry.warm).closedCount).toBe(1)
    expect(asFake(b.entry.warm).closedCount).toBe(1)
  })

  test("a BUSY entry past the idle deadline is never reaped", () => {
    const pool = new SessionPool(ENV, { sessionIdleMs: 1_000, makeSession: fakeMakeSession })
    const t0 = 0
    const a = pool.acquire(TEST_ISOLATION, t0)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    // never released => still busy, however much time passes
    expect(pool.reap(t0 + 1_000_000)).toEqual([])
    expect(asFake(a.entry.warm).closedCount).toBe(0)
  })
})

describe("SessionPool.quiescent (8)", () => {
  test("false while any entry is busy or any warm turn is in flight; true after release and settle", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    expect(pool.quiescent()).toBe(true) // empty pool

    const a = pool.acquire(TEST_ISOLATION, t0)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(pool.quiescent()).toBe(false) // busy

    pool.release(a.entry.id, t0 + 1)
    expect(pool.quiescent()).toBe(true) // idle, no turn in flight

    asFake(a.entry.warm).setTurnInFlight(true)
    expect(pool.quiescent()).toBe(false) // idle per the pool, but the warm session is still finishing a pumped turn

    asFake(a.entry.warm).setTurnInFlight(false)
    expect(pool.quiescent()).toBe(true)
  })
})

describe("SessionPool.closeAll (9)", () => {
  test("closes every warm exactly once, including busy entries (the daemon's shutdown path, which may interrupt)", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const a = pool.acquire(TEST_ISOLATION, t0)
    const b = pool.acquire(TEST_ISOLATION_2, t0)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    pool.release(a.entry.id, t0 + 1) // a idle, b stays busy
    pool.closeAll()
    expect(asFake(a.entry.warm).closedCount).toBe(1)
    expect(asFake(b.entry.warm).closedCount).toBe(1)
    expect(pool.size()).toBe(0)
    expect(pool.quiescent()).toBe(true) // nothing left to be busy or in flight
  })
})

describe("SessionPool.closeEntry (review-sensor §2)", () => {
  test("closes and removes an idle entry; warm.close() is called exactly once", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const a = pool.acquire(TEST_ISOLATION, t0)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const id = a.entry.id

    pool.release(id, t0 + 1)
    const r = pool.closeEntry(id)
    expect(r.closed).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(pool.size()).toBe(0)
    expect(asFake(a.entry.warm).closedCount).toBe(1)
  })

  test("refuses a busy entry (not released)", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const a = pool.acquire(TEST_ISOLATION, t0)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const id = a.entry.id

    // no release — still busy
    const r = pool.closeEntry(id)
    expect(r).toEqual({ closed: false, reason: "busy" })
    expect(pool.size()).toBe(1)
    expect(asFake(a.entry.warm).closedCount).toBe(0)
  })

  test("refuses an idle entry with turnInFlight() => true (turn still finishing)", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const t0 = Date.now()
    const a = pool.acquire(TEST_ISOLATION, t0)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    const id = a.entry.id

    pool.release(id, t0 + 1)
    // idle per the pool, but the warm session reports a turn still in flight
    asFake(a.entry.warm).setTurnInFlight(true)

    const r = pool.closeEntry(id)
    expect(r).toEqual({ closed: false, reason: "turn-in-flight" })
    expect(pool.size()).toBe(1)
    expect(asFake(a.entry.warm).closedCount).toBe(0)
  })

  test("unknown id is a safe no-op (double-close must never throw)", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const r = pool.closeEntry("nonexistent-id")
    expect(r).toEqual({ closed: false, reason: "unknown-id" })
    expect(pool.size()).toBe(0)
  })
})

// No default-makeSession test here: Task 1 ports this pool with no
// backend, so `makeSession` has no default and is always supplied by the
// caller (see the constructor). Task 5's own test — "the pool builds
// ApiSessions by default" — is the direct analog for this backend, once it
// exists.
describe("SessionPool.acquire — explicit makeSession budget legs", () => {
  test("explicit budget legs are never defaults-by-omission — the fake records every leg the pool passed", () => {
    const pool = new SessionPool(ENV, { makeSession: fakeMakeSession })
    const now = Date.now()
    const g = pool.acquire(TEST_ISOLATION, now)
    expect(g.ok).toBe(true)
    if (!g.ok) return
    const opts = asFake(g.entry.warm).opts
    expect(opts).toEqual({
      isolation: TEST_ISOLATION,
      turnTimeoutMs: ACP_BUDGET.turnTimeoutMs,
      queueWaitMs: ACP_BUDGET.queueWaitMs,
      clearTimeoutMs: ACP_BUDGET.clearTimeoutMs,
      setModelMs: ACP_BUDGET.setModelMs,
      hardGraceMs: ACP_BUDGET.hardGraceMs,
    })
  })

  // N3c-iii ruling (2026-08-04): the pool, not a daemon-side factory, owns
  // KKAMAK_ACP_TURN_TIMEOUT_MS — same class of env-driven construction
  // policy as KKAMAK_ACP_MAX_SESSIONS, and a fingerprint-pinned instrument
  // knob (acp-paths.test.ts:69-71). Mirrors acp-daemon.ts's warmBudgetOpts
  // EXACTLY: `Number(env.KKAMAK_ACP_TURN_TIMEOUT_MS) || ACP_BUDGET.turnTimeoutMs`
  // — absent, "0", or non-numeric garbage all fall through the `||` to the
  // raw constant (test 11 above already pins the absent case; this pins the
  // override case, and 0/garbage explicitly, so the two together cover the
  // whole function).
  test("12. env.KKAMAK_ACP_TURN_TIMEOUT_MS overrides turnTimeoutMs exactly like warmBudgetOpts; 0/garbage/absent all fall back to the raw ACP_BUDGET constant", () => {
    const overridden = new SessionPool(
      { ...ENV, KKAMAK_ACP_TURN_TIMEOUT_MS: "12345" },
      { makeSession: fakeMakeSession },
    )
    const now = Date.now()
    const o = overridden.acquire(TEST_ISOLATION, now)
    expect(o.ok).toBe(true)
    if (o.ok) expect(asFake(o.entry.warm).opts.turnTimeoutMs).toBe(12345)

    const zero = new SessionPool({ ...ENV, KKAMAK_ACP_TURN_TIMEOUT_MS: "0" }, { makeSession: fakeMakeSession })
    const z = zero.acquire(TEST_ISOLATION, now)
    expect(z.ok).toBe(true)
    if (z.ok) expect(asFake(z.entry.warm).opts.turnTimeoutMs).toBe(ACP_BUDGET.turnTimeoutMs)

    const garbage = new SessionPool({ ...ENV, KKAMAK_ACP_TURN_TIMEOUT_MS: "banana" }, { makeSession: fakeMakeSession })
    const gp = garbage.acquire(TEST_ISOLATION, now)
    expect(gp.ok).toBe(true)
    if (gp.ok) expect(asFake(gp.entry.warm).opts.turnTimeoutMs).toBe(ACP_BUDGET.turnTimeoutMs)

    const absentEnv = { ...ENV }
    delete absentEnv.KKAMAK_ACP_TURN_TIMEOUT_MS
    const absent = new SessionPool(absentEnv, { makeSession: fakeMakeSession })
    const a = absent.acquire(TEST_ISOLATION, now)
    expect(a.ok).toBe(true)
    if (a.ok) expect(asFake(a.entry.warm).opts.turnTimeoutMs).toBe(ACP_BUDGET.turnTimeoutMs)
  })

  test("A2: ACP_TURN_TIMEOUT_MS (new spelling) is honored, and wins over KKAMAK_ACP_TURN_TIMEOUT_MS when both are set", () => {
    const newOnly = new SessionPool({ ...ENV, ACP_TURN_TIMEOUT_MS: "22222" }, { makeSession: fakeMakeSession })
    const now = Date.now()
    const n = newOnly.acquire(TEST_ISOLATION, now)
    expect(n.ok).toBe(true)
    if (n.ok) expect(asFake(n.entry.warm).opts.turnTimeoutMs).toBe(22222)

    const bothSet = new SessionPool(
      { ...ENV, ACP_TURN_TIMEOUT_MS: "33333", KKAMAK_ACP_TURN_TIMEOUT_MS: "12345" },
      { makeSession: fakeMakeSession },
    )
    const b = bothSet.acquire(TEST_ISOLATION, now)
    expect(b.ok).toBe(true)
    if (b.ok) expect(asFake(b.entry.warm).opts.turnTimeoutMs).toBe(33333)
  })
})

// Task 5 (this repo's own original numbering) made ApiSession the pool's
// default when makeSession is omitted. The api-sdk merge brief's OWN Task 5
// flips it again: the pool now exists only for the heavy (agent/CLI) lane —
// HAZARD 3's api-lane traffic is routed to a per-session ApiSession that
// bypasses the pool entirely (acp-daemon.ts, Task 4) — so WarmSession is the
// only backend the pool ever needs to construct by default now.
// `toBeInstanceOf(WarmSession)` alone proves this without spawning
// anything: WarmSession's constructor never calls ensure()/query() (see
// warm-session.test.ts's own "construction only, no CLI spawn" block) — the
// real subprocess only spawns on the first oneShot().
describe("SessionPool — default backend (api-sdk merge brief Task 5)", () => {
  test("the pool builds WarmSessions by default", () => {
    const pool = new SessionPool(ENV, { max: 1 })
    const got = pool.acquire(TEST_ISOLATION, Date.now())
    expect(got.ok).toBe(true)
    if (!got.ok) throw new Error("unreachable")
    expect(got.entry.warm).toBeInstanceOf(WarmSession)
    pool.closeAll()
  })

  test("an injected makeSession overrides the default", () => {
    let built = 0
    const pool = new SessionPool(ENV, {
      max: 1,
      makeSession: () => { built++; return { turnInFlight: () => false, close: () => {} } },
    })
    pool.acquire(TEST_ISOLATION, Date.now())
    expect(built).toBe(1)
    pool.closeAll()
  })
})
