// client.ts — shared Anthropic SDK client construction, extracted from
// call.ts so the ambient-env-leak guards live in exactly one place as this
// package grows more call sites (daemonCall, listModels, retrieveModel).
//
// AMBIENT-ENV LEAK GUARDS (verified against SDK 0.115.0 client.js): the SDK
// defaults any OMITTED (undefined) apiKey/authToken/baseURL option from the
// REAL process.env (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_BASE_URL), and authHeaders() COMPOSES both auth headers with no
// precedence — a host carrying the other credential in its ambient env
// would silently send BOTH X-Api-Key and Authorization. Therefore:
//   - the not-chosen auth field is ALWAYS explicit null in each lane;
//   - baseURL is ALWAYS `env.ANTHROPIC_BASE_URL ?? null` — null, never
//     omission (undefined re-triggers the process.env default; null falls
//     through to the production default URL).
// The passed `env` param stays the single authority over what the client
// sees.
import Anthropic from "@anthropic-ai/sdk"
import { resolveAuth, type AuthDeps } from "./auth.ts"

export type ClientResolution = { client: Anthropic } | { kind: "no-auth" }

/** Resolves credentials and constructs an Anthropic client, or reports
 * `no-auth` — never throws. `budgetMs` becomes the SDK client's per-HTTP-
 * request timeout (`Anthropic({ timeout })`), not a total-operation budget:
 * a caller that issues multiple requests off one client (e.g. draining a
 * paginated list) is bounded per-request, not overall. */
export function buildClient(
  env: Record<string, string | undefined>,
  opts: { budgetMs: number; authDeps?: AuthDeps },
): ClientResolution {
  const auth = resolveAuth(env, opts.authDeps)
  if (auth === undefined) return { kind: "no-auth" }

  try {
    const client =
      "apiKey" in auth
        ? new Anthropic({
            apiKey: auth.apiKey,
            authToken: null,
            maxRetries: 0,
            timeout: opts.budgetMs,
            baseURL: env.ANTHROPIC_BASE_URL ?? null,
          })
        : new Anthropic({
            authToken: auth.authToken,
            apiKey: null,
            maxRetries: 0,
            timeout: opts.budgetMs,
            // OAuth bearer tokens require this beta on /v1/messages and
            // /v1/models alike.
            defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
            baseURL: env.ANTHROPIC_BASE_URL ?? null,
          })
    return { client }
  } catch {
    // Belt-and-suspenders: no realistic throw path exists in construction
    // (no network I/O happens here).
    return { kind: "no-auth" }
  }
}
