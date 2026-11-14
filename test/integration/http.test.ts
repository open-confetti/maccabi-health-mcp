/**
 * Every read of the account goes through one transport, and these are its rules as they show from
 * outside the built bundle, with the fake Maccabi answering. Who is sent the bearer token and the
 * cookies; which redirects it follows, which fail the read and which mean the session is over; what an
 * answer must not bring with it; and how long it waits. Unless Maccabi itself ended the session, a read
 * that is refused leaves it where it was. Hosts that are not Maccabi's are reserved example names.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
// @ts-expect-error the fake is plain JavaScript and has no type declarations
import { IMAGING } from "../fake/records.mjs";
// @ts-expect-error the fake is plain JavaScript and has no type declarations
import { MARKERS } from "../fake/tags.mjs";
import { MEMBER, memberSession, type Route } from "../rig";

const { box, start, signIn, ok, fails, last, count } = memberSession("transport", [], "imaging");
/** A second, command-line session, for the one case that needs a process of its own. */
const CLI = { config: "transport-on-cli" };

const HOST = {
  portal: "https://online.maccabi4u.co.il",
  signIn: "https://mac.maccabi4u.co.il",
  viewer: "https://meddreamy.maccabi4u.co.il",
};
/** The prescriptions list is the read that every case below interferes with. */
const LIST = "/prescriptions";
const readFails = (route: Route, code: string, detail?: string) => fails("prescriptions", {}, [route], code, detail);
/** A rule that answers requests matching `match` with a redirect to `location`. */
const redirected = (location: string, match = LIST): Route => ({ match, headers: { location }, status: 302, text: "" });

const hasSession = () => fs.existsSync(path.join(box.configDir("transport"), "signed-in.json"));
const wasRequested = (fragment: string) => box.fetches().some(({ url }) => url.includes(fragment));

test("signing in, once over MCP and once on the command line", async () => {
  await start();
  box.signIn(CLI);
});

describe("each credential goes to its own host and to no other", () => {
  test("a fresh sign-in asks for its bootstrap with the placeholder bearer the portal itself uses", () => {
    const [bootstrap] = box.fetches().filter(({ url }) => url.includes("/token/full"));
    expect(bootstrap?.authorization).toBe("Bearer null");
  });

  test("a read is sent with the token from the bootstrap and with the portal's session cookie", async () => {
    await ok("prescriptions");
    const { authorization, cookie } = last(LIST);
    expect(cookie).toContain(`MRHSession=${MARKERS.sessionCookie}`);
    expect(authorization).toBe(`Bearer ${MARKERS.apiToken}`);
  });

  test("no cookie of the portal ever travels to the sign-in host", () => {
    const cookiesSent = box.fetches().filter(({ origin }) => origin === HOST.signIn);
    expect(cookiesSent.length).toBeGreaterThan(0);
    for (const { url, cookie } of cookiesSent) expect(cookie, url).toBe("");
  });

  test("a redirect onto another of Maccabi's hosts is followed, but with neither the bearer nor a portal cookie", async () => {
    const arrival: Route = { match: "/arrives-here", text: "<html>not the portal</html>" };
    const routes = [redirected(`${HOST.viewer}/arrives-here`), arrival];
    await fails("prescriptions", {}, routes, "UNEXPECTED_ANSWER", "html-where-json");
    expect(last("/arrives-here")).toMatchObject({ cookie: "", authorization: "", origin: HOST.viewer });
  });
});

describe("where a redirect may lead", () => {
  test.each([
    ["to a host that is not on the allowlist", "https://invalid.example/never-asked"],
    [
      "to the portal under an address with a user and password in it",
      "https://someone:pw@online.maccabi4u.co.il/never-asked",
    ],
  ])("%s: the read fails and the address is not requested", async (_where, location) => {
    const readsBefore = count(LIST);
    await readFails(redirected(location), "FOREIGN_HOST");
    expect(wasRequested("never-asked")).toBe(false);
    expect(count(LIST) - readsBefore).toBe(1);
  });

  test("back to the address it came from: the read gives up after nine requests", async () => {
    const readsBefore = count(LIST);
    const itself = `/sonline/MedicalFileAPI/webapi/mac/v1/members/0/${MEMBER}${LIST}`;
    await readFails(redirected(itself), "REDIRECT_LOOP");
    expect(count(LIST) - readsBefore).toBe(9);
  });

  test("nowhere, when the Location is no address at all: the read fails", async () => {
    await readFails(redirected("http://"), "BAD_ADDRESS");
  });

  test("to the sign-in host, for a read that was signed in: the session is over and its file is removed", async () => {
    await readFails(redirected(`${HOST.signIn}/login?SAMLRequest=session-is-over`), "SIGN_IN_NEEDED");
    expect(wasRequested("session-is-over")).toBe(false);
    expect(hasSession()).toBe(false);
    await signIn();
  });

  test("off the portal and then back to the portal's logon page: that ends the session as well", async () => {
    // The handoff to the imaging viewer carries on at the sign-in host, and this chain is turned round there.
    const there = redirected(`${HOST.portal}/sonline/back-again`, "/imaging/login");
    const andBack = redirected("/my.policy", "/sonline/back-again");
    await fails("scan", { study_uid: IMAGING.study }, [there, andBack], "SIGN_IN_NEEDED");
    expect(hasSession()).toBe(false);
    expect(wasRequested("/sonline/back-again")).toBe(true);
    await signIn();
  });
});

describe("an answer that fails its read and does the session no harm", () => {
  test("a 403 for a signed-in read is passed on with its status, and the read after it succeeds", async () => {
    await readFails({ match: LIST, status: 403 }, "HTTP_REFUSED", "status=403");
    expect(hasSession()).toBe(true);
    await ok("prescriptions");
  });

  test("an answer that sets a cookie for somebody else's domain is turned down", async () => {
    const strayCookie = { "set-cookie": "stray=1; Path=/; Domain=example.org" };
    await readFails({ match: LIST, headers: strayCookie }, "BAD_COOKIE");
    await ok("prescriptions");
  });

  test.each([
    ["is cancelled", "AbortError", "REQUEST_CANCELLED"],
    ["takes longer than the deadline allows", "TimeoutError", "TIMED_OUT"],
    ["stops short", "TypeError", "UNEXPECTED_ANSWER"],
  ])(
    "a body that %s partway through gets a code that says which of the three it was",
    async (_how, streamError, code) => {
      await readFails({ match: LIST, headers: { "content-type": "application/json" }, streamError }, code);
    },
  );
});

describe("no answer at all", () => {
  test("is TIMED_OUT when the deadline passes, with no second attempt and no harm to the session", () => {
    const readsBefore = count(LIST);
    const unanswered = box.cli(["prescriptions"], { ...CLI, scenario: "stalled" });
    const { code, message } = unanswered.error();
    expect(message).toContain("Nothing was retried");
    expect([code, unanswered.code, unanswered.out]).toEqual(["TIMED_OUT", 1, ""]);
    expect(count(LIST) - readsBefore).toBe(1);
    expect(box.cli(["prescriptions"], CLI).code).toBe(0);
  });
});

test("no request handed its redirects to the platform, and none was for something the fake does not serve", () => {
  for (const { url, redirect } of box.fetches()) expect(redirect, url).toBe("manual");
  expect(box.unexpected()).toEqual([]);
});
