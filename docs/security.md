# Security model

This describes what the code does today. Each claim names the file that implements it.

## What is protected, and from whom

Protected: the saved session (portal cookies and the API bearer), the member's records, ID number and SMS
code, and the Maccabi account itself, which nothing here may change.

The tool defends against other local users (file modes), other members' data reaching a result (owner
binding), any host that is not Maccabi's (network confinement), and credentials or identity numbers reaching
a terminal, a pipe or a model's context (redaction and fixed error text).

The trust boundary is the session file and Unix permissions. The MCP server speaks stdio only
(`src/mcp/serve.ts`) and has no authentication: whoever starts the process and holds its stdin can run every
read. The shipped file imports no `node:http`, `node:net` or `node:tls`, so it opens no listening socket.
Any process running as the same user can read the session file. Nothing here defends against that, or
against root. Clinical text is returned as Maccabi wrote it and is never interpreted; a client must treat it
as data.

## Read-only

There is no code path that books, cancels, pays, sends, marks as read or edits anything.

- Every read is one entry of the registry in `src/operations/`. Both surfaces run it through
  `execute()` (`src/operations/execute.ts`). The MCP `operation` argument is looked up in that registry; any other name is refused.
- The upstream client has no generic request. Each method in `src/maccabi/member/*.ts` builds a fixed path
  under the signed-in owner (`MemberScope.path`).
- The `portal` operation can only call entries of `CATALOG` in `src/maccabi/member/parse/catalog.ts`.
  An entry fixes service, method and path template. A caller supplies only declared parameters, each
  checked against an anchored pattern and URI-encoded.
- `NEVER_OFFERED` in the same file lists the portal calls that are deliberately not in the catalog:
  booking, changing and cancelling appointments, waiting lists, Switchit, uploads, sending or editing
  doctor requests, mark-as-read calls, consents, payments, profile edits, token and link minting, logging,
  and the GETs that have an effect (`allow_no_card_visit`, `read/{doc}`, `show_what_new`). It also lists
  two reads that were removed (`test-information`, `medicine-name`), because no list gives a caller an id
  they accept. None of those names resolves: asking for one is refused before any request, with the fixed
  reason recorded for it.
- Sign-out deletes local files and sends nothing upstream (`signOut` in `src/session/sign-in.ts`).
  Session renewal is one GET to `MainAppAPI/v1/.../alive` (`renew` in `src/maccabi/member/account.ts`).

### Every non-GET request

Everything not listed here is a GET. All paths are under `src/maccabi/`.

| File, function | Endpoint | Why it is a read or a sign-in step |
| --- | --- | --- |
| `sms-sign-in.ts`, `SmsSignIn.begin` | `mac.maccabi4u.co.il/infosec/auth` | Sign-in: submits the ID to open the SMS challenge |
| `sms-sign-in.ts`, `#enterPortal` | `online.maccabi4u.co.il/saml/sp/profile/post/acs` (form) | Sign-in: posts the SAML assertion that opens the portal session |
| `member/parse/viewer-study.ts`, `viewerShell` (two form posts) | `meddreamy.maccabi4u.co.il/saml/sp/profile/post/acs` | Viewer sign-in: the SAML assertion, then the viewer's `dummy` nonce form |
| `member/scheduling.ts`, `allFutureAppointments` | `AppointmentOrderAPI/v2/.../appointments/future` | List query |
| `member/scheduling.ts`, `fetchFutureAppointment` | `MainAppAPI/v1/.../providers`, `AppointmentOrderAPI/v1/.../appointments/instructions_for_visit_type` | Provider card and visit instructions of one listed appointment |
| `member/scheduling.ts`, `askBookingEntitlement` | `AppointmentOrderAPI/v1/.../appointments/eligibility` (`action_type: 1`) | Asks whether booking is allowed; books nothing |
| `member/scheduling.ts`, `fetchAppointmentProvider` | `MainAppAPI/v1/.../providers` (`retrieval_type: "1"`) | Provider card |
| `member/parse/appointment-queries.ts`, `providerCard` | `MainAppAPI/v1/.../providers` | Provider card the booking page loads |
| `member/parse/appointment-queries.ts`, `queryVisitTypes` | `AppointmentOrderAPI/v1/.../appointments/visit_types` | Visit types of one provider; sent on page load |
| `member/parse/appointment-queries.ts`, `openSlots` | `AppointmentOrderAPI/v1/.../appointments/provider_appointments` | Free-slot query; the portal repeats it on every calendar move, so it holds nothing |
| `member/parse/appointment-queries.ts`, `visitNotes` | `AppointmentOrderAPI/v1/.../appointments/instructions_for_visit_type` | Instruction text for one visit type |
| `member/parse/appointment-queries.ts`, `queryMemberEligibility` | `AppointmentOrderAPI/v1/.../appointments/member-eligibilities` | Eligibility flag the booking page reads on mount |
| `member/visits.ts`, `allVisits` | `AppointmentOrderAPI/v1/.../visits/history` | List query |
| `member/labs.ts`, `allTests` | `TestResultsAPI/v1/.../tests` | List query |
| `member/labs.ts`, `labDetail` | `TestResultsAPI/v1/.../getresultsbyid` | One result of a listed row |
| `member/prescriptions.ts`, `allPrescriptions` | `MedicalFileAPI/v1/.../prescriptions` | List query |
| `member/mailings.ts`, `allNotifications` | `DirectorshipAPI/v1/.../all/letters_for_member` | Letters in a date range |
| `member/requests.ts`, `allAdministrativeRequests` | `RequestsAndApprovalsAPI/v1/.../requests_and_cases` | List query |
| `member/records.ts`, `allHospitalHistory` | `/online/webapi/MailingsFromHospitals/GetMailingsFromHospitals/` | Hospital mailings in a date range |
| `member/records.ts`, `allPurchasedMedicationHistory` | `DrugsManager/WsPurchasedDrugsManager.asmx/GetPurchasedPrescriptionList` | One page of a legacy grid; the rows' auditing handler is never called |
| `member/records.ts`, `allSavedMedicalDocuments` | `PHR/WsPHRManager.asmx/GetGridViewAjax` | One page of a legacy grid; the page's upload, edit and save postbacks are never sent |
| `member/records.ts`, `allLegacyRequestsAndApprovals` | `RequestsAndApprovals/WsRequestsAndApprovalsAPI.asmx/GetGridViewAjax`, `.../GetApplicationTypeManagementResponse` | One page of a legacy grid, and the value the same page loads |
| `member/payments.ts`, `allQuarterlyBillingReports` | `DebitsAndCredits/WcDebitsAndCreditsManager.asmx/GetQuarterlyReport` | Report catalog of one quarter |
| `member/payments.ts`, `allNursingInsuranceReports` | `.../GetLTCReport` | Report catalog |
| `member/payments.ts`, `#archivedPdf` | `.../GetDocFromArchive` | Prepares one archived report PDF by the token of a freshly listed row |
| `member/portal.ts`, `answer` | The twelve POST entries of the catalog | Pure queries; each entry carries its justification in `post` |
| `provider-directory.ts`, `#fetchText` | `serguide.maccabi4u.co.il/webapi/api/` search, settings and provider details | Public directory queries; no cookies, `credentials: "omit"` |

The twelve catalog POSTs are `magnetic-card-cost`, `service-eligibilities`, `service-history`,
`service-rights`, `doctor-assignment-search`, `appointment-documents-indication`, `visit-triage`,
`future-appointments`, `future-appointments-v1`, `inquiry-eligibility`, `sick-note-eligibility` and
`requests-and-cases`. The SMS itself is requested with a GET (`SmsSignIn.sendCode` in `sms-sign-in.ts`).

## Network confinement

`PortalHttp` (`src/maccabi/http.ts`) carries every signed-in request.

- **Origin allowlist.** Only `https://mac.maccabi4u.co.il`, `https://online.maccabi4u.co.il` and
  `https://meddreamy.maccabi4u.co.il`. A URL with a user name or password is refused.
- **Manual redirects.** Every fetch uses `redirect: "manual"`. The transport follows at most eight hops and
  checks each destination against the allowlist. The imaging handoff follows its own hops and checks the
  exact origin and path of each.
- **Cross-origin stripping.** `Authorization`, `Origin` and `Referer` are dropped when a redirect changes
  origin. Cookies come only from the per-URL jar; a caller-supplied `Cookie` header is deleted.
- **Expiry detection.** A signed-in portal request redirected to the login host or to `/my.policy` clears
  the jar and raises `SESSION_ENDED`; the one exemption is the imaging handoff to
  `/imaging/login`. A logout or F5 logon page served with status 200 is caught in `src/maccabi/member/`
  (`mustStillBeSignedIn`, `getJson`). A 401 or 403 fails that request and leaves the session alone.
- **Timeouts.** 30 seconds per transport request, enforced even when fetch ignores the abort signal;
  30 seconds per directory request; 240 seconds per MCP call. A pending mailing PDF is polled at most six
  times, five seconds apart.
- **Body caps, enforced while reading.** JSON and HTML 16 MiB; PDF 2 MiB; legacy pages and script-service
  answers 1 MiB; viewer HTML and JSON 4 MiB, thumbnail 8 MiB, pixels 64 MiB; directory 4 MiB; a
  portal-catalog result 4 MiB. The MCP server refuses a JSON result above 128 KiB and a file above 16 MiB.

The public directory (`src/maccabi/provider-directory.ts`) does not use the transport. It requests fixed
URLs on `https://serguide.maccabi4u.co.il`, sends no cookies and no `Authorization`, and refuses any
answer that is not a 200 from the URL it asked for.

## Owner binding

- **Bootstrap.** `MemberScope.open` (`src/maccabi/member/context.ts`) reads who is signed in. A saved
  owner that differs from the signed-in member fails with `NOT_THE_MEMBERS`. `verifySignIn` applies the same
  check to the ID the challenge was opened for.
- **Dependent selected.** If the portal is viewing a different member than the one signed in, every
  account read fails with `OTHER_MEMBER_SELECTED`.
- **Responses.** Each row that names a member must name the owner (`mustBelongToMember`). Portal-catalog
  responses are checked at every depth (`mustBelongToMemberDeep`). Legacy pages are checked for the owner
  marker (`mustBeMembersPage`).
- **Caller-supplied ids.** An id is used only after it is found in a freshly fetched owner list: test rows,
  the imaging study UID with its series and instance, recent providers, visit types, and the bound
  parameters of catalog entries. Otherwise the read fails with `NOT_THE_MEMBERS` and the id is never sent.
- **Stable references.** A document is selected by a 64-hex reference hashed from the row's stable fields
  and its position among equal rows (`SteadyReferences` in `member/shared.ts`), never from a link,
  timestamp or signature. A malformed reference is refused before any request.
- **Downloads.** The route and signature come from the fresh read, never from the caller. The final URL
  must equal the requested one, the type must be `application/pdf`, and the bytes must start with `%PDF-`.

## What never leaves the process

`redact()` (`src/maccabi/redact.ts`) runs on every JSON result and on the details printed beside a file.
It drops keys at every depth, matched case-insensitively with punctuation ignored:

- The member's identity: `member_id`, `member_id_code`, `patient_id`, `logged_customer_info`, `family_data`.
- Other people's ID numbers: `user_id`, `primary_id`, `recipient_id`, `payer_id`, `requested_by_id`,
  `infant_id`, `id_number`.
- Identity checksums and numbers: `checksum`, `id_tech`, `national_id`, `passport_number`, `account_number`.
- Credentials: `authorization`, `cookie`, `MRHSession`, `token`, `access_token`, `jwt`, `session`,
  `session_id`, `SAMLResponse`, `password`, `otp`, and a device's `device_token` and `udid`.
- Viewer patient fields: `patientName`, `patientBirthDate`, `viewportLabels`.
- **DICOM rule.** Inside an `attributes` object, the whole patient group (tags `0010xxxx`) and eight
  person-identification-code sequences are removed. Every other tag is kept.

Deliberately kept:

- Maccabi's temporary download links and their signatures (`pdf_link`, `hash`, `timestamp` and similar).
  They open only with the session cookies, which are dropped, and they change on every response.
  The portal catalog still withholds a link that carries the member checksum (`member/portal.ts`).
- `patientSex`. It is not an identifier, imaging interpretation depends on it, and `profile` returns it.
- An authorized user's technical id. It is not a national ID.

Clinical prose is not de-identified: the filter drops fields, not text. Binary results pass through.

## Errors

Both surfaces show only `Failure` (`src/operations/failure.ts`):
`{"error":{"code","message","detail"?,"cause","retry","known_issue"?}}`.

- `message` is fixed text written in `failure.ts`, `src/maccabi/faults.ts` or, for a request the portal
  catalog turns down, `src/maccabi/member/parse/catalog.ts`.
- `cause` and `retry` are one of a few fixed words, and `known_issue` is a fixed sentence, all written in
  `faults.ts` or `failure.ts` ([known-issues.md](known-issues.md) lists the sentences).
- `detail` is a token this client wrote, such as `status=503`, `key:pdf_link` or
  `reference-unknown`. A reason is dropped unless it matches `^[A-Za-z0-9_.:=\[\]-]{1,120}$`.
- No upstream body, URL, header or fetch error cause is kept. An unanticipated error becomes
  `TOOL_DEFECT` with fixed text.
- Nothing the caller typed is repeated. An input error names the argument at fault only when it is one
  the operation defines; for an unknown argument or option it lists the accepted names instead, and an
  unknown command is answered with a pointer to the help. The one exception is outside this code: a call
  that breaks a tool's own top-level schema is refused by the MCP SDK, whose message names the unknown key.

## At rest

`SessionStore` (`src/session/files.ts`) keeps two files, mode 0600, in a 0700 directory:
`signed-in.json` (portal cookies, sign-in time, API bearer, the owner's member id and id code) and
`sign-in-attempt.json` (an open challenge: its tokens, mid-login cookies, phone labels and the member id).

- Writes go to a uniquely named temporary file, created 0600, which then takes the place of the file.
- A file found readable by others is narrowed to 0600 when read. An existing directory is narrowed to 0700
  only when it is named `maccabi-health`. Permission bits are not applied on Windows.
- Directory: `$MACCABI_CONFIG_DIR`, else `$XDG_CONFIG_HOME/maccabi-health`, else `%APPDATA%\maccabi-health`
  on Windows, else `~/.config/maccabi-health`.
- Never stored: the SMS code, and the imaging viewer's cookies.
- The member id in both files is the member's ID number.
- A document written with `--out` is a new 0600 file; an existing file is never overwritten.

## Sign-in rules

- One SMS per start (`startSignIn` in `src/session/sign-in.ts`). Nothing resends automatically.
- One attempt per code. A rejected code ends the challenge, because retries lock the account.
  A code that is not six digits is refused before the challenge is touched.
- The challenge lasts ten minutes (`SmsSignIn` in `src/maccabi/sms-sign-in.ts`).
- The phone is never chosen for the member. With several SMS-capable phones and no choice, nothing is sent
  and the options are returned.
- Interactive `login` reads the ID and the code from the terminal, hidden. Without a terminal,
  `--id-stdin` and `--code-stdin` read them from standard input, which keeps them out of the process list,
  the shell history and the environment. `MACCABI_ID` and `MACCABI_OTP` carry them in the environment;
  `--id` and `--code` work too, but put the values in the process list.
- The MCP server sends at most three sign-in SMS in ten minutes without a completed sign-in (`allowSms` in
  `src/mcp/server.ts`), so a
  client that loops on `maccabi_login_start` cannot spend the member's SMS budget into an account lock.
- A sign-in over MCP cannot be kept from the model: the ID number is an argument of
  `maccabi_login_start` and the code an argument of `maccabi_login_verify`. That is why the server's
  sign-in hint and the first tool's description recommend `login` in the member's own terminal.

## Sessions

- Maccabi ends an idle session after a few minutes and every session one hour after sign-in.
  Renewal runs every 240 seconds and holds off the idle limit only (`src/session/keep-alive.ts`).
- A finished CLI `login` starts a detached `keep-alive`: this Node binary running this same file. It stops
  after one hour, when the session expires, is signed out or is replaced, or after three failures in a row.
- The child's environment is scrubbed of every variable whose name matches `TOKEN`, `SECRET`, `PASSW`,
  `API_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `AUTH`, `COOKIE`, `SESSION`, `MACCABI_ID` or `MACCABI_OTP`.
- The MCP server renews on the same interval through its call queue, so within that process a renewal
  never overlaps a read. A call abandoned at its 240 s deadline is told so and no longer writes to the
  session.
- Processes are not serialized against each other. A CLI command, the detached keep-alive and an MCP
  server may each save the cookies they were handed; the last save wins. Every save and every removal
  first checks that the stored session is still the same sign-in (`SessionStore.refresh`, `forget`), so
  late work cannot restore a signed-out session or replace or delete a newer sign-in, short of a
  sub-millisecond window between that check and the rename.
- Renewal never deletes the session file.
  A read that finds the session ended deletes the file and answers `SIGN_IN_NEEDED`.

## Running it confined

MCP's security guidance asks hosts to launch local servers with restricted file-system and network access.
This tool needs only:

- outbound HTTPS to `mac`, `online`, `meddreamy` and `serguide` under `maccabi4u.co.il`;
- read and write access to its config directory;
- write access to the directory of an `--out` path, for the CLI's document commands.

It listens on no port, reads no other file, and starts one child process: itself, as `keep-alive`.

## Supply chain

- The release is one file, `release/maccabi-health.mjs`, built by `scripts/build.mjs`. It runs with Node
  alone, and its bytes depend only on the source tree and the lockfile.
- `BUNDLED_PACKAGES` in `scripts/build.mjs` lists the packages allowed into the bundle. Any other package,
  direct or transitive, fails the build.
- License notices of every bundled and inlined package go into the file's header and
  `THIRD_PARTY_LICENSES.txt`. A missing notice for an inlined package fails the build.
- `--check-release` fails unless `release/` equals a fresh build.
- [SKILL.md](../skills/maccabi-health/SKILL.md) pins one commit and one SHA-256 and verifies the download
  before anything can run it. Development installs with `npm ci --ignore-scripts`.

## Checked against MCP's security best practices

Each section of the Model Context Protocol's security best-practices document, and how it applies here.

| Section | Applies? | How it is met |
| --- | --- | --- |
| Confused deputy | No | The server is not an OAuth proxy and has no authorization endpoints. |
| Token passthrough | Yes | No token is accepted from a client or forwarded. The only credential is the member's own session, read from the private session file. |
| Server-side request forgery | Yes, as a client of Maccabi | Requests go only to an allowlist of HTTPS hosts; redirects are handled hop by hop and each target is checked (`src/maccabi/http.ts`). No URL from a caller or from a response is ever fetched: links inside records are returned, not followed. |
| State handle hijacking | No | There is no HTTP transport, so no session identifiers are issued to clients. |
| Local MCP server compromise | Yes | stdio only; no listening socket, so nothing to reach by DNS rebinding. Installed as one file at a pinned commit and SHA-256, never through `npx` or a registry. What a sandbox must allow is listed under "Running it confined". |
| OAuth authorization URL validation | No | The server opens no URLs and has no OAuth flow. |
| stdio transport in proxy scenarios | No | The server spawns no other servers. Its one child process is itself, as `keep-alive`, with a fixed argument list. |
| Mix-up attacks, localhost redirect URIs, client metadata trust | No | No OAuth client or authorization server is implemented. |
| Scope minimisation | Yes, in spirit | There are no scopes; the equivalent is that only reads exist, each bound to the signed-in member. |

## Which test enforces what

Files under `test/` change often, so this list names topics.

- `test/integration/shipped-file.test.ts`: the shipped file names no host but Maccabi's, is reproducible,
  matches `release/`, starts no process but its own keep-alive, imports no network built-in, and returns
  instruction-like record text as data.
- `test/integration/parity.test.ts`: every operation answers the same on the CLI and over MCP.
- `test/integration/catalog.test.ts`: what the catalog refuses, owner-bound ids, and which links are returned.
- `test/integration/member-scope.test.ts`: owner check, dependent selected, expiry, renewal.
- `test/integration/http.test.ts`: redirects stay on the allowlist, credentials do not cross hosts, a
  refused or stalled answer costs the session nothing.
- `test/integration/session.test.ts`, `terminal.test.ts`: sign-in rules, file modes, storage failures, hidden
  input on a terminal.
- `test/integration/references.test.ts`: references stay valid while Maccabi rotates its links.
- `test/integration/scheduling.test.ts`: appointment finding makes no scheduling request.
- `test/unit/`: only what the bundle cannot be driven into: call deadlines and renewal timing (intervals
  shortened to milliseconds), storage races and failed writes, a fetch that ignores its abort, and an
  unanticipated error never showing its message.
- `npm run coverage` measures which lines of this project's code inside the bundle the integration suite
  executes, and fails below the minimum.
