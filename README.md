# maccabi-health

Read-only access to a Maccabi Healthcare Services member's own records, as a command-line tool and an
[MCP](https://modelcontextprotocol.io) server in one file: lab results and their history, imaging, visits,
prescriptions, referrals, vaccinations, certificates, doctor correspondence, billing, original documents,
and a search for free appointment slots.

Unofficial and not affiliated with Maccabi. It never books, cancels, pays, sends, marks anything as read,
or changes the account in any way. Signing in takes the member's ID number and the SMS code Maccabi sends
to their registered phone.

Not medical advice. Use it at your own risk: it shows what Maccabi returned, as it was returned, and
anything that matters for your health belongs with your doctor or Maccabi.

## Install

The whole tool is `release/maccabi-health.mjs`. It needs [Node.js 22+](https://nodejs.org) and nothing
else: no `npm install`, no package registry. Its SHA-256 is in `release/maccabi-health.mjs.sha256`.

```bash
(cd release && sha256sum -c maccabi-health.mjs.sha256)
```

```bash
node release/maccabi-health.mjs --version
```

An agent installs it from [SKILL.md](skills/maccabi-health/SKILL.md), which pins one commit and one hash.
Below, `maccabi-health` stands for `node /path/to/maccabi-health.mjs`.

## Use

```bash
maccabi-health login                 # asks for the ID and the SMS code, hidden
maccabi-health labs-latest
maccabi-health lab-history --test-id 1234 --source latest
maccabi-health clinic-visits --limit 5
maccabi-health prescription-pdf --id 987 --out prescription.pdf
maccabi-health logout
```

`maccabi-health` alone lists every command by category; `maccabi-health help COMMAND` shows its arguments.
Results are JSON on stdout. Errors are one JSON object on stderr, with exit code 2 for bad usage, 3 when a
sign-in is needed, and 1 for anything else. Documents are written to `--out FILE` as a new private file
and never overwrite one.

Every error says whose problem it is and whether retrying can help, so an agent can act on it without
guessing:

```json
{"error": {"code": "PORTAL_HTTP_ERROR", "message": "...", "detail": "status=404 report-absent",
  "cause": "maccabi", "retry": "no", "known_issue": "Maccabi does not serve the printable report of older ..."}}
```

`cause` is `maccabi`, `not-applicable` (nothing of that kind exists: a valid answer), `caller`, `session`,
`member`, `network` or `tool`. `retry` is `no`, `once`, `later`, `after-relisting`, `after-fixing-input`,
`after-sign-in` or `after-member-action`. `known_issue` is present for failures seen against the live
service and understood; [docs/known-issues.md](docs/known-issues.md) lists them. An unknown flag or
argument is answered with the ones the command takes, an unknown command with a pointer to `help`.

Without a terminal, sign-in is two commands, with the SMS arriving in between:

```bash
echo 000000000 | maccabi-health login --id-stdin
```

```bash
echo 000000 | maccabi-health login --code-stdin
```

Standard input keeps both values out of the process list, the shell history and the environment. The
variables `MACCABI_ID` and `MACCABI_OTP` and the flags `--id` and `--code` are accepted too, for hosts that
can only inject a secret one of those ways.

### As an MCP server

```json
{
  "mcpServers": {
    "maccabi-health": { "command": "node", "args": ["/absolute/path/to/maccabi-health.mjs", "mcp"] }
  }
}
```

The server speaks MCP over stdio and offers six tools:

| Tool | What it does |
| --- | --- |
| `maccabi_read` | Runs one read. `operation` is any command name; `arguments` are that command's arguments. |
| `maccabi_help` | Describes one operation or one category. No request, no session. |
| `maccabi_status` | Whether a session is saved. No request. |
| `maccabi_login_start`, `maccabi_login_verify` | Sign in from the client when the member has no terminal. |
| `maccabi_logout` | Deletes the saved session. |

Every read is defined once and offered on both surfaces, so a command and its `maccabi_read` operation take
the same arguments and return the same data. The one difference: over MCP a list returns 20 rows unless
`limit` says otherwise, to keep a model's context small. The CLI and the server share one saved session.

## What it reads

| Category | Examples |
| --- | --- |
| `medical` | `test-results`, `lab-values`, `lab-history`, `scans`, `clinic-visits`, `prescriptions`, `referrals`, `vaccine-groups`, `certificates`, `doctor-inquiries`, and their PDFs |
| `appointments` | `appointments`, `bookable-providers`, `open-slots`, `visit-preparation` |
| `providers` | `assigned-doctor`, `recent-providers`, and the public `directory-search` (no account) |
| `account` | `profile`, `contact-details`, `authorized-users`, `notification-settings` |
| `billing` | `quarterly-statements`, `billing-totals`, `nursing-statements` |
| `requests` | `requests`, `request`, `request-attachment-pdf` |
| `notifications` | `mailings`, `mailing-pdf` |
| `portal` | `portal`: any endpoint of a reviewed allowlist (`portal-endpoints` lists them) |

Lists are what Maccabi returned for that call, not a complete history. `--limit` and `--offset` slice the
fetched list; they do not ask Maccabi for more.

## Sessions

Maccabi ends an idle session after a few minutes and every session one hour after sign-in. A finished
`login` starts a background `keep-alive` that renews the session every four minutes; the MCP server does the
same while it runs. Nothing extends the hour: after it, the member signs in again with a new SMS code.

## Security

Health records and a live session are handled here, so the design is deliberately narrow:

- **Read-only.** There is no code path that changes anything at Maccabi. Reads that would have a side
  effect upstream are not offered.
- **Only Maccabi.** Requests go to an allowlist of Maccabi's own HTTPS hosts. A test scans the shipped file
  for any other host.
- **Only the member's own data.** Every identifier a caller passes is checked against a freshly fetched
  list of the signed-in member before it is used, and responses naming another member are refused.
- **Credentials stay out of results.** Cookies, tokens, the member's and other people's ID numbers,
  passport and bank numbers are removed from every result. Error messages are fixed text: nothing Maccabi
  sent and no value the caller passed is repeated in them.
- **Little at rest.** The session is one file, mode 0600 in a 0700 directory
  (`$MACCABI_CONFIG_DIR`, else `~/.config/maccabi-health`). It holds the session cookies and the member's
  ID number, so anyone who can read it can read the member's records until the session ends. The SMS code
  is never stored.
- **Records are data.** Clinical text is returned as Maccabi wrote it and is never interpreted. A client
  should treat it the same way and not follow instructions found inside a record.
- **One file, pinned.** No install step runs third-party code; the release is reproducible from this tree
  and distributed by commit and SHA-256.

If you sandbox it, it needs very little: outbound HTTPS to `*.maccabi4u.co.il`, read and write access to
its config directory, and write access wherever you point `--out`. It needs no other network, no inbound
port, and nothing else on disk.

More in [docs/security.md](docs/security.md). Please report a vulnerability privately through GitHub's
vulnerability reporting, not in an issue.

## Develop

```bash
npm ci --ignore-scripts
```

```bash
npm run check
```

`npm run check` type-checks, lints, builds `dist/maccabi-health.mjs` and runs the tests against it with a
fake Maccabi; no account or network is involved. `npm run coverage` reports how much of the shipped code
those tests execute. [AGENTS.md](AGENTS.md) describes the layout and the rules
for changing it, [docs/design.md](docs/design.md) why it is shaped this way, and
[docs/upstream.md](docs/upstream.md) where each upstream contract came from.

[MIT](LICENSE)
