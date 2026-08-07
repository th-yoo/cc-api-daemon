// HAZARD 3 (api-sdk merge brief): the bare-SDK transport (ApiSession)
// measured 200 for haiku but 429 for claude-sonnet-5/claude-opus-5/
// claude-fable-5 (2026-08-06, 2026-08-07). The Agent-SDK lane (WarmSession)
// serves all of them. So an unrecognized model must default to "agent" —
// degrading to "heavier than necessary" is fine, degrading to a 429 is not.
import { describe, expect, test } from "bun:test"
import { routeBackend } from "../src/route.ts"

describe("routeBackend (HAZARD 3 routing table)", () => {
  test("a haiku model routes to the api (bare-SDK) lane", () => {
    expect(routeBackend("claude-haiku-4-5")).toBe("api")
  })
  test("a dated haiku snapshot still routes to api", () => {
    expect(routeBackend("claude-haiku-4-5-20251001")).toBe("api")
  })

  test("claude-sonnet-5 routes to the agent (CLI) lane — measured 429 on the bare-SDK lane", () => {
    expect(routeBackend("claude-sonnet-5")).toBe("agent")
  })
  test("claude-opus-5 routes to the agent (CLI) lane — measured 429 on the bare-SDK lane", () => {
    expect(routeBackend("claude-opus-5")).toBe("agent")
  })
  test("claude-fable-5 routes to the agent (CLI) lane — measured 429 on the bare-SDK lane", () => {
    expect(routeBackend("claude-fable-5")).toBe("agent")
  })

  test("an unrecognized model defaults to agent — degrading to heavier-than-necessary is safe, degrading to a 429 is not", () => {
    expect(routeBackend("some-future-model-nobody-has-measured")).toBe("agent")
  })
  test("an empty model string defaults to agent", () => {
    expect(routeBackend("")).toBe("agent")
  })
})
