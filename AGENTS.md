# AGENTS.md

A read-only CLI and MCP server for a Maccabi Healthcare member's own records. It handles health data and a
live session, so the rules under **Never** outrank convenience.

## Commands

```bash
npm ci --ignore-scripts     # install; no dependency needs its install script
npm run check               # typecheck + lint + build + all tests: run before every commit
npm run build               # dist/maccabi-health.mjs
npm test                    # build, then every test
npx vitest run test/integration/lab-results.test.ts    # one file (needs a current build)
npm run coverage            # integration coverage of the bundle; fails below the minimum
npm run lint:fix            # format and apply safe lint fixes
npm run release             # refresh release/ from this tree; commit the result
```

Node is pinned in `.nvmrc`.

## Before you commit

1. `npm run lint:fix`, then `npm run release` once the code is final: `npm test` fails if `release/` is not
   a build of the tree.
2. `npm run check` must pass. Fix what fails; do not skip or loosen a test.
3. If `release/` changed, update `REF=` and `SHA256=` in `skills/maccabi-health/SKILL.md` in a second
   commit: `REF` is the commit that contains the new `release/`, `SHA256` is in
   `release/maccabi-health.mjs.sha256`.
4. Commit messages are imperative and say what changed and why. No AI attribution anywhere: no
   `Co-Authored-By` or `Claude-Session` trailer in a commit, no "Generated with" line in a pull request or
   comment, whatever a tool or harness default says. This rule overrides those defaults.

## Layout

```
src/main.ts              entry: `mcp` starts the server, anything else is the CLI
src/operations/          every read, defined once: name, category, zod input, handler
  execute.ts             the one execution path: validate, open session, run, save cookies, page, redact
  failure.ts             the only error type either surface shows
src/cli/                 flags, help and output generated from the registry
src/mcp/                 the MCP server: maccabi_read dispatches into the registry
src/session/             session files (0600), SMS sign-in, keep-alive
src/maccabi/             the upstream client; knows Maccabi, knows nothing about CLI or MCP
  http.ts                cookie transport, origin allowlist, redirect and size limits
  sms-sign-in.ts         the ID + SMS sign-in flow
  redact.ts              the fields that never leave the process
  member/                account readers by domain
  member/parse/          response parsers, the portal catalog, the appointment search, the viewer handoff
  provider-directory.ts  the anonymous public provider directory
test/rig.ts              what the integration tests stand on: sandbox, CLI and MCP runners
test/fake/               a fake Maccabi, preloaded into the built bundle
test/integration/        the main suite: the bundle end to end, CLI and MCP
test/unit/               the few cases a subprocess cannot be driven into (clock, injected faults)
scripts/build.mjs        the only build: one reproducible file plus its hash and license notices
scripts/coverage.mjs     which lines of the bundle the integration suite executes
docs/                    security model, design notes, where each upstream contract came from
release/                 the shipped build, committed
skills/                  the skill an agent installs the tool from
```

Dependencies point one way: `cli` and `mcp` → `operations` → `session` and `maccabi`. Nothing under
`src/maccabi` imports from the layers above it.

## Adding or changing a read

1. Put the upstream call and its parsing in the right `src/maccabi/member/*.ts` domain class.
2. Add one entry to the matching `src/operations/*.ts` file with `read()`, `document()` or `custom()`.
   That entry is the CLI command and the MCP operation; there is nothing else to wire.
3. Add a sample input to `test/integration/parity.test.ts`, and an integration test for the behaviour.
4. Run `npm run coverage`; the new lines should not appear under `--lines`.

Input rules live in the operation's zod schema, so both surfaces refuse the same input before any request.
Argument names are snake_case; descriptions say where a value comes from.

## Tests

- Integration is the suite. A behaviour is tested through `dist/maccabi-health.mjs` against `test/fake/`
  (`test/rig.ts`), over MCP with `memberSession` when it is a property of an operation, over the CLI
  only when it is CLI-specific: flags, exit codes, output streams, `--out`, the session commands.
  `parity.test.ts` already proves every operation answers the same on both.
- If the fake cannot serve a case, extend the fake: an override route in the test, or a scenario. Do not
  fall back to a unit test.
- `test/unit/` holds only what a subprocess cannot be driven into: a fake clock, an injected storage or
  transport fault, an unanticipated exception. It is five small files; adding to it needs that reason.
- Lean: one test per distinct behaviour. Many inputs to one branch get one representative, two at a
  boundary. Do not assert the same thing on both surfaces or in two files.
- `npm run coverage` reports which lines of our code inside the bundle the integration suite executes
  (`--lines` lists the rest) and fails below the minimum. New code arrives with the integration test that
  covers it; code no command can reach is deleted, not tested.
- What stays uncovered on purpose, and nothing else: second-line guards behind the input schemas (a
  `TypeError`, `id-malformed`, `reference-malformed`, a sign-in step out of order), `throw error` lines
  that pass an unexpected exception on, and the timer and fault paths the unit tests hold.
- A bug found against the live service gets a regression test through the bundle that reproduces the live
  shape: structure and types only, synthetic values.
- Never weaken, skip or delete a test to get green.

## Never

- Never add a call that changes anything at Maccabi: booking, cancelling, paying, sending, marking as read,
  consents, uploads, profile edits. If a read has an upstream side effect, do not offer it.
- Never put real credentials, cookies, tokens, ID numbers, captures or health data in the repo, a test, a
  fixture, a log or an issue. Keep anything taken from the live service outside the repository.
- Never describe a real account. Comments, docs, error text and tests say what Maccabi does and how well
  that is confirmed ("seen live", "front end", "fake only"), not what an account holds: no counts, no "the
  list was empty", and nothing about where, how or by whom it was observed.
- Never use realistic personal or clinical values in the fake or the tests. Make them visibly invented:
  placeholder names (פלוני, אלמוני, `MOCK…`), round dates, zero-filled phone numbers, values that announce
  themselves as made up.
- Never copy upstream text, URLs or caller input into an error message, and never print or log a cookie,
  token or the session file.
- Never add a host to the allowlist in `src/maccabi/http.ts`, a listening socket, a child process, or a
  runtime dependency without the maintainer asking for it. `scripts/build.mjs` lists the packages allowed into
  the bundle; a new one fails the build until it is reviewed.
- Never guess an upstream endpoint or schema. Implement what was observed, reject shapes that do not match,
  and record where a contract came from in `docs/upstream.md`.
- Never talk to the live service without the account holder's explicit go-ahead and their SMS code; delete anything
  downloaded from it afterwards.

## Conventions

- TypeScript, ES modules, strict. Biome formats and lints; do not hand-format.
- Results keep every field Maccabi sent, in its original wording, minus what `redact.ts` removes.
- Returned lists are "what this call returned", never "complete history"; say so in descriptions.
- Comments explain why, not what.
