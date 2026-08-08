// acp-paths.ts — endpoint + lock + fingerprint seam. Deliberately SEPARATE
// from acp-daemon.ts: `acp-client.ts` needs these, and a client must never
// transitively pull in a module that can start a server.
//
// The original comment justified the split by claiming `hook-cli.ts` imports
// `acp-client.ts` on SessionStart. It does not — `hook-cli.ts` contains no
// ACP reference at all (grep-verified 2026-08-06). The split is still right,
// but on the general client/server-separation ground above, not that one.
// Today the only value consumer of the client is
// `src/gauge/providers/anthropic-cli-warm.ts`, reached through the
// `src/acp/index.ts` barrel; `src/gauge/send-prompt.ts` type-imports the
// barrel only, and that `import type` is load-bearing (see its own header).
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** §6e instrument fingerprint. The fingerprint covers the WHOLE env MINUS
 * these keys. An enumerated ALLOW-list was the first draft and is rejected:
 * it left ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL, the proxy vars and
 * every CLAUDE_CODE_* toggle free to change the instrument silently.
 *
 * TWO classes, and they are not interchangeable:
 *  · PER-PROCESS VOLATILE — the shell/terminal/ssh/tmux group.
 *  · NOT AN INSTRUMENT PARAMETER —
 *      KKAMAK_ACP_IDLE_MS, KKAMAK_ACP_TEST_SPAWN_LOG : daemon OPERATING
 *        parameters. (Which is exactly why Task 9's validation run binds its
 *        own KKAMAK_ACP_SOCKET rather than relying on a differing idle
 *        budget to produce a separate daemon.)
 *      KKAMAK_ACP_SOCKET : an ENDPOINT ADDRESS — where to reach the
 *        instrument, not what it is.
 *      KKAMAK_GAUGE_TRANSPORT : a LANE SELECTION. Round-4 I4, and
 *        load-bearing: post-flip the live derive path FORCES this value into
 *        a derived env (refiner-cli.ts) while the process that started the
 *        daemon carries whatever the user's shell had. Leaving it in the
 *        hash makes a client and its OWN daemon permanently unable to match
 *        — and since daemonCall never spawns, that is not "one extra
 *        daemon", it is a silent 100% fallback on every record forever.
 *
 * NOT here, deliberately: (KKAMAK_)ACP_TURN_TIMEOUT_MS, (KKAMAK_)ACP_MAX_SESSIONS.
 * They change when a generation is cut off / how many sessions a pool
 * admits, hence which turns produce a derivation, hence the instrument. A
 * daemon running a different budget must not be adopted by a client
 * expecting the registered one — so two processes setting the same value
 * under different spellings (old vs. new) deliberately get DIFFERENT
 * fingerprints and cannot share a daemon. Safe direction (over-isolation,
 * not cross-talk); pinned by test/acp-paths.test.ts.
 *
 * Also NOT here, deliberately: (KKAMAK_)ACP_TEST_MARKER. Being outside the
 * denylist is the mechanism by which a test forks a distinct fingerprint
 * from the live host — denylisting it would collapse any env without a
 * HOME override onto the host fingerprint, letting a test fake overwrite
 * (and on stop() delete) the running host daemon's discovery file.
 *
 * The denylist is a FIXED list, not host-extensible: the daemon is a
 * separate process spawned as bare `bun <acp-daemon.ts>` carrying only env,
 * fingerprinting off this module-level constant. Any in-process extension
 * the client applied couldn't reach the daemon — the two would compute
 * different fingerprints and never rendezvous. */
export const ACP_ENV_DENYLIST: readonly string[] = [
  "_", "PWD", "OLDPWD", "SHLVL", "RANDOM", "LINES", "COLUMNS", "WINDOWID",
  "TERM_SESSION_ID", "ITERM_SESSION_ID", "TMUX", "TMUX_PANE", "STY",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY",
  "XDG_SESSION_ID", "DBUS_SESSION_BUS_ADDRESS",
  "KKAMAK_ACP_IDLE_MS", "KKAMAK_ACP_TEST_SPAWN_LOG", "ACP_IDLE_MS", "ACP_TEST_SPAWN_LOG",
  "KKAMAK_ACP_SOCKET", "KKAMAK_GAUGE_TRANSPORT",
]

/** Keys whose NAME looks like a credential contribute presence, never value.
 * A name-shaped rule rather than an enum, so a new credential variable is
 * covered the day it appears. NO `g` FLAG: a global regex carries lastIndex
 * across .test() calls and would alternate true/false on the same key. */
export const ACP_SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

export function envFingerprint(env: Record<string, string | undefined>): string {
  const deny = new Set(ACP_ENV_DENYLIST)
  const lines: string[] = []
  for (const k of Object.keys(env).sort()) {
    if (deny.has(k)) continue
    const v = env[k]
    if (v === undefined) continue
    lines.push(ACP_SECRET_KEY_RE.test(k) ? `${k}=set` : `${k}=${v}`)
  }
  return crypto.createHash("sha256").update(lines.join("\n") + "\n").digest("hex").slice(0, 12)
}

/** websocket-transport swap: replaces `socketPath`. A unix socket path
 * doubled as a self-organizing registry — the fingerprint WAS the address,
 * so "does a daemon exist for this env" and "where do I reach it" were the
 * same question. A TCP port carries no fingerprint, so the mapping has to
 * become an artifact: a small JSON file at the SAME fingerprint-derived
 * location the socket used to occupy, holding `{port, pid}`.
 *
 * `env.HOME` is consulted explicitly, ahead of `os.homedir()` — this is
 * NOT cosmetic. `os.homedir()` reads the CURRENT process's real
 * environment; it has no way to see a `HOME` field inside a plain `env`
 * object a caller merely PASSED IN. Two callers rely on that distinction:
 * (1) a spawned daemon subprocess, whose `Bun.spawn({env})` REPLACES its
 * OWN process.env wholesale (acp-client.ts's spawnDaemonProcess), so its
 * own `os.homedir()` already agrees with `env.HOME` — the explicit check
 * is redundant but harmless there; (2) a TEST or client process calling
 * `discoveryPath(someEnv)`/`readDiscovery(someEnv)` on a plain object
 * that is NOT its own process.env, where `os.homedir()` would silently
 * return the REAL host's home directory regardless of what `someEnv.HOME`
 * says — exactly the isolation escape a per-test HOME override exists to
 * prevent. */
export function discoveryPath(env: Record<string, string | undefined>): string {
  const home = env.HOME || os.homedir()
  const fp = envFingerprint(env)
  return path.join(home, ".config", "kkamak", `acp-${fp}.json`)
}

export interface DiscoveryInfo {
  port: number
  pid: number
}

/** Never throws — a missing, unreadable, or malformed file all collapse to
 * `undefined`, same discipline as `resolveAuth`/`readDiscovery`'s
 * neighbors in this module. Structural-only: does NOT probe whether `port`
 * is still live — that is a connect attempt, the caller's job (ensureDaemon
 * / the daemon's own bind takeover), not a filesystem read's. */
export function readDiscovery(env: Record<string, string | undefined>): DiscoveryInfo | undefined {
  try {
    const raw = fs.readFileSync(discoveryPath(env), "utf-8")
    const parsed = JSON.parse(raw) as Partial<DiscoveryInfo> | null
    if (typeof parsed?.port !== "number" || typeof parsed?.pid !== "number") return undefined
    return { port: parsed.port, pid: parsed.pid }
  } catch {
    return undefined
  }
}

/** MAY THROW (EACCES on an unwritable parent) — same fail-open contract as
 * the old `ensureSocketDir`: callers that need never-throws (ensureDaemon)
 * own that wrapping, not this function. Directory `0700`, file `0600` — the
 * RULING declines to authenticate the WebSocket handshake itself, but
 * there is no reason to make the port world-readable when the socket dir
 * never was; this costs nothing and keeps the file honest about who owns
 * it. Call ONLY after a successful bind (acp-daemon.ts) — publishing before
 * that would let a discovery file mean "someone is about to listen here"
 * instead of "someone IS listening here", which is what makes a client
 * that reads it safe to dial without an extra existence race. */
export function writeDiscovery(env: Record<string, string | undefined>, info: DiscoveryInfo): void {
  const p = discoveryPath(env)
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, JSON.stringify(info), { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* best-effort, matches the old socket chmod's own discipline */ }
}

export function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}`
}

/** TWO locks, deliberately. The CLIENT holds `.spawn.lock` from "decide to
 * spawn" until the daemon answers `initialize`; the DAEMON holds
 * `.bind.lock` across probe->unlink->rebind. One shared file deadlocks: the
 * client would still hold it while the daemon it started tried to bind.
 * Re-derived from `discoveryPath` now (was `socketPath`) — the two-lock
 * protocol itself is transport-independent, only the address it hangs off
 * of changed. */
export function spawnLockPath(env: Record<string, string | undefined>): string {
  return `${discoveryPath(env)}.spawn.lock`
}
export function bindLockPath(env: Record<string, string | undefined>): string {
  return `${discoveryPath(env)}.bind.lock`
}

/** Staleness discipline shaped EXACTLY on corpus-store.ts:134-177 —
 * `tryCreateLock` (:134-143) is one `wx` create attempt, content and
 * exclusivity in the same syscall, and RETHROWS anything that is not EEXIST;
 * `isLockStale` (:149-158) collapses stale/vanished/torn to one takeover
 * path; `acquireLock` (:164-177) does unlink + ONE fresh `wx` retry, treating
 * a lost retry race as a refusal rather than an assumed ownership.
 * SIGNATURES MATCH THAT MODULE — `content` and `now` stay explicit
 * parameters so the two implementations remain directly comparable. */
export const ACP_LOCK_STALE_MS = 30_000

export interface AcpLockContent { pid: number; ts: number }

export function tryCreateLock(lockPath: string, content: AcpLockContent): boolean {
  try {
    // mode 0o700 only applies on creation — a no-op for an already-existing dir.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false
    throw e
  }
}

export function isLockStale(lockPath: string, now: number): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<AcpLockContent> | null
    if (typeof parsed?.ts !== "number") return true
    return now - parsed.ts >= ACP_LOCK_STALE_MS
  } catch {
    return true
  }
}

export function acquireAcpLock(lockPath: string, now: number): boolean {
  const content: AcpLockContent = { pid: process.pid, ts: now }

  if (tryCreateLock(lockPath, content)) return true
  if (!isLockStale(lockPath, now)) return false

  try {
    fs.unlinkSync(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
  return tryCreateLock(lockPath, content)
}

export function releaseAcpLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath)
  } catch {
    // best-effort — never let release itself surface
  }
}
