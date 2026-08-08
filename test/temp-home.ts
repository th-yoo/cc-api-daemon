// temp-home.ts — throwaway HOME dirs for daemon-isolation tests. Extracted
// from test/acp-client.test.ts (A6.1): that file calls `afterEach` at
// module scope, so re-exporting straight from it would drag `bun:test`
// into the published `./testing` surface. This module imports nothing from
// `bun:test` — plain enough to import from a consumer's own test runner.
//
// `LIVE_HOMES` is a registry, not a hidden implementation detail: `tempEnv`
// pushes onto it, and nothing in this module sweeps it automatically —
// there is no `afterEach` here to do that. A caller MUST invoke
// `cleanupTempHomes()` from its own teardown (afterEach/afterAll), or every
// throwaway HOME dir this creates leaks on disk for the life of the host.
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"

export const LIVE_HOMES: string[] = []

export function tempHome(tag: string): string {
  return fs.mkdtempSync(path.join(tmpdir(), `c-${tag}-`))
}

/** Builds a full env object for a daemon/client under test, with its own
 * throwaway `HOME` — no daemon-isolation test should ever touch the real
 * host's `~/.config/acpd/` (`discoveryPath` consults `env.HOME` explicitly,
 * ahead of the real host's `os.homedir()`, for exactly this isolation
 * seam). Registers the new HOME on `LIVE_HOMES` for `cleanupTempHomes()`
 * to sweep later. */
export function tempEnv(tag: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const home = tempHome(tag)
  LIVE_HOMES.push(home)
  return { ...process.env, KKAMAK_ACP_TEST_MARKER: "acp-client-test", HOME: home, ...extra }
}

/** Drains `LIVE_HOMES`, best-effort `rmSync`-ing each one. Call from your
 * own `afterEach`/`afterAll` — this module has no test-runner hook of its
 * own to call it for you. */
export function cleanupTempHomes(): void {
  while (LIVE_HOMES.length) {
    const h = LIVE_HOMES.pop()!
    try { fs.rmSync(h, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}
