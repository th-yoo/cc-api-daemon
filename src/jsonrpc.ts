// jsonrpc.ts — message-layer validation for the WebSocket transport. A
// WebSocket message is already a discrete frame (no decoder.push(chunk)
// loop needed, see acp-daemon.ts/acp-client.ts), but it still needs the
// JSON-RPC 2.0 structural checks the unix-socket transport got for free
// from FrameDecoder's "parse or drop" behaviour.
//
// Ported from chronos-api-0.4.5's src/websocket/websocket-client.ts:100-155
// and src/types/json-rpc.ts's validate_jsonrpc_input/create_error_response —
// the DISCIPLINE, not the code: chronos validates with zod against a large
// domain-specific schema (order params, ISIN checks, batch requests, none
// of which apply here); this is hand-rolled and dependency-free, matching
// every other file in src/ (acp-wire.ts's own header: "ACP is just
// interface not implementation"). No batch support — ACP has no batch
// concept and this package's dispatcher (acp-daemon.ts) handles one frame
// at a time.
//
// THE RULE WORTH COPYING VERBATIM (chronos gets this right, easy to get
// wrong): a notification (no `id` field at all) gets NO REPLY, not even an
// error response — JSON-RPC 2.0 requires this. `session/cancel` is a
// notification in ACP (acp-wire.ts), so this is a live path here, not a
// spec footnote. A malformed message that FAILS TO PARSE as JSON at all is
// a different case: it has no id to check, so it always gets a Parse Error
// response (chronos's own on_message_received does this unconditionally,
// before any notification check runs) — the notification-suppression rule
// only applies once a message parses as an object we can inspect for `id`.
export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export const JSON_RPC_PARSE_ERROR = -32700
export const JSON_RPC_INVALID_REQUEST = -32600
export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INVALID_PARAMS = -32602
// ACP's own -32000 (no-call) / -32001 (call-consumed) stay in acp-wire.ts —
// those are §6e outcome-law codes, not JSON-RPC structural-validation codes.

export type JsonRpcValidation =
  | { ok: true; value: JsonRpcRequest }
  | { ok: false; code: number; message: string; id: number | string | null; isNotification: boolean }

/** Structural validation only — does not know or care about ACP method
 * names (that is the dispatcher's job, -32601 there). `raw` is the ALREADY
 * -PARSED value (a WebSocket message payload after `JSON.parse`) — a raw
 * string that fails to parse at all is the caller's job to catch and
 * report as -32700 before ever calling this, since JSON.parse throwing is
 * a distinct failure mode this function has no `try/catch` around by
 * design (mirrors chronos's own two-step: parse, THEN validate).
 *
 * A message with NO `id` field never reaches the `ok: true` arm, even when
 * it is otherwise a perfectly well-formed notification — `isNotification`
 * is the caller's ENTIRE instruction in that case: per JSON-RPC 2.0, a
 * notification never gets a reply, so the caller must check
 * `isNotification` FIRST and return without responding, never build an
 * error response from `code`/`message` for it. This mirrors chronos's own
 * `on_message_received`, which checks "is this a notification" before
 * ever constructing a validation-error response — including when the
 * notification is ALSO malformed some other way (see the id-absent check
 * running before the jsonrpc/method checks below settle `isNotification`
 * for every rejection branch, not just this one). */
export function validateJsonRpc(raw: unknown): JsonRpcValidation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request", id: null, isNotification: false }
  }
  const o = raw as Record<string, unknown>
  const hasId = Object.prototype.hasOwnProperty.call(o, "id")
  const id = hasId && (typeof o.id === "string" || typeof o.id === "number") ? o.id : null

  if (o.jsonrpc !== "2.0") {
    return { ok: false, code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request: jsonrpc must be \"2.0\"", id, isNotification: !hasId }
  }
  if (typeof o.method !== "string" || o.method.length === 0) {
    return { ok: false, code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request: method must be a non-empty string", id, isNotification: !hasId }
  }
  if (!hasId) {
    return { ok: false, code: JSON_RPC_INVALID_REQUEST, message: "notification (no id) — no reply", id: null, isNotification: true }
  }
  if (o.id !== undefined && typeof o.id !== "string" && typeof o.id !== "number") {
    return { ok: false, code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request: id must be a string or number", id, isNotification: false }
  }

  return { ok: true, value: { jsonrpc: "2.0", id: o.id as number | string, method: o.method, params: o.params } }
}

export function createErrorResponse(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } }
}
