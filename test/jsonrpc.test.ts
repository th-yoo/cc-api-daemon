// test/jsonrpc.test.ts — pure structural validation, no daemon, no socket.
import { describe, expect, test } from "bun:test"
import { validateJsonRpc, createErrorResponse } from "../src/jsonrpc.ts"

describe("validateJsonRpc", () => {
  test("a valid request parses", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  })

  test("a notification is flagged and carries a null id", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", method: "session/cancel", params: {} })
    if (r.ok) throw new Error("expected the validator to flag the missing id")
    expect(r.isNotification).toBe(true)
    expect(r.id).toBeNull()
  })

  test("a malformed request reports Invalid Request with its id preserved", () => {
    const r = validateJsonRpc({ jsonrpc: "1.0", id: 7, method: "initialize" })
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe(-32600)
    expect(r.id).toBe(7)
    expect(r.isNotification).toBe(false)
  })

  // Chronos rule, worth pinning explicitly: a notification that is ALSO
  // malformed some other way still reports isNotification:true — the
  // caller must never build a reply for it, regardless of what else is
  // wrong.
  test("a malformed notification (no id, wrong jsonrpc version) is STILL flagged as a notification", () => {
    const r = validateJsonRpc({ jsonrpc: "1.0", method: "session/cancel" })
    if (r.ok) throw new Error("unreachable")
    expect(r.isNotification).toBe(true)
  })

  test("a non-string method is Invalid Request", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", id: 1, method: 42 })
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe(-32600)
    expect(r.isNotification).toBe(false)
  })

  test("an empty-string method is Invalid Request", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", id: 1, method: "" })
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe(-32600)
  })

  test("a non-string/non-number id is Invalid Request, not a notification", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", id: {}, method: "initialize" })
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe(-32600)
    expect(r.isNotification).toBe(false)
  })

  test("a string id round-trips verbatim", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", id: "abc", method: "initialize" })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.id).toBe("abc")
  })

  test("a bare array is Invalid Request, not treated as a batch (this package has no batch concept)", () => {
    const r = validateJsonRpc([{ jsonrpc: "2.0", id: 1, method: "initialize" }])
    if (r.ok) throw new Error("unreachable")
    expect(r.code).toBe(-32600)
  })

  test("null and primitives are Invalid Request, never throw", () => {
    for (const v of [null, undefined, 1, "x", true]) {
      const r = validateJsonRpc(v)
      expect(r.ok).toBe(false)
    }
  })

  test("params is optional and passed through verbatim when present", () => {
    const r = validateJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.params).toEqual({ a: 1 })
  })
})

describe("createErrorResponse", () => {
  test("is well-formed", () => {
    expect(createErrorResponse(3, -32700, "Parse error")).toEqual({
      jsonrpc: "2.0", id: 3, error: { code: -32700, message: "Parse error" },
    })
  })

  test("carries optional data when provided", () => {
    expect(createErrorResponse(null, -32600, "Invalid Request", { detail: "x" })).toEqual({
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request", data: { detail: "x" } },
    })
  })

  test("id null is preserved verbatim, not coerced", () => {
    expect(createErrorResponse(null, -32700, "Parse error").id).toBeNull()
  })
})
