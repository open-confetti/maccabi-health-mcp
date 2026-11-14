# Design notes

Why the code is shaped the way it is, and the published guidance each choice follows. Read this before
changing the architecture; [AGENTS.md](../AGENTS.md) has the day-to-day rules.

## One registry, two thin surfaces

Guidance for tools that are both a CLI and an MCP server is consistent: keep the logic in a shared core,
make each surface a thin adapter over the same handlers, share validation and the response shape, and test
that the two agree.

- Every read is one entry in `src/operations/`. `src/cli/` and `src/mcp/` only parse input and render
  output; `execute()` in `src/operations/execute.ts` is the single path both call.
- Input rules live in the entry's zod schema, so the two surfaces refuse the same input the same way.
- `test/integration/parity.test.ts` runs every operation through both and compares the answers.

## Few tools, not one per endpoint

Anthropic's guide to writing tools for agents advises against wrapping every API endpoint as its own tool:
many overlapping tools cost context and distract the model. It recommends a small number of clearly named,
namespaced tools, with descriptions written for someone new to the domain.

- Six tools, all prefixed `maccabi_`. `maccabi_read` takes the operation name; its description lists every
  operation with its arguments, so a model can choose one without a discovery call, and `maccabi_help`
  explains one in full.
- Descriptions say where each identifier comes from ("`request_id` of a `test-results` row") and what a result does
  not claim.

## Results sized for a model

The same guide asks for bounded responses with sensible defaults, and for truncation that tells the caller
how to narrow the request.

- Lists return 20 rows over MCP unless `limit` is given, with `page.nextOffset` to continue.
- A result over 128 KiB is refused with `TOO_LARGE_TO_RETURN` and advice, never silently shortened.
- The CLI has no default limit: its output goes to a pipe or a file, not into a context window.

## Errors a caller can act on

The MCP specification separates protocol errors from tool execution errors, puts input validation failures
in the second group, and says execution errors should reach the model so it can correct itself. Anthropic's
guide adds that an error should say what was wrong and what to do next.

- Every failure, including a bad argument, is a tool result with `isError: true` whose text is
  `{"error":{"code","message","detail"?,"cause","retry","known_issue"?}}`. Some clients show a model only
  that text, so the text carries everything.
- `cause` says whose problem the failure is and `retry` what a second attempt can achieve, as fixed words
  a model can act on without reading the prose. `known_issue` is there when the failure was seen against
  the live service and is understood ([known-issues.md](known-issues.md)).
- Messages name the next step ("List again and take the value from the new result") and are fixed text,
  for the reasons in [security.md](security.md).

## A conventional command line

The Command Line Interface Guidelines ask for primary output on stdout and messages on stderr, zero on
success and distinct non-zero codes for the important failures, help on `-h` and `--help` wherever they
appear, machine-readable output, never requiring a prompt, and secrets taken from standard input or a file
rather than a flag or the environment.

- Results are JSON on stdout; an error is one JSON line on stderr; exit codes are 2 for bad usage, 3 when a
  sign-in is needed and 1 for any other failure.
- `help`, `help COMMAND`, `COMMAND --help` and `help --json` all come from the registry.
- `login` prompts only on a terminal. Otherwise `--id-stdin` and `--code-stdin` take the two values from
  standard input. Flags and environment variables remain for hosts that can inject a secret no other way.

## Validate, bound, sanitise

The MCP tools specification says a server must validate all tool inputs, implement access controls, rate
limit tool invocations and sanitise tool outputs.

- Inputs: every operation has a strict schema, checked before a session is opened or a request is made.
- Access: every identifier is checked against a fresh list of the signed-in member's own data.
- Rate: calls run one at a time, each with a deadline, and the one tool that costs the member something,
  `maccabi_login_start`, is limited to three unfinished attempts in ten minutes.
- Outputs: every result passes through `redact` before it is returned.

## Honest annotations

The specification tells clients to treat annotations as untrusted hints. They are still what a client uses
to decide what needs confirmation, so they must be true.

- `maccabi_read`, `maccabi_help` and `maccabi_status` are `readOnlyHint`. The reads that would have changed
  something upstream are not offered at all.
- `maccabi_login_start` is not read-only (it sends an SMS). `maccabi_logout` is `destructiveHint`: undoing
  it costs the member another SMS.

## Local transport only

MCP's security best practices say a server meant to run locally should "use the `stdio` transport to limit
access to just the MCP client", and that an HTTP transport needs an authorization token or a restricted
socket, because a server left listening on localhost can be reached by other processes and by DNS
rebinding. They forbid accepting a token that was not issued to the server, and describe a local server
installed from an unpinned package as a code-execution risk.

- The server speaks stdio only, and the shipped file imports no networking built-ins, so there is nothing
  to reach on localhost. The loopback HTTP transport and its OAuth server were removed for this reason.
- No token is accepted from a client and none is passed on. The only credential is the member's own
  session, kept in a private file.
- Outbound requests follow the same document's advice on request forgery: HTTPS only, a fixed allowlist of
  hosts, and every redirect hop validated instead of followed automatically (`src/maccabi/http.ts`).
- The tool is installed as one file at a pinned commit and SHA-256, never through `npx` or a package
  registry (`skills/maccabi-health/SKILL.md`).
- The same document asks hosts to run local servers with restricted file-system and network access. The
  README states the little this tool needs, so a sandbox can be written tightly.
- The server instructions and SKILL.md both say that record text is data, never instructions.

## Small on purpose

- One package, one build script, one shipped file. No framework, no plugin system, no configuration file.
- Runtime dependencies are the MCP SDK, zod, a cookie jar and an HTML parser. A new one fails the build
  until it is added to the allowlist in `scripts/build.mjs`.
- `AGENTS.md` follows the format's own description, "a README for agents": the commands to run, how to
  test, what to do before committing, a short map of the code and the rules an agent cannot infer.

## Sources

- Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Model Context Protocol, [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  and [Security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices),
  both read from the specification repository
- [Command Line Interface Guidelines](https://clig.dev/)
- [AGENTS.md](https://github.com/openai/agents.md), and Philipp Schmid,
  [Writing a good AGENTS.md](https://www.philschmid.de/writing-good-agents)
