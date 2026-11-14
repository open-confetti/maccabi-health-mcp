/**
 * A sign-in from its first command to its last file, run through the built bundle against the fake
 * Maccabi, mostly on the command line and at the end over MCP. In order: the two steps and what each one
 * sends, the process a finished login starts, an ID with more than one phone, the single attempt an SMS
 * code gets, `status`, the two credential files and the directory they live in, a session Maccabi has
 * ended, `logout`, `keep-alive`, the MCP tools, the values on standard input, and the limit on SMS.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error the fake is plain JavaScript and has no type declarations
import { MARKERS } from "../fake/tags.mjs";
import {
  type CliResult,
  call,
  carriesNone,
  ID,
  MEMBER,
  merge,
  OTP,
  ROOT,
  type Route,
  type RunOptions,
  sandbox,
} from "../rig";

const box = sandbox("session");

const SESSION = "signed-in.json";
const PENDING = "sign-in-attempt.json";
const fileIn = (config: string, name: string) => path.join(box.configDir(config), name);
const stored = (config: string) => fs.readdirSync(box.configDir(config)).sort();
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const permissions = (target: string) => fs.statSync(target).mode & 0o777;

const requests = (fragment: string) => box.fetches().filter(({ url }) => url.includes(fragment));
/** Each request to this endpoint is one SMS on the member's phone. */
const smsSent = () => requests("/otp/generateV2").length;
const started = () => box.log().filter(({ kind }) => kind === "spawn");

/** One command under the config directory `config`. */
const run = (config: string, args: string[], more: RunOptions = {}) => box.cli(args, { ...more, config });
/** The same, for a command that has to manage without a single request. */
function runOffline(config: string, args: string[], more: RunOptions = {}): CliResult {
  const requestsBefore = box.fetches().length;
  const result = run(config, args, more);
  expect(box.fetches().length - requestsBefore, `requests by "${args.join(" ")}"`).toBe(0);
  return result;
}
const askForSms = (config: string, more?: RunOptions) => run(config, ["login", "--id", ID], more);
/** The first step, done: an SMS is out and the sign-in waits for its code. */
function awaitCode(config: string): void {
  expect(askForSms(config).code).toBe(0);
}
const finishQuietly = (config: string) => run(config, ["login", "--code", OTP, "--no-keep-alive"]);
const statusOf = (config: string) => run(config, ["status"]).json().status;

/** Checks the exit code and the error code of a command that failed, and returns its error. */
function failure(result: CliResult, exit: number, code: string) {
  const error = result.error();
  expect({ exit: result.code, code: error.code }).toEqual({ exit, code });
  return error;
}
const NO_SMS = "No SMS was sent.";

/** What Maccabi's lookup lists for the ID: one `[number, mobile, kosher]` per phone. */
type ListedPhone = [number: string, mobile?: boolean, kosher?: boolean];
function lookupListing(...listing: ListedPhone[]): { overrides: { routes: Route[] } } {
  const phones = listing.map(([number, mobile = true, kosher = false]) => ({ number, mobile, kosher }));
  return { overrides: { routes: [merge("/otp/detailsV2", { details: { phones } })] } };
}
const upstream = (...routes: Route[]): RunOptions => ({ overrides: { routes } });

describe("the two commands of a sign-in", () => {
  const config = "two-steps";

  test("the first, given --id, has one SMS sent and names the phone by its last digits", () => {
    const sentBefore = smsSent();
    const first = askForSms(config);
    expect(first.code).toBe(0);
    const { expiresInSeconds, ...rest } = first.json();
    expect(rest).toEqual({ phone: "ending 0001", status: "sms-sent" });
    expect(expiresInSeconds).toBeGreaterThan(590);
    expect(smsSent() - sentBefore).toBe(1);
  });

  test("the second, given --code, saves a session that the next command reads the account with", () => {
    const second = finishQuietly(config);
    expect(second.json()).toEqual({ keepAlive: false, status: "signed-in" });
    expect(second.code).toBe(0);
    expect(stored(config)).not.toContain(PENDING);
    expect(run(config, ["clinic-visits"]).code).toBe(0);
  });

  test("every request of the sign-in carries the token the previous answer issued", () => {
    const chain = [
      ["/infosec/auth", "origin"],
      ["/otp/detailsV2", "auth"],
      ["/otp/generateV2", "sender"],
      ["/otp/validate", "validator"],
      ["/infosec/response", "verified"],
    ];
    for (const [endpoint, issuedBy] of chain) {
      expect(requests(endpoint as string)[0]?.authorization, endpoint).toBe(`Bearer ${MARKERS.jwt}.${issuedBy}`);
    }
  });

  test("the portal gets the assertion together with its own cookie, and no sign-in token with it", () => {
    const [handover] = requests("/saml/sp/profile/post/acs");
    expect(handover?.authorization).toBe("");
    expect(handover?.cookie).toContain(`preauth=${MARKERS.preauthCookie}`);
    expect(new URLSearchParams(handover?.body).get("SAMLResponse")).toBe(MARKERS.saml);
  });

  test("a zero typed in front of the ID is not sent, and neither is a password", () => {
    expect(run("zero-in-front", ["login", "--id", `0${ID}`]).json().status).toBe("sms-sent");
    const sent = requests("/infosec/auth").pop()?.body;
    expect(JSON.parse(sent)).toEqual({ type: "none", password: "", id: `0-${ID}` });
  });

  test("--id together with --code is a usage error, and nothing is sent or stored", () => {
    const both = runOffline("both-flags", ["login", "--id", ID, "--code", OTP]);
    failure(both, 2, "BAD_INPUT");
    expect(both.err).not.toContain(OTP);
    expect(fs.existsSync(box.configDir("both-flags"))).toBe(false);
  });

  test("the two values may come as MACCABI_ID and MACCABI_OTP, and an ID still exported at the second step is ignored", () => {
    const config = "from-environment";
    expect(run(config, ["login"], { env: { MACCABI_ID: ID } }).json().status).toBe("sms-sent");
    const second = run(config, ["login", "--no-keep-alive"], { env: { MACCABI_OTP: OTP, MACCABI_ID: ID } });
    expect(second.json().status).toBe("signed-in");
  });

  test("a flag decides which step runs, even with the other step's variable set", () => {
    const config = "flag-over-variable";
    expect(askForSms(config, { env: { MACCABI_OTP: OTP } }).json().status).toBe("sms-sent");
    const second = run(config, ["login", "--code", OTP, "--no-keep-alive"], { env: { MACCABI_ID: ID } });
    expect(second.json().status).toBe("signed-in");
  });

  test("an ID with anything but digits in it is turned down without a request", () => {
    const typed = "4071x";
    const refused = runOffline("not-digits", ["login", "--id", typed]);
    expect(failure(refused, 2, "BAD_INPUT").message).toContain(NO_SMS);
    expect(refused.err).not.toContain(typed);
  });

  test("a bare login with no terminal to ask on is exit 3 NO_TERMINAL, and nothing is sent or stored", () => {
    const refused = runOffline("no-terminal", ["login"]);
    const { message } = failure(refused, 3, "NO_TERMINAL");
    expect(message).toContain(NO_SMS);
    expect(message).toContain("login --id DIGITS");
    expect(refused.out).toBe("");
    expect(fs.existsSync(box.configDir("no-terminal"))).toBe(false);
  });

  test("when Maccabi cannot look the ID up just now, the failure comes before any SMS and says so", () => {
    const sentBefore = smsSent();
    const lookup = askForSms("lookup-down", { scenario: "id-lookup-down" });
    expect(failure(lookup, 1, "ID_LOOKUP_FAILED").message).toContain(NO_SMS);
    expect(smsSent()).toBe(sentBefore);
  });

  test.each<[string, RunOptions]>([
    ["a landline and nothing else", { scenario: "landline-only" }],
    ["no list of phones", upstream(merge("/otp/detailsV2", { details: { phones: null } }))],
  ])("an ID with %s has no phone for an SMS, so it is refused and no sign-in is left open", (_what, lookup) => {
    const sentBefore = smsSent();
    failure(askForSms("nowhere-to-send", lookup), 1, "NO_SMS_PHONE");
    expect(smsSent()).toBe(sentBefore);
    expect(stored("nowhere-to-send")).toEqual([]);
  });

  const oddPhone = { kosher: false, mobile: "yes", number: "0500000001" };
  test.each<[string, Route, string]>([
    ["the sign-in page cannot be had", { match: "/login?", status: 503 }, "SIGN_IN_PAGE_DOWN"],
    ["the sign-in page has no token in it", { match: "/login?", text: "<html>empty</html>" }, "SIGN_IN_PAGE_CHANGED"],
    ["the first answer brings no token", merge("/infosec/auth", { jwt: "" }), "SIGN_IN_ANSWER_CHANGED"],
    ["the member lookup answers with a list", { match: "/otp/detailsV2", json: [] }, "SIGN_IN_ANSWER_CHANGED"],
    [
      "a phone comes in an unknown shape",
      merge("/otp/detailsV2", { details: { phones: [oddPhone] } }),
      "SIGN_IN_ANSWER_CHANGED",
    ],
    [
      "Maccabi does not let this member sign in online",
      merge("/otp/detailsV2", { details: { digitalUser: false } }),
      "SIGN_IN_NOT_OFFERED",
    ],
  ])("when %s, the error says so, no SMS goes out and no sign-in is left open", (_what, change, code) => {
    const sentBefore = smsSent();
    failure(askForSms("upstream-changed", upstream(change)), 1, code);
    expect(smsSent()).toBe(sentBefore);
    expect(stored("upstream-changed")).toEqual([]);
  });
});

describe("the process a finished login leaves behind", () => {
  test("is this Node on this bundle as keep-alive, detached, with none of the login's secrets passed on", () => {
    awaitCode("renewing");
    const startedBefore = started().length;
    const env = { GH_TOKEN: "mock-github-token", SOME_SECRET: "mock-secret-value", MACCABI_OTP: OTP };
    expect(run("renewing", ["login"], { env }).json()).toEqual({ keepAlive: true, status: "signed-in" });
    const children = started().slice(startedBefore);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      inherited: [],
      detached: true,
      args: [box.bundle(), "keep-alive"],
      file: process.execPath,
    });
  });

  test("does not exist after --no-keep-alive", () => {
    awaitCode("not-renewing");
    const startedBefore = started().length;
    expect(finishQuietly("not-renewing").json()).toEqual({ keepAlive: false, status: "signed-in" });
    expect(started()).toHaveLength(startedBefore);
  });
});

describe("an ID that has several phones", () => {
  const config = "several-phones";
  const several: RunOptions = { scenario: "phones" };
  const lastSmsRequest = () => requests("/otp/generateV2").pop()?.url;

  test("gets a list of the ones an SMS can reach, each with its option number, and no SMS yet", () => {
    const sentBefore = smsSent();
    const listed = askForSms(config, several);
    expect(listed.code).toBe(0);
    const { expiresInSeconds, ...rest } = listed.json();
    expect(expiresInSeconds).toEqual(expect.any(Number));
    expect(rest).toEqual({
      phones: [
        { label: "Phone ending 0001", option: 1 },
        { label: "Phone ending 0002", option: 3 },
      ],
      status: "phone-required",
    });
    expect(smsSent()).toBe(sentBefore);
  });

  test("turns down a code while no phone is chosen, without trying the code", () => {
    const early = runOffline(config, ["login", "--code", OTP], several);
    expect(early.error().code).toBe("CHOOSE_A_PHONE");
    expect(early.code).not.toBe(0);
  });

  test("has its one SMS sent to the phone that --phone picks", () => {
    const sentBefore = smsSent();
    const chosen = run(config, ["login", "--id", ID, "--phone", "3"], several);
    expect(chosen.json()).toMatchObject({ phone: "ending 0002", status: "sms-sent" });
    expect(smsSent() - sentBefore).toBe(1);
    // Maccabi counts its phones from zero, so the third option is its number 2.
    expect(lastSmsRequest()).toContain("phone=2");
  });

  test("sees a phone as Maccabi masked it, as a position when it shows no digits, and with its option when two end the same", () => {
    const masks = lookupListing(["05*-****000"], [""], ["0500000005"], ["0550000005"]);
    expect(askForSms("phone-labels", masks).json().phones).toEqual([
      { label: "Phone 05*-****000", option: 1 },
      { label: "Phone 2", option: 2 },
      { label: "Phone ending 0005 (option 3)", option: 3 },
      { label: "Phone ending 0005 (option 4)", option: 4 },
    ]);
  });

  test("is offered a phone that is listed twice once, where it first stands, and a kosher phone not at all", () => {
    const repeated: ListedPhone = ["0500000001"];
    const listing = lookupListing(["030000000", false], repeated, repeated, ["0500000002", true, true], ["0500000003"]);
    expect(askForSms("phone-repeats", listing).json().phones).toEqual([
      { label: "Phone ending 0001", option: 2 },
      { label: "Phone ending 0003", option: 5 },
    ]);
  });

  test("needs no choice when a single phone can take an SMS, whatever its place in the list", () => {
    const sent = askForSms("phone-after-landline", lookupListing(["030000000", false], ["0500000003"]));
    expect(sent.json()).toMatchObject({ phone: "ending 0003", status: "sms-sent" });
    expect(lastSmsRequest()).toContain("phone=1");
  });

  test("is told BAD_PHONE_OPTION, exit 2, for an option that was not on the list, and gets no SMS", () => {
    const sentBefore = smsSent();
    const landline = run(config, ["login", "--id", ID, "--phone", "2"], several);
    expect(failure(landline, 2, "BAD_PHONE_OPTION").message).toContain(NO_SMS);
    expect(smsSent()).toBe(sentBefore);
  });
});

describe("the single attempt an SMS code gets", () => {
  const tryCode = (config: string, more?: RunOptions) => run(config, ["login", "--code", OTP], more);

  test("a code Maccabi calls wrong is exit 3 CODE_REJECTED, and the sign-in that waited for it is gone", () => {
    awaitCode("wrong-code");
    const sentBefore = smsSent();
    const rejected = tryCode("wrong-code", { scenario: "code-refused" });
    failure(rejected, 3, "CODE_REJECTED");
    expect(rejected.err).not.toContain(OTP);
    expect(stored("wrong-code")).toEqual([]);
    expect(smsSent()).toBe(sentBefore);
  });

  test("another code after that one is exit 3 NOTHING_TO_VERIFY and never reaches Maccabi", () => {
    const second = runOffline("wrong-code", ["login", "--code", OTP]);
    failure(second, 3, "NOTHING_TO_VERIFY");
    expect(second.out).toBe("");
  });

  test.each([
    [302, "CODE_EXPIRED"],
    [304, "SIGN_IN_BLOCKED"],
  ])("Maccabi's code %i for a refused SMS code is exit 3 %s, and it too ends the sign-in", (theirs, ours) => {
    awaitCode("code-refused");
    const refusal: Route = { match: "/otp/validate", json: { code: theirs, status: "error" }, status: 400 };
    failure(tryCode("code-refused", upstream(refusal)), 3, ours);
    expect(stored("code-refused")).not.toContain(PENDING);
  });

  const redirectTo = (match: string, location: string): Route => ({
    match,
    status: 302,
    headers: { location },
    text: "",
  });
  test.each<[string, Route[], number, string]>([
    [
      "is to be handed to some other destination",
      [merge("/infosec/response", { destination: "https://invalid.example/not-the-portal" })],
      1,
      "HANDOFF_CHANGED",
    ],
    [
      "comes with an assertion that is not text",
      [merge("/infosec/response", { payload: { SAMLResponse: 7 } })],
      1,
      "HANDOFF_CHANGED",
    ],
    [
      "ends on a page other than the portal's home, with or without a session cookie",
      [redirectTo("=/", "/some-other-page"), { match: "/some-other-page", text: "<html>elsewhere</html>" }],
      3,
      "SESSION_NOT_OPENED",
    ],
    ["is cut off by Maccabi ahead of the first read", [redirectTo("/token/full", "/my.policy")], 3, "SIGN_IN_NEEDED"],
  ])("a code that is accepted leaves no session behind when the sign-in %s", (_what, routes, exit, code) => {
    awaitCode("accepted-but");
    failure(tryCode("accepted-but", upstream(...routes)), exit, code);
    expect(stored("accepted-but")).toEqual([]);
    expect(requests("invalid.example")).toEqual([]);
  });

  test("a code of the wrong length is exit 2 and costs nothing: the sign-in still takes the right one", () => {
    awaitCode("short-code");
    failure(runOffline("short-code", ["login", "--code", OTP.slice(1)]), 2, "BAD_CODE");
    expect(stored("short-code")).toEqual([PENDING]);
    expect(finishQuietly("short-code").json().status).toBe("signed-in");
  });

  test("ten minutes on, a sign-in takes no code any more, and its file goes when one is tried", () => {
    awaitCode("too-late");
    const pending = fileIn("too-late", PENDING);
    fs.writeFileSync(pending, JSON.stringify({ ...readJson(pending), endsAt: Date.now() - 1_000 }));
    expect(runOffline("too-late", ["login", "--code", OTP]).error().code).toBe("NOTHING_TO_VERIFY");
    expect(fs.existsSync(pending)).toBe(false);
    expect(statusOf("too-late")).toBe("signed-out");
  });
});

describe("status", () => {
  const config = "status";
  const offline = (name: string) => runOffline(name, ["status"]);
  const verify = (more?: RunOptions) => run(config, ["status", "--verify"], more);

  test("says signed-out where nothing is stored, and stores nothing by asking", () => {
    const nothing = offline("status-of-nothing");
    expect(nothing.json()).toEqual({ verified: false, status: "signed-out" });
    expect(nothing.code).toBe(0);
    expect(fs.existsSync(box.configDir("status-of-nothing"))).toBe(false);
  });

  test("says pending-login for as long as a code is expected", () => {
    awaitCode(config);
    const { expiresInSeconds, ...rest } = offline(config).json();
    expect(rest).toEqual({ verified: false, smsSent: true, status: "pending-login" });
    expect(expiresInSeconds).toBeGreaterThan(590);
  });

  test("says signed-in on the strength of the saved file, with no request", () => {
    finishQuietly(config);
    expect(offline(config).json()).toEqual({ verified: false, status: "signed-in" });
  });

  test("asks Maccabi once when given --verify", () => {
    const asked = () => requests("/token/full").length;
    const askedBefore = asked();
    expect(verify().json()).toEqual({ verified: true, status: "signed-in" });
    expect(asked() - askedBefore).toBe(1);
  });

  test("given --verify for a session that is dead at its first request, is exit 3 SIGN_IN_NEEDED and removes it", () => {
    failure(verify({ scenario: "expired" }), 3, "SIGN_IN_NEEDED");
    expect(stored(config)).not.toContain(SESSION);
  });

  test("takes the session's deadline from F5's cookie and shows the time and nothing else of it", () => {
    box.signIn({ config: "deadline-past", scenario: "f5" });
    const past = offline("deadline-past");
    // The fake dates this session to the middle of 2025, so no request is needed to call it expired.
    expect(past.json()).toEqual({ verified: false, expiresAt: "2025-07-01T01:00:00.000Z", status: "expired" });
    expect(past.out).not.toContain("1751328000");
  });

  test("shows a deadline that is still to come along with signed-in", () => {
    box.signIn({ config: "deadline-ahead", scenario: "f5-live" });
    const ahead = offline("deadline-ahead").json();
    const minutesLeft = (Date.parse(ahead.expiresAt) - Date.now()) / 60_000;
    expect(minutesLeft).toBeLessThanOrEqual(60);
    expect(minutesLeft).toBeGreaterThan(55);
    expect(ahead.status).toBe("signed-in");
  });
});

describe("the two files that hold credentials", () => {
  const config = "files";
  const session = fileIn.bind(null, config, SESSION);
  const NOT_A_SESSION = "{ no session in here";

  test("a waiting sign-in is sign-in-attempt.json alone, mode 0600, in a directory of mode 0700", () => {
    awaitCode(config);
    expect(stored(config)).toEqual([PENDING]);
    expect(permissions(fileIn(config, PENDING))).toBe(0o600);
    expect(permissions(box.configDir(config))).toBe(0o700);
  });

  test("it records which member it was opened for, and the ID appears nowhere else in it", () => {
    const { member, ...everythingElse } = readJson(fileIn(config, PENDING));
    carriesNone(everythingElse, [ID]);
    expect(member).toBe(MEMBER);
  });

  test("the finished sign-in is signed-in.json alone, with the same modes", () => {
    finishQuietly(config);
    expect(stored(config)).toEqual([SESSION]);
    expect(permissions(session())).toBe(0o600);
    expect(permissions(box.configDir(config))).toBe(0o700);
  });

  test("it holds a session and its owner, without the SMS code and without the ID outside the owner", () => {
    const saved = readJson(session());
    expect(Object.keys(saved).sort()).toEqual(["owner", "session"]);
    expect(saved.owner).toEqual({ memberIdCode: "0", memberId: MEMBER });
    const cookieNames = saved.session.jar.cookies.map(({ key }: { key: string }) => key);
    expect(cookieNames).toContain("MRHSession");
    carriesNone(saved.session, [OTP, ID]);
    // What the sign-in itself ran on is spent and not kept: neither a token of its steps nor the assertion.
    carriesNone(saved, [MARKERS.saml, MARKERS.jwt]);
  });

  test("reading it closes it to everyone else again, should it have been left readable", () => {
    fs.chmodSync(session(), 0o644);
    expect(statusOf(config)).toBe("signed-in");
    expect(permissions(session())).toBe(0o600);
  });

  test("a session file that is not JSON makes a read and status exit 3 DAMAGED_SESSION without a request", () => {
    fs.mkdirSync(box.configDir("not-json"));
    fs.writeFileSync(fileIn("not-json", SESSION), NOT_A_SESSION);
    for (const command of ["status", "clinic-visits"]) {
      const damaged = runOffline("not-json", [command]);
      expect(failure(damaged, 3, "DAMAGED_SESSION").message, command).toContain("sign in again");
      expect(damaged.err, command).not.toContain(box.dir());
    }
    expect(run("not-json", ["logout"]).code).toBe(0);
  });

  test("so does one that is JSON but not a session with its owner", () => {
    // A true session, stripped of the owner it was saved with.
    const { session: ownerless } = readJson(session());
    fs.mkdirSync(box.configDir("ownerless"));
    fs.writeFileSync(fileIn("ownerless", SESSION), JSON.stringify({ session: ownerless }));
    failure(runOffline("ownerless", ["clinic-visits"]), 3, "DAMAGED_SESSION");
  });

  test("a damaged sign-in-attempt.json is DAMAGED_SESSION when a code arrives, and gives way to the next sign-in", () => {
    const config = "pending-damaged";
    awaitCode(config);
    const pending = fileIn(config, PENDING);
    fs.writeFileSync(pending, JSON.stringify({ ...readJson(pending), format: 2 }));
    failure(runOffline(config, ["login", "--code", OTP]), 3, "DAMAGED_SESSION");
    awaitCode(config);
    expect(statusOf(config)).toBe("pending-login");
  });

  test("a damaged session file gives way to the next sign-in as well", () => {
    fs.writeFileSync(session(), NOT_A_SESSION);
    box.signIn({ config });
    expect(statusOf(config)).toBe("signed-in");
  });
});

describe("the directory the two files live in", () => {
  const TOOL = "maccabi-health";
  const inBox = (...parts: string[]) => path.join(box.dir(), ...parts);
  /** Options that blank MACCABI_CONFIG_DIR, which leaves the tool to derive the directory from the rest. */
  const unconfigured = (env: Record<string, string> = {}): RunOptions => ({ env: { ...env, MACCABI_CONFIG_DIR: "" } });
  const startIn = (options: RunOptions) => expect(box.cli(["login", "--id", ID], options).code).toBe(0);

  test("is XDG_CONFIG_HOME/maccabi-health when MACCABI_CONFIG_DIR is not set", () => {
    startIn(unconfigured({ XDG_CONFIG_HOME: inBox("xdg") }));
    expect(fs.readdirSync(inBox("xdg", TOOL))).toEqual([PENDING]);
  });

  test("is ~/.config/maccabi-health when that is not set either", () => {
    startIn(unconfigured());
    expect(fs.readdirSync(inBox(".config", TOOL))).toEqual([PENDING]);
  });

  test("is closed to others, mode 0700, if it carries the tool's own name and was open", () => {
    const own = inBox("xdg-entered-by-all", TOOL);
    fs.mkdirSync(own, { recursive: true });
    fs.chmodSync(own, 0o755);
    startIn(unconfigured({ XDG_CONFIG_HOME: path.dirname(own) }));
    expect(permissions(own)).toBe(0o700);
  });

  test("keeps the mode it has under any other name, as a shared MACCABI_CONFIG_DIR would have", () => {
    fs.mkdirSync(box.configDir("shared"));
    fs.chmodSync(box.configDir("shared"), 0o755);
    awaitCode("shared");
    expect(permissions(fileIn("shared", PENDING))).toBe(0o600);
    expect(permissions(box.configDir("shared"))).toBe(0o755);
  });

  test.each(["logout", "clinic-visits"])(
    "when it cannot be used at all, %s is exit 1 STORAGE_UNAVAILABLE and neither names a path nor sends a request",
    (command) => {
      fs.writeFileSync(inBox("plain-file"), "");
      const below = { env: { MACCABI_CONFIG_DIR: inBox("plain-file", "config") } };
      const unusable = runOffline("unused", [command], below);
      const { message } = failure(unusable, 1, "STORAGE_UNAVAILABLE");
      expect(message).toContain("permissions of the config directory");
      expect(unusable.err).not.toContain(box.dir());
    },
  );

  test("when it lists as empty and still cannot be written, a sign-in stops short of the SMS", () => {
    fs.symlinkSync(inBox("missing", "target"), inBox("dangling-link"));
    const unwritable = { env: { MACCABI_CONFIG_DIR: inBox("dangling-link") } };
    failure(runOffline("unused", ["login", "--id", ID], unwritable), 1, "STORAGE_UNAVAILABLE");
  });

  test("a signed-in.json that exists and cannot be read is STORAGE_UNAVAILABLE rather than a damaged session", () => {
    fs.mkdirSync(fileIn("a-directory-for-a-file", SESSION), { recursive: true });
    expect(runOffline("a-directory-for-a-file", ["status"]).error().code).toBe("STORAGE_UNAVAILABLE");
  });
});

describe("a session Maccabi has ended", () => {
  test("shows as F5's redirect on a read, which is exit 3 SIGN_IN_NEEDED and the end of signed-in.json", () => {
    const config = "ended";
    box.signIn({ config });
    const sentBefore = smsSent();
    // What F5 does with a request of a session it no longer knows.
    const turnedAway: Route = { match: "/prescriptions", headers: { location: "/my.policy" }, status: 302 };
    const read = run(config, ["prescriptions"], upstream(turnedAway));
    const { message } = failure(read, 3, "SIGN_IN_NEEDED");
    expect(message).toContain("login --id DIGITS");
    expect(message).toContain("it was removed");
    expect(read.out).toBe("");
    expect(stored(config)).toEqual([]);
    // The tool says what happened and stops there. Asking for a new SMS is the member's decision.
    expect(smsSent()).toBe(sentBefore);
  });
});

describe("logout", () => {
  const SIGNED_OUT = { status: "signed-out" };

  test("deletes a session and a waiting sign-in alike, and asks Maccabi nothing", () => {
    box.signIn({ config: "leaving" });
    awaitCode("leaving");
    expect(stored("leaving")).toEqual([PENDING, SESSION]);
    const left = runOffline("leaving", ["logout"]);
    expect(left.json()).toEqual(SIGNED_OUT);
    expect(left.code).toBe(0);
    expect(stored("leaving")).toEqual([]);
  });

  test("succeeds all the same when there was nothing to delete", () => {
    const left = runOffline("never-signed-in", ["logout"]);
    expect(left.json()).toEqual(SIGNED_OUT);
    expect(left.code).toBe(0);
  });
});

describe("keep-alive", () => {
  const config = "keep-alive";

  /** `keep-alive` as a process the test does not wait for, so that things can happen while it renews. */
  function renewer(scenario = "normal", routes: Route[] = []) {
    const preload = path.join(ROOT, "test", "fake", "maccabi.mjs");
    const child = spawn(process.execPath, ["--import", preload, box.bundle(), "keep-alive"], {
      env: box.env({ config, scenario, overrides: { routes } }),
      stdio: ["ignore", "pipe", "ignore"],
      cwd: box.dir(),
    });
    const printed: string[] = [];
    child.stdout.on("data", (chunk) => printed.push(String(chunk)));
    const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
    const isRenewing = () => box.fetches().some(({ pid, url }) => pid === child.pid && url.endsWith("/alive"));
    return {
      stop: () => child.kill(),
      interrupt: () => child.kill("SIGTERM"),
      /** Resolves once the process has sent its first renewal, which it does right after starting. */
      async renewing(): Promise<void> {
        for (let tries = 0; tries < 100 && !isRenewing(); tries += 1) await sleep(50);
        expect(isRenewing()).toBe(true);
      },
      /** Its exit code must be 0. Returns the one line of JSON it printed. */
      async report(): Promise<unknown> {
        expect(await exit).toBe(0);
        return JSON.parse(printed.join(""));
      },
    };
  }

  // The three renewals below share one sign-in. Two of them leave the session alone and the last ends it.
  beforeAll(() => box.signIn({ config }));

  test("ends at once as signed-out, without a request, where no session is stored", () => {
    const idle = runOffline("keep-alive-of-nothing", ["keep-alive"]);
    expect(idle.json()).toEqual({ renewals: 0, status: "signed-out" });
    expect(idle.code).toBe(0);
  });

  test("ends as interrupted, with the one renewal it made, when stopped between two renewals", async () => {
    const keeper = renewer();
    try {
      await keeper.renewing();
      keeper.interrupt();
      expect(await keeper.report()).toEqual({ renewals: 1, status: "interrupted" });
      expect(statusOf(config)).toBe("signed-in");
    } finally {
      keeper.stop();
    }
  });

  test("does not count a renewal that Maccabi answers with an error, nor let it touch the session", async () => {
    const keeper = renewer("normal", [{ match: "/alive", text: "", status: 500 }]);
    try {
      await keeper.renewing();
      keeper.interrupt();
      expect(await keeper.report()).toEqual({ renewals: 0, status: "interrupted" });
      expect(statusOf(config)).toBe("signed-in");
    } finally {
      keeper.stop();
    }
  });

  test("ends by itself, and writes no session back, when logout comes while a renewal is on its way", async () => {
    const keeper = renewer("slow-renewal");
    try {
      await keeper.renewing();
      expect(run(config, ["logout"]).code).toBe(0);
      expect(await keeper.report()).toEqual({ renewals: 0, status: "signed-out" });
      expect(stored(config)).toEqual([]);
    } finally {
      keeper.stop();
    }
  });
});

describe("the MCP sign-in tools share their files with the command line", () => {
  const config = "over-mcp";
  const server = () => box.mcp({ config });
  type Server = Awaited<ReturnType<typeof server>>;
  /** The structured result of one tool call. */
  const tool = async (client: Server, name: string, args?: Record<string, unknown>) =>
    (await call(client, name, args)).structuredContent;

  test("maccabi_login_start has one SMS sent, after which the tool and the CLI both see a sign-in waiting", async () => {
    const client = await server();
    const sentBefore = smsSent();
    const { expiresInSeconds, ...rest } = await tool(client, "maccabi_login_start", { id: ID });
    expect(rest).toEqual({ phone: "ending 0001", status: "sms-sent" });
    expect(expiresInSeconds).toEqual(expect.any(Number));
    expect(smsSent() - sentBefore).toBe(1);

    const waiting = { smsSent: true, expiresInSeconds: expect.any(Number), status: "pending-login" };
    expect(await tool(client, "maccabi_status")).toEqual(waiting);
    expect(run(config, ["status"]).json()).toEqual({ verified: false, ...waiting });
    expect(permissions(fileIn(config, PENDING))).toBe(0o600);
  });

  test("maccabi_login_verify completes it, and the session it saves serves a CLI read", async () => {
    const client = await server();
    const signedIn = { status: "signed-in" };
    expect(await tool(client, "maccabi_login_verify", { code: OTP })).toEqual(signedIn);
    expect(await tool(client, "maccabi_status")).toEqual(signedIn);
    expect(stored(config)).toEqual([SESSION]);
    expect(permissions(box.configDir(config))).toBe(0o700);
    expect(permissions(fileIn(config, SESSION))).toBe(0o600);
    expect(run(config, ["clinic-visits"]).code).toBe(0);
  });

  test("maccabi_logout deletes the files with no request made, which signs the CLI out too", async () => {
    const client = await server();
    const requestsBefore = box.fetches().length;
    expect(await tool(client, "maccabi_logout")).toEqual({ status: "signed-out" });
    expect(box.fetches()).toHaveLength(requestsBefore);
    expect(stored(config)).toEqual([]);
    expect(statusOf(config)).toBe("signed-out");
  });

  test("a server that is already running loses its session when the CLI logs out", async () => {
    const client = await server();
    const visits = () => call(client, "maccabi_read", { operation: "clinic-visits" });
    await tool(client, "maccabi_login_start", { id: ID });
    await tool(client, "maccabi_login_verify", { code: OTP });
    expect((await visits()).isError).not.toBe(true);
    run(config, ["logout"]);
    expect((await visits()).structuredContent.error.code).toBe("SIGN_IN_NEEDED");
  });

  test("for several phones maccabi_login_start returns the options, and an SMS goes out only for a valid choice", async () => {
    const client = await box.mcp({ scenario: "phones", config: "over-mcp-phones" });
    const start = (phone?: number) => tool(client, "maccabi_login_start", phone ? { id: ID, phone } : { id: ID });
    const sentBefore = smsSent();
    expect(await start()).toMatchObject({ phones: [{ option: 1 }, { option: 3 }], status: "phone-required" });
    expect(await tool(client, "maccabi_status")).toMatchObject({ smsSent: false, status: "pending-login" });
    expect((await start(2)).error.code).toBe("BAD_PHONE_OPTION");
    expect(smsSent()).toBe(sentBefore);
    expect(await start(3)).toMatchObject({ phone: "ending 0002", status: "sms-sent" });
    expect(smsSent() - sentBefore).toBe(1);
  });
});

describe("the ID and the code on standard input", () => {
  test("sign in through --id-stdin and --code-stdin, so that neither argv nor the environment holds them", () => {
    const first = run("piped", ["login", "--id-stdin"], { input: `${ID}\n` });
    expect(first.json().status).toBe("sms-sent");
    const second = run("piped", ["login", "--no-keep-alive", "--code-stdin"], { input: `${OTP}\n` });
    expect(second.json().status).toBe("signed-in");
  });

  test("cannot both be read in one command: that is a usage error, and no SMS goes out", () => {
    const sentBefore = smsSent();
    const both = run("piped-twice", ["login", "--id-stdin", "--code-stdin"], { input: `${ID}\n` });
    expect(both.code).toBe(2);
    expect(smsSent()).toBe(sentBefore);
  });
});

describe("a client that calls the sign-in tool over and over", () => {
  const startStatus = async (client: Awaited<ReturnType<typeof box.mcp>>) =>
    (await call(client, "maccabi_login_start", { id: ID })).structuredContent.status;

  test("gets three starts within ten minutes, and the fourth is refused before its SMS", async () => {
    const client = await box.mcp({ config: "sms-three-times" });
    for (const nth of ["first", "second", "third"])
      expect(await startStatus(client), `the ${nth} start`).toBe("sms-sent");
    const sentBefore = smsSent();
    const fourth = await call(client, "maccabi_login_start", { id: ID });
    expect(fourth.structuredContent.error).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    expect(fourth.structuredContent.error.message).toContain("No SMS was sent");
    expect(fourth.isError).toBe(true);
    expect(smsSent()).toBe(sentBefore);
  });

  test("is not held to that limit by sign-ins that were completed", async () => {
    const client = await box.mcp({ config: "sms-then-code" });
    for (const nth of ["first", "second", "third", "fourth"]) {
      expect(await startStatus(client), `the ${nth} start`).toBe("sms-sent");
      const verified = await call(client, "maccabi_login_verify", { code: OTP });
      expect(verified.structuredContent.status).toBe("signed-in");
    }
  });
});

test("none of this needed a request the fake does not know, or a socket", () => {
  expect(box.unexpected()).toEqual([]);
});
