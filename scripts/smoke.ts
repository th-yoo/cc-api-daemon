// Live smoke — REAL SPEND (one haiku call). Run deliberately, never in CI:
//   bun scripts/smoke.ts
// index.ts points at the real ACP client (acp-client.ts): ensureDaemon
// connects-or-spawns a real daemon over a localhost WebSocket; daemonCall is
// a real round-trip through it. Auth is resolved daemon-side (ApiSession)
// now, not in this process — one messages.create, and the provenance check.
//
// Task 7 reality-check: ensureDaemon(env) alone defaults to waitMs:0 (kick
// a background spawn, return immediately — the SessionStart-hook mode),
// which on a cold run (nothing already listening) returns false before the
// spawned daemon has had any chance to bind. That is NOT a credentials
// failure — ensureDaemon only proves socket connectivity + envFingerprint
// match; auth resolution happens later, inside the daemon, per turn.
// waitMs:15_000 gives a freshly-spawned `bun src/acp-daemon.ts` process
// enough time to bind (Task 6's e2e test measured well under that on a
// warm Bun install).
import { ensureDaemon, daemonCall, modelProvenBy, type WarmIsolation } from "../src/index.ts"

const REQUESTED = "claude-haiku-4-5"

const isolation: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "cc-api-daemon-smoke",
  thinking: { type: "disabled" },
}

const env = process.env as Record<string, string | undefined>

const ready = await ensureDaemon(env, { waitMs: 15_000 })
console.log("ensureDaemon:", ready)
if (!ready) {
  console.error("daemon did not come up within 15s (spawn failed or never bound) — smoke cannot run")
  process.exit(1)
}

const outcome = await daemonCall("Reply with exactly the word: ok", REQUESTED, env, { isolation })
console.log("outcome.kind:", outcome.kind)
if (outcome.kind !== "ok") {
  console.error("smoke FAILED:", outcome)
  process.exit(1)
}
console.log("text:", JSON.stringify(outcome.text))
console.log("model:", outcome.model, "canonicalModel:", outcome.canonicalModel)
console.log("sessionId:", outcome.sessionId)
console.log("provenance:", modelProvenBy(outcome.model, REQUESTED, outcome.canonicalModel))
