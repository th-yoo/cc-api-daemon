// Live smoke — REAL SPEND (one haiku call). Run deliberately, never in CI:
//   bun scripts/smoke.ts
// Exercises the real auth ladder (on a dev machine typically the darwin
// keychain OAuth lane), one messages.create, and the provenance check.
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

const ready = await ensureDaemon(env)
console.log("ensureDaemon:", ready)
if (!ready) {
  console.error("no resolvable credentials — smoke cannot run")
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
