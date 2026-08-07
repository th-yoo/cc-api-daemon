// §6e ACP wire subset. Hand-rolled, dependency-free (user ruling: "ACP is
// just interface not implementation"): JSON-RPC 2.0, newline-delimited,
// the methods this daemon serves. Wire shapes transcribed from
// agentclientprotocol.com (protocol/session-setup, protocol/prompt-turn);
// fixtures in acp-wire.test.ts are the conformance record.
//
// SCOPE: a PRIVATE INSTRUMENT PROFILE of the ACP wire, not a
// general-purpose ACP agent — `_meta.kkamak.model` is REQUIRED on
// session/prompt, `session/new.cwd` is accepted-and-ignored (the instrument
// pins a neutral cwd), and `session/cancel` is answerable as a request.
// Off-the-shelf editor clients are explicitly out of scope.
//
// Transport-agnostic: the daemon binds it to a Unix socket, and a --stdio
// flag binds the same dispatcher to stdin/stdout for our own tooling.
//
// Imports nothing but node:string_decoder, deliberately: transport.ts
// imports this module eagerly and transport.ts is on hook-cli.ts's eager
// import path (hook-cli.ts:24).
import { StringDecoder } from "node:string_decoder"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  /** §6e law L3 step (i): AUTHORITATIVE call-consumption channel when
   * present AND boolean. A recognized numeric code with this field absent
   * is honoured by step (ii); anything else falls to L2. */
  data?: { callConsumed: boolean; model?: string }
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: JsonRpcError
}

export const ACP_INITIALIZE = "initialize"
export const ACP_SESSION_NEW = "session/new"
export const ACP_SESSION_PROMPT = "session/prompt"
export const ACP_SESSION_CANCEL = "session/cancel"
export const ACP_SESSION_UPDATE = "session/update"
/** review-sensor build prerequisite: the sensor's close-not-release
 * discipline (SessionPool.closeEntry, acp-pool.ts) needs a wire verb to
 * reach it from a client. Request params `{ sessionId: string }`; response
 * result `{ closed: boolean; reason?: string }` — ALWAYS a response, never
 * an error frame, so a lost close race (unknown/busy/in-flight session) is
 * a no-op by spec, same as `session/cancel`'s own ack. */
export const ACP_SESSION_CLOSE = "session/close"

/** §6e law L1/L4 — the prompt bytes never crossed the boundary toward the
 * model. The caller MAY fall back to the one-shot lane without breaking
 * §4's exactly-one-call rule. This is the ONLY safe fallback signal. */
export const ACP_ERR_NO_CALL = -32000
/** §6e law L2/L5/L6 — the prompt bytes were pushed and the turn still
 * failed. The caller MUST NOT fall back; the record stays
 * pending/retryable. */
export const ACP_ERR_CALL_CONSUMED = -32001

/** §6e instrument invariant: a turn's timers start at the PUSH while the
 * CLI subprocess is still booting, and §6d measured that spawn at
 * 1.25-1.46 s. No WarmSession construction — production or test — may use
 * a `turnTimeoutMs` below this floor, or it cannot distinguish "generation
 * failed" from "the subprocess had not started yet". Round-4 finding C3:
 * a regression test built on a 1 s budget fails a CORRECT implementation
 * deterministically. */
export const CLI_SPAWN_BUDGET_MS = 8_000

/** §6e budget rule. ONE object, in the module both sides import, because
 * `daemonLegMs > daemonWorstCaseMs` is a CONTRACT: split these across two
 * files and a drift silently converts a `call-consumed` into a `no-call`,
 * i.e. two model calls for one record. Locked by acp-wire.test.ts. */
export const ACP_BUDGET = {
  /** daemon: a turn still queued at this point never reached execute() */
  queueWaitMs: 6_000,
  /** daemon: `/clear` must be confirmed by conversation_reset within this */
  clearTimeoutMs: 4_000,
  /** daemon: setModel() is an un-timed SDK control round-trip (sdk.d.ts:2327);
   * capped so one wedged subprocess cannot hang the FIFO for the daemon's
   * whole lifetime with no timer armed. */
  setModelMs: 2_000,
  /** daemon: generation budget, measured from the prompt push. MUST be
   * >= CLI_SPAWN_BUDGET_MS — the spawn happens inside this window. */
  turnTimeoutMs: 16_000,
  /** daemon: grace before destroying the Query when interrupt() hangs */
  hardGraceMs: 4_000,
  /** derived: 6 000 + 4 000 + 2 000 + 16 000 + 4 000. Does NOT include the
   * uncapped lazy `import("@anthropic-ai/claude-agent-sdk")` (~84 ms
   * measured); an import slow enough to eat the client's slack degrades to
   * law L2 (call-consumed, a lost retryable record), never to a second
   * model call. */
  daemonWorstCaseMs: 32_000,
  /** client: MUST exceed daemonWorstCaseMs. The 4 000 ms of slack is the
   * connect + initialize + session/new preamble, which the daemon's own
   * per-turn clock does not cover. */
  daemonLegMs: 36_000,
  /** client: below this remaining, do not start a fallback at all */
  minFallbackMs: 10_000,
  /** client: today's CALL_TIMEOUT_MS — per-record latency never exceeds it */
  recordBudgetMs: 60_000,
} as const

/** §6e "Which field proves the model", the MATCHING rule — the single
 * definition, used by WarmSession.route() (to pick which modelUsage entry
 * is the turn's own) and by callModelDerive (to decide whether the daemon
 * lane may stamp a record).
 *
 * NOT string equality, and that is load-bearing: this repo's own captured
 * CLI transcripts key `modelUsage` by the DATED snapshot id
 * (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22 =>
 * `"modelUsage":{"claude-haiku-4-5-20251001": …}`) for a request that named
 * the undated alias `claude-haiku-4-5`, and sdk.d.ts:1274-1277 states the
 * key "may differ from the raw model string this entry is keyed by
 * (provider-specific ids, aliases)". Strict equality would return
 * `undefined` for EVERY honest daemon derivation — a whole sized go spent
 * for zero records (round-4 finding C1).
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
 * POLICY.
 *
 * Declared here (not in the session backend's own module) for the same single-source reason
 * as ACP_BUDGET, and for one scheduling reason worth stating: the pool
 * plan's S0 (WarmSession takes an isolation) and S1 (the profile registry,
 * whose AcpProfile.options IS a WarmIsolation) would otherwise be forced
 * into a chain, S0 -> S1, on the project's longest dependency path.
 * Declaring the type in this module — which both already import — makes
 * them independent. */
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

/** The §6d/§6e gauge isolation set — byte-identical to the option literal
 * currently inlined in agent-transport.ts's agentSdkCall (see :119-132
 * there for the authority). A later node proves that equality with a
 * test. */
export const GAUGE_ISOLATION: WarmIsolation = {
  systemPrompt: "",
  settingSources: [],
  settings: { autoMemoryEnabled: false },
  persistSession: false,
  strictMcpConfig: true,
  tools: [],
  title: "kkamak-gauge",
  thinking: { type: "disabled" },
}

// ACP extensibility rule (agentclientprotocol.com): "All types in the
// protocol include a `_meta` field with type `{ [key: string]: unknown }`
// that implementations can use to attach custom information," but
// "Implementations MUST NOT add any custom fields at the root of a type
// that's part of the specification. All possible names are reserved for
// future protocol versions." Bare keys under `_meta` (`_meta.model`, etc.)
// would themselves be squatting on that reserved root, so every custom
// payload here nests under one vendor key, `kkamak` — mirroring the spec's
// own `"zed.dev/debugMode"` / `agentCapabilities._meta["zed.dev"]`
// examples. `traceparent` / `tracestate` / `baggage` at `_meta` root are
// W3C trace-context names and are likewise not ours to take.

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: { loadSession: false }
  /** §6e instrument fingerprint — the client refuses a daemon whose
   * fingerprint differs from its own (pre-send => law L1 => no-call). */
  _meta: { kkamak: { envFingerprint: string } }
}
/** N3c-iii: `session/new` gains the isolation VALUE, required (never
 * defaulted — the same "no magic selection" rule `AcpPromptParams.model`
 * already enforces for the model). `cwd`/`mcpServers` stay optional and
 * ignored (§6e delta (b): the instrument pins a neutral cwd) — unchanged
 * from today's wire shape, just given a name so `acp-client.ts` can build
 * its `session/new` params `satisfies` this type. */
export interface AcpNewSessionParams {
  cwd?: string
  mcpServers?: unknown[]
  _meta: { kkamak: { isolation: WarmIsolation } }
}
export interface AcpNewSessionResult { sessionId: string }
export interface AcpPromptParams {
  sessionId: string
  prompt: Array<{ type: "text"; text: string }>
  /** REQUIRED: the daemon never substitutes its own env's model for the
   * caller's — a silent substitution would make the record's `model` stamp
   * a lie (§6e provenance rule). */
  _meta: { kkamak: { model: string } }
}
export interface AcpPromptResult {
  stopReason: "end_turn"
  /** `model` is the `modelUsage` KEY the turn ran under (sdk.d.ts:4312) and
   * `canonicalModel` is that entry's canonicalModel (sdk.d.ts:1274-1277) or
   * "". They are EVIDENCE, checked client-side with `modelProvenBy` — never
   * the requested model, which would make the caller's check a tautology,
   * and never a daemon-side verdict, which would hide the dated-snapshot
   * case from the caller. */
  _meta: { kkamak: { model: string; canonicalModel: string; callConsumed: true } }
}
export interface AcpUpdateParams {
  sessionId: string
  update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
}

export function encodeFrame(msg: object): string {
  return JSON.stringify(msg) + "\n"
}

const DEFAULT_MAX_LINE_CHARS = 4 * 1024 * 1024

/** Newline-delimited JSON-RPC decoder. Malformed lines (and lines longer
 * than `maxLineChars`, which also reset the buffer) increment `malformed`
 * and are dropped — a broken or hostile client never kills the daemon and
 * never grows its memory without bound.
 *
 * UTF-8-BOUNDARY-SAFE by construction: a StringDecoder holds any partial
 * multi-byte sequence at a chunk edge until its remaining bytes arrive. A
 * bare `chunk.toString()` would emit U+FFFD on both sides of the split; the
 * frame would still parse as JSON and a CORRUPTED prompt would reach the
 * model with no error raised anywhere. `maxLineChars` counts UTF-16 code
 * units (JS string length), not bytes — named accordingly.
 *
 * In production both sides also call `socket.setEncoding("utf8")`, so the
 * string branch is the one that runs and Node's own decoder does this work;
 * the Buffer branch here is the second layer, and the split-multibyte test
 * is what keeps it honest. */
export class FrameDecoder {
  private buf = ""
  private readonly dec = new StringDecoder("utf8")
  private readonly maxLineChars: number
  malformed = 0

  constructor(opts: { maxLineChars?: number } = {}) {
    this.maxLineChars = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS
  }

  push(chunk: Buffer | string): object[] {
    this.buf += typeof chunk === "string" ? chunk : this.dec.write(chunk)
    const out: object[] = []
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed === "object" && parsed !== null) out.push(parsed)
        else this.malformed++
      } catch {
        this.malformed++
      }
    }
    if (this.buf.length > this.maxLineChars) {
      this.malformed++
      this.buf = ""
    }
    return out
  }
}
