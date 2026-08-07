import path from "node:path"
import { tmpdir } from "node:os"

/** AF_UNIX socket paths are capped by sun_path: 104 bytes on darwin, 108 on
 * Linux. A bind past the cap fails outright, the client maps the dead socket
 * to `no-call`, and every fake-daemon test silently degrades into the
 * fallback leg (observed on darwin 2026-08-05: tmpdir() is ~49 bytes under
 * /var/folders, and the old `kkamak-acp-<file>-<tag>-<pid>-<Date.now()>-<rand>`
 * names pushed paths to ~121 bytes — 33 test failures, all no-call).
 *
 * Every test socket path MUST come from here: short name, hard length assert.
 * Uniqueness = pid + 6 random base36 chars; tests also unlink in cleanup. */
const SUN_PATH_SAFE_MAX = 100

export function shortBase(tag: string): string {
  const p = path.join(tmpdir(), `kk-${tag}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  if (Buffer.byteLength(`${p}.sock`) > SUN_PATH_SAFE_MAX)
    throw new Error(`test socket path exceeds sun_path budget (${SUN_PATH_SAFE_MAX}B): ${p}.sock — shorten the tag`)
  return p
}

export function shortSock(tag: string): string {
  return `${shortBase(tag)}.sock`
}
