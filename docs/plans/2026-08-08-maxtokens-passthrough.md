# Thread `maxTokens` from the client through to the api lane

Handoff spec from the meta-harness side (now pinning this package in two packages).

## Why — a real, silent degradation found in review

`call.ts:26` caps every api-lane turn at `DEFAULT_MAX_TOKENS = 2_048`, and
`sendOne` **already accepts** `opts.maxTokens` (`call.ts:66,74`). But nothing threads it
through: `daemonCall`'s public opts (`acp-client.ts:131`) is
`{ isolation, budgetMs? }`, the `session/prompt` wire params carry no such field, and
`ApiSession` never passes one. So the cap is unreachable from any consumer.

That just bit a real migration. meta-harness moved its P2 A4-review lane onto this
package (`A4_MODEL = "claude-haiku-4-5"` → api lane). A4 asks the model for
`{"complied": bool, "requiredEdits": [...]}` with no bound on the array. A reply past
2048 output tokens truncates mid-JSON, the consumer's parse fails, and its re-pass is
**silently skipped** — no crash, no error, just a quiet non-result. The CLI lane it came
from had no such cap, so this is a regression introduced purely by moving lanes.

It matters beyond that one consumer: P2 is an experiment comparing rule-delivery
carriers, and A4-review-and-reinject is one of the arms. Silent truncation would make
that arm look worse for an instrumentation reason rather than a real one.

## What to build

Thread an optional `maxTokens` from `daemonCall` to `sendOne`. The leaf already supports
it — this is plumbing.

- [ ] `acp-client.ts`: widen `daemonCall`'s opts to `{ isolation, budgetMs?, maxTokens? }`.
      Additive and optional — existing callers are unaffected and the default stays 2048.
- [ ] Wire: carry it on `session/prompt`. Follow the existing `_meta.kkamak` convention
      the prompt frame already uses for `model` (`acp-client.ts:274`) — do NOT invent a
      second metadata channel, and do NOT rename `_meta.kkamak` (that decision is
      recorded in the README and stands).
- [ ] Daemon dispatcher: read it off the frame and pass it down to the session.
- [ ] `ApiSession`: forward to `sendOne`'s existing `opts.maxTokens`.
- [ ] Validate it: a non-positive or non-integer value should be rejected at the wire
      boundary rather than silently coerced. Decide the exact contract, document it, test it.

## The part that needs care — the agent lane

`WarmSession` (the CLI lane) has no `max_tokens` equivalent. So a caller setting
`maxTokens` on a sonnet/opus/fable turn would have it **silently ignored** — precisely
the silent-behavior class this package has been burned by repeatedly (the retired
`KKAMAK_ACP_SOCKET`, the unsignalled env override downstream).

Do not let it pass silently. Pick one and justify it in a comment:
- reject at the boundary when the routed lane cannot honor it, or
- accept but emit a non-throwing diagnostic naming the lane, matching the
  `console.error`-not-throw style used elsewhere.

Either is defensible; silently dropping it is not. Test whichever you choose.

## Constraints

- Two consumers already pin this package — nothing already exported may change shape.
  `maxTokens` is strictly additive and optional.
- Suite green at each commit. Three verifications before push, run CONCURRENTLY:
  `bunx tsc --noEmit`, `bun test`, and
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test`.
- Baseline `f99bcd6` (v0.3.0). Minor version bump.
- Document the new option in README, including the agent-lane behavior you chose.

Report the SHA and all three results.
