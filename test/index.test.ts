// test/index.test.ts — A6.4: proves envFingerprint, routeBackend, and
// ACP_BUDGET are reachable from the main entry, imported by the PUBLIC
// package specifier (`@th-yoo/cc-api-daemon`), not a relative path — every
// other test file in this suite imports `../src/...` directly, which would
// keep passing even if package.json's `exports["."]` were wrong.
import { describe, expect, test } from "bun:test"
import { envFingerprint, routeBackend, ACP_BUDGET } from "@th-yoo/cc-api-daemon"
import { routeBackend as routeBackendDirect } from "../src/route.ts"
import { ACP_BUDGET as ACP_BUDGET_DIRECT } from "../src/acp-wire.ts"
import { envFingerprint as envFingerprintDirect } from "../src/acp-paths.ts"

describe("main-entry exports (A6.4)", () => {
  test("routeBackend re-exported from the main entry is the SAME function as route.ts's own", () => {
    expect(routeBackend).toBe(routeBackendDirect)
  })
  test("ACP_BUDGET re-exported from the main entry is the SAME object as acp-wire.ts's own", () => {
    expect(ACP_BUDGET).toBe(ACP_BUDGET_DIRECT)
  })
  test("envFingerprint re-exported from the main entry is the SAME function as acp-paths.ts's own", () => {
    expect(envFingerprint).toBe(envFingerprintDirect)
  })
  test("envFingerprint computed via the main entry matches the same call against acp-paths.ts directly", () => {
    const env = { ANTHROPIC_MODEL: "probe" }
    expect(envFingerprint(env)).toBe(envFingerprintDirect(env))
  })
})
