# Phase A — decouple this package from kkamak

Handoff spec. Authored by the meta-harness side, which will consume this package.
Five review rounds went into it; the corrections marked **CRITICAL** below each came
from a round that found the *previous* round's fix to be wrong. Do not "simplify" them.

## Why

`@th-yoo/cc-api-daemon` carries kkamak's identity in its public surface: env-var names,
the discovery directory, a wire method name, and a silent default isolation. meta-harness
is about to become a consumer via a git pin, and wants the package neutral first — doing
it after the swap means re-pinning and re-editing every consumer twice.

**Out of scope this run:** the `./testing` subpath export (A6) and any consumer-side work.
Those are held pending re-review. Do not add `exports` entries.

## Global constraints

- Back-compat: old spellings keep working. This package is already consumed.
- Every change lands with its own test. The suite must stay green at each commit.
- Three verification runs before push: `bunx tsc --noEmit`, `bun test`, and the
  credential-scrubbed invariant
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test`.
- Baseline is `abf4f72`. Report the final SHA plus all three run results when done.

## A1 — neutral default isolation

`WarmSession` silently defaults to kkamak's gauge profile: `warm-session.ts:267`
`this.isolation = opts.isolation ?? GAUGE_ISOLATION`, and `GAUGE_ISOLATION`
(`acp-wire.ts:212`) carries `title: "kkamak-gauge"`. A consumer omitting `isolation` gets
another project's profile with no error, and cannot even name it — it is not exported.

- Add `DEFAULT_ISOLATION` with a neutral `title` (e.g. `"acp-warm"`); make
  `warm-session.ts:267` default to it; export it from `index.ts`.
- **Do NOT re-export `GAUGE_ISOLATION` from `index.ts`.** Its only outside consumer imports
  it from meta-harness's own local copy, which stays. Publishing a `kkamak-gauge` constant
  would add permanent kkamak surface for nothing. Keep it internal.
- Breaks `test/warm-session.test.ts:366-370`
  (`expect(ws.isolation).toEqual(GAUGE_ISOLATION)` on a default-constructed session) — update it.
- `warm-session.ts:469-477`'s comments assert byte-identity with the gauge literal; update them.
- Verified for you: nothing in evidence selection, `modelProvenBy`, `/clear` or `setModel`
  reads the default — the daemon always passes isolation explicitly.

## A2 — env vars `KKAMAK_ACP_*` → `ACP_*`, old spellings still honored

Four read sites: `acp-pool.ts:89` (`MAX_SESSIONS`), `acp-pool.ts:127` (`TURN_TIMEOUT_MS`),
`acp-daemon.ts:694` (`IDLE_MS`), `acp-daemon.ts:790` (`TEST_SPAWN_LOG`). Each becomes
`env.ACP_X ?? env.KKAMAK_ACP_X`. Test per var: both spellings work, new one wins.

**CRITICAL — the denylist must move with the aliases.** `envFingerprint` hashes the whole
env minus `ACP_ENV_DENYLIST` (`acp-paths.ts:59-68`). Today only the `KKAMAK_` spellings are
listed (`:49`). Alias without updating it and a process setting `ACP_IDLE_MS` computes a
*different* fingerprint → different `discoveryPath` → mismatching `initialize` echo →
client refuses pre-send (`acp-client.ts:237`) → **permanent `no-call`**. That is exactly the
I4 hole `acp-paths.ts:24-32` documents.

- **Add** `ACP_IDLE_MS` and `ACP_TEST_SPAWN_LOG` to the denylist.
- **CRITICAL — do NOT denylist `ACP_TEST_MARKER` or `KKAMAK_ACP_TEST_MARKER`.** Being
  *outside* the denylist is the mechanism by which a test forks a distinct fingerprint.
  Denylisting it collapses any env without a `HOME` override onto the live host
  fingerprint, at which point a test fake overwrites — and on `stop()` deletes — the
  **running host daemon's** discovery file.
- **Keep `KKAMAK_ACP_SOCKET` on the denylist.** It is vestigial, but removing it breaks
  `test/acp-paths.test.ts:70-72` and contradicts `:65-69`'s "`envFingerprint` stays exactly
  as-is" contract, for zero benefit.
- **Do NOT make the denylist host-extensible.** The daemon is a separate process spawned as
  bare `bun <acp-daemon.ts>` carrying only env (`acp-client.ts:432-441`), fingerprinting off
  the module-level constant (`acp-daemon.ts:693`). Any in-process extension the client
  applies cannot reach the daemon; the two would compute different fingerprints and never
  rendezvous. Keep the list fixed. `KKAMAK_GAUGE_TRANSPORT` stays as a default entry.
- Note in a comment: `TURN_TIMEOUT_MS` and `MAX_SESSIONS` are deliberately **not**
  denylisted (`acp-paths.ts:40-43`, pinned by `test/acp-paths.test.ts:74-82`), so after
  aliasing, two processes setting the same value under different spellings get different
  fingerprints and cannot share a daemon. Safe direction (over-isolation, not cross-talk),
  but assert it rather than leave it to be discovered.

## A3 — wire method `kkamak/models/list` → `acp/models/list`

`acp-wire.ts:68`. The **daemon accepts both**; add a second `case`. Verified for you:
dispatch is a plain `switch (method)` (`acp-daemon.ts:324`), `validateJsonRpc` has no method
allowlist (`jsonrpc.ts:70-92`), and an empty fallthrough does not trip
`noFallthroughCasesInSwitch`. Nothing in `src/` *sends* this method — the only senders are
`test/acp-daemon.test.ts:551,567,579`. Test both spellings against one daemon.

## A4 — discovery dir `~/.config/kkamak/` → `~/.config/acpd/`

`acp-paths.ts:94`, the only construction site. No fallback read — orphaning old daemons is
correct (they idle-reap), and it usefully guarantees the old meta-harness stack and this
package can never collide during the migration. `discoveryPath`'s `env.HOME` isolation seam
must keep working exactly as it does now.

## A4b — `_meta.kkamak`: KEEP IT, and record the decision

**CRITICAL — do not rename this.** It looks like A3 but is not. `_meta` rides every frame:
the client both writes it (`acp-client.ts:251,274`) and reads it (`:237,247,294,295,349`),
and the daemon emits it (`acp-daemon.ts:156,206,311,329` + error strings `:346,364`).
Renaming does **not** change the fingerprint or `discoveryPath`, so an old client and a new
daemon still rendezvous on the same discovery file and then fail the fingerprint echo at
`acp-client.ts:237` — **permanent silent `no-call`** across any version skew. A correct
rename needs daemon and client changed in lockstep, emitting and accepting both keys, for
zero user-visible benefit.

- Keep `_meta.kkamak` as-is.
- **Record the decision in README**, so "decoupled from kkamak" does not imply the wire is
  neutral when it is not.

## A5 — provenance and stale comments

Rewrite to describe behavior, not foreign repo paths: `api-session.ts:3`, `auth.ts:2`,
`call.ts:6-7`, `acp-pool.ts:64`, `acp-daemon.ts:15`, `acp-paths.ts:10-11`.

Outright false today, fix them:
- `acp-daemon.ts:706` and `:884` claim the pool defaults to `ApiSession`; it defaults to
  `WarmSession` (`acp-pool.ts:193`).
- `scripts/smoke.ts:4` says "over a unix socket".
- `src/index.ts:20-22` says "a unix-socket ACP daemon".
- `warm-session.ts:470-471` claims `acp-wire.test.ts` locks `GAUGE_ISOLATION`; it is
  `test/warm-session.test.ts:353`.

## A7 — tests, docs, verify, push

- **11 test files carry kkamak names, ~190 matching lines** — `acp-daemon.test.ts` alone is
  ~78. `acp-wire.test.ts` (~30) pins the very constant A3 renames, and
  `test/acp-fake-daemon.ts` (~10) is easy to miss. Budget accordingly.
- **Docs**: `README.md:283-325` and `CLAUDE.md:310-314` document `kkamak/models/list`.
  `CLAUDE.md` is your own instruction file — leaving it stale misleads the next session.
- `gate.json:2` runs `KKAMAK_GATE_FAST=1 bun test` — a live `KKAMAK_` coupling in the
  package's own gate command. Alias it too, or record why not.
- Minor version bump.
- Run all three verification commands, then push, then report the SHA and the three results.
