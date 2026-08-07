// call.ts — the ACP daemon's one-call leaf (ApiSession.drain, api-session.ts).
// One `messages.create` per `sendOne`, with the no-call/call-consumed
// send-boundary law:
//   no-call        = provably nothing went toward the model
//   call-consumed  = any ambiguity at/after `messages.create`
// Outcome-law + client-construction conventions adapted from meta-harness
// cc-gate-plugin/src/gauge/transport.ts (sdkCallOutcome, lines ~189-298);
// machinery that doesn't apply here (structured-output schemas, transport
// selection, stopReason plumbing) is deliberately not carried over.
//
// Task 5 of the api-sdk-swap plan: this file used to also hold an
// in-process daemonCall/ensureDaemon/closeSession trio — a single-process
// twin of the real ACP client, kept alive from Task 1 through Task 4
// because index.ts exported it and deleting it earlier would have broken
// that export mid-task (the gate made duplication cheap, deletion
// expensive — see Task 5 Step 4a). index.ts now points at the real
// acp-client.ts trio instead, so the twin is gone; sendOne — the only
// thing that was ever genuinely new here — is what remains.
import { buildClient } from "./client.ts"
import type { AuthDeps } from "./auth.ts"
import type { WarmIsolation } from "./acp-wire.ts"
import type { TurnOutcome } from "./session-contract.ts"

const DEFAULT_BUDGET_MS = 60_000
const DEFAULT_MAX_TOKENS = 2_048

/** The ACP daemon's one-call leaf. No sessionId (the daemon owns session
 * identity via `DaemonState.sessions`); returns `TurnOutcome`; accepts an
 * `AbortSignal` so a session can implement `cancel`, and an optional
 * pre-built `messages` array so the caller (a session accumulating its own
 * history) controls conversation continuity — this function stays
 * stateless per call either way. Never throws — the returned promise never
 * rejects; every failure mode is folded into a TurnOutcome arm. */
export async function sendOne(
  outgoingText: string,
  model: string,
  env: Record<string, string | undefined>,
  opts: {
    isolation: WarmIsolation
    budgetMs?: number
    maxTokens?: number
    authDeps?: AuthDeps
    signal?: AbortSignal
    messages?: Array<{ role: "user" | "assistant"; content: string }>
  },
): Promise<TurnOutcome> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS

  if (opts.isolation.thinking.type === "enabled") {
    return { kind: "no-call" }
  }

  const resolution = buildClient(env, { budgetMs, authDeps: opts.authDeps })
  if ("kind" in resolution) return { kind: "no-call" }
  const { client } = resolution

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        messages: opts.messages ?? [{ role: "user", content: outgoingText }],
        ...(opts.isolation.systemPrompt ? { system: opts.isolation.systemPrompt } : {}),
      },
      { signal: opts.signal },
    )

    let text = ""
    for (const block of response.content) {
      if (block.type === "text") text += block.text
    }
    if (!text) return { kind: "call-consumed" }

    return { kind: "ok", text, model: response.model, canonicalModel: response.model }
  } catch {
    return { kind: "call-consumed" }
  }
}
