// daemon-reap.ts — SIGTERM real spawned daemon processes by pid, read out
// of their spawn log. Extracted from test/acp-client.test.ts (A6.1): that
// file calls `afterEach` at module scope, so re-exporting straight from it
// would drag `bun:test` into the published `./testing` surface. This
// module imports nothing from `bun:test`.
//
// `LIVE_DAEMONS` is a registry, not a hidden implementation detail: a
// caller pushes `{ spawnLog }` onto it after spawning a real daemon, and
// nothing in this module sweeps it automatically — there is no
// `afterEach` here to do that. A caller MUST invoke `reapDaemons()` from
// its own teardown, or every spawned daemon this registers stays alive for
// the full `DEFAULT_IDLE_MS` (900 000 ms) idle budget.
import fs from "node:fs"

export const LIVE_DAEMONS: Array<{ spawnLog: string }> = []

/** Read the POST-LISTEN pids out of the spawn log and SIGTERM each one.
 * Pid-scoped, never `pkill -f` — §6e forbids host-wide teardown (round-4
 * I9). Does NOT remove the daemon's own files (discovery, both locks, spawn
 * log) — those live under the daemon's throwaway HOME, swept generically by
 * temp-home.ts's `cleanupTempHomes()`. */
export function killDaemonByPid(spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
}

/** Poll a spawn-log-shaped file for at least `n` post-listen lines. */
export async function waitForLines(file: string, n: number, ms: number): Promise<string[]> {
  const deadline = Date.now() + ms
  for (;;) {
    let lines: string[] = []
    try { lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()) } catch { /* not yet */ }
    if (lines.length >= n || Date.now() > deadline) return lines
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Drains `LIVE_DAEMONS`, killing each by pid. Call from your own
 * `afterEach`/`afterAll` — this module has no test-runner hook of its own
 * to call it for you. */
export function reapDaemons(): void {
  while (LIVE_DAEMONS.length) {
    const d = LIVE_DAEMONS.pop()!
    killDaemonByPid(d.spawnLog)
  }
}
