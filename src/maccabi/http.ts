/**
 * The one place a request to Maccabi is made: a cookie jar, three permitted hosts, redirects walked
 * by hand, a deadline that holds even when `fetch` does not, and bounded body reads.
 */
import { Cookie, CookieJar, type SerializedCookieJar } from "tough-cookie";
import { HttpFailure, SessionEnded } from "./faults";
import type { PortalSession } from "./portal-session";

/** Where the ID + SMS sign-in happens. */
export const SIGN_IN_SITE = "https://mac.maccabi4u.co.il";
/** The member portal and its APIs. */
export const PORTAL_SITE = "https://online.maccabi4u.co.il";
/**
 * The imaging viewer (MedDream). It keeps a gateway session and an application session of its own;
 * the portal hands a member over to it once per imaging read and shares nothing else with it.
 */
export const VIEWER_SITE = "https://meddreamy.maccabi4u.co.il";
/** A redirect from the portal to this path on the sign-in host starts the viewer handoff. */
export const VIEWER_ENTRY_PATH = "/imaging/login";

const PERMITTED_SITES: ReadonlySet<string> = new Set([SIGN_IN_SITE, PORTAL_SITE, VIEWER_SITE]);
const VIEWER_HOST = new URL(VIEWER_SITE).hostname;
const PORTAL_ROOT = `${PORTAL_SITE}/`;
const MAX_REDIRECTS = 8;
const DEFAULT_DEADLINE_MS = 30_000;

export type Fetch = (given: string | Request | URL, setup?: RequestInit) => Promise<Response>;

export interface HttpRequest extends RequestInit {
  /** `false` for the document downloads a browser fetches with cookies alone. */
  bearer?: boolean;
  /**
   * Only the request that asks the portal for the viewer handoff sets this. Its success looks exactly
   * like an expired session (a 302 to the sign-in host), so that one request may be redirected to
   * `VIEWER_ENTRY_PATH` there without the session being declared over. Any other sign-in-host
   * destination, `/my.policy` included, still ends the session.
   */
  viewerEntry?: boolean;
}

export interface HttpOptions {
  fetch?: Fetch;
  session?: PortalSession;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Settles with `work`, or rejects with the signal's reason as soon as the signal fires, whichever is
 * first. Passing the signal to `fetch` is not enough: an implementation may sit on it (Node cannot
 * interrupt a DNS lookup that is already running), and every caller above waits its turn behind one
 * session lock, so a request that never settles would stall all of them. The request left behind
 * finishes or fails by itself.
 */
export function settleOrAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let fire = (): void => {};
  const fired = new Promise<never>((_resolve, reject) => {
    fire = () => reject(signal.reason);
  });
  if (signal.aborted) fire();
  else signal.addEventListener("abort", fire, { once: true });
  return Promise.race([fired, work]).finally(() => signal.removeEventListener("abort", fire));
}

/**
 * Cancels the body of a response that will not be read. An unread body keeps its socket checked out
 * of Node's pool, and a long-running server that fails many reads in a row would run the pool dry.
 * A body that is already drained or broken needs nothing.
 */
export async function release(reply: Response): Promise<void> {
  await reply.body?.cancel().catch(() => {});
}

/** Abort and deadline errors keep their own codes; any other failure while reading becomes `refusal`. */
export async function whileReading<T>(consume: () => Promise<T>, refusal: Error): Promise<T> {
  try {
    return await consume();
  } catch (caught) {
    const kind = caught instanceof Error ? caught.name : undefined;
    if (kind === "TimeoutError") throw new HttpFailure("TIMED_OUT");
    if (kind === "AbortError") throw new HttpFailure("REQUEST_CANCELLED");
    throw refusal;
  }
}

/**
 * The body as bytes, refusing with `refusal` once it grows past `maxBytes`.
 *
 * `Response.arrayBuffer()` and `.text()` hold the entire body in memory before its size can be
 * checked, and a server is free to send more than its content-length says. Here the stream is
 * cancelled at the first chunk over the limit, so memory use never exceeds the limit by more than
 * that chunk. No body at all is zero bytes.
 */
export async function bytesUpTo(reply: Response, maxBytes: number, refusal: Error): Promise<Uint8Array> {
  if (!reply.body) return new Uint8Array(0);
  const reader = reply.body.getReader();
  return whileReading(async () => {
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        total += next.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw refusal;
        }
        parts.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const whole = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.byteLength;
    }
    return whole;
  }, refusal);
}

/**
 * The limit for a JSON or HTML answer read in full. The appointment front-end script is the biggest
 * real one and its reader stops at eight million characters, so this leaves ample room.
 */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** The body as text under a size limit, decoded the way `Response.text()` decodes it. */
export async function textUpTo(reply: Response, refusal: Error, maxBytes: number = MAX_TEXT_BYTES): Promise<string> {
  const bytes = await bytesUpTo(reply, maxBytes, refusal);
  return new TextDecoder("utf-8").decode(bytes);
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * `bytes` as text when they are UTF-8 through and through, a leading byte-order mark dropped. A
 * sequence that is not valid becomes `refusal`; `textUpTo` would have put a replacement character there.
 */
export function utf8Strictly(bytes: Uint8Array, refusal: Error): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw refusal;
  }
}

/** The body as parsed JSON under a size limit; text that is not JSON is refused like an oversized body. */
export async function jsonUpTo(reply: Response, refusal: Error, maxBytes: number = MAX_TEXT_BYTES): Promise<unknown> {
  const text = await textUpTo(reply, refusal, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw refusal;
  }
}

/** Restores a jar from its saved form; anything it cannot read is a damaged session. */
function openJar(saved: SerializedCookieJar): CookieJar {
  try {
    return CookieJar.deserializeSync(saved);
  } catch {
    throw new HttpFailure("DAMAGED_SESSION");
  }
}

function parseAddress(given: string | URL, base: string | URL): URL {
  try {
    return new URL(given, base);
  } catch {
    throw new HttpFailure("BAD_ADDRESS");
  }
}

/** Only the three Maccabi hosts, and never with credentials in the address. */
function mustBePermitted(address: URL): void {
  const permitted = PERMITTED_SITES.has(address.origin) && !address.username && !address.password;
  if (!permitted) throw new HttpFailure("FOREIGN_HOST");
}

/** A browser turns these redirected requests into a GET without a body. */
function becomesGet(status: number, method: string): boolean {
  if (status === 303) return method !== "HEAD";
  return (status === 301 || status === 302) && method === "POST";
}

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status);

/** HTTPS with cookies, used by sign-in and by every account reader. */
export class PortalHttp {
  readonly #send: Fetch;
  readonly #deadlineMs: number;
  readonly #clock: () => number;
  #jar: CookieJar;
  #signedInAt?: string;
  #bearer?: string;

  constructor({ fetch, session, timeoutMs, now }: HttpOptions = {}) {
    this.#send = fetch ?? globalThis.fetch;
    this.#deadlineMs = timeoutMs ?? DEFAULT_DEADLINE_MS;
    this.#clock = now ?? Date.now;
    if (session && session.format !== 1) throw new HttpFailure("DAMAGED_SESSION");
    this.#jar = session ? openJar(session.jar) : new CookieJar();
    this.#signedInAt = session?.signedInAt;
    this.#bearer = session?.bearer;
  }

  useApiToken(secret: string): void {
    if (!secret || /[\r\n]/.test(secret)) throw new HttpFailure("BAD_API_TOKEN");
    this.#bearer = `Bearer ${secret}`;
  }

  /** For the sign-in flow alone, once it has seen the whole success sequence end on the portal home page. */
  markSignedIn(): void {
    this.#signedInAt = new Date(this.#clock()).toISOString();
  }

  /**
   * The session as it is saved to disk, without the viewer's cookies. Saving those breaks imaging:
   * with the viewer's gateway session still alive on the next run, the handoff does not replay as
   * its parser expects and the token request is turned down (seen live on 2026-10-04; with them left
   * out the handoff succeeds). Each imaging read performs the handoff afresh anyway.
   */
  async snapshot(): Promise<PortalSession> {
    if (!this.#signedInAt) throw new SessionEnded();
    const jar = await this.#jar.serialize();
    const session: PortalSession = {
      format: 1,
      jar: { ...jar, cookies: jar.cookies.filter((crumb) => crumb.domain !== VIEWER_HOST) },
      signedInAt: this.#signedInAt,
    };
    if (this.#bearer) session.bearer = this.#bearer;
    return session;
  }

  /**
   * Run before each handoff, for session files written before `snapshot` left the viewer out.
   * Removal is by domain, as in `snapshot`, so a cookie the viewer scoped to a sub-path goes too.
   */
  async forgetViewerCookies(): Promise<void> {
    await this.#jar.store.removeCookies(VIEWER_HOST, null);
  }

  /** The jar part-way through sign-in, for the process that will enter the code. `snapshot` refuses until sign-in is done. */
  async cookieSnapshot(): Promise<SerializedCookieJar> {
    return this.#jar.serialize();
  }

  loadCookies(cookies: SerializedCookieJar): void {
    this.#jar = openJar(cookies);
  }

  async forgetSession(): Promise<void> {
    await this.#jar.removeAllCookies();
    this.#signedInAt = undefined;
    this.#bearer = undefined;
  }

  async holdsPortalSession(): Promise<boolean> {
    const crumbs = await this.#jar.getCookies(PORTAL_ROOT);
    return crumbs.some((crumb) => crumb.key === "MRHSession" && Boolean(crumb.value));
  }

  /**
   * The portal's per-member navigation session id. The portal writes the first one it is given into
   * a cookie named after the member and reuses it for as long as that cookie exists; so does this.
   */
  async navigationSessionFor(me: { memberId: number; memberIdCode: string }, seedSessionId: string): Promise<string> {
    const refused = new HttpFailure("BAD_NAVIGATION_SEED");
    const idIsUsable = Number.isSafeInteger(me.memberId) && me.memberId >= 0;
    const codeIsUsable = typeof me.memberIdCode === "string" && /^\d+$/.test(me.memberIdCode);
    if (!idIsUsable || !codeIsUsable) throw refused;
    const name = `cookie_sessionId_${me.memberIdCode}_${me.memberId}`;
    try {
      const crumbs = await this.#jar.getCookies(PORTAL_ROOT);
      const kept = crumbs.find((crumb) => crumb.key === name);
      const crumb = kept?.value ? kept : new Cookie({ key: name, value: seedSessionId, path: "/", secure: true });
      if (!crumb.validate()) throw refused;
      if (crumb !== kept) await this.#jar.setCookie(crumb, PORTAL_ROOT);
      return crumb.value;
    } catch {
      throw refused;
    }
  }

  async request(given: string | URL, setup: HttpRequest = {}): Promise<Response> {
    const { bearer, viewerEntry, ...passThrough } = setup;
    let address = parseAddress(given, PORTAL_SITE);
    mustBePermitted(address);
    let method = (setup.method ?? "GET").toUpperCase();
    let body = setup.body;

    const headers = new Headers(setup.headers);
    // The jar decides which cookies a host receives; a caller's own header would bypass its scoping.
    headers.delete("cookie");
    const isPortalApi = address.origin === PORTAL_SITE && address.pathname.startsWith("/sonline/");
    if (bearer !== false && isPortalApi && !headers.has("authorization")) {
      // With no token yet, the portal's own client sends the word "null"; so does this.
      headers.set("authorization", this.#bearer ?? "Bearer null");
    }

    const deadline = AbortSignal.timeout(this.#deadlineMs);
    const signal = setup.signal ? AbortSignal.any([setup.signal, deadline]) : deadline;

    for (let followed = 0; followed <= MAX_REDIRECTS; followed++) {
      // Whether this hop speaks for the signed-in session is decided hop by hop, from where the
      // request is actually going: only a portal request made after sign-in carries that session's
      // cookies. A chain that begins on the sign-in host and lands on the portal is therefore covered
      // from the landing onwards. The sign-in flow is never covered, since it forgets the session
      // before its first request.
      const signedIn = Boolean(this.#signedInAt) && address.origin === PORTAL_SITE;

      const outgoing = new Headers(headers);
      const crumbs = await this.#jar.getCookieString(address.href);
      if (crumbs) outgoing.set("cookie", crumbs);

      let reply: Response;
      try {
        const sending = this.#send(address.href, {
          ...passThrough,
          method,
          body,
          headers: outgoing,
          redirect: "manual",
          signal,
        });
        reply = await settleOrAbort(sending, signal);
      } catch {
        if (deadline.aborted && signal.reason === deadline.reason) throw new HttpFailure("TIMED_OUT");
        throw new HttpFailure(signal.aborted ? "REQUEST_CANCELLED" : "UNREACHABLE");
      }

      try {
        for (const header of reply.headers.getSetCookie()) await this.#jar.setCookie(header, address.href);
      } catch {
        await release(reply);
        throw new HttpFailure("BAD_COOKIE");
      }

      // A 401 or 403 does not mean the session is over. On live traffic the gateway ends a session
      // with a redirect to /my.policy, never with these; a 403 is far more likely the bot filter in
      // front of the portal. So this request fails and the cookies stay, and a session that has in
      // fact ended is still caught by the redirect rule further down.
      if (signedIn && (reply.status === 401 || reply.status === 403)) {
        await release(reply);
        throw new HttpFailure("HTTP_REFUSED", reply.status);
      }

      const location = reply.headers.get("location");
      if (!location || !isRedirect(reply.status)) return reply;

      let next: URL;
      try {
        next = parseAddress(location, address);
      } catch (caught) {
        await release(reply);
        throw caught;
      }

      // The single exemption from the rule below: the caller asked for the viewer handoff and the
      // portal answered with exactly its entry address. An ended session answers the same request
      // with /my.policy, which does not match.
      const startsHandoff = viewerEntry === true && next.origin === SIGN_IN_SITE && next.pathname === VIEWER_ENTRY_PATH;
      // How an ended session shows itself, and the only way seen. The gateway has just replaced
      // MRHSession with an anonymous one, and the jar now holds it; unless everything is dropped
      // here, each later request would bounce to /my.policy again with no explanation.
      const sentToSignIn = next.origin === SIGN_IN_SITE || next.pathname === "/my.policy";
      if (signedIn && sentToSignIn && !startsHandoff) {
        await release(reply);
        await this.forgetSession();
        throw new SessionEnded(reply.status);
      }

      // A caller that asked for manual redirects makes the next request through `request` again,
      // where its address is checked; this method checks only the addresses it requests itself.
      if (setup.redirect === "manual") return reply;

      try {
        mustBePermitted(next);
      } catch (caught) {
        await release(reply);
        throw caught;
      }

      if (next.origin !== address.origin) {
        for (const name of ["authorization", "origin", "referer"]) headers.delete(name);
      }
      if (becomesGet(reply.status, method)) {
        method = "GET";
        body = undefined;
        for (const name of ["content-type", "content-length"]) headers.delete(name);
      }
      await release(reply);
      address = next;
    }
    throw new HttpFailure("REDIRECT_LOOP");
  }
}
