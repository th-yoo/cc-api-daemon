// call.ts — the single-process @anthropic-ai/sdk twin of meta-harness
// src/acp's client surface. One `messages.create` per `daemonCall`, with the
// no-call/call-consumed send-boundary law preserved in-process:
//   no-call        = provably nothing went toward the model
//   call-consumed  = any ambiguity at/after `messages.create`
// Outcome-law + client-construction conventions adapted from meta-harness
// cc-gate-plugin/src/gauge/transport.ts (sdkCallOutcome, lines ~189-298);
// machinery that doesn't apply here (structured-output schemas, transport
// selection, stopReason plumbing) is deliberately not carried over.
//
// Top-level static import is fine: this is a single-purpose package with no
// hook-latency constraint (unlike the gate plugin, which lazy-loads).
import Anthropic from "@anthropic-ai/sdk"
import type { WarmIsolation, DaemonOutcome } from "./types.ts"
import { resolveAuth, type AuthDeps } from "./auth.ts"

const DEFAULT_BUDGET_MS = 60_000
const DEFAULT_MAX_TOKENS = 2_048

/** One model call. NEVER throws — the returned promise never rejects; every
 * failure mode is folded into a DaemonOutcome arm. */
export async function daemonCall(
  outgoingText: string,
  model: string,
  env: Record<string, string | undefined>,
  opts: { isolation: WarmIsolation; budgetMs?: number; maxTokens?: number; authDeps?: AuthDeps },
): Promise<DaemonOutcome> {
  // Minted FIRST, before any check runs — carried on every outcome arm,
  // including the pre-auth no-call (types.ts documents this departure from
  // the original ACP client, which only set it on `ok`).
  const sessionId = crypto.randomUUID()
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS

  // No proven thinking-budget mapping for the raw API request shape — same
  // refusal as meta-harness minimal/providers/anthropic-api.ts:59-61: an
  // enabled-thinking isolation is declined up front (nothing sent) rather
  // than sent with a guessed mapping.
  if (opts.isolation.thinking.type === "enabled") {
    return { kind: "no-call", sessionId }
  }

  const auth = resolveAuth(env, opts.authDeps)
  if (auth === undefined) return { kind: "no-call", sessionId }

  let client: Anthropic
  try {
    // AMBIENT-ENV LEAK GUARDS (the plan's Critical fix, verified against SDK
    // 0.115.0 client.js): the SDK defaults any OMITTED (undefined)
    // apiKey/authToken/baseURL option from the REAL process.env
    // (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL), and
    // authHeaders() COMPOSES both auth headers with no precedence — a host
    // carrying the other credential in its ambient env would silently send
    // BOTH X-Api-Key and Authorization. Therefore:
    //   - the not-chosen auth field is ALWAYS explicit null in each lane;
    //   - baseURL is ALWAYS `env.ANTHROPIC_BASE_URL ?? null` — null, never
    //     omission (undefined re-triggers the process.env default; null
    //     falls through to the production default URL).
    // The passed `env` param stays the single authority over what the
    // client sees.
    //
    // maxRetries: 0 — exactly-one-call provable; no retry machinery needed
    // (and with an explicit apiKey or authToken the SDK's credential-chain
    // 401-refresh-retry path can never arm).
    client =
      "apiKey" in auth
        ? new Anthropic({
            apiKey: auth.apiKey,
            authToken: null,
            maxRetries: 0,
            timeout: budgetMs,
            baseURL: env.ANTHROPIC_BASE_URL ?? null,
          })
        : new Anthropic({
            authToken: auth.authToken,
            apiKey: null,
            maxRetries: 0,
            timeout: budgetMs,
            // OAuth bearer tokens require this beta on /v1/messages.
            defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
            baseURL: env.ANTHROPIC_BASE_URL ?? null,
          })
  } catch {
    // Belt-and-suspenders: no realistic throw path exists in construction
    // (no network I/O happens here), but a throw before `messages.create`
    // is entered provably sent nothing → no-call.
    return { kind: "no-call", sessionId }
  }

  // From here EVERY failure is call-consumed: thrown SDK error, timeout,
  // HTTP 4xx/5xx. That INCLUDES 401 — uniform post-create classification;
  // distinguishing status codes (e.g. mapping auth failures back to a
  // softer arm) is a conscious non-goal: once `messages.create` is entered
  // we cannot prove nothing reached the model, so the conservative reading
  // wins (transport.ts's §6e boundary law).
  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: outgoingText }],
      // `system` key OMITTED entirely when systemPrompt is "" — mirror of
      // anthropic-api.ts's rule (empty string means "no system prompt",
      // not "system prompt that is empty").
      ...(opts.isolation.systemPrompt ? { system: opts.isolation.systemPrompt } : {}),
    })

    // DELIBERATE departure from transport.ts's first-text-block rule:
    // concatenate ALL `type === "text"` content blocks, joined with "" —
    // content blocks read as one continuous stream, so returning only the
    // first would silently truncate multi-block replies.
    let text = ""
    for (const block of response.content) {
      if (block.type === "text") text += block.text
    }
    if (!text) return { kind: "call-consumed", sessionId }

    // canonicalModel === model always here: the raw API exposes exactly one
    // identity field (`response.model`), so modelProvenBy's canonical-branch
    // (types.ts:23) is dead in this implementation — documented, not
    // "fixed"; the caller's reconciliation contract stays uniform.
    return { kind: "ok", text, model: response.model, canonicalModel: response.model, sessionId }
  } catch {
    return { kind: "call-consumed", sessionId }
  }
}

/** Readiness probe = "could a daemonCall resolve credentials right now".
 * Never throws. `waitMs` is accepted-and-ignored: there is no daemon
 * process to wait for in this single-process implementation — the param
 * exists for interface parity with the out-of-process client surface. */
export async function ensureDaemon(
  env: Record<string, string | undefined>,
  opts?: { waitMs?: number; authDeps?: AuthDeps },
): Promise<boolean> {
  return resolveAuth(env, opts?.authDeps) !== undefined
}

/** Stateless no-op. Sessions hold no server-side state here — each
 * daemonCall is a single stateless messages.create, so there is nothing to
 * close; `sessionId`/`env`/`opts` are accepted for interface parity with
 * the ACP client's close-not-release contract. */
export async function closeSession(
  sessionId: string,
  env: Record<string, string | undefined>,
  opts?: { budgetMs?: number },
): Promise<{ closed: boolean; reason?: string }> {
  void sessionId
  void env
  void opts
  return { closed: true }
}
