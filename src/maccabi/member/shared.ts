/**
 * Common ground of the member readers: the shapes they exchange, and the checks no reader gets to skip
 * (what an answer looks like, whose it is, how a document is referred to, which links are private).
 */
import { createHash } from "node:crypto";
import { ReadRefusal, refuse, SessionEnded } from "../faults";
import { bytesUpTo, type HttpRequest, jsonUpTo, PORTAL_SITE, release, SIGN_IN_SITE, textUpTo } from "../http";
import { hasLonePercent } from "./parse/guards";

export type Fields = Record<string, unknown>;

export interface MemberKey {
  memberId: number;
  memberIdCode: string;
}

/** The part of the transport a reader touches. docs/upstream.md records where each upstream contract was seen. */
export interface MemberHttp {
  request(input: string | URL, setup?: HttpRequest): Promise<Response>;
  useApiToken(token: string): void;
  navigationSessionFor?(me: MemberKey, seedSessionId: string): Promise<string>;
}

/** Which service answered, and how much of its answer the reading holds. */
export interface ReadingSource {
  operation: string;
  service: string;
  completeness: "local-filtered-subset" | "upstream-response";
  /** Present when rows were dropped here, after Maccabi answered, and says by what rule. */
  selection?: { mode: "local"; year: number; field: "execute_date" };
  scope?: "payer-account-aggregate";
  schemaEvidence?: "frontend-field-projection";
}

export interface Reading<T> {
  source: ReadingSource;
  retrievedAt: string;
  data: T;
}

export interface DaySpan {
  from: string;
  to: string;
}

/** The validated part of the sign-in profile, under Maccabi's own field names. */
export interface MemberProfile {
  member_id_code: string;
  member_id: number;
  sex: string;
  birth_date: string;
  l_name_english: string;
  f_name_english: string;
  l_name_hebrew: string;
  f_name_hebrew: string;
}

// ---- What an answer looks like ----

export const isRecord = (candidate: unknown): candidate is Fields =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

/** Sent at all: a value that is neither left out nor null. */
export const isPresent = (candidate: unknown): boolean => candidate !== undefined && candidate !== null;

/** A whole number from zero up, the form counts, codes and phone numbers arrive in. */
export const isCount = (candidate: unknown): candidate is number =>
  typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0;

/** The detail token names the field when the caller knows it, and the bare complaint when it does not. */
const shapeDetail = (column: string | undefined, bare: string): string =>
  column === undefined ? bare : `key:${column}`;

export function asObject(candidate: unknown, label: string, column?: string): Fields {
  if (isRecord(candidate)) return candidate;
  throw refuse("UNEXPECTED_ANSWER", label, shapeDetail(column, "not-an-object"));
}

export function asString(candidate: unknown, label: string, column?: string): string {
  if (typeof candidate === "string") return candidate;
  throw refuse("UNEXPECTED_ANSWER", label, shapeDetail(column, "not-a-string"));
}

/** Fields that may be left out of a row. One that is sent has to be null or of a listed type. */
export function checkOptional(
  entry: Fields,
  columns: readonly string[],
  types: readonly string[],
  label: string,
): void {
  for (const column of columns) {
    const sent = entry[column];
    if (Object.hasOwn(entry, column) && sent !== null && !types.includes(typeof sent))
      throw refuse("UNEXPECTED_ANSWER", label, `key:${column}`);
  }
}

/** Percent-decoded text, or undefined for anything that is not text or does not decode. */
export function percentDecoded(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return undefined;
  }
}

/** `text` percent-encoded for an address. Text that cannot be encoded, a lone surrogate for one, is refused. */
export function percentEncoded(text: string, label: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    throw refuse("UNEXPECTED_ANSWER", label, "link-unencodable");
  }
}

/** A download signature as the query string needs it. A missing one and a mangled one get the same refusal. */
export function unescapeComponent(candidate: unknown, label: string): string {
  const plain = percentDecoded(candidate);
  if (plain === undefined) throw refuse("UNEXPECTED_ANSWER", label, "signature-undecodable");
  return plain;
}

/**
 * Whether `text` can stand in a query string as one value without being encoded, which is how the
 * website writes Maccabi's timestamps and hashes: not empty, within `limit`, holding no separator or
 * control character, and with every `%` opening a complete escape. A space is a separator too, except
 * for the few worded values that `spaces` lets through.
 */
export function fitsQueryValue(text: string, limit: number, spaces = false): boolean {
  if (text.length === 0 || text.length > limit) return false;
  if (!spaces && text.includes(" ")) return false;
  return !/[\x00-\x1f\x7f&#?=]/.test(text) && !hasLonePercent(text);
}

/** A value Maccabi sent, fit to go into a query string as it is; refused when it could not go in whole. */
export function queryValue(sent: unknown, limit: number, label: string, spaces = false): string {
  const text = asString(sent, label);
  if (!fitsQueryValue(text, limit, spaces)) throw refuse("UNEXPECTED_ANSWER", label, "signature-unsafe");
  return text;
}

export function memberKeyOf(candidate: unknown, label: string): MemberKey {
  const { member_id: memberId, member_id_code: memberIdCode } = asObject(candidate, label);
  if (!isCount(memberId) || typeof memberIdCode !== "string" || !/^\d+$/.test(memberIdCode))
    throw refuse("UNEXPECTED_ANSWER", label, "key:member_id");
  return { memberId, memberIdCode };
}

export function valuesOf(entry: Fields, attrs: readonly string[]): unknown[] {
  return attrs.map((column) => entry[column] ?? null);
}

// ---- Whose it is ----

export const sameMember = (one: MemberKey, other: MemberKey): boolean =>
  one.memberIdCode === other.memberIdCode && one.memberId === other.memberId;

/** Whether `entry` carries a member id or id code other than `me`'s. `silent` lists the values that name nobody. */
function namesAnotherMember(entry: Fields, me: MemberKey, silent: readonly unknown[]): boolean {
  const differs = (sent: unknown, mine: number | string) => !silent.includes(sent) && String(sent) !== String(mine);
  return differs(entry.member_id, me.memberId) || differs(entry.member_id_code, me.memberIdCode);
}

/** One row: an id that is present at all, null and empty included, has to be the member's. */
export function mustBelongToMember(entry: Fields, me: MemberKey, label: string): void {
  if (namesAnotherMember(entry, me, [undefined])) throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
}

/**
 * A whole answer: refused when any object inside it, at any depth, names a member who is not `me`.
 * Here an id that is absent, null or empty names nobody. Reads that list the family on purpose are
 * declared with owner "family" and never come through this.
 */
export function mustBelongToMemberDeep(candidate: unknown, me: MemberKey, label: string, level = 0): void {
  if (level > 32 || typeof candidate !== "object" || candidate === null) return;
  if (!Array.isArray(candidate) && namesAnotherMember(candidate as Fields, me, [undefined, null, ""]))
    throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
  for (const inner of Object.values(candidate)) mustBelongToMemberDeep(inner, me, label, level + 1);
}

/**
 * The strict owner test, for an answer that has to say whose it is: both ids are there and both are
 * `me`'s. The checks above let an answer through when it names nobody; this one does not.
 */
export function namesMember(id: unknown, idCode: unknown, me: MemberKey): boolean {
  return String(id) === String(me.memberId) && String(idCode) === me.memberIdCode;
}

/**
 * The row a caller's id picks out of a list that was just fetched and owner-checked. An id that picks
 * nothing is not the member's. One that picks two rows is Maccabi contradicting itself, which is a
 * different fault from a caller reaching for somebody else's row.
 */
export function theOnly<T>(fits: readonly T[], label: string): T {
  if (fits.length === 0) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
  if (fits.length > 1) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
  return fits[0] as T;
}

// ---- How a document is referred to ----

/** SHA-256 over the JSON text of `parts`, written in hex: the form a reference takes. */
export function digestOf(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

const REFERENCE = /^[0-9a-f]{64}$/;

/** Whether `candidate` has the form of a reference at all; nothing is said about what it refers to. */
export const isReference = (candidate: string): boolean => REFERENCE.test(candidate);

/** Turns a caller's reference away when it cannot be one, before any list is read to look it up. */
export function mustBeReference(candidate: string, label: string): void {
  if (!isReference(candidate)) throw refuse("NOT_THE_MEMBERS", label, "reference-malformed");
}

/**
 * References for documents that Maccabi identifies by nothing but a download link.
 *
 * The link is reissued, with a new timestamp and a new signature, each time the list is served. A
 * reference derived from it would already be dead when a later process lists the documents again to
 * confirm ownership ahead of the download. So the reference hashes what stays put: the row's steady
 * fields, and the row's turn among rows sharing exactly those fields, in the order Maccabi sent
 * them. Look-alike documents still end up with separate references, and one document keeps its
 * reference from answer to answer for as long as Maccabi keeps look-alikes in the same order.
 *
 * Ownership is untouched by this. A reference means something only against a list that was just
 * fetched and owner-checked: an unknown reference is refused, and another member's row is refused
 * before a reference is computed for it at all. Rows that differ in a steady field may trade places
 * freely. Rows that differ in none may trade places unnoticed, since Maccabi sends nothing that
 * would distinguish them.
 *
 * Keep volatile material out of an identity: no signature, token, hash, timestamp, URI, path or link.
 */
export class SteadyReferences {
  /** How many rows of each identity this answer has produced so far, by the identity's JSON text. */
  readonly #turns = new Map<string, number>();

  next(identity: readonly unknown[]): string {
    const same = JSON.stringify(identity);
    const turn = this.#turns.get(same) ?? 0;
    this.#turns.set(same, turn + 1);
    return steadyReference(identity, turn);
  }
}

export function steadyReference(identity: readonly unknown[], occurrence: number): string {
  return digestOf(["stable-reference-v1", identity, occurrence]);
}

/**
 * A field with one of these words in its name is routing or signing material, reissued per answer.
 * `base64` belongs with them: Maccabi builds that document afresh for each request, so its bytes
 * differ between the listing and the download and cannot identify the row.
 */
const VOLATILE_FIELD = /expir|checksum|signature|stamp|hash|token|path|ur[il]|link|base64/i;

/** Identifiers a document row can arrive with. A row that has any is identified by them and by nothing else. */
const ROW_ID_FIELDS = [
  "document_id",
  "doc_id",
  "referral_id",
  "prescription_id",
  "approval_id",
  "item_id",
  "id",
] as const;

/** An identifier counts when it is a finite number or text that is not empty. */
export const isIdentifier = (candidate: unknown): boolean =>
  typeof candidate === "number" ? Number.isFinite(candidate) : typeof candidate === "string" && candidate !== "";

function isPlainValue(candidate: unknown): boolean {
  if (typeof candidate === "number") return Number.isFinite(candidate);
  return candidate === null || ["string", "boolean"].includes(typeof candidate);
}

/**
 * What identifies one attachment row from answer to answer. Its own identifiers do when it has some.
 * Failing that, its plain top-level values do, taken in name order, leaving out every field whose
 * name marks it as routing or signing material.
 */
export function steadyIdentity(entry: Fields): unknown[] {
  const pairs = (columns: readonly string[]) => columns.map((column) => [column, entry[column]]);
  const ids = ROW_ID_FIELDS.filter((column) => isIdentifier(entry[column]));
  if (ids.length > 0) return ["ids", ...pairs(ids)];
  const steady = Object.keys(entry).filter((column) => isPlainValue(entry[column]) && !VOLATILE_FIELD.test(column));
  return ["fields", ...pairs(steady.sort())];
}

/**
 * Lays a validated projection over the answer it was made from, so that nothing Maccabi sent is lost
 * (results keep every field Maccabi sent). Two records are joined name by name, and the projection
 * wins a name they share. Two lists are joined item by item only when they are equally long, which is
 * what a row-for-row projection produces; a list of any other length comes from the projection alone.
 * Anything the projection added by itself, such as a reference or a flag, stays as it is.
 */
export function overSource<T>(origin: unknown, shaped: T): T {
  if (Array.isArray(shaped)) {
    if (!Array.isArray(origin) || origin.length !== shaped.length) return shaped;
    return shaped.map((item, at) => overSource(origin[at], item)) as T;
  }
  if (!isRecord(origin) || !isRecord(shaped) || ArrayBuffer.isView(shaped)) return shaped;
  const joined = structuredClone(origin);
  for (const [column, item] of Object.entries(shaped)) joined[column] = overSource(origin[column], item);
  return joined as T;
}

// ---- Which links are private ----

/**
 * The names the member checksum travels under. It identifies the member on portal requests and is
 * withheld from every result. Download signatures are another matter: `hash`, `timestamp`,
 * `time_stamp`, `corona_hash` and `corona_t` pass through untouched (results keep every field Maccabi
 * sent), because each answer mints new ones and no download here is driven by a value that was
 * returned.
 */
export const CHECKSUM_KEYS = new Set(["checksum", "checksum_id"]);

/**
 * Whether a portal JSON field holds a link, path or URI to a document, going by its name: one of the
 * words link(s), url, uri or path standing alone between underscores, or `result_file`. That covers the
 * observed `file_path`, `link_pdf` and `file_name_path`.
 */
export function isLinkKey(prop: string): boolean {
  return /(?:^|_)(?:links?|ur[il]|path)(?:_|$)|^result_file$/i.test(prop);
}

/** The portal and the sign-in site: any address on them belongs to the session. */
const SESSION_HOSTS = new Set([PORTAL_SITE, SIGN_IN_SITE].map((site) => new URL(site).hostname));
const SIGNATURE_LIKE_PARAMETER = /checksum|stamp|otp|jwt|session|auth|key|hash|sig|token/i;

/**
 * True for a link anybody could open: an absolute https address off the session hosts, the imaging
 * viewer and the portal application paths, with no credentials and no query parameter that reads like
 * a signature. Health-guide articles and eligibility pages are of this kind and count as plain
 * content. Every other link is private. Private links are not removed either (results keep every field
 * Maccabi sent); the caller marks each with a `*_reference` or `*_present` field next to it.
 */
export function isOpenLink(candidate: string): boolean {
  if (!URL.canParse(candidate)) return false;
  const { protocol, username, password, hostname, pathname, searchParams } = new URL(candidate);
  if (protocol !== "https:" || username !== "" || password !== "") return false;
  if (SESSION_HOSTS.has(hostname.toLowerCase()) || /^meddreamy\./i.test(hostname)) return false;
  if (/^\/s?online\//i.test(pathname)) return false;
  return ![...searchParams.keys()].some((prop) => SIGNATURE_LIKE_PARAMETER.test(prop));
}

const CHECKSUM_PARAMETER = /[?&](?:checksum(?:_?id)?|id_?tech)=/i;

/**
 * Looks for the member checksum in a link as written, then after one and after two rounds of
 * percent-decoding. A checksum or id_tech query parameter counts whatever its value; so does the
 * member's own checksum value, wherever in the text it sits.
 */
export function holdsChecksum(href: string, checksum: string | undefined): boolean {
  let text = href;
  for (let decodings = 0; ; decodings += 1) {
    if (CHECKSUM_PARAMETER.test(text) || (checksum && text.includes(checksum))) return true;
    const decoded = decodings < 2 ? percentDecoded(text) : undefined;
    if (decoded === undefined || decoded === text) return false;
    text = decoded;
  }
}

// ---- Days ----

export function todayLocal(): string {
  const now = new Date();
  const twoDigits = (part: number) => String(part).padStart(2, "0");
  return [now.getFullYear(), twoDigits(now.getMonth() + 1), twoDigits(now.getDate())].join("-");
}

/** The same calendar day `years` earlier, counted the way the portal counts: 29 February lands on the 28th. */
export function yearsBefore(day: string, years: number): string {
  const dash = day.indexOf("-");
  const year = String(Number(day.slice(0, dash)) - years).padStart(4, "0");
  const monthAndDay = day.slice(dash + 1);
  return `${year}-${monthAndDay === "02-29" ? "02-28" : monthAndDay}`;
}

/** The range the website's date picker opens with: from a year before `today` up to `today`. */
export function yearUpTo(today: string): DaySpan {
  return { from: yearsBefore(today, 1), to: today };
}

const DAY_LAYOUT = "0000-00-00";
const MOMENT_LAYOUT = `${DAY_LAYOUT}T00:00:00`;

/** Whether `text` is written like `layout`: a digit wherever the layout has a zero, the layout's own character elsewhere. */
function writtenLike(layout: string, text: string): boolean {
  if (typeof text !== "string" || text.length !== layout.length) return false;
  return layout.split("").every((mark, at) => {
    const unit = text.charAt(at);
    return mark === "0" ? unit >= "0" && unit <= "9" : unit === mark;
  });
}

/** A day that exists, written YYYY-MM-DD. The trip through Date is what turns 30 February away. */
function isCalendarDay(dayText: string): boolean {
  if (!writtenLike(DAY_LAYOUT, dayText)) return false;
  const midnight = new Date(`${dayText}T00:00:00Z`);
  return !Number.isNaN(midnight.getTime()) && midnight.toISOString().startsWith(dayText);
}

/**
 * A moment the way the portal writes one, YYYY-MM-DDTHH:MM:SS: wall-clock text with no zone. The date
 * and the time both have to exist.
 */
export function isPortalMoment(text: string): boolean {
  if (!writtenLike(MOMENT_LAYOUT, text)) return false;
  const moment = new Date(`${text}Z`);
  return !Number.isNaN(moment.getTime()) && moment.toISOString().startsWith(text);
}

export function checkDaySpan(span: DaySpan): void {
  if (!isCalendarDay(span.from) || !isCalendarDay(span.to))
    throw new TypeError("a date range needs two real days written YYYY-MM-DD");
  if (span.to < span.from) throw new TypeError("a date range cannot end before it starts");
}

// ---- Documents ----

/**
 * The largest original PDF this client reads. A longer body is cut off while it streams, so it is
 * never held whole just to be measured. The MCP server counts on this cap when it embeds a document
 * in a reply.
 */
export const MAX_PDF_BYTES = 2 * 1024 * 1024;

const PDF_OPENING = Buffer.from("%PDF-", "latin1");

/** A PDF opens with `%PDF-`. Bytes that do not are refused, whatever the response called them. */
export function mustBePdf(buffer: Uint8Array, label: string): Uint8Array {
  if (!PDF_OPENING.equals(buffer.subarray(0, PDF_OPENING.length)))
    throw refuse("UNEXPECTED_ANSWER", label, "file:not-a-pdf");
  return buffer;
}

const BASE64_SYMBOL = "[0-9A-Za-z+/]";
/** Standard base64 in whole groups of four, padded only at the end: no whitespace, no URL-safe alphabet. */
const PADDED_BASE64 = new RegExp(`^(?:${BASE64_SYMBOL}{4})*(?:${BASE64_SYMBOL}{2}==|${BASE64_SYMBOL}{3}=)?$`);

export function pdfFromBase64(base64: unknown, label: string): Uint8Array {
  if (typeof base64 !== "string" || !PADDED_BASE64.test(base64))
    throw refuse("UNEXPECTED_ANSWER", label, "file:base64");
  const decoded = Buffer.from(base64, "base64");
  // The pattern still lets stray bits ride in the last group; only text that encodes back to itself passes.
  if (decoded.toString("base64") !== base64) throw refuse("UNEXPECTED_ANSWER", label, "file:base64");
  // Copied out, so the caller holds the document and not a window onto Buffer's shared pool.
  return mustBePdf(new Uint8Array(decoded), label);
}

export function pdfFromEnvelope(payload: Fields, label: string): Uint8Array {
  if (payload.type === "pdf") return pdfFromBase64(payload.base64, label);
  throw refuse("UNEXPECTED_ANSWER", label, "key:type");
}

// ---- Fetching ----

/** Throws `refusal` for a response whose body will go unread, after letting that body go so its connection is freed. */
export async function turnAway(reply: Response, refusal: Error): Promise<never> {
  await release(reply);
  throw refusal;
}

/** A status outside 2xx is refused with that status. */
export async function mustBeOk(reply: Response, label: string): Promise<void> {
  if (!reply.ok) await turnAway(reply, new ReadRefusal("PORTAL_HTTP_ERROR", label, reply.status));
}

/** The media type a response declares, lower-cased and without parameters; empty when it declares none. */
export function mediaType(reply: Response): string {
  const [essence = ""] = (reply.headers.get("content-type") ?? "").split(";");
  return essence.trim().toLowerCase();
}

/**
 * Marks of the logon and logout pages of the F5 BIG-IP gateway in front of the portal. An expired
 * session was observed as a 302 to `/my.policy`, and the transport already stops at that. The page
 * behind the redirect is a 200 `text/html` one, though, so a gateway that skipped the redirect would
 * hand it straight to a JSON read. HTML bearing one of these marks therefore means the session is
 * over. HTML without them means this client met a page it cannot parse, and the caller is told that
 * instead.
 */
const GATEWAY_LOGON_PAGE = /my\.(?:policy|logout\.php3)|\bF5\b/i;

/** Whether a body is the gateway's logon or logout page. Only its opening stretch is searched for the marks. */
export const isGatewayLogonPage = (body: string): boolean => GATEWAY_LOGON_PAGE.test(body.slice(0, 8192));

/**
 * One JSON read. `noContent` is set by the few reads where Maccabi was seen answering 204 for
 * "nothing here" (the appointment finder, the visit linked to an inquiry, and the biobank, Switchit
 * and pending-referral catalog entries); they get null. For every other read an empty answer is a
 * broken one. A refusal carries a fixed token and a status: never a body, an address or a value.
 */
export async function getJson(
  http: MemberHttp,
  where: string,
  label: string,
  setup?: RequestInit,
  noContent = false,
): Promise<unknown> {
  const reply = await http.request(where, setup);
  if (reply.status === 204 && noContent) {
    await release(reply);
    return null;
  }
  await mustBeOk(reply, label);
  const declared = reply.headers.get("content-type") ?? "";
  if (!declared.toLowerCase().includes("html"))
    return jsonUpTo(reply, refuse("UNEXPECTED_ANSWER", label, "body-not-json-or-oversized"));
  const page = await textUpTo(reply, refuse("UNEXPECTED_ANSWER", label, "body-unreadable"));
  if (isGatewayLogonPage(page)) throw new SessionEnded(reply.status);
  throw refuse("UNEXPECTED_ANSWER", label, "html-where-json");
}

const CHARSET_PARAMETER = /;\s*charset\s*=\s*(?:"(?<quoted>[^"]+)"|(?<bare>[^\s;]+))/gi;
const CLASSIC_CHARSETS = new Set(["windows-1255", "utf-8"]);

/**
 * The text of a classic page or script-service answer, in the charset its header declares. Only the
 * two encodings seen on the wire are taken, UTF-8 standing in when none is declared, and decoding is
 * strict: a byte that does not fit fails the read where a replacement character would have hidden
 * it. The JSON services never come through here; they are UTF-8 throughout.
 */
export async function classicBody(reply: Response, label: string): Promise<string> {
  const declared = [...(reply.headers.get("content-type") ?? "").matchAll(CHARSET_PARAMETER)];
  const charset = (declared[0]?.groups?.quoted ?? declared[0]?.groups?.bare ?? "utf-8").toLowerCase();
  if (declared.length > 1 || !CLASSIC_CHARSETS.has(charset))
    await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "page-charset"));
  const buffer = await bytesUpTo(reply, 1024 * 1024, refuse("UNEXPECTED_ANSWER", label, "body-unreadable"));
  try {
    return new TextDecoder(charset, { fatal: true }).decode(buffer);
  } catch {
    throw refuse("UNEXPECTED_ANSWER", label, "page-charset");
  }
}
