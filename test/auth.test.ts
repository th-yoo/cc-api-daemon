// All cases run on injected deps — no real keychain, no real disk, no real
// process.env dependence. `platform` is always pinned so a test never takes
// the host's lane by accident.
import { describe, expect, test } from "bun:test"
import { resolveAuth, type AuthDeps } from "../src/auth.ts"

const OAUTH_JSON = '{"claudeAiOauth":{"accessToken":"tok"}}'

function neverExec(): string {
  throw new Error("exec must not be called")
}
function neverRead(): string {
  throw new Error("readFile must not be called")
}

describe("env precedence", () => {
  test("ANTHROPIC_API_KEY wins over ANTHROPIC_AUTH_TOKEN", () => {
    const result = resolveAuth(
      { ANTHROPIC_API_KEY: "sk-ant-key", ANTHROPIC_AUTH_TOKEN: "env-tok" },
      { platform: "darwin", exec: neverExec, readFile: neverRead },
    )
    expect(result).toEqual({ apiKey: "sk-ant-key" })
  })

  test("ANTHROPIC_AUTH_TOKEN wins over an available keychain (exec not called)", () => {
    let execCalled = false
    const deps: AuthDeps = {
      platform: "darwin",
      exec: () => {
        execCalled = true
        return OAUTH_JSON
      },
    }
    const result = resolveAuth({ ANTHROPIC_AUTH_TOKEN: "env-tok" }, deps)
    expect(result).toEqual({ authToken: "env-tok" })
    expect(execCalled).toBe(false)
  })

  test("empty-string env values are treated as absent", () => {
    const result = resolveAuth(
      { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      { platform: "darwin", exec: () => OAUTH_JSON },
    )
    expect(result).toEqual({ authToken: "tok" })
  })
})

describe("darwin lane", () => {
  test("keychain JSON with claudeAiOauth.accessToken resolves", () => {
    const result = resolveAuth({}, { platform: "darwin", exec: () => OAUTH_JSON })
    expect(result).toEqual({ authToken: "tok" })
  })

  test("exec throwing → undefined, readFile not consulted", () => {
    let readCalled = false
    const result = resolveAuth(
      {},
      {
        platform: "darwin",
        exec: neverExec,
        readFile: () => {
          readCalled = true
          return OAUTH_JSON
        },
      },
    )
    expect(result).toBeUndefined()
    expect(readCalled).toBe(false)
  })
})

describe("non-darwin lane", () => {
  test("credentials file with claudeAiOauth.accessToken resolves", () => {
    let readPath = ""
    const result = resolveAuth(
      { HOME: "/home/u" },
      {
        platform: "linux",
        exec: neverExec,
        readFile: (p) => {
          readPath = p
          return OAUTH_JSON
        },
      },
    )
    expect(result).toEqual({ authToken: "tok" })
    expect(readPath).toBe("/home/u/.claude/.credentials.json")
  })

  test("credentials file with bare accessToken resolves", () => {
    const result = resolveAuth(
      {},
      { platform: "linux", home: "/home/u", readFile: () => '{"accessToken":"bare"}' },
    )
    expect(result).toEqual({ authToken: "bare" })
  })

  test("readFile throwing → undefined", () => {
    const result = resolveAuth({}, { platform: "linux", home: "/home/u", readFile: neverRead })
    expect(result).toBeUndefined()
  })

  test("malformed JSON → undefined", () => {
    const result = resolveAuth(
      {},
      { platform: "linux", home: "/home/u", readFile: () => "not json{" },
    )
    expect(result).toBeUndefined()
  })

  test("JSON without any token → undefined", () => {
    const result = resolveAuth(
      {},
      { platform: "linux", home: "/home/u", readFile: () => '{"claudeAiOauth":{}}' },
    )
    expect(result).toBeUndefined()
  })

  test("empty-string token → undefined", () => {
    const result = resolveAuth(
      {},
      { platform: "linux", home: "/home/u", readFile: () => '{"accessToken":""}' },
    )
    expect(result).toBeUndefined()
  })
})

describe("never throws", () => {
  const bomb = () => {
    throw new Error("boom")
  }

  test("adversarial exec on darwin", () => {
    expect(() => resolveAuth({}, { platform: "darwin", exec: bomb })).not.toThrow()
  })

  test("adversarial readFile on linux", () => {
    expect(() => resolveAuth({}, { platform: "linux", home: "/h", readFile: bomb })).not.toThrow()
  })

  test("exec returning non-string garbage", () => {
    const deps = { platform: "darwin", exec: () => undefined } as unknown as AuthDeps
    expect(() => resolveAuth({}, deps)).not.toThrow()
    expect(resolveAuth({}, deps)).toBeUndefined()
  })
})
