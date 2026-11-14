/**
 * The command line from the caller's seat, with the built bundle on one side and the fake Maccabi on the
 * other. The help, which is written by the operation registry; the commands that are turned down as
 * typed; what goes to stdout and what to stderr for a result and for a failure; paging done locally;
 * `--out` for documents; and the exit code of each case. session.test.ts covers signing in and the
 * session files.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { OPERATION_GROUPS, OPERATIONS } from "../../src/operations/index";
import { NAME, VERSION } from "../../src/version";
import { type CliResult, OTP, type RunOptions, sandbox } from "../rig";

const box = sandbox("cli");
const WITH_SESSION: RunOptions = { config: "has-session" };
/** Nothing signs in under this config directory, ever. */
const NO_SESSION: RunOptions = { config: "no-session" };
// One sign-in serves the file. With a session at hand, a command that is supposed to run nothing would
// show up at the fake if it ran after all.
beforeAll(() => box.signIn(WITH_SESSION));

const OPERATION_NAMES = OPERATIONS.map(({ name }) => name);
const SESSION_COMMANDS = ["login", "status", "logout", "keep-alive", "mcp", "help"];
/** A value the tests type on the command line. No output may repeat it. */
const TYPED = "mock-typed-value";

/** A command that has to do its work without a request, which is checked. */
function quiet(args: string[], options = NO_SESSION): CliResult {
  const requestsBefore = box.fetches().length;
  const result = box.cli(args, options);
  expect(box.fetches().length - requestsBefore, `requests by "${args.join(" ")}"`).toBe(0);
  return result;
}
const signedIn = (...args: string[]) => box.cli(args, WITH_SESSION);
/** Checks how a command failed, that it printed nothing, and returns its error. */
function failure(result: CliResult, exit: number, code: string) {
  const error = result.error();
  expect({ exit: result.code, code: error.code, out: result.out }).toEqual({ exit, code, out: "" });
  return error;
}

describe("the help, which the registry writes and which wants no session", () => {
  const helpOf = (...topic: string[]) => quiet(["help", ...topic]);
  const index = () => helpOf().out;

  test("has a line in its index for each operation and each session command", () => {
    const { out, err, code } = helpOf();
    for (const command of [...SESSION_COMMANDS, ...OPERATION_NAMES]) {
      expect(out, command).toMatch(new RegExp(`^  ${command} +\\S`, "m"));
    }
    expect(err).toBe("");
    expect(code).toBe(0);
  });

  test("is that same index when the command line is empty, or just --help or -h", () => {
    for (const args of [[], ["--help"], ["-h"]]) expect(quiet(args).out, args.join(" ")).toBe(index());
  });

  test("of an operation opens with its usage and names its category and each of its flags, whatever kind it is", () => {
    // The text is generated, so one operation per kind speaks for the others. These six cover all argument
    // types, a default, a required and an optional argument, a document, each kind of access, and an
    // operation with no arguments.
    const oneOfEachKind = [
      "profile",
      "portal",
      "portal-endpoints",
      "prescriptions",
      "directory-search",
      "lab-history-pdf",
    ];
    for (const { name, summary, category, input, returns } of OPERATIONS.filter((op) =>
      oneOfEachKind.includes(op.name),
    )) {
      const { out, code } = helpOf(name);
      expect(code, name).toBe(0);
      expect(out.indexOf(`${NAME} ${name}`), name).toBe(0);
      for (const said of [summary, `Category: ${category}.`]) expect(out, name).toContain(said);
      for (const argument of Object.keys(input.shape)) {
        expect(out, `${name}: ${argument}`).toContain(`  --${argument.replaceAll("_", "-")}`);
      }
      expect(out.includes("--out FILE"), name).toBe(returns === "file");
    }
  });

  test("of an operation is also what --help after the operation prints, in place of running it", () => {
    const asked = quiet(["referral-pdf", "--id", "ref-1", "--help"], WITH_SESSION);
    expect(asked.out).toBe(helpOf("referral-pdf").out);
    expect(asked.code).toBe(0);
  });

  test("as --json holds each operation exactly once, under its category, with a summary and its arguments", () => {
    const listing = helpOf("--json").json();
    expect(listing.session.map(({ name }: any) => name)).toEqual(SESSION_COMMANDS);
    expect(listing).toMatchObject({ version: VERSION, name: NAME });

    const listed: any[] = [];
    for (const { category, about, operations } of listing.categories) {
      expect(about).toBe(OPERATION_GROUPS[category as keyof typeof OPERATION_GROUPS]);
      for (const operation of operations) {
        expect(operation.category, operation.name).toBe(category);
        expect(operation.arguments, operation.name).toBeInstanceOf(Array);
        expect(operation.summary.length, operation.name).toBeGreaterThan(10);
        listed.push(operation);
      }
    }
    expect(listed.map(({ name }) => name).sort()).toEqual([...OPERATION_NAMES].sort());
    const distinctSummaries = new Set(listed.map(({ summary }) => summary));
    expect(distinctSummaries.size, "operations whose summaries are all different").toBe(listed.length);
  });

  test("as --json gives an argument the type and the necessity that the flag parser goes by", () => {
    const labs = helpOf("test-results", "--json").json();
    expect(labs).toMatchObject({ returns: "json", access: "member", category: "medical", name: "test-results" });
    const year = labs.arguments.find(({ name }: any) => name === "year");
    expect(year).toEqual({ name: "year", description: expect.any(String), required: false, type: "integer" });
  });

  test("given --category leaves out the operations of the other categories", () => {
    const { categories } = helpOf("--category", "billing", "--json").json();
    expect(categories).toHaveLength(1);
    expect(categories[0].category).toBe("billing");
    const billing = OPERATIONS.filter(({ category }) => category === "billing").map(({ name }) => name);
    expect(categories[0].operations.map(({ name }: any) => name)).toEqual(billing);

    const asText = helpOf("--category", "billing").out;
    expect(asText).not.toContain("lab-values");
    expect(asText).toContain("quarterly-statements");
  });

  test("of a session command says how that command is used", () => {
    const { out, code } = helpOf("login");
    for (const said of ["MACCABI_ID and MACCABI_OTP", "--code-stdin", "--id-stdin"]) expect(out).toContain(said);
    expect(code).toBe(0);
  });

  test.each(["version", "--version"])("is not needed for %s, which prints the tool's name and version", (command) => {
    const { out, code } = quiet([command]);
    expect(out).toBe(`${NAME} ${VERSION}\n`);
    expect(code).toBe(0);
  });

  test("left the config directory uncreated through all of the above", () => {
    expect(fs.existsSync(box.configDir(NO_SESSION.config))).toBe(false);
  });
});

describe("a command that is wrong as typed is turned down with nothing loaded and nothing sent", () => {
  const portal = (...params: string[]) => ["portal", "--endpoint", "features", ...params];
  test.each<[string, string[], string]>([
    [
      "an option nobody defined, which is answered with the ones the command takes",
      ["test-results", `--${TYPED}`, TYPED],
      "Unknown option. It takes: --year, --limit, --offset. Run `maccabi-health help test-results`.",
    ],
    ["--no- in front of an option that takes a value", ["test-results", "--no-year"], "Unknown option."],
    ["the same option twice", ["referral-pdf", "--id", TYPED, "--id", TYPED], "given twice"],
    ["an option whose value is missing", ["test-results", "--year"], "--year needs a value."],
    ["a number written with an exponent", ["test-results", "--year=1e3"], "--year takes a whole number."],
    ["a document asked for without --out", ["referral-pdf", "--id", TYPED], "add --out FILE"],
    ["a switch that is given a value", ["prescriptions", `--permanent=${TYPED}`], "--permanent takes no value."],
    ["a bare word behind a switch", ["prescriptions", "--permanent", TYPED], "Arguments are given as --name value."],
    ["a map entry without a =", portal("--params", TYPED), "KEY=VALUE"],
    ["a map entry whose key is __proto__", portal("--params", "__proto__=1"), "KEY=VALUE"],
    ["one map key twice", portal("--params", `${TYPED}=1`, "--params", `${TYPED}=2`), "key was given twice"],
    ["a command that does not exist", [TYPED], "There is no such command."],
    ["help for a command that does not exist", ["help", TYPED], "There is no such command."],
    ["help for a category that does not exist", ["help", "--category", TYPED], "That is not a category."],
    ["help with an option nobody defined", ["help", `--${TYPED}`], "Unknown option."],
    ["a value outside the ones the operation lists", ["prescriptions", "--status", TYPED], "status:"],
    ["login --phone with a code, not with the ID", ["login", "--phone", "1", "--code", OTP], "--phone goes with"],
  ])("%s: exit 2 BAD_INPUT, with what was typed left out of the message", (_what, args, said) => {
    const refused = quiet(args, WITH_SESSION);
    expect(failure(refused, 2, "BAD_INPUT").message).toContain(said);
    expect(refused.err).not.toContain(TYPED);
  });

  test("an unknown command and an unknown option get the whole fixed answer, which proposes no other name", () => {
    const command = failure(quiet([TYPED], WITH_SESSION), 2, "BAD_INPUT").message;
    expect(command).toBe("There is no such command. Run `maccabi-health help`.");
    const option = failure(quiet(["lab-values", `--${TYPED}`, "1"], WITH_SESSION), 2, "BAD_INPUT").message;
    expect(option).toBe("Unknown option. It takes: --request-id, --doc-id. Run `maccabi-health help lab-values`.");
  });

  test("a read of the account with no session is exit 3 SIGN_IN_NEEDED, gives the two login commands and sends nothing", () => {
    const { message } = failure(quiet(["test-results"]), 3, "SIGN_IN_NEEDED");
    for (const step of ["--id", "--code"]) expect(message).toContain(`${NAME} login ${step} DIGITS`);
  });
});

describe("what a result and a failure look like", () => {
  const VISIT_IDS = ["encounter-41", "encounter-42"];
  const idsOf = (rows: any[]) => rows.map((row) => row.appointment_id);
  const secondOfTwo = { available: 2, returned: 1, offset: 1, nextOffset: null };

  test("a result is indented JSON on stdout with stderr empty, and a list comes whole, with no page, unless one is asked for", () => {
    const visits = signedIn("clinic-visits");
    const result = visits.json();
    expect(visits.out).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(visits.err).toBe("");
    expect(visits.code).toBe(0);
    expect(idsOf(result.data)).toEqual(VISIT_IDS);
    expect(Object.keys(result)).not.toContain("page");
  });

  test("--offset alone drops that many rows from the front and returns all that follow", () => {
    const { data, page } = signedIn("clinic-visits", "--offset", "1").json();
    expect(page).toEqual(secondOfTwo);
    expect(idsOf(data)).toEqual(VISIT_IDS.slice(1));
  });

  test("an option may carry its value after a = as well as after a space", () => {
    expect(signedIn("clinic-visits", "--offset=1", "--limit=1").json().page).toEqual(secondOfTwo);
  });

  test("when the list sits inside the result, a page cuts the list and leaves what surrounds it", () => {
    const { data, page } = signedIn("test-results", "--limit", "1").json();
    expect(page).toEqual({ available: 1, returned: 1, offset: 0, nextOffset: null });
    expect(data.categories).toEqual([]);
    expect(data.tests).toHaveLength(1);
  });

  test("text is sent the way it was typed: digits are not made a number, and --name=value is split at its first = only", () => {
    const sentName = (...name: string[]) => {
      const search = box.cli(["directory-search", "--field", "101", "--category", "doctors", ...name], NO_SESSION);
      expect(search.code).toBe(0);
      return JSON.parse(box.fetches().pop()?.body).DocName;
    };
    expect(sentName("--name", "0071")).toBe("0071");
    expect(sentName("--name=--x=y")).toBe("--x=y");
  });

  test("a row keeps all that Maccabi sent in it, save the ID of the member it belongs to", () => {
    const [row] = signedIn("test-results").json().data.tests;
    for (const ownerField of ["member_id_code", "member_id"]) expect(row).not.toHaveProperty(ownerField);
    expect(row).toMatchObject({
      hash: "mock%2Fhash%3D%3D",
      result_files: null,
      doc_id: "assay-doc-3",
      request_id: "assay-req-3",
    });
  });

  test("a read that fails is exit 1 with stdout empty and, on stderr, one line of JSON with nothing in it that Maccabi sent", () => {
    const serverError = { match: "/prescriptions", text: TYPED, status: 500 };
    const failed = box.cli(["prescriptions"], { ...WITH_SESSION, overrides: { routes: [serverError] } });
    expect(failed.out).toBe("");
    expect(failed.code).toBe(1);
    const [line, afterLastNewline, ...more] = failed.err.split("\n");
    expect([afterLastNewline, more]).toEqual(["", []]);
    const error = {
      detail: "status=500",
      message: expect.any(String),
      code: "PORTAL_HTTP_ERROR",
      cause: "maccabi",
      retry: "once",
    };
    expect(JSON.parse(line as string)).toEqual({ error });
    expect(failed.err).not.toContain(TYPED);
    expect(failed.err).not.toMatch(/https?:|maccabi4u/);
  });
});

describe("a document goes to the file --out names", () => {
  const inBox = (name: string) => path.join(box.dir(), name);

  test("which is created, closed to others with mode 0600, and holds the document, while stdout has only its description", () => {
    const target = inBox("the-referral.pdf");
    const saved = signedIn("referral-pdf", "--id", "ref-1", "--out", target);
    expect(saved.err).toBe("");
    expect(saved.code).toBe(0);
    expect(saved.out).not.toContain("%PDF");
    const file = fs.statSync(target);
    expect(file.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(target, "latin1").slice(0, 5)).toBe("%PDF-");
    const { retrievedAt, source, ...rest } = saved.json();
    expect(rest).toEqual({ bytes: file.size, mimeType: "application/pdf", status: "saved" });
    expect(source).toMatchObject({ operation: "referral-pdf" });
    expect(retrievedAt).toEqual(expect.any(String));
  });

  test("an --out that cannot be written to is turned down, each kind under a code of its own, with no request for the document and no echo of the path", () => {
    const existing = "here-already.pdf";
    fs.writeFileSync(inBox(existing), "an earlier file");
    const unusable = [
      [existing, "OUT_EXISTS"],
      [path.join(TYPED, "new.pdf"), "OUT_DIR_MISSING"],
      [".", "OUT_IS_DIR"],
    ] as const;
    for (const [target, code] of unusable) {
      const refused = quiet(["sensitivities-pdf", "--out", target], WITH_SESSION);
      failure(refused, 1, code);
      expect(refused.err, target).not.toContain(TYPED);
    }
    // A refusal neither replaces the file that was there nor makes the directory that was not.
    expect(fs.existsSync(inBox(TYPED))).toBe(false);
    expect(fs.readFileSync(inBox(existing), "utf8")).toBe("an earlier file");
  });

  test("is not left behind, not even empty, when the document could not be had", () => {
    expect(box.cli(["sensitivities-pdf", "--out", "not-written.pdf"], NO_SESSION).code).toBe(3);
    expect(fs.existsSync(inBox("not-written.pdf"))).toBe(false);
  });
});

test("the fake was asked for nothing it does not know, and no socket was opened", () => {
  expect(box.unexpected()).toEqual([]);
});
