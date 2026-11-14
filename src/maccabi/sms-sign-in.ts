/**
 * Sign-in with an ID number and a code sent by SMS, as the public sign-in page does it: look the
 * member up, send a code to a phone they pick, check the code, then carry the SAML answer to the
 * portal. Asking the person and storing anything is the caller's business.
 */
import type { SerializedCookieJar } from "tough-cookie";
import { SignInFailure } from "./faults";
import { jsonUpTo, PORTAL_SITE, PortalHttp, SIGN_IN_SITE, textUpTo } from "./http";
import type { PortalSession } from "./portal-session";

/** An Israeli ID number as the sign-in takes it: one to nine digits, leading zeros optional. */
export const ID_NUMBER = /^[0-9]{1,9}$/;

export interface PhoneOption {
  /** Where the phone stands in Maccabi's list, counted from zero. The send step takes this. */
  position: number;
  /** For a numbered list of choices: "Phone 050-*****00". */
  label: string;
  /** For the middle of a sentence ("a code went to 050-*****00"): the same value, bare. */
  shown: string;
  canText: boolean;
}

export interface SignInChallenge {
  /** Names the attempt to the two steps that follow, `sendCode` and `finish`. */
  attemptId: string;
  phones: PhoneOption[];
}

/** An unfinished sign-in in a form another process can pick up. It contains tokens and cookies, so it belongs in protected storage only. */
export interface OpenSignIn {
  format: 1;
  attempt: string;
  member: number;
  /** Authorises sending a code. */
  sendToken: string;
  /** Authorises checking the code; present once one was sent. */
  checkToken?: string;
  phones: PhoneOption[];
  endsAt: number;
  jar: SerializedCookieJar;
}

type Attempt = Omit<OpenSignIn, "format" | "jar"> & { busy: boolean };
type Json = Record<string, unknown>;

const ACS = `${PORTAL_SITE}/saml/sp/profile/post/acs`;
const SIGNED_IN_PAGE = `${PORTAL_SITE}/sonline/homepage/NotificationAndUpdates/`;
/** How the sign-in page's inline script begins the assignment of its first token. */
const TOKEN_ASSIGNMENT = String.raw`originJWT\s*=`;
/** The assignment with the token it assigns. The page is read as text; no upstream script is ever run. */
const ASSIGNED_TOKEN = new RegExp(String.raw`${TOKEN_ASSIGNMENT}\s*["'](?<token>[\w.-]+)["']`);
/** Seeing that assignment again means the sign-in page was served, not the portal. */
const TOKEN_IS_ASSIGNED = new RegExp(TOKEN_ASSIGNMENT);
const NO_CACHE = { "cache-control": "no-cache, no-store, must-revalidate", pragma: "no-cache", expires: "0" };

const changed = (status?: number): SignInFailure => new SignInFailure("SIGN_IN_ANSWER_CHANGED", status);

function isJson(input: unknown): input is Json {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** The token each step returns for the next one. It goes into a header, so no line breaks. */
function nextToken(answer: Json): string {
  const { jwt } = answer;
  if (typeof jwt !== "string" || jwt === "" || /[\r\n]/.test(jwt)) throw changed();
  return jwt;
}

/** The sign-in service puts its own reason in `code` when it turns a step down. */
function refusalFor(code: unknown): string {
  if (code === 302) return "CODE_EXPIRED";
  const numeric = Number(code);
  if (numeric === 301 || numeric === 304) return "SIGN_IN_BLOCKED";
  if (numeric === 300 || numeric === 303) return "CODE_REJECTED";
  return "SIGN_IN_FAILED";
}

const DIGITS = "0123456789";
/** Characters that stand in for the hidden digits of a masked number. */
const MASKING = "*xX•";
const PHONE_PUNCTUATION = "+() -";

/** `text` with every character dropped that is not one of `kept`. */
const only = (text: string, kept: string): string =>
  text
    .split("")
    .filter((unit) => kept.includes(unit))
    .join("");

/**
 * The member's phones as choices. A phone is identified by its position in Maccabi's list, since
 * that is what the send step takes. An entry repeated exactly is offered once, at its first
 * position, like the sign-in page; two different numbers that mask to the same text both stay and
 * are told apart by option number.
 */
function phoneChoices(listed: unknown[]): PhoneOption[] {
  const choices: PhoneOption[] = [];
  const seen = new Set<string>();
  const timesShown = new Map<string, number>();
  for (const [position, phone] of listed.entries()) {
    if (!isJson(phone)) throw changed();
    const { number, mobile, kosher } = phone;
    if (typeof number !== "string" || typeof mobile !== "boolean" || typeof kosher !== "boolean") throw changed();
    const identity = JSON.stringify([number, mobile, kosher]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    // Shown as Maccabi masked it; failing that by its last four digits; failing that by position.
    const lastDigits = only(number, DIGITS).slice(-4);
    let shown = lastDigits ? `ending ${lastDigits}` : String(position + 1);
    if (only(number, MASKING) !== "") shown = only(number, DIGITS + MASKING + PHONE_PUNCTUATION);
    const label = `Phone ${shown}`;
    timesShown.set(label, (timesShown.get(label) ?? 0) + 1);
    choices.push({ position, label, shown, canText: mobile && !kosher });
  }
  for (const choice of choices) {
    if ((timesShown.get(choice.label) ?? 0) > 1) choice.label += ` (option ${choice.position + 1})`;
  }
  return choices;
}

/** Holds at most one sign-in in progress. */
export class SmsSignIn {
  readonly http: PortalHttp;
  readonly #clock: () => number;
  readonly #attemptLifeMs: number;
  #attempt?: Attempt;
  #beginning = false;

  constructor(http = new PortalHttp(), opts: { now?: () => number; lifetimeMs?: number } = {}) {
    this.http = http;
    this.#clock = opts.now ?? Date.now;
    // How long this tool is willing to hold sign-in tokens. Maccabi's own expiry is separate and unknown.
    this.#attemptLifeMs = opts.lifetimeMs ?? 10 * 60_000;
  }

  async begin(idNumber: string): Promise<SignInChallenge> {
    if (!ID_NUMBER.test(idNumber)) throw new SignInFailure("BAD_ID");
    this.#mustBeIdle();
    this.#beginning = true;
    try {
      await this.http.forgetSession();
      const member = Number.parseInt(idNumber, 10);
      const pageToken = await this.#signInPageToken();
      const auth = await this.#call("/auth", pageToken, {
        method: "POST",
        body: JSON.stringify({ id: `0-${member}`, password: "", type: "none" }),
      });
      const lookup = await this.#lookUp(nextToken(auth));
      const { details } = lookup;
      if (!isJson(details)) throw changed();
      const listed = details.phones ?? [];
      if (!Array.isArray(listed)) throw changed();
      if (details.allowedAge !== true || details.digitalUser !== true) throw new SignInFailure("SIGN_IN_NOT_OFFERED");
      const phones = phoneChoices(listed);
      if (!phones.some((phone) => phone.canText)) throw new SignInFailure("NO_SMS_PHONE");
      this.#attempt = {
        attempt: crypto.randomUUID(),
        member,
        sendToken: nextToken(lookup),
        phones,
        endsAt: this.#clock() + this.#attemptLifeMs,
        busy: false,
      };
      return { attemptId: this.#attempt.attempt, phones: phones.map((phone) => ({ ...phone })) };
    } finally {
      this.#beginning = false;
    }
  }

  /** Sends one SMS. Only ever in answer to the person asking; nothing here sends a second one unasked. */
  async sendCode(attemptId: string, phoneAt?: number): Promise<void> {
    const attempt = this.#current(attemptId);
    const usable = attempt.phones.filter((phone) => phone.canText).map((phone) => phone.position);
    const position = phoneAt ?? usable[0];
    if (position === undefined || !usable.includes(position)) throw new SignInFailure("BAD_PHONE_OPTION");
    await this.#exclusively(attempt, async () => {
      const sent = await this.#call(`/otp/generateV2?target=sms&phone=${position}`, attempt.sendToken);
      attempt.checkToken = nextToken(sent);
    });
  }

  async finish(attemptId: string, otp: string): Promise<PortalSession> {
    const attempt = this.#current(attemptId);
    if (!/^\d{6}$/.test(otp)) throw new SignInFailure("BAD_CODE");
    const { checkToken } = attempt;
    if (!checkToken) throw new SignInFailure("NO_CODE_SENT");
    return this.#exclusively(attempt, async () => {
      try {
        const verdict = await this.#call(`/otp/validate?otp=${encodeURIComponent(otp)}`, checkToken);
        if (verdict.status !== "ok") throw new SignInFailure("CODE_REJECTED");
        await this.#enterPortal(nextToken(verdict));
        this.http.markSignedIn();
        this.#attempt = undefined;
        return await this.http.snapshot();
      } catch (caught) {
        // A step Maccabi turned down spends the attempt; a transport error leaves it open to retry.
        if (caught instanceof SignInFailure) this.#attempt = undefined;
        throw caught;
      }
    });
  }

  /** The sign-in in progress, with the cookies it has collected, for another process to finish. */
  async snapshotOpen(): Promise<OpenSignIn> {
    const { attempt, member, sendToken, checkToken, phones, endsAt } = this.#current(this.#attempt?.attempt ?? "");
    const open: OpenSignIn = {
      format: 1,
      attempt,
      member,
      sendToken,
      phones: phones.map((phone) => ({ ...phone })),
      endsAt,
      jar: await this.http.cookieSnapshot(),
    };
    if (checkToken) open.checkToken = checkToken;
    return open;
  }

  /** Takes over a sign-in that `snapshotOpen` saved; the steps left are the same ones. */
  resume(open: OpenSignIn): void {
    this.#mustBeIdle();
    const wellFormed =
      open.format === 1 &&
      typeof open.attempt === "string" &&
      typeof open.sendToken === "string" &&
      Number.isSafeInteger(open.member) &&
      Array.isArray(open.phones) &&
      Number.isFinite(open.endsAt);
    if (!wellFormed) throw new SignInFailure("NO_OPEN_SIGN_IN");
    if (this.#clock() >= open.endsAt) throw new SignInFailure("SIGN_IN_EXPIRED");
    this.http.loadCookies(open.jar);
    const { attempt, member, sendToken, checkToken, phones, endsAt } = open;
    this.#attempt = { attempt, member, sendToken, checkToken, phones, endsAt, busy: false };
  }

  async abandon(): Promise<void> {
    if (this.#beginning || this.#attempt?.busy) throw new SignInFailure("SIGN_IN_BUSY");
    this.#attempt = undefined;
    await this.http.forgetSession();
  }

  #mustBeIdle(): void {
    if (this.#beginning || this.#attempt) throw new SignInFailure("SIGN_IN_ALREADY_OPEN");
  }

  /** The attempt `ident` names, provided it is the open one, still within its lifetime and not mid-step. */
  #current(ident: string): Attempt {
    const attempt = this.#attempt;
    if (!attempt || attempt.attempt !== ident) throw new SignInFailure("NO_OPEN_SIGN_IN");
    if (this.#clock() >= attempt.endsAt) {
      this.#attempt = undefined;
      throw new SignInFailure("SIGN_IN_EXPIRED");
    }
    if (attempt.busy) throw new SignInFailure("SIGN_IN_BUSY");
    return attempt;
  }

  async #exclusively<T>(attempt: Attempt, step: () => Promise<T>): Promise<T> {
    attempt.busy = true;
    try {
      return await step();
    } finally {
      attempt.busy = false;
    }
  }

  async #signInPageToken(): Promise<string> {
    const page = await this.http.request(`${PORTAL_SITE}/`);
    if (!page.ok) throw new SignInFailure("SIGN_IN_PAGE_DOWN", page.status);
    const markup = await textUpTo(page, changed(page.status));
    const token = ASSIGNED_TOKEN.exec(markup)?.groups?.token;
    if (!token) throw new SignInFailure("SIGN_IN_PAGE_CHANGED");
    return token;
  }

  /**
   * Fetches the member's sign-in details. When Maccabi cannot look an ID up at the moment, this is
   * the step that fails, and no SMS has gone out yet; it gets a code of its own so the caller can
   * say exactly that.
   */
  async #lookUp(token: string): Promise<Json> {
    try {
      return await this.#call("/otp/detailsV2", token);
    } catch (caught) {
      const lookupFailed = caught instanceof SignInFailure && caught.code === "SIGN_IN_FAILED";
      throw lookupFailed ? new SignInFailure("ID_LOOKUP_FAILED", caught.status) : caught;
    }
  }

  /** Collects the SAML answer and posts it to the portal, which must then serve its signed-in home page. */
  async #enterPortal(token: string): Promise<void> {
    const handoff = await this.#call("/response", token, { headers: { relay: "home" } });
    const { payload } = handoff;
    const asExpected =
      handoff.status === "ok" && handoff.method === "post" && handoff.destination === ACS && isJson(payload);
    if (!asExpected) throw new SignInFailure("HANDOFF_CHANGED");
    const { SAMLResponse, RelayState } = payload;
    if (typeof SAMLResponse !== "string" || typeof RelayState !== "string") throw new SignInFailure("HANDOFF_CHANGED");
    const landing = await this.http.request(ACS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: SIGN_IN_SITE },
      body: new URLSearchParams({ RelayState, SAMLResponse }),
    });
    const markup = await textUpTo(landing, changed(landing.status));
    const opened =
      landing.ok &&
      landing.url === SIGNED_IN_PAGE &&
      landing.headers.get("content-type")?.includes("text/html") === true &&
      !TOKEN_IS_ASSIGNED.test(markup) &&
      (await this.http.holdsPortalSession());
    if (!opened) throw new SignInFailure("SESSION_NOT_OPENED");
  }

  /** One JSON call to the sign-in service, authorised by the token the previous step returned. */
  async #call(where: string, token: string, setup: RequestInit = {}): Promise<Json> {
    const address = new URL(`/infosec${where}`, SIGN_IN_SITE);
    const headers = new Headers(setup.headers);
    const json = "application/json; charset=utf-8";
    const always = { authorization: `Bearer ${token}`, origin: SIGN_IN_SITE, accept: json, "content-type": json };
    // Every step after the first is sent uncacheable, with the clock as a cache-busting parameter.
    const afterFirstStep = address.pathname !== "/infosec/auth";
    if (afterFirstStep) address.searchParams.set("_", String(this.#clock()));
    for (const [name, value] of Object.entries({ ...always, ...(afterFirstStep ? NO_CACHE : {}) })) {
      headers.set(name, value);
    }
    const reply = await this.http.request(address, { ...setup, headers });
    const answer = await jsonUpTo(reply, changed(reply.status));
    if (!isJson(answer)) throw changed(reply.status);
    if (!reply.ok) throw new SignInFailure(refusalFor(answer.code), reply.status);
    return answer;
  }
}
