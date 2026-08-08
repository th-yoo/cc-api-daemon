// test/testing-subpath.test.ts — A6.3: proves the `./testing` subpath
// export actually resolves and works, imported by its PUBLIC package
// specifier (`@th-yoo/cc-api-daemon/testing`), not a relative path — a
// relative import would pass even if package.json's `exports` map were
// wrong or missing entirely.
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import {
  fakeDaemon, discoveryPath, readDiscovery,
  LIVE_HOMES, tempHome, tempEnv, cleanupTempHomes,
  LIVE_DAEMONS, reapDaemons,
} from "@th-yoo/cc-api-daemon/testing"

describe("./testing subpath", () => {
  test("fakeDaemon publishes a real discovery file readDiscovery can read, and stop() removes it", async () => {
    const env = tempEnv("subpath-fake")
    const fingerprint = "deadbeef0000"
    const fake = await fakeDaemon(env, { fingerprint, answer: "ok" })
    try {
      const info = readDiscovery(env)
      expect(info).toBeDefined()
      expect(typeof info!.port).toBe("number")
      expect(typeof info!.pid).toBe("number")
    } finally {
      fake.stop()
      cleanupTempHomes()
    }
    // stop() removes the discovery file synchronously.
    expect(readDiscovery(env)).toBeUndefined()
  })

  test("readDiscovery on an env with no daemon returns undefined — the negative-test seam A6.3 exists for", () => {
    const env = tempEnv("subpath-nodaemon")
    try {
      expect(readDiscovery(env)).toBeUndefined()
    } finally {
      cleanupTempHomes()
    }
  })

  test("cleanupTempHomes drains LIVE_HOMES and removes the dirs from disk", () => {
    const before = LIVE_HOMES.length
    const home = tempHome("subpath-cleanup")
    LIVE_HOMES.push(home)
    expect(LIVE_HOMES.length).toBe(before + 1)
    cleanupTempHomes()
    expect(LIVE_HOMES.length).toBe(0)
    expect(fs.existsSync(home)).toBe(false)
  })

  test("reapDaemons drains LIVE_DAEMONS without throwing on a spawn log that never listened", () => {
    LIVE_DAEMONS.push({ spawnLog: "/nonexistent/never-written" })
    expect(() => reapDaemons()).not.toThrow()
    expect(LIVE_DAEMONS.length).toBe(0)
  })

  test("discoveryPath is keyed by fingerprint, reachable via the subpath too", () => {
    const home = tempHome("subpath-path")
    try {
      const a = discoveryPath({ HOME: home, FOO: "1" })
      const b = discoveryPath({ HOME: home, FOO: "2" })
      expect(a).not.toBe(b)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
