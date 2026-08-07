import { describe, expect, test } from "bun:test"
import {
  FrameDecoder, encodeFrame, ACP_BUDGET, AUTH_RESOLVE_BUDGET_MS, modelProvenBy,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
} from "../src/acp-wire.ts"
import type {
  AcpInitializeResult, AcpNewSessionParams, AcpPromptParams, AcpPromptResult,
} from "../src/acp-wire.ts"

// TYPE-LEVEL conformance guard (ACP extensibility rule), independent of any
// runtime fixture. The runtime test below ("every Acp*'s _meta has no
// custom key other than 'kkamak'") only catches a REQUIRED field added at
// `_meta` root — a required addition forces someone to edit the fixture
// literals, and that edit is what trips the runtime assertion. An OPTIONAL
// addition (e.g. `_meta: { kkamak: {...}; debug?: boolean }`) types-checks
// the existing fixtures completely unchanged, so `tsc --noEmit` stays clean
// and the runtime `Object.keys` check still evaluates to `["kkamak"]` —
// the exact bare-root violation this node exists to prevent would ship
// silently. `OnlyKkamak<M>` resolves to `true` iff `M`'s only key is
// `kkamak`, and to `never` (a type error against `true`) otherwise, so any
// `Acp*` `_meta` gaining ANY other key — required or optional — fails
// `tsc --noEmit` here regardless of what the runtime fixtures say. Do NOT
// delete this block as "unused": deleting it silently reopens the hole
// described above. Sweep of `Acp*` interfaces in acp-wire.ts confirms
// AcpInitializeResult, AcpNewSessionParams (N3c-iii: gained `_meta` when
// isolation crossed the wire), AcpPromptParams and AcpPromptResult declare a
// `_meta` field (AcpNewSessionResult and AcpUpdateParams have none) — add a
// line here for any future one that gains one.
type OnlyKkamak<M> = Exclude<keyof M, "kkamak"> extends never ? true : never
const acpInitializeResultMetaIsKkamakOnly: OnlyKkamak<AcpInitializeResult["_meta"]> = true
const acpNewSessionParamsMetaIsKkamakOnly: OnlyKkamak<AcpNewSessionParams["_meta"]> = true
const acpPromptParamsMetaIsKkamakOnly: OnlyKkamak<AcpPromptParams["_meta"]> = true
const acpPromptResultMetaIsKkamakOnly: OnlyKkamak<AcpPromptResult["_meta"]> = true
void acpInitializeResultMetaIsKkamakOnly
void acpNewSessionParamsMetaIsKkamakOnly
void acpPromptParamsMetaIsKkamakOnly
void acpPromptResultMetaIsKkamakOnly

describe("acp-wire framing", () => {
  test("round-trips a request frame", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    expect(frames.length).toBe(1)
    expect((frames[0] as { method: string }).method).toBe("initialize")
  })
  test("reassembles frames split across chunks", () => {
    const d = new FrameDecoder()
    const wire = encodeFrame({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/x" } })
    expect(d.push(wire.slice(0, 10)).length).toBe(0)
    expect(d.push(wire.slice(10)).length).toBe(1)
  })
  test("a multi-byte character split across two BUFFER chunks survives verbatim", () => {
    // THE corruption guard. A bare chunk.toString() yields two U+FFFD here,
    // the frame still parses as JSON, and a silently corrupted prompt goes
    // to the model — a wrong derivation with no error anywhere.
    const d = new FrameDecoder()
    const text = "é你好\u{1F600} tail"        // 2-, 3- and 4-byte sequences
    const wire = Buffer.from(encodeFrame({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { text } }), "utf8")
    // Cut inside the 4-byte emoji: find its start and split one byte in.
    const cut = wire.indexOf(Buffer.from("\u{1F600}", "utf8")) + 1
    expect(d.push(wire.subarray(0, cut)).length).toBe(0)
    const frames = d.push(wire.subarray(cut))
    expect(frames.length).toBe(1)
    expect((frames[0] as { params: { text: string } }).params.text).toBe(text)
  })
  test("two frames in one chunk", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 3, method: "a" }) + encodeFrame({ jsonrpc: "2.0", id: 4, method: "b" }))
    expect(frames.length).toBe(2)
  })
  test("malformed line counts, never throws, stream survives", () => {
    const d = new FrameDecoder()
    const frames = d.push("not json\n" + encodeFrame({ jsonrpc: "2.0", id: 5, method: "ok" }))
    expect(frames.length).toBe(1)
    expect(d.malformed).toBe(1)
  })
  test("an unterminated giant line is dropped, not buffered forever", () => {
    const d = new FrameDecoder({ maxLineChars: 64 })
    expect(d.push("x".repeat(200)).length).toBe(0)
    expect(d.malformed).toBe(1)
    // buffer was reset: a well-formed frame right after still decodes
    expect(d.push(encodeFrame({ jsonrpc: "2.0", id: 6, method: "ok" })).length).toBe(1)
  })
  test("the two instrument error codes are distinct, stable, and inside the reserved server-error band", () => {
    expect(ACP_ERR_NO_CALL).toBe(-32000)
    expect(ACP_ERR_CALL_CONSUMED).toBe(-32001)
    for (const c of [ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED]) {
      expect(c).toBeLessThanOrEqual(-32000)
      expect(c).toBeGreaterThanOrEqual(-32099)
    }
  })
})

// §6e budget rule, locked as arithmetic rather than prose: if the client
// leg ever stops exceeding the daemon's worst case, an ordinary slow turn
// trips law L2 and the record costs TWO model calls.
//
// Re-budgeted for HTTP (Task 3 of the api-sdk-swap plan): clearTimeoutMs/
// setModelMs are inert on this backend (no /clear, no setModel round-trip),
// so daemonWorstCaseMs is the sum of the three legs that survive, not all
// five — the old five-leg sum (32 000) is gone, replaced below.
// daemonLegMs/minFallbackMs/recordBudgetMs (kkamak's own client-side
// fallback-timing policy, upstream) are dropped, not renamed — per the
// fork ruling, that policy is kkamak's repo's concern now, not this
// daemon's budget object. clientBudgetMs is daemonLegMs's direct successor
// for the one role this repo's own daemonCall still needs.
describe("ACP_BUDGET arithmetic (§6e budget rule)", () => {
  test("daemon worst case is the sum of the legs that survive on HTTP", () => {
    // Actual-first with the computed (plain-`number`) sum, expected-second
    // with the `as const`-literal-typed field — not just style: bun:test's
    // `toBe<T>` ties T to the ACTUAL value, so `expect(<literal 26000>).toBe(<number>)`
    // fails to compile (expected must be the exact literal type); this
    // order is the same one the pre-Task-3 version of this test already used.
    expect(ACP_BUDGET.queueWaitMs + ACP_BUDGET.turnTimeoutMs + ACP_BUDGET.hardGraceMs)
      .toBe(ACP_BUDGET.daemonWorstCaseMs)
  })
  test("client budget exceeds daemon worst case — drift here double-spends", () => {
    expect(ACP_BUDGET.clientBudgetMs).toBeGreaterThan(ACP_BUDGET.daemonWorstCaseMs)
  })
  test("the client's slack covers a connect + initialize + session/new preamble", () => {
    // Not decoration: the daemon's clock starts when it accepts the prompt,
    // the client's when it opens the socket. Anything under a second of
    // slack would make an ordinary busy daemon look like law L2.
    expect(ACP_BUDGET.clientBudgetMs - ACP_BUDGET.daemonWorstCaseMs).toBeGreaterThanOrEqual(3_000)
  })
  test("turnTimeoutMs is floored by auth resolution, not by a CLI spawn", () => {
    // A turn's timers start at the PUSH while credentials are still being
    // resolved (keychain exec / credentials-file read, auth.ts's
    // EXEC_TIMEOUT_MS — same reasoning as the CLI-spawn floor this replaces,
    // different pre-HTTP cost). A turnTimeoutMs at or below it cannot
    // distinguish "generation failed" from "auth had not resolved yet".
    expect(ACP_BUDGET.turnTimeoutMs).toBeGreaterThanOrEqual(AUTH_RESOLVE_BUDGET_MS)
  })
})

// §6e "Which field proves the model" — the MATCHING rule, not equality.
// This is the round-4 C1 lock: the repo's own captured CLI transcripts key
// modelUsage by the DATED snapshot id
// (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22 =>
// "claude-haiku-4-5-20251001") while resolveModelId("haiku") produces the
// undated alias. Strict equality here discards EVERY honest derivation.
describe("modelProvenBy (§6e model-proof rule)", () => {
  test("exact match proves", () => {
    expect(modelProvenBy("claude-haiku-4-5", "claude-haiku-4-5")).toBe(true)
  })
  test("a DATED snapshot key proves its undated alias", () => {
    expect(modelProvenBy("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(true)
  })
  test("canonicalModel proves even when the key is provider-specific", () => {
    expect(modelProvenBy("bedrock/anthropic.claude-haiku", "claude-haiku-4-5", "claude-haiku-4-5")).toBe(true)
  })
  test("a DIFFERENT model never proves — prefix matching must not be a substring match", () => {
    expect(modelProvenBy("claude-opus-5", "claude-haiku-4-5")).toBe(false)
    expect(modelProvenBy("claude-opus-5-20260101", "claude-haiku-4-5")).toBe(false)
    // and the boundary: a longer FAMILY name is not a snapshot of a shorter one
    expect(modelProvenBy("claude-haiku-4-52", "claude-haiku-4-5")).toBe(false)
  })
  test("empty inputs never prove anything", () => {
    expect(modelProvenBy("", "claude-haiku-4-5")).toBe(false)
    expect(modelProvenBy("claude-haiku-4-5", "")).toBe(false)
  })
})

// ACP extensibility rule (agentclientprotocol.com): every custom `_meta`
// payload MUST be namespaced under a vendor key, because "all possible
// [bare] names [at _meta's root] are reserved for future protocol
// versions" — the spec's own examples key by vendor ("zed.dev/debugMode",
// `agentCapabilities._meta` holding a `"zed.dev"` object). Ours is
// "kkamak". `JsonRpcError.data` is exempt: it is JSON-RPC's own free-form
// slot, not the root of an ACP spec type, so the namespacing rule does not
// reach it.
describe("_meta namespacing (ACP extensibility rule)", () => {
  const initResult: AcpInitializeResult = {
    protocolVersion: 1,
    agentCapabilities: { loadSession: false },
    _meta: { kkamak: { envFingerprint: "abc123" } },
  }
  const promptParams: AcpPromptParams = {
    sessionId: "s1",
    prompt: [{ type: "text", text: "hi" }],
    _meta: { kkamak: { model: "claude-haiku-4-5" } },
  }
  const promptResult: AcpPromptResult = {
    stopReason: "end_turn",
    _meta: { kkamak: { model: "claude-haiku-4-5-20251001", canonicalModel: "claude-haiku-4-5", callConsumed: true } },
  }

  test("AcpInitializeResult._meta nests envFingerprint under kkamak", () => {
    expect(initResult._meta.kkamak.envFingerprint).toBe("abc123")
  })
  test("AcpPromptParams._meta nests model under kkamak", () => {
    expect(promptParams._meta.kkamak.model).toBe("claude-haiku-4-5")
  })
  test("AcpPromptResult._meta nests model/canonicalModel/callConsumed under kkamak", () => {
    expect(promptResult._meta.kkamak).toEqual({
      model: "claude-haiku-4-5-20251001",
      canonicalModel: "claude-haiku-4-5",
      callConsumed: true,
    })
  })

  // The conformance property itself, shape-level: for every Acp*
  // result/params fixture, `_meta` has no custom key other than `kkamak`.
  // A future addition at `_meta` root (bypassing the kkamak nest) fails
  // this loudly instead of silently colliding with a future protocol
  // version's reserved name.
  test("every Acp*'s _meta has no custom key other than 'kkamak'", () => {
    const fixtures: Array<{ name: string; meta: Record<string, unknown> }> = [
      { name: "AcpInitializeResult", meta: initResult._meta },
      { name: "AcpPromptParams", meta: promptParams._meta },
      { name: "AcpPromptResult", meta: promptResult._meta },
    ]
    for (const { name, meta } of fixtures) {
      expect(Object.keys(meta), `${name}._meta`).toEqual(["kkamak"])
    }
  })
})
