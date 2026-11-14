/**
 * Renewal runs every four minutes for up to an hour. No test through a subprocess can wait that out, so
 * the loop is driven here directly, with milliseconds where it has minutes. It works on a real session
 * file in a temporary directory, and Maccabi is a function that answers the two requests a renewal
 * consists of. Beside it stands the rule for the environment the detached renewal process is given.
 * Nothing in here is a real value.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import type { Fetch } from "../../src/maccabi/http";
import { type SavedSession, SessionStore } from "../../src/session/files";
import { createRenewer, holdSession, withoutSecrets } from "../../src/session/keep-alive";

const owner = { memberIdCode: "0", memberId: 40718293 };
const member = {
  member_id: owner.memberId,
  member_id_code: owner.memberIdCode,
  birth_date: "2000-01-01",
  sex: "mock",
  f_name_english: "Specimen",
  l_name_english: "Member",
  f_name_hebrew: "בדויה",
  l_name_hebrew: "לגמרי",
};
/** What Maccabi answers when a renewal asks who is signed in. */
const whoIsSignedIn = {
  token: { success: true, content: "mock-token-for-the-api" },
  current_customer_info: member,
  logged_customer_info: member,
};

/** The session of a sign-in at `minute` past an arbitrary hour. */
function sessionFrom(minute = 0): SavedSession {
  const signedInAt = new Date(Date.UTC(2001, 0, 1, 12, minute)).toISOString();
  const jar = {
    cookies: [],
    rejectPublicSuffixes: true,
    storeType: "MemoryCookieStore",
    version: "tough-cookie@6.0.2",
  };
  return { owner, session: { jar, signedInAt, format: 1 } } as SavedSession;
}

const temporary: string[] = [];
afterEach(() => {
  while (temporary.length > 0) fs.rmSync(temporary.pop() as string, { force: true, recursive: true });
});

type Renewal = Response | Promise<Response>;
const renewed = () => new Response("");
/** A renewal that cannot reach Maccabi at all. */
const offline = (): never => {
  throw new TypeError("mock: the network is down");
};

/**
 * A store with a session in it, and a stand-in for Maccabi that counts the renewals asked of it and
 * answers the n-th with `answer(n)`.
 */
async function signedIn(answer: (nth: number) => Renewal = renewed) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "maccabi-keep-alive-"));
  temporary.push(directory);
  const store = new SessionStore(directory);
  await store.save(sessionFrom());

  let asked = 0;
  const respond = async ({ pathname }: URL): Promise<Response> => {
    if (pathname.endsWith("/token/full")) return Response.json(whoIsSignedIn);
    if (!pathname.endsWith("/alive")) throw new Error("a renewal asked for something that is not part of one");
    asked += 1;
    return answer(asked);
  };
  const fetch: Fetch = async (input) => {
    const url = new URL(String(input));
    return Object.defineProperty(await respond(url), "url", { value: url.href });
  };
  return { store, fetch, renewalsAsked: () => asked };
}
const untilStopped = () => new AbortController().signal;

describe("keepAlive", () => {
  test("renews straight away and again after each interval, until the lifetime of the session is used up", async () => {
    const { store, fetch, renewalsAsked } = await signedIn();

    const { status, renewals } = await holdSession(store, untilStopped(), { fetch, lifetimeMs: 150, intervalMs: 20 });

    expect(status).toBe("lifetime-reached");
    expect(renewals).toBe(renewalsAsked());
    expect(renewals).toBeLessThanOrEqual(8);
    expect(renewals).toBeGreaterThanOrEqual(2);
  });

  test("gives up as failed after three renewals in a row have failed, and does not touch the saved session", async () => {
    const { store, fetch, renewalsAsked } = await signedIn(offline);

    const outcome = await holdSession(store, untilStopped(), { fetch, intervalMs: 1 });

    expect(outcome).toEqual({ renewals: 0, status: "failed" });
    expect(renewalsAsked()).toBe(3);
    expect(await store.load()).toEqual(sessionFrom());
  });

  test("counts failures afresh after a renewal that worked", async () => {
    // Two failures, a success, then the three failures in a row that end it.
    const { store, fetch, renewalsAsked } = await signedIn((nth) => (nth === 3 ? renewed() : offline()));

    const outcome = await holdSession(store, untilStopped(), { fetch, intervalMs: 1 });

    expect(outcome).toEqual({ renewals: 1, status: "failed" });
    expect(renewalsAsked()).toBe(6);
  });

  test("ends as signed-out when a later sign-in has taken the place of the session it began with", async () => {
    const { store, fetch, renewalsAsked } = await signedIn();
    const later = sessionFrom(30);

    const running = holdSession(store, untilStopped(), { fetch, intervalMs: 200 });
    while (renewalsAsked() === 0) await sleep(2);
    // Some way into the pause before the second renewal, and nowhere near its end.
    await sleep(60);
    await store.save(later);

    expect(await running).toEqual({ renewals: 1, status: "signed-out" });
    expect(await store.load()).toEqual(later);
    expect(renewalsAsked()).toBe(1);
  });
});

/** A running MCP server calls this function once every four minutes. */
describe("the renewal that a long-lived process keeps repeating", () => {
  test("is not asked again for a session Maccabi has ended, and is asked again once there is a later sign-in", async () => {
    const logonPage = () => new Response("<html>my.policy</html>");
    const { store, fetch, renewalsAsked } = await signedIn((nth) => (nth === 1 ? logonPage() : renewed()));
    const renew = createRenewer(store, fetch);

    await renew();
    await renew();
    expect(await store.load()).toEqual(sessionFrom());
    expect(renewalsAsked()).toBe(1);

    await store.save(sessionFrom(30));
    await renew();
    expect(renewalsAsked()).toBe(2);
  });
});

/** That process stays up for an hour. A secret it was never handed is one its process entry cannot show. */
describe("the environment the detached renewal process gets", () => {
  const usual = { PATH: "/usr/bin" };

  test("has no variable whose name looks like that of a secret", () => {
    const secretLooking = [
      ...["MACCABI_OTP", "MACCABI_ID", "SOME_COOKIE", "DESKTOP_SESSION", "DB_PASSWORD"],
      ...["GITHUB_TOKEN", "npm_config__authToken", "GOOGLE_APPLICATION_CREDENTIALS"],
      ...["AWS_SECRET_ACCESS_KEY", "SSH_PRIVATE_KEY", "VENDOR_APIKEY"],
    ];
    const secrets = Object.fromEntries(secretLooking.map((name) => [name, "mock"]));

    expect(withoutSecrets({ ...usual, ...secrets })).toEqual(usual);
  });

  test("keeps what the process needs in order to run and to find its files", () => {
    const needed = {
      ...usual,
      LANG: "C.UTF-8",
      HOME: "/home/nobody",
      XDG_CONFIG_HOME: "/nowhere/xdg",
      MACCABI_CONFIG_DIR: "/nowhere/config",
      APPDATA: "C:\\Nowhere",
      HTTPS_PROXY: "http://proxy.example:3128",
    };

    expect(withoutSecrets(needed)).toEqual(needed);
  });

  test("is made without changing the environment it is made from", () => {
    const callers = { ...usual, MACCABI_OTP: "904512" };

    withoutSecrets(callers);

    expect(callers).toEqual({ ...usual, MACCABI_OTP: "904512" });
  });
});
