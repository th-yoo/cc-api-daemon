// HAZARD 3 (api-sdk merge brief): a hard constraint, not a preference.
// Measured twice (2026-08-06, 2026-08-07) — the bare-SDK transport
// (ApiSession) returns 200 for haiku but 429 for claude-sonnet-5,
// claude-opus-5, and claude-fable-5. The Agent-SDK lane (WarmSession)
// serves all of them. An unrecognized model therefore defaults to
// "agent": degrading to "heavier than necessary" is fine, degrading to a
// 429 is not.
export function routeBackend(model: string): "api" | "agent" {
  return model.includes("haiku") ? "api" : "agent"
}
