// Shared stub Anthropic-API server for gauge SDK-transport tests (§6c).
// Every test that exercises the transport points KKAMAK_GAUGE_SDK_BASE_URL
// here — the suite makes ZERO real model calls, ever.
export interface Captured {
  authorization: string | null
  beta: string | null
  /** X-Api-Key header — must ALWAYS be null: the transport is OAuth-only
   * and must suppress the SDK's ANTHROPIC_API_KEY env fallback. */
  apiKey: string | null
  body: Record<string, unknown>
}

export interface SdkStub {
  url: string
  captured: Captured[]
  stop: () => void
}

export function stubServer(handler: (captured: Captured) => Response): SdkStub {
  const captured: Captured[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      // The Agent-SDK transport's spawned CLI issues a bodiless `HEAD
      // /api/hello` connectivity probe before the real /v1/messages call —
      // it is not a model call, so answer it directly rather than letting
      // `JSON.parse("")` throw and turn into an unhandled rejection that
      // bun:test then (mis)attributes to whichever test is running.
      const bodyText = await req.text()
      if (!bodyText) return new Response(null, { status: 200 })
      let body: Record<string, unknown>
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>
      } catch {
        return new Response(null, { status: 200 })
      }
      const c: Captured = {
        authorization: req.headers.get("authorization"),
        beta: req.headers.get("anthropic-beta"),
        apiKey: req.headers.get("x-api-key"),
        body,
      }
      captured.push(c)
      return handler(c)
    },
  })
  return { url: `http://localhost:${server.port}`, captured, stop: () => server.stop(true) }
}

/** Minimal successful /v1/messages body whose single text block is `text`. */
export function okResponse(text: string): Response {
  return Response.json({
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

/** Convenience: a stub that always answers with `derivation` as JSON text. */
export function stubServerFor(derivation: unknown): SdkStub {
  return stubServer(() => okResponse(JSON.stringify(derivation)))
}
