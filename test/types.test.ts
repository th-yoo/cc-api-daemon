import { describe, test, expect } from "bun:test"
import { modelProvenBy } from "../src/types.ts"

// §6e "Which field proves the model" — the MATCHING rule, not equality.
// This is the round-4 C1 lock: the API keys modelUsage by the DATED
// snapshot id ("claude-haiku-4-5-20251001") while callers request the
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
