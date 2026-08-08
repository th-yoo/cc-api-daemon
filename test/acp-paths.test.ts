// test/acp-paths.test.ts — no daemon, no CLI, no credentials needed.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import {
  envFingerprint, discoveryPath, readDiscovery, writeDiscovery, wsUrl,
  spawnLockPath, bindLockPath, ACP_ENV_DENYLIST,
  tryCreateLock, isLockStale, acquireAcpLock, releaseAcpLock,
  ACP_LOCK_STALE_MS,
} from "../src/acp-paths.ts"

/** Every test builds its OWN path under tmpdir. NO TEST MAY EVER TOUCH
 * ~/.config/kkamak/ — this file only exercises path/hash/lock logic against
 * temp files, never the real default discoveryPath() (i.e. never calls it
 * without an explicit env.HOME override). */
function tempPath(tag: string): string {
  return path.join(tmpdir(), `kkamak-acp-paths-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(tmpdir(), "kkamak-acp-paths-home-"))
}

describe("acp-paths", () => {
  test("the fingerprint covers the WHOLE env, not a five-key sample", () => {
    // The rejected allow-list would have made these three pairs identical.
    // Each of them changes the instrument.
    expect(envFingerprint({ ANTHROPIC_MODEL: "a" })).not.toBe(envFingerprint({ ANTHROPIC_MODEL: "b" }))
    expect(envFingerprint({ HTTPS_PROXY: "http://p1" })).not.toBe(envFingerprint({ HTTPS_PROXY: "http://p2" }))
    expect(envFingerprint({ CLAUDE_CODE_DISABLE_X: "1" })).not.toBe(envFingerprint({}))
  })
  test("a different base URL is a different instrument", () => {
    expect(envFingerprint({ ANTHROPIC_BASE_URL: "http://a" }))
      .not.toBe(envFingerprint({ ANTHROPIC_BASE_URL: "http://b" }))
  })
  test("secret-NAMED keys contribute PRESENCE only — the value never changes the fingerprint", () => {
    const a = envFingerprint({ ANTHROPIC_API_KEY: "sk-aaa" })
    const b = envFingerprint({ ANTHROPIC_API_KEY: "sk-bbb" })
    const none = envFingerprint({})
    expect(a).toBe(b)
    expect(a).not.toBe(none)
    // ...and the same rule reaches every secret-shaped name, not an enum.
    expect(envFingerprint({ SOME_AUTH_TOKEN: "t1" })).toBe(envFingerprint({ SOME_AUTH_TOKEN: "t2" }))
    expect(envFingerprint({ SOME_AUTH_TOKEN: "t1" })).not.toBe(none)
    // the regex must be stateless: a /g flag would carry lastIndex across
    // calls and make the SAME key match, then not match.
    expect(envFingerprint({ A_KEY: "1", B_KEY: "2" })).toBe(envFingerprint({ A_KEY: "9", B_KEY: "9" }))
  })
  test("denylisted keys do not change the fingerprint", () => {
    for (const k of [
      "PWD", "SHLVL", "TMUX_PANE",
      "KKAMAK_ACP_IDLE_MS", "KKAMAK_ACP_TEST_SPAWN_LOG",
      "ACP_IDLE_MS", "ACP_TEST_SPAWN_LOG",
    ]) {
      expect(ACP_ENV_DENYLIST.includes(k)).toBe(true)
      expect(envFingerprint({ [k]: "x" })).toBe(envFingerprint({ [k]: "y" }))
    }
  })
  test("CRITICAL: ACP_TEST_MARKER (and its legacy spelling) is NOT denylisted — a test fork must get its own fingerprint", () => {
    for (const k of ["ACP_TEST_MARKER", "KKAMAK_ACP_TEST_MARKER"]) {
      expect(ACP_ENV_DENYLIST.includes(k)).toBe(false)
      expect(envFingerprint({ [k]: "fork-a" })).not.toBe(envFingerprint({ [k]: "fork-b" }))
      expect(envFingerprint({ [k]: "fork-a" })).not.toBe(envFingerprint({}))
    }
  })
  test("ROUND-4 I4: lane SELECTION and the ENDPOINT ADDRESS are denylisted", () => {
    // KKAMAK_GAUGE_TRANSPORT chooses a lane; it cannot change one byte the
    // daemon sends. Post-flip the live path FORCES it into a derived env
    // while the process that started the daemon carries whatever the shell
    // had, so leaving it in the hash makes a client and its OWN daemon
    // permanently unable to match — and because daemonCall never spawns,
    // that is not "one extra daemon", it is 100% silent fallback forever.
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_GAUGE_TRANSPORT")).toBe(true)
    expect(envFingerprint({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe(envFingerprint({}))
    // KKAMAK_ACP_SOCKET is vestigial post-transport-swap (no more socket
    // path to override) but stays in the denylist unchanged — envFingerprint
    // is required to stay "exactly as-is" (websocket-transport plan, Task
    // 2), and a stray KKAMAK_ACP_SOCKET key in some caller's env must still
    // never perturb the fingerprint, whether or not anything sets it anymore.
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_ACP_SOCKET")).toBe(true)
    expect(envFingerprint({ KKAMAK_ACP_SOCKET: "/tmp/a.sock" }))
      .toBe(envFingerprint({ KKAMAK_ACP_SOCKET: "/tmp/b.sock" }))
  })
  test("ROUND-4 I4: the TURN BUDGET is an instrument parameter and is NOT denylisted (either spelling)", () => {
    // It changes when a generation is cut off, hence which turns produce a
    // derivation. A daemon running a different turn budget is a different
    // instrument and must not be adopted by a client expecting the
    // registered one.
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_ACP_TURN_TIMEOUT_MS")).toBe(false)
    expect(ACP_ENV_DENYLIST.includes("ACP_TURN_TIMEOUT_MS")).toBe(false)
    expect(envFingerprint({ KKAMAK_ACP_TURN_TIMEOUT_MS: "9000" }))
      .not.toBe(envFingerprint({ KKAMAK_ACP_TURN_TIMEOUT_MS: "20000" }))
    // Safe direction, asserted: the two spellings of the SAME value get
    // DIFFERENT fingerprints (over-isolation), so aliasing never lets two
    // differently-spelled-but-equal-valued processes share a daemon.
    expect(envFingerprint({ ACP_TURN_TIMEOUT_MS: "9000" }))
      .not.toBe(envFingerprint({ KKAMAK_ACP_TURN_TIMEOUT_MS: "9000" }))
  })
  test("the SESSION CAP is an instrument parameter and is NOT denylisted (either spelling)", () => {
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_ACP_MAX_SESSIONS")).toBe(false)
    expect(ACP_ENV_DENYLIST.includes("ACP_MAX_SESSIONS")).toBe(false)
    expect(envFingerprint({ ACP_MAX_SESSIONS: "4" }))
      .not.toBe(envFingerprint({ KKAMAK_ACP_MAX_SESSIONS: "4" }))
  })
  test("key ORDER in the object does not change the fingerprint (keys are sorted)", () => {
    expect(envFingerprint({ A: "1", B: "2" })).toBe(envFingerprint({ B: "2", A: "1" }))
  })

  test("the discovery path is keyed by fingerprint, like the socket path was", () => {
    const home = tmpHome()
    const a = discoveryPath({ HOME: home, FOO: "1" })
    const b = discoveryPath({ HOME: home, FOO: "2" })
    expect(a).not.toBe(b)
    expect(a.endsWith(".json")).toBe(true)
  })
  test("a secret's VALUE never reaches the discovery filename", () => {
    const p = discoveryPath({ HOME: tmpHome(), ANTHROPIC_API_KEY: "sk-super-secret-value" })
    expect(p).not.toContain("sk-super-secret-value")
  })
  test("env.HOME wins over the real host home — the isolation lever ensureDaemon/tests rely on", () => {
    const p = discoveryPath({ HOME: "/nonexistent/fake-home" })
    expect(p.startsWith("/nonexistent/fake-home")).toBe(true)
  })
  test("A4: the discovery dir is ~/.config/acpd/, not the old ~/.config/kkamak/ — no fallback read of the old location", () => {
    const p = discoveryPath({ HOME: "/nonexistent/fake-home" })
    expect(p).toBe(path.join("/nonexistent/fake-home", ".config", "acpd", `acp-${envFingerprint({ HOME: "/nonexistent/fake-home" })}.json`))
    expect(p.includes(`${path.sep}kkamak${path.sep}`)).toBe(false)
  })

  test("write then read round-trips", () => {
    const env = { HOME: tmpHome(), KKAMAK_TEST: "rt" }
    writeDiscovery(env, { port: 45123, pid: 999 })
    expect(readDiscovery(env)).toMatchObject({ port: 45123, pid: 999 })
  })
  test("a missing discovery file reads as undefined, not a throw", () => {
    expect(readDiscovery({ HOME: tmpHome(), KKAMAK_TEST: "absent" })).toBeUndefined()
  })
  test("a malformed discovery file (torn JSON, or missing fields) reads as undefined, not a throw", () => {
    const home = tmpHome()
    const p = discoveryPath({ HOME: home })
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, "{not json")
    expect(readDiscovery({ HOME: home })).toBeUndefined()

    const home2 = tmpHome()
    const p2 = discoveryPath({ HOME: home2 })
    fs.mkdirSync(path.dirname(p2), { recursive: true })
    fs.writeFileSync(p2, JSON.stringify({ port: "not-a-number" }))
    expect(readDiscovery({ HOME: home2 })).toBeUndefined()
  })
  test("writeDiscovery creates the parent dir 0700 and the file 0600", () => {
    const home = tmpHome()
    const env = { HOME: home }
    writeDiscovery(env, { port: 1, pid: 2 })
    const p = discoveryPath(env)
    const dirSt = fs.statSync(path.dirname(p))
    expect(dirSt.isDirectory()).toBe(true)
    expect(dirSt.mode & 0o777).toBe(0o700)
    const fileSt = fs.statSync(p)
    expect(fileSt.mode & 0o777).toBe(0o600)
  })

  test("wsUrl builds a loopback URL for the given port", () => {
    expect(wsUrl(45123)).toBe("ws://127.0.0.1:45123")
  })

  test("the spawn lock and the bind lock are DIFFERENT files (they guard different critical sections)", () => {
    const env = { HOME: tmpHome() }
    expect(spawnLockPath(env)).not.toBe(bindLockPath(env))
  })
})

describe("acp-paths — locks (signatures mirror corpus-store.ts)", () => {
  test("tryCreateLock: first create succeeds, a second create on the same path fails (EEXIST -> false)", () => {
    const lockPath = tempPath("lock-a")
    expect(tryCreateLock(lockPath, { pid: process.pid, ts: Date.now() })).toBe(true)
    expect(tryCreateLock(lockPath, { pid: process.pid, ts: Date.now() })).toBe(false)
  })
  test("tryCreateLock rethrows non-EEXIST errors (e.g. unwritable parent)", () => {
    const blocker = tempPath("lock-blocker-file")
    fs.writeFileSync(blocker, "not a directory")
    const lockPath = path.join(blocker, "sub", "x.lock")
    expect(() => tryCreateLock(lockPath, { pid: process.pid, ts: Date.now() })).toThrow()
  })
  test("isLockStale: missing file, old ts, and torn content all collapse to stale (true)", () => {
    const missing = tempPath("lock-missing")
    expect(isLockStale(missing, Date.now())).toBe(true)

    const old = tempPath("lock-old")
    fs.writeFileSync(old, JSON.stringify({ pid: 1, ts: 0 }))
    expect(isLockStale(old, Date.now())).toBe(true)

    const torn = tempPath("lock-torn")
    fs.writeFileSync(torn, "{not json")
    expect(isLockStale(torn, Date.now())).toBe(true)
  })
  test("isLockStale: a fresh lock (ts within ACP_LOCK_STALE_MS) is NOT stale", () => {
    const fresh = tempPath("lock-fresh")
    const now = Date.now()
    fs.writeFileSync(fresh, JSON.stringify({ pid: process.pid, ts: now }))
    expect(isLockStale(fresh, now + ACP_LOCK_STALE_MS - 1)).toBe(false)
    expect(isLockStale(fresh, now + ACP_LOCK_STALE_MS)).toBe(true)
  })
  test("acquireAcpLock: fresh contention refuses (false), never overwrites a live lock", () => {
    const lockPath = tempPath("lock-contend")
    const now = Date.now()
    expect(acquireAcpLock(lockPath, now)).toBe(true)
    expect(acquireAcpLock(lockPath, now + 1)).toBe(false)
  })
  test("acquireAcpLock: a stale lock is taken over (unlink + one fresh create)", () => {
    const lockPath = tempPath("lock-stale")
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: 0 }))
    expect(acquireAcpLock(lockPath, Date.now())).toBe(true)
    const content = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
    expect(content.pid).toBe(process.pid)
  })
  test("releaseAcpLock: unlinks an existing lock and tolerates an already-vanished one", () => {
    const lockPath = tempPath("lock-release")
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
    releaseAcpLock(lockPath)
    expect(fs.existsSync(lockPath)).toBe(false)
    // second release on the same (now-missing) path must not throw
    expect(() => releaseAcpLock(lockPath)).not.toThrow()
  })
})
