// types.ts — the wire-independent core types, ported from kkamak's
// cc-gate-plugin acp layer (acp-wire.ts / acp-client.ts). Pure module:
// zero imports, so anything may depend on it without pulling in the SDK.

/** §6e "Which field proves the model", the MATCHING rule — the single
 * definition, used to pick which modelUsage entry is the turn's own and to
 * decide whether the daemon lane may stamp a record.
 *
 * NOT string equality, and that is load-bearing: the API keys usage by the
 * DATED snapshot id (e.g. `"modelUsage":{"claude-haiku-4-5-20251001": …}`)
 * for a request that named the undated alias `claude-haiku-4-5`, and the
 * SDK documents that the key "may differ from the raw model string this
 * entry is keyed by (provider-specific ids, aliases)". Strict equality
 * would return `undefined` for EVERY honest daemon derivation — a whole
 * sized go spent for zero records (round-4 finding C1).
 *
 * The `"-"` in the prefix test is deliberate: `startsWith(requested)` alone
 * would let `claude-haiku-4-52` prove `claude-haiku-4-5`. */
export function modelProvenBy(key: string, requested: string, canonicalModel?: string): boolean {
  if (!key || !requested) return false
  if (key === requested) return true
  if (key.startsWith(`${requested}-`)) return true
  return canonicalModel === requested
}

/** The per-session slice of the SDK option set. `model`, `cwd` and `env`
 * stay separate: they are per-session VALUES, this is the session's
 * POLICY. */
export interface WarmIsolation {
  systemPrompt: string
  settingSources: []
  settings: { autoMemoryEnabled: false }
  persistSession: false
  strictMcpConfig: true
  tools: []
  title: string
  thinking: { type: "disabled" } | { type: "enabled" }
}

/** Mirrors WarmSession's TurnOutcome so §6e's send-boundary law survives
 * the process boundary. `model`/`canonicalModel` are the daemon's EVIDENCE
 * (the modelUsage key and its canonicalModel), forwarded verbatim — the
 * caller reconciles them with modelProvenBy.
 *
 * `sessionId` is set when a session was established, so a caller can later
 * `closeSession` it (close-not-release). Unlike the original ACP client,
 * THIS implementation mints the sessionId before any check runs, so it is
 * present on EVERY arm, not only `ok`. */
export type DaemonOutcome =
  | { kind: "ok"; text: string; model: string; canonicalModel: string; sessionId?: string }
  | { kind: "no-call"; sessionId?: string }
  | { kind: "call-consumed"; sessionId?: string }
