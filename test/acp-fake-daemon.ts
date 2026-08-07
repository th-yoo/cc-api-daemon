// test/acp-fake-daemon.ts — a scripted ACP daemon over WebSocket: no
// WarmSession, no CLI, no model. Shared by acp-client.test.ts so the suite
// cannot drift on the fingerprint echo — a fake that echoes the WRONG
// fingerprint makes every client call a silent law-L1 no-call, which looks
// like a routing bug and is not one. NOT matched by bun's test glob (no
// `.test.ts` suffix), same discipline as sdk-stub.ts / agent-cli-stub.ts.
//
// Mirrors the REAL daemon's wire shape exactly where it matters for the
// client under test: `_meta` is namespaced under `kkamak` (T2n), the "ok"
// answer emits ONE session/update notification carrying the full text
// BEFORE the session/prompt result (acp-daemon.ts's own ordering — a client
// racing on the result must not miss the chunk), and failures are JSON-RPC
// errors carrying `data.callConsumed`, never a fake stopReason.
//
// websocket-transport swap: takes `env` now, not a raw socket path —
// `daemonCall`/`ensureDaemon` locate a daemon via `readDiscovery(env)`, so
// this fake must publish ITS OWN port to the SAME discovery file the
// client under test will read, under whatever `HOME` that env carries.
import fs from "node:fs"
import http from "node:http"
import crypto from "node:crypto"
import { WebSocketServer, type WebSocket } from "ws"
import {
  ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_CANCEL, ACP_SESSION_UPDATE,
  ACP_SESSION_CLOSE, ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
} from "../src/acp-wire.ts"
import { discoveryPath, writeDiscovery } from "../src/acp-paths.ts"

export type FakeAnswer =
  | "ok"
  | "no-call"
  | "call-consumed"
  | "no-call-code-no-data"
  | "consumed-code-no-data"
  | "nonboolean-data"
  /** final-review Important 2: `data` PRESENT but not an object at all (a
   * string here, deliberately truthy-looking -- "false" -- so a bug that
   * merely checked truthiness rather than shape would be masked). Paired
   * with the NO_CALL code to prove the client does not launder this into
   * no-call by falling through to the code-based branch. */
  | "nonobject-data"
  | "mismatched-data"
  | "unknown-code"
  | "hang"
  | "die-before-prompt"
  /** N3c-iii test 8: the daemon's own -32002 pool-exhaustion shape
   * (data.callConsumed:false) -- proves the client's EXISTING L3 step (i)
   * classification already routes it to {kind:"no-call"} with no new
   * client-side code, just this scripted response. */
  | "pool-exhausted"

export interface FakeDaemonOpts {
  /** echoed in initialize._meta; pass envFingerprint(theEnvUnderTest) */
  fingerprint: string
  /** Task 8: echoed in initialize._meta.kkamak.daemonWorstCaseMs when
   * present; omitted entirely when undefined (the default) — a fake that
   * always sent SOME number could never exercise the client's
   * older-daemon-compatibility path (a daemon predating this field). */
  daemonWorstCaseMs?: number
  answer: FakeAnswer
  /** text the "ok" answer carries; default "ANSWER" */
  text?: string
  /** _meta.model the "ok" answer reports — the modelUsage KEY. Default: the
   * requested model with "-20251001" appended, so the DEFAULT fake
   * exercises the dated path rather than the degenerate equal-strings path
   * (round-4 C1). */
  model?: string
  /** _meta.canonicalModel the "ok" answer reports; default "" */
  canonicalModel?: string
}

export interface FakePromptParams {
  sessionId: string
  prompt: Array<{ type: "text"; text: string }>
  _meta: { model: string }
}

export interface FakeSessionNewParams {
  cwd?: unknown
  mcpServers?: unknown
  _meta?: { kkamak?: { isolation?: unknown } }
}

export interface FakeDaemonHandle {
  stop: () => void
  /** true iff a session/prompt frame was ever decoded — the wire-level
   * proof for every "the fallback never sent anything" assertion */
  sawPrompt: () => boolean
  /** the params of the last session/prompt, for byte-identity assertions */
  promptParams: () => FakePromptParams | undefined
  /** the params of the last session/new, added N3c-iii so a test can assert
   * `daemonCall` sent `_meta.kkamak.isolation` deep-equal to what the
   * caller passed. */
  sessionNewParams: () => FakeSessionNewParams | undefined
  /** review-sensor Task 3: the params of the last session/close frame, so a
   * client test can assert `closeSession` sent the sessionId it was given.
   * This fake always echoes `{closed:true}` — it has no notion of a real
   * pool entry to refuse, unlike the real daemon's unknown/busy cases
   * (those are covered against the real dispatcher in acp-daemon.test.ts). */
  closeParams: () => { sessionId: string } | undefined
}

export async function fakeDaemon(env: Record<string, string | undefined>, opts: FakeDaemonOpts): Promise<FakeDaemonHandle> {
  let sawPromptFlag = false
  let captured: FakePromptParams | undefined
  let capturedSessionNew: FakeSessionNewParams | undefined
  let capturedClose: { sessionId: string } | undefined

  const clients = new Set<WebSocket>()

  function respondPrompt(write: (msg: object) => void, id: number | string, sessionId: string, requestedModel: string): void {
    switch (opts.answer) {
      case "ok": {
        const text = opts.text ?? "ANSWER"
        const model = opts.model ?? `${requestedModel}-20251001`
        const canonicalModel = opts.canonicalModel ?? ""
        // ONE session/update notification carrying the full text, THEN the
        // result — mirrors acp-daemon.ts's own ordering exactly.
        write({
          jsonrpc: "2.0",
          method: ACP_SESSION_UPDATE,
          params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
        })
        write({
          jsonrpc: "2.0", id,
          result: { stopReason: "end_turn", _meta: { kkamak: { model, canonicalModel, callConsumed: true } } },
        })
        return
      }
      case "no-call":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_NO_CALL, message: "no-call", data: { callConsumed: false } } })
        return
      case "call-consumed":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_CALL_CONSUMED, message: "call-consumed", data: { callConsumed: true } } })
        return
      case "no-call-code-no-data":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_NO_CALL, message: "no-call, data omitted" } })
        return
      case "consumed-code-no-data":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_CALL_CONSUMED, message: "consumed, data omitted" } })
        return
      case "nonboolean-data":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_NO_CALL, message: "nonboolean data", data: { callConsumed: "false" } } })
        return
      case "nonobject-data":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_NO_CALL, message: "nonobject data", data: "false" } })
        return
      case "mismatched-data":
        write({ jsonrpc: "2.0", id, error: { code: ACP_ERR_NO_CALL, message: "mismatched data", data: { callConsumed: true } } })
        return
      case "unknown-code":
        write({ jsonrpc: "2.0", id, error: { code: -32603, message: "unknown code" } })
        return
      case "pool-exhausted":
        write({ jsonrpc: "2.0", id, error: { code: -32002, message: "pool exhausted", data: { callConsumed: false } } })
        return
      case "hang":
        // never respond — the client's budget timer owns this case.
        return
      case "die-before-prompt":
        // unreachable: the connection is closed right after session/new, so
        // this daemon never receives a session/prompt frame at all.
        return
    }
  }

  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer()
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
  })

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws)
    const write = (msg: object): void => {
      try { ws.send(JSON.stringify(msg)) } catch { /* peer gone */ }
    }

    ws.on("message", (data) => {
      let f: unknown
      try { f = JSON.parse(String(data)) } catch { return }
      const req = f as { id?: number | string; method?: unknown; params?: unknown }
      const id = req.id
      const method = typeof req.method === "string" ? req.method : ""
      const params = req.params

      switch (method) {
        case ACP_INITIALIZE: {
          if (id === undefined) break
          const kkamak: { envFingerprint: string; daemonWorstCaseMs?: number } = { envFingerprint: opts.fingerprint }
          if (opts.daemonWorstCaseMs !== undefined) kkamak.daemonWorstCaseMs = opts.daemonWorstCaseMs
          write({
            jsonrpc: "2.0", id,
            result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, _meta: { kkamak } },
          })
          break
        }
        case ACP_SESSION_NEW: {
          capturedSessionNew = params as FakeSessionNewParams | undefined
          if (id === undefined) break
          const sessionId = crypto.randomUUID()
          if (opts.answer === "die-before-prompt") {
            // Answer, THEN close — the client's session/new promise must
            // resolve before this connection dies.
            write({ jsonrpc: "2.0", id, result: { sessionId } })
            try { ws.close() } catch { /* ignore */ }
            break
          }
          write({ jsonrpc: "2.0", id, result: { sessionId } })
          break
        }
        case ACP_SESSION_PROMPT: {
          sawPromptFlag = true
          const p = params as { sessionId?: unknown; prompt?: Array<{ type: "text"; text: string }>; _meta?: { kkamak?: { model?: unknown } } } | undefined
          const sessionId = typeof p?.sessionId === "string" ? p.sessionId : ""
          const requestedModel = typeof p?._meta?.kkamak?.model === "string" ? p._meta.kkamak.model : ""
          captured = { sessionId, prompt: p?.prompt ?? [], _meta: { model: requestedModel } }
          if (id === undefined) break
          respondPrompt(write, id, sessionId, requestedModel)
          break
        }
        case ACP_SESSION_CANCEL: {
          if (id !== undefined) write({ jsonrpc: "2.0", id, result: {} })
          break
        }
        case ACP_SESSION_CLOSE: {
          const p = params as { sessionId?: unknown } | undefined
          const sessionId = typeof p?.sessionId === "string" ? p.sessionId : ""
          capturedClose = { sessionId }
          if (id !== undefined) write({ jsonrpc: "2.0", id, result: { closed: true } })
          break
        }
        default:
          if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } })
      }
    })
    ws.on("error", () => { /* a peer reset must never crash the fake */ })
    ws.on("close", () => { clients.delete(ws) })
  })

  server.on("error", () => { /* never crash the test process */ })
  // `.listen()`'s bind is not guaranteed synchronous — await the
  // `listening` event before trusting `.address()` rather than racing it.
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("fakeDaemon: server.address() returned no port after listen")
  }
  writeDiscovery(env, { port: address.port, pid: process.pid })

  return {
    stop() {
      for (const ws of clients) { try { ws.terminate() } catch { /* ignore */ } }
      try { server.close() } catch { /* ignore */ }
      try { fs.rmSync(discoveryPath(env), { force: true }) } catch { /* ignore */ }
    },
    sawPrompt: () => sawPromptFlag,
    promptParams: () => captured,
    sessionNewParams: () => capturedSessionNew,
    closeParams: () => capturedClose,
  }
}
