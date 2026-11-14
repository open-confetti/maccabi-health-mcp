/**
 * Before any member read the tool asks Maccabi who is signed in and for the API token. These tests feed
 * the built bundle bootstraps that are wrong in one way each: another member selected or signed in, no
 * usable token, a changed field, a page instead of JSON. They also cover what the bootstrap seeds for
 * the legacy pages, how a session is renewed, and which of the failures ask the reader to report them,
 * which only a defect of this client should.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { bootstrap, ID, memberSession, type Route, SOMEONE_ELSE } from "../rig";

/** Text the tests put on upstream pages. No error may repeat it. */
const PAGE_TEXT = "MOCKPAGETEXT93";
const { box, start, signIn, ok, fails, expired, last, query, count } = memberSession("bootstrap", [PAGE_TEXT]);

const TOKEN = "/token/full";
const ALIVE = "/alive";
const PORTAL = "https://online.maccabi4u.co.il";
/** How a message ends when the failure points at a defect in this client. */
const REPORT = "tell this tool's maintainers which operation it was";
/** Any read does for a bootstrap test, since every one of them starts with the bootstrap. */
const failsToRead = (route: Route, code: string, detail?: string) => fails("test-results", {}, [route], code, detail);
/** A rule that puts `text` where the bootstrap should be. */
const inItsPlace = (text: string, more: Partial<Route> = {}): Route => ({ ...more, match: TOKEN, text });

const sessionFile = () => path.join(box.configDir("bootstrap"), "signed-in.json");

test("signing in", start);

describe("who the bootstrap is about", () => {
  test("another member selected in the portal gets a code of its own, not the one for an expired session", async () => {
    const dependent = bootstrap({ current_customer_info: { member_id: SOMEONE_ELSE } });
    await failsToRead(dependent, "OTHER_MEMBER_SELECTED");
  });

  test("another member signed in than the one saved is refused, and it makes no difference who is selected", async () => {
    const someoneElse = { member_id: SOMEONE_ELSE };
    const swapped = bootstrap({ current_customer_info: someoneElse, logged_customer_info: someoneElse });
    await failsToRead(swapped, "NOT_THE_MEMBERS", "saved-member-differs");
    await signIn();
  });
});

describe("the token that comes with it", () => {
  test.each([
    ["marked as failed", { content: "x", success: false }],
    ["empty", { content: "", success: true }],
  ])("a token %s is NO_PORTAL_TOKEN", async (_what, token) => {
    await failsToRead(bootstrap({ token }), "NO_PORTAL_TOKEN");
  });

  test("a token with a line break in it, which would add a header of its own, is refused", async () => {
    const token = { content: "mock\r\nx-smuggled: 1", success: true };
    await failsToRead(bootstrap({ token }), "BAD_API_TOKEN");
  });
});

describe("a bootstrap that is not what it used to be", () => {
  test.each([
    ["the member's id code", { logged_customer_info: { member_id_code: "x" } }, "key:member_id"],
    ["a name", { logged_customer_info: { f_name_hebrew: 7 } }, "key:f_name_hebrew"],
    ["the token object", { token: "x" }, "key:token"],
  ])("a change to %s is reported by the name of the field", async (_what, patch, detail) => {
    await failsToRead(bootstrap(patch), "UNEXPECTED_ANSWER", detail);
  });

  test("a body that claims to be JSON and does not parse is a gap in this client", async () => {
    const broken = inItsPlace("{broken json", { headers: { "content-type": "application/json" } });
    await failsToRead(broken, "UNEXPECTED_ANSWER", "body-not-json-or-oversized");
  });

  test.each([
    ["under F5's name", "<html><title>F5 access policy</title><body>Your session timed out.</body></html>"],
    ["with a form for its policy check", '<html><body><form method="post" action="/my.policy"></form></body></html>'],
  ])("a logon page %s in its place means the session has run out", async (_how, logonPage) => {
    await expired("test-results", {}, [inItsPlace(logonPage)]);
  });
});

describe("which failures ask to be reported", () => {
  test("a page nobody has seen before does, without a word of the page", async () => {
    const unknown = inItsPlace(`<html><body>the portal is being serviced ${PAGE_TEXT}</body></html>`);
    const { message } = await failsToRead(unknown, "UNEXPECTED_ANSWER", "html-where-json");
    expect(message).toContain(REPORT);
  });

  test("a portal that is failing does not, because that is no defect here", async () => {
    const unavailable = inItsPlace(PAGE_TEXT, { status: 503 });
    const { message } = await failsToRead(unavailable, "PORTAL_HTTP_ERROR", "status=503");
    expect(message).not.toContain(REPORT);
  });

  test("an id missing from the fresh list does not either; the message says what to do instead", async () => {
    const { message } = await fails("referral-pdf", { id: "no-such-referral" }, [], "NOT_THE_MEMBERS");
    expect(message).not.toContain(REPORT);
  });
});

describe("the navigation cookie that opens a legacy page", () => {
  /** The legacy pages want a cookie whose value the bootstrap seeds with its `session_id`. */
  const LEGACY_PAGE = "/online/medicalfile/summary/";
  const seededWith = (session_id: string) => bootstrap({ session_id });
  const sentSeed = () => query(LEGACY_PAGE).sr_id;
  function savedCookie(): Record<string, any> | undefined {
    const saved = JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
    const cookies: Record<string, any>[] = saved.session.jar.cookies;
    return cookies.find(({ key }) => key === `cookie_sessionId_0_${ID}`);
  }

  test("is neither stored nor used when the seed could not be a cookie value", async () => {
    await fails("medical-summary", {}, [seededWith("mock; smuggled=value")], "BAD_NAVIGATION_SEED");
    expect(savedCookie()).toBeUndefined();
    expect(count(LEGACY_PAGE)).toBe(0);
  });

  test("is stored secure, for the portal's host alone and without a lifetime beyond the session", async () => {
    await ok("medical-summary");
    const cookie = savedCookie();
    expect(cookie).toMatchObject({
      value: sentSeed(),
      secure: true,
      hostOnly: true,
      domain: "online.maccabi4u.co.il",
      path: "/",
    });
    for (const lifetime of ["maxAge", "expires"]) expect(cookie).not.toHaveProperty(lifetime);
  });

  test("does not change when a later bootstrap brings a different seed", async () => {
    const original = sentSeed();
    await ok("medical-summary", {}, [seededWith("mock-second-seed")]);
    expect(sentSeed()).toBe(original);
  });
});

describe("renewing the session", () => {
  test("takes one GET without a body, and finding the session expired ends it but leaves the file", () => {
    // F5 turns an expired session away by redirecting it to its policy page.
    const turnedAway: Route = { match: ALIVE, status: 302, headers: { location: `${PORTAL}/my.policy` }, text: "" };
    const renewalsBefore = count(ALIVE);
    const renewal = box.cli(["keep-alive"], { overrides: { routes: [turnedAway] }, config: "bootstrap" });
    expect(renewal.code, renewal.err).toBe(0);
    expect(renewal.json()).toEqual({ renewals: 0, status: "expired" });
    expect(fs.existsSync(sessionFile())).toBe(true);

    expect(count(ALIVE) - renewalsBefore).toBe(1);
    const { url, method, body } = last(ALIVE);
    expect(url).toBe(`${PORTAL}/sonline/MainAppAPI/webapi/mac/v1/members/0/${ID}/alive`);
    expect(method).toBe("GET");
    expect(body).toBeUndefined();
  });
});

test("through all of it the fake had nothing to refuse", () => {
  expect(box.unexpected()).toEqual([]);
});
