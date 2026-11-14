/**
 * The MedDream viewer behind an imaging study: getting from a portal session to a viewer session, and
 * the four things a viewer session can then read.
 *
 * Getting in takes eight requests, all of them plain HTTP. Two of the answers are HTML pages whose
 * form submits itself; the fields the form would send are written out in the page's markup. Two
 * others are redirects, and the address they point to is the one place a needed value appears. The
 * last request is what signs the session in: the viewer answers it by replacing its application
 * cookie. Cookies carry the whole exchange. The transport's jar, which scopes every cookie to the
 * host that set it, is therefore all it takes: the portal's API authorization is never sent, and
 * none of the pages' scripts is executed.
 *
 * The arithmetic on pixel data is written for any image and refuses what it cannot account for; it
 * does not take the numbers of any one study for granted. Which HTTP status the viewer uses for an
 * error is not known, since none has been seen.
 */
import {
  bytesUpTo,
  type HttpRequest,
  PORTAL_SITE,
  release,
  SIGN_IN_SITE,
  textUpTo,
  utf8Strictly,
  VIEWER_ENTRY_PATH,
  VIEWER_SITE,
} from "../../http";
import { type Guard, guardFor } from "./guards";

export interface ViewerHttp {
  request(input: string | URL, setup?: HttpRequest): Promise<Response>;
  /** The real transport always has it. It is optional only to spare a stand-in from writing one. */
  forgetViewerCookies?(): Promise<void>;
}

/**
 * Every code here is one of the reader's own refusal codes, so the reader can raise a viewer refusal
 * again under the name of its operation and the guidance written for that code still applies. That
 * holds for NO_PORTAL_TOKEN too: here it means the handoff ended without a viewer session, and the
 * advice attached to the code is the right advice for that.
 */
export type ViewerRefusalCode = "PORTAL_HTTP_ERROR" | "UNEXPECTED_ANSWER" | "NO_PORTAL_TOKEN" | "NOT_OFFERED";
export class ViewerRefusal extends Error {
  constructor(
    readonly code: ViewerRefusalCode,
    readonly status?: number,
  ) {
    super(`The imaging viewer could not be read (${code})`);
    this.name = "ViewerRefusal";
  }
}

/** What the handoff leaves behind for the reads that follow, besides the cookie in the transport's jar. */
export interface ViewerSession {
  studyInstanceUID: string;
  modality: string;
  storageId: string;
  referer: string;
  /** Spring Security puts one on every answer. A GET passes without it; it is sent back because the viewer's own page sends it. */
  csrfToken?: string;
}
export interface StudyImage {
  sopInstanceUID: string;
  sopClassUID: string;
  transferSyntaxUID: string;
  /** Not filled in by /structure: seen live as 0 for an image whose /metadata says 1. */
  numberOfFrames: number;
  [prop: string]: unknown;
}
export interface StudySeries {
  seriesInstanceUID: string;
  modality: string;
  instances: StudyImage[];
  [prop: string]: unknown;
}
export interface StudyTree {
  studyInstanceUID: string;
  storageId: string;
  mainModality: string;
  studyDate: string;
  studyTime: string;
  series: StudySeries[];
  [prop: string]: unknown;
}
export interface ImageDetails {
  studyInstanceUID: string;
  seriesInstanceUID: string;
  sopInstanceUID: string;
  /** The syntax the pixels are served in, after decoding. The stored syntax is the one /structure names. */
  transferSyntaxUID: string;
  rows: number;
  columns: number;
  bitsAllocated: number;
  samplesPerPixel: number;
  numberOfFrames: number;
  [prop: string]: unknown;
}
/** How to read a pixel buffer. The buffer says none of this about itself, so it never travels without it. */
export interface PixelLayout {
  rows: number;
  columns: number;
  samplesPerPixel: number;
  numberOfFrames: number;
  bitsAllocated: number;
  bitsStored?: number;
  pixelRepresentation?: number;
  photometricInterpretation?: string;
  transferSyntaxUID: string;
  windowWidth?: unknown;
  windowCenter?: unknown;
  expectedBytes: number;
  bytesPerFrame: number;
}
export interface PixelData extends PixelLayout {
  pixels: Uint8Array;
}

const MEGABYTE = 1024 * 1024;
const PAGE_LIMIT = 4 * MEGABYTE;
const MAX_JSON_BYTES = 4 * MEGABYTE;
const MAX_PREVIEW_BYTES = 8 * MEGABYTE;
/**
 * The most pixel data that will be asked for. The size is worked out from the image's metadata, so an
 * image over the limit is refused, by name, before any of it is requested. A cine series with many
 * frames is what would grow without bound, and it is better refused than read into memory.
 */
export const MAX_PIXEL_BYTES = 64 * MEGABYTE;

const check: Guard = guardFor(() => new ViewerRefusal("UNEXPECTED_ANSWER"));

/**
 * A DICOM UID: digits in dot-separated groups, 64 characters at most, which is also what the ones seen
 * live look like. A UID becomes part of an address, so nothing else is let through.
 */
export function mustBeUid(value: unknown): string {
  const uid = check.string(value);
  return uid.length <= 64 && /^\d+(?:\.\d+)*$/.test(uid) ? uid : check.fail();
}
function storageId(value: unknown): string {
  const id = check.string(value);
  return /^[\w-]{1,64}$/.test(id) ? id : check.fail();
}
function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : check.fail();
}

// ---- Requests and their answers.

/** No viewer request carries the portal's API authorization; the cookie jar is what signs them. */
const page = (referer: string): HttpRequest => ({
  bearer: false,
  headers: { accept: "text/html,application/xhtml+xml", referer },
});
/**
 * Submits a form to the viewer host's gateway the way the browser submits the page's own: urlencoded
 * and coming from `origin`. The gateway answers with a redirect, which is returned and not followed.
 */
function submitForm(
  http: ViewerHttp,
  action: URL,
  fields: Record<string, string>,
  origin: string,
  referer: string,
): Promise<Response> {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const headers = { referer, origin, "content-type": "application/x-www-form-urlencoded" };
  return http.request(action, { bearer: false, method: "POST", headers, body: `${form}`, redirect: "manual" });
}
/** A request the way the viewer's own page makes it once the session exists. */
function asViewer({ csrfToken, referer }: Pick<ViewerSession, "csrfToken" | "referer">): HttpRequest {
  const headers: Record<string, string> = { accept: "*/*", referer };
  if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken;
  return { bearer: false, headers };
}

/** An answer that is going to be read: it succeeded and, where a type is expected, declares it. */
async function answer(
  http: ViewerHttp,
  address: URL,
  setup: HttpRequest,
  declares?: (contentType: string | null) => boolean,
): Promise<Response> {
  const reply = await http.request(address, setup);
  const mistyped = reply.ok && declares !== undefined && !declares(reply.headers.get("content-type"));
  if (reply.ok && !mistyped) return reply;
  await release(reply);
  throw new ViewerRefusal(mistyped ? "UNEXPECTED_ANSWER" : "PORTAL_HTTP_ERROR", reply.status);
}
const unreadable = (reply: Response): ViewerRefusal => new ViewerRefusal("UNEXPECTED_ANSWER", reply.status);
/** The declared media type is exactly `type`, whatever parameters follow it. */
const exactly =
  (type: string) =>
  (contentType: string | null): boolean =>
    contentType?.split(";")[0]?.trim() === type;

async function askViewer(http: ViewerHttp, address: URL, session: Pick<ViewerSession, "csrfToken" | "referer">) {
  const reply = await answer(http, address, asViewer(session), (type) => type?.toLowerCase().includes("json") === true);
  const cannotRead = unreadable(reply);
  // Strictly UTF-8: a byte sequence that is not valid fails the read instead of being patched over.
  const body = utf8Strictly(await bytesUpTo(reply, MAX_JSON_BYTES, cannotRead), cannotRead);
  let content: unknown;
  try {
    content = JSON.parse(body);
  } catch {
    throw cannotRead;
  }
  return check.object(content);
}

/**
 * Where a redirect leads, without going there: at two points of the handoff the address itself is
 * what is wanted. A redirect that leaves `site`, or that misses the one `path` expected of it, is a
 * handoff that did not go as seen live.
 */
async function redirectOf(reply: Response, requested: URL | string, site: string, path?: string): Promise<URL> {
  await release(reply);
  const { status } = reply;
  if (![301, 302, 303, 307, 308].includes(status))
    throw new ViewerRefusal(status < 400 ? "NO_PORTAL_TOKEN" : "PORTAL_HTTP_ERROR", status);
  const location = reply.headers.get("location");
  const target = location && URL.canParse(location, requested) ? new URL(location, requested) : undefined;
  if (target?.origin !== site || (path !== undefined && target.pathname !== path))
    throw new ViewerRefusal("NO_PORTAL_TOKEN", status);
  return target;
}

/** The character references a server writes into an attribute value, each without its ampersand. */
const WRITTEN_AS = [
  ["quot;", '"'],
  ["apos;", "'"],
  ["#39;", "'"],
  ["lt;", "<"],
  ["gt;", ">"],
  ["amp;", "&"],
] as const;

/**
 * An attribute value with those references resolved, in a single pass: text that a reference
 * produced is never read as the start of another.
 */
function resolved(value: string): string {
  const [first = "", ...afterAmpersands] = value.split("&");
  const rest = afterAmpersands.map((piece) => {
    const reference = WRITTEN_AS.find(([name]) => piece.startsWith(name));
    return reference ? reference[1] + piece.slice(reference[0].length) : `&${piece}`;
  });
  return first + rest.join("");
}

/** One attribute of a tag, however its value is quoted. */
function attributeIn(tag: string, name: "name" | "value"): string | undefined {
  const found = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`, "i").exec(tag);
  return found?.[1] ?? found?.[2] ?? found?.[3];
}

/**
 * The fields a self-submitting page would send, read straight from its markup: each input's name
 * with its value, the first input winning where a name repeats. That stands in for a browser here;
 * the page's inline script is neither needed nor run. Only the entities a server writes into an
 * attribute value are decoded.
 */
export function hiddenInputs(markup: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [tag] of markup.matchAll(/<input\b[^>]*>/gi)) {
    const name = attributeIn(tag, "name");
    if (name === undefined || fields.has(name)) continue;
    fields.set(name, resolved(attributeIn(tag, "value") ?? ""));
  }
  return fields;
}
async function formFields(http: ViewerHttp, address: URL, referer: string): Promise<Map<string, string>> {
  const reply = await answer(http, address, page(referer));
  return hiddenInputs(await textUpTo(reply, unreadable(reply), PAGE_LIMIT));
}

// ---- The handoff.

/**
 * The address the handoff starts from: a portal request, made with the session, that answers with a
 * redirect to the sign-in host. An F5 session that has run out answers in exactly that way, which
 * is why the transport makes its one exception for this destination. The address names the member
 * (member_id_code and member_id) and carries the member's checksum, so it works as a credential. It
 * is put together here and given to `enterViewer`, and no caller of the reader gets to see it.
 */
export function viewerEntry(
  me: { memberId: number; memberIdCode: string },
  viewerChecksum: string,
  studyInstanceUID: string,
): string {
  const study = encodeURIComponent(mustBeUid(studyInstanceUID));
  if (!/^[A-Za-z0-9]{1,128}$/.test(viewerChecksum)) throw new ViewerRefusal("NO_PORTAL_TOKEN");
  const member = `${encodeURIComponent(me.memberIdCode)}/${me.memberId}`;
  return `/sonline/TestResultsAPI/webapi/mac/pdf/members/${member}/meddream/token/${study}?checksum=${viewerChecksum}`;
}

const LOBBY = `${PORTAL_SITE}/sonline/testsResults/TestsResults/lobby/`;
const FROM_SIGN_IN = `${SIGN_IN_SITE}/`;

/** Requests 1 and 2: the portal sends the session on to the sign-in host, which issues a SAML assertion for the viewer. */
async function samlAssertion(http: ViewerHttp, entry: string): Promise<Map<string, string>> {
  const sentOn = await http.request(entry, {
    bearer: false,
    viewerEntry: true,
    redirect: "manual",
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", referer: LOBBY },
  });
  const signIn = await redirectOf(sentOn, PORTAL_SITE, SIGN_IN_SITE, VIEWER_ENTRY_PATH);
  // The sign-in host keeps no state for this: the JWE in the address is the credential, all of it.
  // Its answer is a page whose form posts the signed assertion.
  return formFields(http, signIn, LOBBY);
}

/**
 * Requests 3 to 6: the viewer host's gateway. Posting the assertion opens an F5 session of the
 * viewer's own. The gateway then asks for a second post, which returns the nonce it wrote into a small
 * page so that the first cannot be replayed. After that the APM redirects to the viewer with the HIS
 * token added to the address. That redirect is the one place the token can be read, unless the signed
 * assertion that brought it were taken apart.
 */
async function viewerShell(http: ViewerHttp, assertion: Map<string, string>): Promise<URL> {
  const SAMLResponse = assertion.get("SAMLResponse");
  if (!SAMLResponse) throw new ViewerRefusal("NO_PORTAL_TOKEN");
  const acs = new URL("/saml/sp/profile/post/acs", VIEWER_SITE);
  const asserted = { SAMLResponse, RelayState: assertion.get("RelayState") ?? "" };
  const afterAssertion = await submitForm(http, acs, asserted, SIGN_IN_SITE, FROM_SIGN_IN);
  const policy = await redirectOf(afterAssertion, acs, VIEWER_SITE, "/my.policy");

  const dummy = (await formFields(http, policy, FROM_SIGN_IN)).get("dummy");
  if (dummy === undefined) throw new ViewerRefusal("NO_PORTAL_TOKEN");
  const afterEcho = await submitForm(http, acs, { dummy }, VIEWER_SITE, policy.href);
  const front = await redirectOf(afterEcho, acs, VIEWER_SITE, "/");

  const bare: HttpRequest = { bearer: false, redirect: "manual", headers: { referer: FROM_SIGN_IN } };
  return redirectOf(await http.request(front, bare), front, VIEWER_SITE, "/");
}

/**
 * The whole handoff, for one study. It is done when `/his` has swapped MEDDREAMSESSID for a
 * signed-in one; the reads below then travel on that cookie, which the transport's jar holds. Every
 * study gets a handoff of its own. The portal mints the handoff token for a single click, and nothing
 * seen live suggests that a viewer session may be used for a study it was not opened for.
 */
export async function enterViewer(http: ViewerHttp, entry: string, studyInstanceUID: string): Promise<ViewerSession> {
  // The viewer host's cookies go first. Measured live on 2026-10-04: with them still in the jar the
  // gateway answers the assertion differently and issues no token, and every study after the first
  // fails with NO_PORTAL_TOKEN.
  await http.forgetViewerCookies?.();
  const viewerPage = await viewerShell(http, await samlAssertion(http, entry));
  const viewerToken = viewerPage.searchParams.get("token");
  if (!viewerToken) throw new ViewerRefusal("NO_PORTAL_TOKEN");

  // Request 7: the viewer's page. Loading it sets an application cookie that is not signed in yet,
  // and brings the first CSRF token.
  const shell = await http.request(viewerPage, page(FROM_SIGN_IN));
  const csrfToken = shell.headers.get("x-csrf-token") ?? undefined;
  await release(shell);
  if (!shell.ok) throw new ViewerRefusal("PORTAL_HTTP_ERROR", shell.status);

  // Request 8 signs the session in: the viewer swaps MEDDREAMSESSID for a new value, and a /studies
  // request without that value fails.
  const referer = viewerPage.href;
  const his = await askViewer(http, new URL(`/his?token=${encodeURIComponent(viewerToken)}`, VIEWER_SITE), {
    csrfToken,
    referer,
  });
  if (!Array.isArray(his.studyIds)) check.fail();
  const granted = his.studyIds.map(check.object).find((study) => study.studyUid === studyInstanceUID);
  // Whose study this is was settled before the handoff began. If the requested study is missing
  // from what the viewer grants, the viewer has contradicted itself, and that is what gets reported:
  // an answer that makes no sense, not an attempt on someone else's study.
  if (!granted) return check.fail();
  return {
    studyInstanceUID: mustBeUid(granted.studyUid),
    storageId: storageId(granted.storageId),
    modality: check.string(granted.modality),
    csrfToken,
    referer,
  };
}

// ---- What a session can read.

function studyAddress(session: ViewerSession, rest: string): URL {
  const address = new URL(`/studies/${encodeURIComponent(session.studyInstanceUID)}${rest}`, VIEWER_SITE);
  address.searchParams.set("storageId", session.storageId);
  return address;
}
function imageAddress(session: ViewerSession, seriesInstanceUID: string, sopInstanceUID: string, leaf: string): URL {
  const series = encodeURIComponent(mustBeUid(seriesInstanceUID));
  const image = encodeURIComponent(mustBeUid(sopInstanceUID));
  return studyAddress(session, `/series/${series}/images/${image}/${leaf}`);
}

/** The study with its series and their images. The per-image reads take their address from the UIDs in it. */
export async function studyTree(http: ViewerHttp, session: ViewerSession): Promise<StudyTree> {
  const tree = await askViewer(http, studyAddress(session, "/structure"), session);
  if (mustBeUid(tree.studyInstanceUID) !== session.studyInstanceUID || !Array.isArray(tree.series)) check.fail();
  for (const entry of tree.series) {
    const series = check.object(entry);
    mustBeUid(series.seriesInstanceUID);
    if (!Array.isArray(series.instances)) check.fail();
    for (const image of series.instances) mustBeUid(check.object(image).sopInstanceUID);
  }
  return tree as unknown as StudyTree;
}

/** One image's DICOM fields. They include the numbers that /pixels needs and does not send. */
export async function imageDetails(
  http: ViewerHttp,
  session: ViewerSession,
  seriesInstanceUID: string,
  sopInstanceUID: string,
): Promise<ImageDetails> {
  const details = await askViewer(http, imageAddress(session, seriesInstanceUID, sopInstanceUID, "metadata"), session);
  // The answer repeats the study, series and image it was asked for. If one differs, it describes another image.
  const asked = { studyInstanceUID: session.studyInstanceUID, seriesInstanceUID, sopInstanceUID };
  for (const [uid, value] of Object.entries(asked)) if (details[uid] !== value) check.fail();
  return details as unknown as ImageDetails;
}

/**
 * The size and shape the pixel buffer must have, worked out from what this image's metadata says and
 * not from any one modality. An image with 16-bit samples gets twice the bytes per frame, and one with
 * several frames a multiple of them, without either being a case of its own. Samples that do not fill
 * whole bytes have no layout defined here; such an image is refused, not guessed at.
 */
export function pixelLayout(details: ImageDetails): PixelLayout {
  const rows = positiveInteger(details.rows);
  const columns = positiveInteger(details.columns);
  const samplesPerPixel = positiveInteger(details.samplesPerPixel);
  const bitsAllocated = positiveInteger(details.bitsAllocated);
  // /structure says 0 frames for an image whose /metadata says 1, so there a zero means "not filled
  // in". Let through here, a zero would turn the expected size into nothing without any complaint.
  const numberOfFrames = positiveInteger(details.numberOfFrames);
  if (bitsAllocated > 64 || bitsAllocated % 8 !== 0) throw new ViewerRefusal("NOT_OFFERED");
  const bytesPerSample = bitsAllocated / 8;
  const bytesPerFrame = rows * columns * samplesPerPixel * bytesPerSample;
  const expectedBytes = numberOfFrames * bytesPerFrame;
  if (expectedBytes > MAX_PIXEL_BYTES || !Number.isSafeInteger(expectedBytes)) throw new ViewerRefusal("NOT_OFFERED");
  const layout: PixelLayout = {
    rows,
    columns,
    samplesPerPixel,
    bitsAllocated,
    numberOfFrames,
    bytesPerFrame,
    expectedBytes,
    transferSyntaxUID: check.string(details.transferSyntaxUID),
  };
  // The rest is passed on when the image has it, and left out when it does not.
  if (typeof details.bitsStored === "number") layout.bitsStored = details.bitsStored;
  if (typeof details.pixelRepresentation === "number") layout.pixelRepresentation = details.pixelRepresentation;
  if (typeof details.photometricInterpretation === "string")
    layout.photometricInterpretation = details.photometricInterpretation;
  if (details.windowCenter !== undefined) layout.windowCenter = details.windowCenter;
  if (details.windowWidth !== undefined) layout.windowWidth = details.windowWidth;
  return layout;
}

/**
 * An image's pixels as the viewer serves them, together with their layout. The body is sample data
 * from its first byte to its last and carries nothing to recognise it by. Its length is the one
 * thing a client can verify, against the size the metadata works out to, which is also why the
 * layout is returned along with the bytes. `content-length` is not that length: it counts the
 * compressed body, and stays out of the comparison.
 */
export async function imagePixels(
  http: ViewerHttp,
  session: ViewerSession,
  seriesInstanceUID: string,
  sopInstanceUID: string,
  details: ImageDetails,
): Promise<PixelData> {
  const layout = pixelLayout(details);
  const address = imageAddress(session, seriesInstanceUID, sopInstanceUID, "pixels");
  const reply = await answer(http, address, asViewer(session), exactly("application/octet-stream"));
  const pixels = await bytesUpTo(reply, MAX_PIXEL_BYTES, unreadable(reply));
  if (pixels.byteLength !== layout.expectedBytes) throw unreadable(reply);
  return { ...layout, pixels };
}

/**
 * The preview the viewer renders of an image: a baseline JPEG, which is not DICOM. No way of asking
 * for a particular size was ever seen.
 */
export async function imagePreview(
  http: ViewerHttp,
  session: ViewerSession,
  seriesInstanceUID: string,
  sopInstanceUID: string,
): Promise<Uint8Array> {
  const address = imageAddress(session, seriesInstanceUID, sopInstanceUID, "thumbnail");
  // The answer is typed `image/jpeg;charset=UTF-8`. A charset means nothing for a JPEG; the server adds it anyway.
  const reply = await answer(http, address, asViewer(session), exactly("image/jpeg"));
  const jpeg = await bytesUpTo(reply, MAX_PREVIEW_BYTES, unreadable(reply));
  // A JPEG opens with the start-of-image marker and the first byte of the next one, and closes with end-of-image.
  const opens = jpeg.byteLength >= 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff;
  if (!opens || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw unreadable(reply);
  return jpeg;
}
