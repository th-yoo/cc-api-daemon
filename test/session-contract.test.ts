// test/session-contract.test.ts
import { test, expect } from "bun:test"
import type { DispatchableSession, TurnOutcome, CancelResult } from "../src/session-contract.ts"
import type { WarmIsolation } from "../src/acp-wire.ts"

const iso: WarmIsolation = {
  systemPrompt: "", settingSources: [], settings: { autoMemoryEnabled: false },
  persistSession: false, strictMcpConfig: true, tools: [],
  title: "t", thinking: { type: "disabled" },
}

test("a minimal object satisfies DispatchableSession structurally", () => {
  const s: DispatchableSession = {
    isolation: iso,
    turnInFlight: () => false,
    close: () => {},
    oneShot: async (): Promise<TurnOutcome> => ({ kind: "no-call" }),
    cancel: (): CancelResult => "unknown",
  }
  expect(s.turnInFlight()).toBe(false)
  expect(s.cancel("tag")).toBe("unknown")
})
