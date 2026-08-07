// models.ts — read-only model metadata (GET /v1/models, GET
// /v1/models/{id}), NOT a billed model turn. Deliberately does NOT reuse
// daemonCall's no-call/call-consumed vocabulary (types.ts): that law exists
// specifically to encode billed-call spend-risk ("did a paid messages.create
// provably not happen, or is there ambiguity after it") for a caller who
// must not double-spend. Listing/retrieving models is an unbilled, idempotent
// GET — there is no double-spend concern, so `no-auth`/`error`/`not-found`
// name what actually happened instead of borrowing spend-risk vocabulary
// that would mislead a caller into treating a network hiccup here as
// call-consumed.
import Anthropic from "@anthropic-ai/sdk"
import type { ModelInfo } from "@anthropic-ai/sdk/resources/models"
import type { AuthDeps } from "./auth.ts"
import { buildClient } from "./client.ts"

/** Re-exported verbatim, not trimmed — see README's "Model metadata"
 * section for why (ModelCapabilities is a live, evolving surface; a
 * hand-copied local type would need manual upkeep on every new capability
 * flag and would silently under-report in the meantime). */
export type { ModelInfo } from "@anthropic-ai/sdk/resources/models"

// Metadata GET, not a generation call — smaller than call.ts's 60s default,
// which is calibrated for model latency, not a listing round-trip.
const DEFAULT_MODELS_BUDGET_MS = 10_000

// NOTE: budgetMs bounds each individual HTTP request, not the total time to
// drain a paginated listModels() call — a multi-page walk issues one request
// per page, each independently bounded by budgetMs, so total wall-clock for
// draining all pages is unbounded by budgetMs. Same documented-not-fixed
// shape as call.ts's auth-resolution-runs-before-budgetMs gap (see
// README's "Known limitations").

export type ModelListOutcome =
  | { kind: "ok"; models: ModelInfo[] }
  | { kind: "no-auth" }
  | { kind: "error"; status?: number; message?: string }

export type ModelRetrieveOutcome =
  | { kind: "ok"; model: ModelInfo }
  | { kind: "no-auth" }
  | { kind: "not-found" }
  | { kind: "error"; status?: number; message?: string }

/** Enumerate available models. NEVER throws. Drains every page into one
 * flat array — this package prefers "the whole logical answer" over a
 * stream/iterator to manage, matching daemonCall's own text-concatenation
 * choice. If a later page fails mid-walk, the partial list is discarded
 * (binary all-or-error, no partial-success arm). */
export async function listModels(
  env: Record<string, string | undefined>,
  opts?: { budgetMs?: number; authDeps?: AuthDeps },
): Promise<ModelListOutcome> {
  const resolution = buildClient(env, {
    budgetMs: opts?.budgetMs ?? DEFAULT_MODELS_BUDGET_MS,
    authDeps: opts?.authDeps,
  })
  if ("kind" in resolution) return { kind: "no-auth" }

  try {
    const models: ModelInfo[] = []
    for await (const model of resolution.client.models.list()) {
      models.push(model)
    }
    return { kind: "ok", models }
  } catch (e) {
    if (e instanceof Anthropic.APIError) return { kind: "error", status: e.status, message: e.message }
    return { kind: "error" }
  }
}

/** Look up one model by ID. NEVER throws. A 404 gets its own `not-found`
 * arm — unlike daemonCall's uniform post-create classification (a
 * conscious non-goal that exists only to preserve the spend-boundary law,
 * which doesn't apply to this unbilled GET), so there's no reason to
 * collapse real, useful status information here. */
export async function retrieveModel(
  modelId: string,
  env: Record<string, string | undefined>,
  opts?: { budgetMs?: number; authDeps?: AuthDeps },
): Promise<ModelRetrieveOutcome> {
  const resolution = buildClient(env, {
    budgetMs: opts?.budgetMs ?? DEFAULT_MODELS_BUDGET_MS,
    authDeps: opts?.authDeps,
  })
  if ("kind" in resolution) return { kind: "no-auth" }

  try {
    const model = await resolution.client.models.retrieve(modelId)
    return { kind: "ok", model }
  } catch (e) {
    if (e instanceof Anthropic.NotFoundError) return { kind: "not-found" }
    if (e instanceof Anthropic.APIError) return { kind: "error", status: e.status, message: e.message }
    return { kind: "error" }
  }
}
