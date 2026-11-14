/**
 * Papers Maccabi addressed to the member: the notifications and letters of the mailbox, the information
 * sheets handed out around treatments, and medical certificates. Each kind is listed for a date range
 * and its PDFs are fetched by a reference that only a list of that same range can resolve.
 */
import { ReadRefusal, refuse } from "../faults";
import { bytesUpTo, PORTAL_SITE, release } from "../http";
import type { MemberScope } from "./context";
import { type Mailing, MailingShapeError, shapeMailings } from "./parse/mailings";
import {
  asObject,
  asString,
  checkDaySpan,
  checkOptional,
  type DaySpan,
  digestOf,
  type Fields,
  getJson,
  MAX_PDF_BYTES,
  mediaType,
  mustBeOk,
  mustBePdf,
  mustBeReference,
  namesMember,
  overSource,
  queryValue,
  type Reading,
  SteadyReferences,
  turnAway,
  unescapeComponent,
} from "./shared";

const DIRECTORSHIP = "DirectorshipAPI";
const MAIN_APP = "MainAppAPI";
const MEDICAL_FILE = "MedicalFileAPI";
const MAX_LINK = 16384;
/** How often a PDF that is still being prepared is asked for, and how long to wait in between. */
const PREPARING_ATTEMPTS = 6;
const PREPARING_WAIT_MS = 5000;

const LETTER_TEXT = ["letter_desc", "item_date", "original_item_date"];
const INFORMATION_OPTIONAL = ["display_text", "practitioner_name", "specialization"];
/** What tells one information item from another once its link is set aside, in reference order. */
const INFORMATION_IDENTITY = ["session_datetime", "type_id", ...INFORMATION_OPTIONAL];
const INFORMATION_TYPES: readonly unknown[] = [1, 2, 3];
/** The fields of a certificate the website shows. In this order they are also its identity. */
const CERTIFICATE_SHOWN = [
  "title_name",
  "practitioner_full_name",
  "specialization_description",
  "approval_date",
  "approval_date_from",
  "approval_date_to",
  "approval_type_code",
] as const;
const CERTIFICATE_SIGNED = ["pdf_link", "timestamp", "hash"] as const;

/** A certificate row as sent, its short-lived link and signature included, plus the reference to fetch it by. */
export type Certificate = Fields &
  Record<(typeof CERTIFICATE_SHOWN)[number] | (typeof CERTIFICATE_SIGNED)[number] | "reference", string>;

/**
 * A notification's document as remembered for fetching. `signed` is the object that carries its link
 * and signature: the row itself for types 1 and 2, one of the row's tutorials for type 3.
 */
interface MailedFile {
  letterType: 1 | 2 | 3;
  signed: Fields;
}

/** The fetchable documents of the list read last, together with the date range that list covered. */
class ListedFiles<File> {
  #files = new Map<string, File>();
  #span?: string;

  hold(span: DaySpan, files: Map<string, File>): void {
    this.#files = files;
    this.#span = `${span.from}/${span.to}`;
  }
  isFor(span: DaySpan): boolean {
    return this.#span === `${span.from}/${span.to}`;
  }
  get(reference: string): File | undefined {
    return this.#files.get(reference);
  }
}

/**
 * One list's documents while the list is being read. A private link or a reference that turns up a
 * second time means the list contradicts itself, and the whole read is refused.
 */
class FilesOfList<File> {
  readonly byReference = new Map<string, File>();
  readonly #links = new Set<string>();

  constructor(private readonly label: string) {}

  claimLink(link: unknown): void {
    const key = JSON.stringify(link);
    if (this.#links.has(key)) throw this.#twice();
    this.#links.add(key);
  }
  add(reference: string, file: File): void {
    if (this.byReference.has(reference)) throw this.#twice();
    this.byReference.set(reference, file);
  }
  #twice(): ReadRefusal {
    return refuse("UNEXPECTED_ANSWER", this.label, "row-twice");
  }
}

export class Mailings {
  readonly #notifications = new ListedFiles<MailedFile>();
  readonly #information = new ListedFiles<Fields>();
  readonly #certificates = new ListedFiles<Fields>();

  constructor(private readonly scope: MemberScope) {}

  /**
   * The mailbox for a date range, as this call returned it. A row whose document can be fetched carries
   * a `reference`; a type-3 row carries a `pdf_reference` on each of its PDF tutorials instead.
   */
  async allNotifications(span: DaySpan): Promise<Reading<Fields[]>> {
    checkDaySpan(span);
    const label = "mailings";
    const route = this.scope.path(DIRECTORSHIP, "v1", "all/letters_for_member");
    const asked = this.scope.post({ from_date: span.from, to_date: span.to, members: [this.scope.member()] });
    const sent = asObject(await getJson(this.scope.http, route, label, asked), label);
    const files = new FilesOfList<MailedFile>(label);
    const references = new SteadyReferences();
    const rows = this.scope.rows(sent.letters, label, "letters").map((row): Fields => {
      this.#mustBeMembersOwn(row, label);
      if (row.letter_type === 1) return this.#letter(row, files, label);
      if (row.letter_type !== 2 && row.letter_type !== 3) throw refuse("NOT_OFFERED", label, "letter-kind-unknown");
      let shaped: Mailing;
      try {
        shaped = shapeMailings([row])[0]!;
      } catch (error) {
        throw error instanceof MailingShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
      }
      const shown = overSource(row, shaped);
      const dated = [row.item_date, row.original_item_date];
      if (shown.letter_type === 2) {
        if (!shown.has_document) return shown;
        files.claimLink(row.link);
        const reference = references.next(["notification", 2, ...dated, shown.status]);
        files.add(reference, { letterType: 2, signed: row });
        return { ...shown, reference };
      }
      const sentTutorials = row.tutorials as Fields[];
      const tutorials = shown.tutorials.map((tutorial, at) => {
        if (tutorial.tutorial_type !== "pdf") return tutorial;
        const signed = asObject(sentTutorials[at], label, "tutorial");
        files.claimLink(signed.url);
        const within = [row.service_type_text, row.practitioner_name, at, tutorial.display_text];
        const reference = references.next(["notification", 3, ...dated, ...within]);
        files.add(reference, { letterType: 3, signed });
        return { ...tutorial, pdf_reference: reference };
      });
      return { ...shown, tutorials };
    });
    this.#notifications.hold(span, files.byReference);
    // Only letters (type 1) are passed on unprojected; the other kinds follow the website's rendering.
    const anyProjected = rows.some((row) => row.letter_type !== 1);
    return anyProjected
      ? this.scope.renderedResult(rows, DIRECTORSHIP, label)
      : this.scope.result(rows, DIRECTORSHIP, label);
  }

  /** The PDF of a notification, by a reference from the list of the same date range. */
  async fetchNotificationPdf(reference: string, span: DaySpan): Promise<Reading<Uint8Array>> {
    checkDaySpan(span);
    const label = "mailing-pdf";
    mustBeReference(reference, label);
    // The list at hand is good enough for a letter, as long as it covers the same dates. A type-2 or
    // type-3 document is always looked up in a list read anew.
    const held = this.#notifications.get(reference);
    if (!this.#notifications.isFor(span) || (held !== undefined && held.letterType !== 1))
      await this.allNotifications(span);
    const file = this.#notifications.get(reference);
    if (!file) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    const { signed } = file;
    const part = (value: unknown): string => queryValue(value, MAX_LINK, label);
    if (file.letterType === 2) {
      const route = this.scope.path(MAIN_APP, "v1", "features");
      const switches = this.scope
        .rows(await getJson(this.scope.http, route, label), label)
        .filter((one) => one.feature_id === "isOpenPdfByLinkHandlerV2");
      const [handler, ...repeats] = switches;
      if (!handler || repeats.length > 0 || typeof handler.feature_enabled !== "boolean")
        throw refuse("UNEXPECTED_ANSWER", label, "key:feature_enabled");
      const located = `file_path=${part(signed.link)}&timestamp=${part(signed.timestamp)}`;
      // The switch picks between the portal's two PDF routes. The newer one takes no hash and may
      // need several requests before the file is there.
      if (handler.feature_enabled)
        return this.#pdfOncePrepared(`${this.scope.path(MAIN_APP, "v2", "pdf")}?${located}`, label);
      const address = `${this.scope.path(MAIN_APP, "v1", "pdf")}?${located}&hash=${part(signed.hash)}`;
      return this.scope.pdfAt(address, MAIN_APP, label);
    }
    if (file.letterType === 3) {
      // The website writes these three values into the query exactly as the tutorial carried them.
      const query = `file_path=${part(signed.url)}&timestamp=${part(signed.timestamp)}&hash=${part(signed.hash)}`;
      return this.scope.pdfAt(`${this.scope.path(MAIN_APP, "v1", "pdf/http")}?${query}`, MAIN_APP, label);
    }
    const id = encodeURIComponent(asString(signed.reference_id, label, "reference_id"));
    const name = encodeURIComponent(asString(signed.name_document, label, "name_document"));
    const query = new URLSearchParams({
      timestamp: asString(signed.timestamp, label, "timestamp"),
      hash: unescapeComponent(signed.hash, label),
    });
    const route = this.scope.path(DIRECTORSHIP, "v1", `letters_for_member/${id}/${name}/pdf`);
    return this.scope.pdfAt(`${route}?${query}`, DIRECTORSHIP, label);
  }

  /**
   * The information items handed to the member in a date range, as this call returned them. Items of
   * type 1 are PDFs and get a `reference`; the rest are links, which are passed on and never followed.
   */
  async allAdditionalInformation(span: DaySpan): Promise<Reading<Fields[]>> {
    checkDaySpan(span);
    const label = "additional-information";
    const query = new URLSearchParams({ from_date: span.from, to_date: span.to });
    const route = this.scope.path(MEDICAL_FILE, "v1", "tutorials");
    const sent = asObject(await getJson(this.scope.http, `${route}?${query}`, label), label);
    const files = new FilesOfList<Fields>(label);
    const references = new SteadyReferences();
    const rows = this.scope.rows(sent.tutorials, label, "tutorials").map((row) => {
      const hasText = (key: string) => typeof row[key] === "string" && row[key] !== "";
      if (!hasText("url") || !hasText("session_datetime") || !INFORMATION_TYPES.includes(row.type_id))
        throw refuse("NOT_OFFERED", label, "row-shape-unknown");
      // The row is returned whole, its short-lived url and signature too, since results keep every
      // field Maccabi sent. It costs nothing: a fetch goes by the reference against a list read for
      // it, and never by whatever copy of the url a caller holds.
      let shown = row;
      if (row.type_id === 1) {
        files.claimLink(row.url);
        const reference = references.next([
          "additional-information",
          ...INFORMATION_IDENTITY.map((key) => row[key] ?? null),
        ]);
        files.add(reference, row);
        shown = { ...row, reference };
      }
      checkOptional(row, INFORMATION_OPTIONAL, ["string", "number"], label);
      return shown;
    });
    this.#information.hold(span, files.byReference);
    return this.scope.renderedResult(rows, MEDICAL_FILE, label);
  }

  /** An information sheet's PDF, by a reference from the list of the same date range. */
  async fetchAdditionalInformationPdf(reference: string, span: DaySpan): Promise<Reading<Uint8Array>> {
    checkDaySpan(span);
    const label = "additional-information-pdf";
    mustBeReference(reference, label);
    if (!this.#information.isFor(span)) await this.allAdditionalInformation(span);
    const row = this.#information.get(reference);
    if (!row) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    const query = new URLSearchParams({
      url: unescapeComponent(row.url, label),
      timestamp: asString(row.timestamp, label, "timestamp"),
      hash: unescapeComponent(row.hash, label),
    });
    return this.scope.pdfAt(`${this.scope.path(MEDICAL_FILE, "v2", "pdf")}?${query}`, MEDICAL_FILE, label);
  }

  /** The medical certificates issued in a date range, as this call returned them. */
  async allCertificates(span: DaySpan): Promise<Reading<Certificate[]>> {
    checkDaySpan(span);
    const label = "certificates";
    const query = new URLSearchParams({ from_date: span.from, to_date: span.to });
    const route = this.scope.path(MEDICAL_FILE, "v1", "approvals");
    const sent = asObject(await getJson(this.scope.http, `${route}?${query}`, label), label);
    const files = new FilesOfList<Fields>(label);
    const references = new SteadyReferences();
    const rows = this.scope.rows(sent.approval, label, "approval").map((row) => {
      for (const key of CERTIFICATE_SIGNED) asString(row[key], label, key);
      const shown = CERTIFICATE_SHOWN.map((key) => asString(row[key], label, key));
      // Two rows under one private link are one certificate listed twice. Two rows that merely look
      // alike are not: real certificates can agree in every shown field, and the reference counter
      // keeps such a pair apart.
      files.claimLink(row.pdf_link);
      const reference = references.next(["medical-certificate", ...shown]);
      files.add(reference, row);
      // Returned whole, the short-lived link and signature included: results keep every field Maccabi sent.
      return { ...row, reference } as Certificate;
    });
    this.#certificates.hold(span, files.byReference);
    return this.scope.result(rows, MEDICAL_FILE, label);
  }

  /** A certificate's PDF, by a reference from the list of the same date range. */
  async fetchCertificatePdf(reference: string, span: DaySpan): Promise<Reading<Uint8Array>> {
    checkDaySpan(span);
    const label = "certificate-pdf";
    mustBeReference(reference, label);
    if (!this.#certificates.isFor(span)) await this.allCertificates(span);
    const row = this.#certificates.get(reference);
    if (!row) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    return this.scope.medicalFilePdf(row, label);
  }

  /** A mailing has to be the member's in every way it states: sent for them, addressed to them, not about a dependent. */
  #mustBeMembersOwn(row: Fields, label: string): void {
    const { owner } = this.scope;
    const { member_id, member_id_code, recipient_id, recipient_id_code, child_info: aboutChild } = row;
    if (!namesMember(member_id, member_id_code, owner)) throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
    // A letter always has to name its recipient. Any other kind has to only when it names one at all.
    const isLetter = row.letter_type === 1;
    const namesRecipient = [recipient_id, recipient_id_code].some((part) => part !== undefined);
    if ((isLetter || namesRecipient) && !namesMember(recipient_id, recipient_id_code, owner))
      throw refuse("NOT_THE_MEMBERS", label, "recipient-is-another-member");
    if (aboutChild === true) throw refuse("NOT_THE_MEMBERS", label, "row-of-a-dependent");
    // Left: a letter whose child flag is neither true nor false. Nothing shows it to be another
    // person's, so NOT_THE_MEMBERS would be wrong, and so would its advice, which is about a stale
    // reference when this read has none. The flag is simply not in a form this reader knows.
    if (isLetter && typeof aboutChild !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:child_info");
  }

  /** A type-1 row: an ordinary letter, fetchable when it carries both parts of its document's address. */
  #letter(row: Fields, files: FilesOfList<MailedFile>, label: string): Fields {
    const { reference_id: id, name_document: name } = row;
    let shown = row;
    if (typeof id === "string" && id !== "" && typeof name === "string" && name !== "") {
      const reference = digestOf([id, name]);
      files.add(reference, { letterType: 1, signed: row });
      shown = { ...row, reference };
    }
    for (const key of LETTER_TEXT) asString(row[key], label, key);
    return shown;
  }

  /**
   * The portal's newer PDF route answers with something other than 200 while the file is being
   * prepared. The website asks again every five seconds, and so does this, a bounded number of times.
   */
  async #pdfOncePrepared(address: string, label: string): Promise<Reading<Uint8Array>> {
    const asked = new URL(address, PORTAL_SITE);
    for (let attemptsLeft = PREPARING_ATTEMPTS; attemptsLeft > 0; attemptsLeft--) {
      const reply = await this.scope.http.request(address);
      const landedAt = new URL(reply.url || address, PORTAL_SITE);
      await this.scope.mustStillBeSignedIn(landedAt, reply);
      await mustBeOk(reply, label);
      const isSameAddress = (["origin", "pathname", "search"] as const).every((at) => landedAt[at] === asked[at]);
      if (!isSameAddress) await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "wrong-route-or-type"));
      if (reply.status !== 200) {
        await release(reply);
        if (attemptsLeft > 1) await new Promise((wake) => setTimeout(wake, PREPARING_WAIT_MS));
        continue;
      }
      if (mediaType(reply) !== "application/pdf")
        await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "file:content-type"));
      const announced = reply.headers.get("content-length");
      if (announced !== null && /^\d+$/.test(announced) && Number(announced) > MAX_PDF_BYTES)
        await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "file:oversized"));
      const pdf = await bytesUpTo(reply, MAX_PDF_BYTES, refuse("UNEXPECTED_ANSWER", label, "body-unreadable"));
      return this.scope.result(mustBePdf(pdf, label), MAIN_APP, label);
    }
    throw new ReadRefusal("PORTAL_REPORTED_ERROR", label);
  }
}
