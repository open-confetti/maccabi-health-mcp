/**
 * The scope every member reader works inside: the transport, the member who signed in, what the
 * sign-in answer said about them, and the owner-bound ways to ask for rows, pages and files.
 */
import { ReadRefusal, refuse, SessionEnded } from "../faults";
import { bytesUpTo, PORTAL_SITE, SIGN_IN_SITE, textUpTo } from "../http";
import { ClassicPageOwnerError, ClassicPageShapeError, mustBeMembersPage } from "./parse/classic-pages";
import {
  asObject,
  asString,
  classicBody,
  type Fields,
  getJson,
  isRecord,
  MAX_PDF_BYTES,
  type MemberHttp,
  type MemberKey,
  type MemberProfile,
  mediaType,
  memberKeyOf,
  mustBelongToMember,
  mustBeOk,
  mustBePdf,
  percentDecoded,
  type Reading,
  sameMember,
  turnAway,
} from "./shared";

/** The classic pages a reader may open, by their address under `/online/`. */
type ClassicPage =
  | `medicalfile/${"summary" | "patientdrugs" | "personalrecommendations" | "documentsandmedicalrecords" | "mailingsfromhospitals"}/`
  | `directorship/${"RequestsAndApprovals" | "personalreminders" | "debitsandcredits"}/`;

/** Every portal JSON service lives under the same prefix. */
export const servicePath = (api: string, rest: string): string => `/sonline/${api}/webapi/mac/${rest}`;

/** Profile fields that stay inside the process: the passport number and the member's identity checksums. */
const WITHHELD_PROFILE_FIELD = /^(?:id_?tech|checksum(?:_?id)?|passport_?number)$/i;

/** The signed-in member's profile with every field Maccabi sent except the withheld ones. */
function returnableProfile(asSent: Fields): Fields {
  const kept = Object.entries(asSent).filter(([prop]) => !WITHHELD_PROFILE_FIELD.test(prop));
  return structuredClone(Object.fromEntries(kept));
}

/** A profile's remark codes joined by commas, the form the portal passes them on in; undefined without a remarks list. */
function remarkCodesOf(remarks: unknown): string | undefined {
  if (!Array.isArray(remarks)) return undefined;
  return remarks.map((remark) => (isRecord(remark) ? String(remark.remark_code ?? "") : "")).join(",");
}

/** Where the gateway and the sign-in site put a visitor whose session is over. */
const SIGNED_OUT_PATHS = new Set(["/mac/login", "/my.policy", "/my.logout.php3"]);

/** The sign-in page hands its token to a script variable; sms-sign-in.ts reads the same assignment. */
const SIGN_IN_PAGE_TOKEN = /originJWT\s*=\s*["'][\w.-]+["']/;

/**
 * How Maccabi's own "this document cannot be opened" page is worded. It was seen live on 2026-10-28 in
 * place of a requested PDF, and the website shows the member the same page, so the failure is
 * Maccabi's and is reported as Maccabi's. HTML without this wording, a sign-in page for one, remains
 * an answer this client did not expect.
 */
const DOCUMENT_ERROR_WORDING = ["שגיאה בפתיחת מסמך", "לא ניתן לפתוח את הקובץ"];

export class MemberScope {
  readonly bootstrapAt = new Date().toISOString();

  /**
   * The checksum Maccabi issues per member. The imaging handoff address takes it as its fourth input,
   * and since it is one value for all of the member's studies it opens every one of them. Hence the
   * private field: no result, log line or address shown to a caller ever carries it.
   */
  readonly #memberChecksum: string | undefined;

  private constructor(
    readonly http: MemberHttp,
    readonly owner: MemberKey,
    readonly profile: MemberProfile,
    readonly bootstrap: Fields,
    memberChecksum: string | undefined,
  ) {
    this.#memberChecksum = memberChecksum;
  }

  /** Reads who is signed in. A session with a dependent selected is refused, and no family data is kept. */
  static async open(http: MemberHttp, rightfulOwner?: MemberKey): Promise<MemberScope> {
    const label = "account";
    const where = servicePath("TokenServerAPI", "v4/members/token/full?checksum=&sr_id=");
    const payload = asObject(await getJson(http, where, label), label);
    const logged = memberKeyOf(payload.logged_customer_info, label);
    const viewed = memberKeyOf(payload.current_customer_info, label);
    // With a dependent selected, the session is alive and looking at somebody else, which the member
    // can undo in the portal without signing in again: that case has a code to itself.
    // NOT_THE_MEMBERS is left for a session whose signed-in member is not the one saved here.
    if (!sameMember(logged, viewed)) throw new ReadRefusal("OTHER_MEMBER_SELECTED", label);
    if (rightfulOwner && !sameMember(logged, rightfulOwner))
      throw refuse("NOT_THE_MEMBERS", label, "saved-member-differs");
    const token = asObject(payload.token, label, "token");
    if (token.success !== true || typeof token.content !== "string" || token.content === "")
      throw new ReadRefusal("NO_PORTAL_TOKEN", label);

    const own = asObject(payload.logged_customer_info, label, "logged_customer_info");
    const shown = asObject(payload.current_customer_info, label, "current_customer_info");
    const text = (column: keyof MemberProfile) => asString(own[column], label, column);
    const profile: MemberProfile = {
      member_id: logged.memberId,
      member_id_code: logged.memberIdCode,
      f_name_hebrew: text("f_name_hebrew"),
      l_name_hebrew: text("l_name_hebrew"),
      f_name_english: text("f_name_english"),
      l_name_english: text("l_name_english"),
      birth_date: text("birth_date"),
      sex: text("sex"),
    };
    http.useApiToken(token.content);

    const copied = structuredClone(own);
    const bootstrap: Fields = {
      englishIdentityOnFile: [shown.f_name_english, shown.l_name_english, shown.passport_number].every(Boolean),
      age: copied.age,
      phones: copied.phones,
      billedToAnotherPayer: typeof own.pays_id === "number" ? own.pays_id !== logged.memberId : undefined,
      classicSessionSeed: typeof payload.session_id === "string" ? payload.session_id : undefined,
      insurancesGroups: structuredClone(shown.insurances_groups),
      remarkCodes: remarkCodesOf(shown.remarks),
      sourceProfile: returnableProfile(own),
      contact: { email: copied.email, phones_update_date: copied.phones_update_date, addresses: copied.addresses },
    };
    // Picked up from this answer because every session fetches it anyway. A profile without one is
    // fine at this point: only the few reads that send the checksum are affected.
    const checksum = typeof shown.checksum_id === "string" && shown.checksum_id !== "" ? shown.checksum_id : undefined;
    return new MemberScope(http, logged, profile, bootstrap, checksum);
  }

  /** For the readers that send the checksum upstream: the imaging handoff and the portal catalog. */
  get memberChecksum(): string | undefined {
    return this.#memberChecksum;
  }

  get memberKey(): MemberKey {
    return { ...this.owner };
  }

  /** The member as the JSON services take them in a request body. */
  member(): { member_id_code: string; member_id: number } {
    const { memberIdCode, memberId } = this.owner;
    return { member_id_code: memberIdCode, member_id: memberId };
  }

  /** The member as the JSON services take them in an address: the id code segment, then the id segment. */
  get ownerSegments(): string {
    return `${encodeURIComponent(this.owner.memberIdCode)}/${this.owner.memberId}`;
  }

  path(api: string, version: string, tail: string): string {
    return servicePath(api, `${version}/members/${this.ownerSegments}/${tail}`);
  }

  post(sent: unknown): RequestInit {
    const body = JSON.stringify(sent);
    return { method: "POST", body, headers: { "content-type": "application/json" } };
  }

  result<T>(payload: T, api: string, label: string): Reading<T> {
    const retrievedAt = new Date().toISOString();
    return {
      data: payload,
      retrievedAt,
      source: { service: api, operation: label, completeness: "upstream-response" },
    };
  }

  /** A result whose checked fields were taken from what the website renders, there being no published schema. */
  renderedResult<T>(payload: T, api: string, label: string): Reading<T> {
    const reading = this.result(payload, api, label);
    reading.source.schemaEvidence = "frontend-field-projection";
    return reading;
  }

  /** A list of objects, each checked against the member before any of them is used. */
  rows(candidate: unknown, label: string, column?: string): Fields[] {
    if (!Array.isArray(candidate))
      throw refuse("UNEXPECTED_ANSWER", label, column === undefined ? "expected-array" : `key:${column}`);
    return candidate.map((item, position) => {
      const entry = asObject(item, label, column === undefined ? undefined : `${column}[${position}]`);
      mustBelongToMember(entry, this.owner, label);
      return entry;
    });
  }

  /**
   * Catches an expired session that got past the transport's redirect check: a response that ended up
   * on the sign-in site, or on a logon or logout path of the portal itself, served with a 200. A reader
   * that looks at its own response calls this first and believes the body only afterwards.
   */
  async mustStillBeSignedIn(landedAt: URL, reply: Response): Promise<void> {
    if (landedAt.origin !== SIGN_IN_SITE && !SIGNED_OUT_PATHS.has(landedAt.pathname.toLowerCase())) return;
    await turnAway(reply, new SessionEnded(reply.status));
  }

  /**
   * A request outside the JSON services (a page, a file, a classic script service), which is sent
   * without the API token. Resolves once the session is known to be alive and the status is a success,
   * with the response and the address it finally came from.
   */
  async navigate(where: string, label: string, setup?: RequestInit): Promise<{ reply: Response; landedAt: URL }> {
    const reply = await this.http.request(where, { ...setup, bearer: false });
    const landedAt = new URL(reply.url || where, PORTAL_SITE);
    await this.mustStillBeSignedIn(landedAt, reply);
    await mustBeOk(reply, label);
    return { reply, landedAt };
  }

  /**
   * The response of a classic service that answers in JSON, its body still unread. It has to come from
   * the very route that was asked, with no query added on the way, and be typed as JSON.
   */
  async classicJson(where: string, label: string, setup?: RequestInit): Promise<Response> {
    const { reply, landedAt } = await this.navigate(where, label, setup);
    const onRoute = landedAt.origin === PORTAL_SITE && landedAt.pathname === where && landedAt.search === "";
    if (!onRoute || mediaType(reply) !== "application/json")
      await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "wrong-route-or-type"));
    return reply;
  }

  /** The markup of one classic page, once it is established that the page is this member's. */
  async classicPage(alias: ClassicPage, label: string): Promise<string> {
    const seed = this.bootstrap.classicSessionSeed;
    if (typeof seed !== "string" || seed === "" || !this.http.navigationSessionFor)
      throw refuse("NOT_OFFERED", label, "classic-navigation-missing");
    const navigation = await this.http.navigationSessionFor(this.owner, seed);
    const where = `/online/${alias}`;
    const lookup = new URLSearchParams({ relative: "-1", sr_id: navigation });
    const { reply, landedAt } = await this.navigate(`${where}?${lookup}`, label);
    const onRoute = landedAt.origin === PORTAL_SITE && landedAt.pathname.toLowerCase() === where.toLowerCase();
    if (!onRoute || mediaType(reply) !== "text/html")
      await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "wrong-route-or-type"));
    const markup = await classicBody(reply, label);
    if (SIGN_IN_PAGE_TOKEN.test(markup)) throw new SessionEnded(reply.status);
    try {
      mustBeMembersPage(markup, this.owner.memberId);
    } catch (caught) {
      if (caught instanceof ClassicPageOwnerError) throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
      // An owner marker that is missing or unreadable says this parser has fallen behind the page,
      // not that the caller holds a stale value. The reads that land here take no id or reference,
      // so advice to list again and copy a fresh one would point at nothing.
      if (caught instanceof ClassicPageShapeError) throw refuse("UNEXPECTED_ANSWER", label, "shape-changed");
      throw caught;
    }
    return markup;
  }

  /** An original PDF from exactly the address asked for: no redirect, a PDF type, capped size, PDF bytes. */
  async pdfAt(given: string, api: string, label: string): Promise<Reading<Uint8Array>> {
    const asked = new URL(given, PORTAL_SITE);
    const { reply, landedAt } = await this.navigate(given, label);
    if (landedAt.origin !== PORTAL_SITE || landedAt.pathname !== asked.pathname || landedAt.search !== asked.search)
      await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "file:redirected"));
    const kind = mediaType(reply);
    if (kind === "text/html") {
      const notAFile = refuse("UNEXPECTED_ANSWER", label, "file:content-type");
      const page = await textUpTo(reply, notAFile, 1024 * 1024).catch(() => "");
      if (!DOCUMENT_ERROR_WORDING.some((wording) => page.includes(wording))) throw notAFile;
      throw refuse("PORTAL_REPORTED_ERROR", label, "maccabi-error-page:document-cannot-be-opened");
    }
    if (kind !== "application/pdf") await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "file:content-type"));
    const oversized = refuse("UNEXPECTED_ANSWER", label, "file:oversized");
    // A length announced above the cap is refused before a byte is read; the read is capped all the same.
    const announced = reply.headers.get("content-length") ?? "";
    if (/^\d+$/.test(announced) && Number(announced) > MAX_PDF_BYTES) await turnAway(reply, oversized);
    const buffer = await bytesUpTo(reply, MAX_PDF_BYTES, oversized);
    return this.result(mustBePdf(buffer, label), api, label);
  }

  /** The PDF behind a medical-file row, addressed by the path, timestamp and signature the row carries. */
  async medicalFilePdf(plain: Fields, label: string): Promise<Reading<Uint8Array>> {
    const path = percentDecoded(plain.pdf_link);
    const hash = percentDecoded(plain.hash);
    if (path === undefined || hash === undefined) throw refuse("UNEXPECTED_ANSWER", label, "file-path-unencodable");
    const timestamp = asString(plain.timestamp, label, "timestamp");
    const lookup = new URLSearchParams({ path, timestamp, hash });
    return this.pdfAt(`${this.path("MedicalFileAPI", "v1", "pdf")}?${lookup}`, "MedicalFileAPI", label);
  }
}
