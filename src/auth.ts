// Credential resolution for the daemon's Anthropic client — adapted from
// meta-harness cc-gate-plugin/src/gauge/transport.ts:63-98 (readAuthToken /
// parseAccessToken / AuthTokenDeps). Not a verbatim port: adds an injectable
// readFile seam so tests never touch disk; deps default to real host
// resolution (process.platform, os.homedir, execFileSync, fs.readFileSync)
// when omitted.
//
// Precedence (user ruling — API key FIRST):
//  1. ANTHROPIC_API_KEY (non-empty)   → { apiKey }
//  2. ANTHROPIC_AUTH_TOKEN (non-empty) → { authToken } — SDK-native env name;
//     doubles as the test / keychain-less-host seam
//  3. darwin: macOS keychain item "Claude Code-credentials" via `security`
//  4. else:   ~/.claude/.credentials.json (the WSL/linux layout)
// Undefined on any failure — never throws. A darwin keychain failure does
// NOT fall through to the credentials file (darwin-vs-else branch, as in
// transport.ts).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"

export interface AuthDeps {
  platform?: NodeJS.Platform
  home?: string
  /** Injected `security` exec; production shells out to the macOS keychain. */
  exec?: (argv: string[]) => string
  /** Injected credentials-file read; production is fs.readFileSync utf-8. */
  readFile?: (p: string) => string
}

export type ResolvedAuth = { apiKey: string } | { authToken: string }

// 10s cap (transport.ts EXEC_TIMEOUT_MS): a locked keychain / ACL prompt
// must fail resolution rather than hang the daemon at startup.
const EXEC_TIMEOUT_MS = 10_000

function defaultExec(argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS })
}

function parseAccessToken(raw: string): string | undefined {
  try {
    const json = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown }
      accessToken?: unknown
    }
    const token = json.claudeAiOauth?.accessToken ?? json.accessToken
    return typeof token === "string" && token ? token : undefined
  } catch {
    return undefined
  }
}

export function resolveAuth(
  env: Record<string, string | undefined>,
  deps: AuthDeps = {},
): ResolvedAuth | undefined {
  const apiKey = env.ANTHROPIC_API_KEY
  if (typeof apiKey === "string" && apiKey) return { apiKey }

  const override = env.ANTHROPIC_AUTH_TOKEN
  if (typeof override === "string" && override) return { authToken: override }

  const platform = deps.platform ?? process.platform
  try {
    if (platform === "darwin") {
      const exec = deps.exec ?? defaultExec
      const token = parseAccessToken(
        exec(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]),
      )
      return token ? { authToken: token } : undefined
    }
    const home = deps.home ?? env.HOME ?? os.homedir()
    const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"))
    const token = parseAccessToken(readFile(`${home}/.claude/.credentials.json`))
    return token ? { authToken: token } : undefined
  } catch {
    return undefined
  }
}
