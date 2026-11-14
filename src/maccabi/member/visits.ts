/**
 * Visits the member has already had. The history lists them; a visit that has a summary opens into a
 * detail; the detail's prescriptions, referrals, approvals and information sheets, and the summary
 * itself, can be fetched as PDFs. `Requests` borrows the detail shaping and the PDF fetch for the visit
 * an inquiry points at.
 */
import { refuse } from "../faults";
import type { MemberScope } from "./context";
import {
  asObject,
  asString,
  type Fields,
  getJson,
  isReference,
  mustBelongToMember,
  percentDecoded,
  percentEncoded,
  queryValue,
  type Reading,
  SteadyReferences,
  steadyIdentity,
  theOnly,
} from "./shared";

const APPOINTMENT_ORDER = "AppointmentOrderAPI";
const HISTORY_TEXT = ["appointment_id", "appointment_date", "service_provider_name", "service_name"] as const;
const DETAIL_TEXT = [
  "member_id",
  "member_id_code",
  "visit_summary_date",
  "service_provider_name",
  "visit_summary_pdf_link",
];
/** Longest private path, and longest signature part, that is accepted from the portal. */
const MAX_PATH = 16384;
const MAX_SIGNATURE_PART = 8192;

export type VisitRow = Fields & Record<(typeof HISTORY_TEXT)[number], string> & { has_summery_file: boolean };

/** What it takes to fetch one document of a visit. The signature parts stay unchecked until the fetch. */
export interface VisitFile {
  path: string;
  hash: unknown;
  timestamp: unknown;
  /** Information sheets are served by the medical file, every other document by the visit's own service. */
  isInformationSheet: boolean;
}

export interface ShapedVisit {
  /** The detail as it is returned to the caller. */
  detail: Fields;
  /** The fetchable documents of the detail's lists, by reference. */
  files: Map<string, VisitFile>;
  /** The visit summary, when the detail links to one. */
  summary?: VisitFile;
}

interface FileList {
  key: string;
  /** The field holding a row's private path. */
  pathKey: string;
  isInformationSheet: boolean;
  /** Whether the website offers this row's document for download. */
  downloadable(row: Fields): boolean;
}
const always = () => true;
const FILE_LISTS: readonly FileList[] = [
  {
    key: "drugs",
    pathKey: "prescription_pdf_link",
    isInformationSheet: false,
    // Only a digital prescription that was not cancelled. The second field name is Maccabi's spelling.
    downloadable: (row) => row.prescription_is_digital === 1 && row.rescription_cancellation_status !== 1,
  },
  { key: "referrals", pathKey: "referral_pdf_link", isInformationSheet: false, downloadable: always },
  { key: "approvals", pathKey: "approval_pdf_link", isInformationSheet: false, downloadable: always },
  // Information items of type 1 are PDFs; types 2 and 3 point at web pages instead.
  { key: "tutorials", pathKey: "item_url", isInformationSheet: true, downloadable: (row) => row.type_id === 1 },
];
const WEB_PAGE_ITEM_TYPES: readonly unknown[] = [2, 3];

/** The address behind an information item that is a web page: percent-decoded, http(s), without credentials. */
function webAddress(sent: unknown, label: string): string {
  const malformed = () => refuse("UNEXPECTED_ANSWER", label, "key:item_url");
  const unreadable = () => refuse("UNEXPECTED_ANSWER", label, "link-unencodable");
  const encoded = asString(sent, label, "item_url");
  if (encoded.length === 0 || encoded.length > MAX_PATH) throw malformed();
  const address = percentDecoded(encoded);
  if (address === undefined) throw unreadable();
  if (address.length > 4096 || /[\x00-\x1f\x7f]/.test(address)) throw malformed();
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw unreadable();
  }
  const isPlainWeb = /^https?:$/.test(parsed.protocol) && parsed.username === "" && parsed.password === "";
  if (!isPlainWeb) throw malformed();
  return address;
}

export class Visits {
  /** Ids of the listed visits that have a summary, from the latest history read. */
  #summarised = new Set<string>();
  /** What the latest detail read of each visit made fetchable. */
  readonly #fetchable = new Map<string, Pick<ShapedVisit, "files" | "summary">>();

  constructor(private readonly scope: MemberScope) {}

  /** The visit history as this one call returned it. */
  async allVisits(): Promise<Reading<VisitRow[]>> {
    const label = "clinic-visits";
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", "visits/history");
    const asked = this.scope.post({ members: [this.scope.member()] });
    const sent = asObject(await getJson(this.scope.http, route, label, asked), label);
    const rows = this.scope.rows(sent.results, label, "results") as VisitRow[];
    for (const row of rows) {
      for (const key of HISTORY_TEXT) asString(row[key], label, key);
      if (typeof row.has_summery_file !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:has_summery_file");
    }
    this.#summarised = new Set(rows.filter((row) => row.has_summery_file).map((row) => row.appointment_id));
    return this.scope.result(rows, APPOINTMENT_ORDER, label);
  }

  /** One visit's detail. Only a visit the history lists with a summary has one. */
  async fetchVisit(visitId: string): Promise<Reading<Fields>> {
    const label = "clinic-visit";
    if (!this.#summarised.has(visitId)) {
      const history = await this.allVisits();
      if (!this.#summarised.has(visitId)) {
        const isListed = history.data.some((row) => row.appointment_id === visitId);
        throw isListed
          ? refuse("NOT_OFFERED", label, "summary-absent")
          : refuse("NOT_THE_MEMBERS", label, "id-unknown");
      }
    }
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", `visits/${encodeURIComponent(visitId)}`);
    const sent = asObject(await getJson(this.scope.http, route, label), label);
    mustBelongToMember(sent, this.scope.owner, label);
    for (const key of DETAIL_TEXT) asString(sent[key], label, key);
    const { detail, files, summary } = this.shapeVisitFiles(sent, visitId, label);
    this.#fetchable.set(visitId, { files, summary });
    return this.scope.result(detail, APPOINTMENT_ORDER, label);
  }

  /**
   * Shapes a visit detail for returning: every field as sent, `has_summary_pdf`, a `pdf_reference` on
   * each row whose document can be fetched and a decoded `link` on information items that are web pages.
   * `withinKey` names the detail the references belong to, so equal rows of two details never share one.
   */
  shapeVisitFiles(sent: Fields, withinKey: string, label: string): ShapedVisit {
    const detail = structuredClone(sent);
    const summaryPath = sent.visit_summary_pdf_link;
    const summary: VisitFile | undefined =
      typeof summaryPath === "string" && summaryPath !== ""
        ? { path: summaryPath, hash: sent.hash, timestamp: sent.timestamp, isInformationSheet: false }
        : undefined;
    detail.has_summary_pdf = summary !== undefined;
    const files = new Map<string, VisitFile>();
    const references = new SteadyReferences();
    for (const list of FILE_LISTS) {
      const listed = sent[list.key];
      if (listed === undefined || listed === null) continue;
      detail[list.key] = this.scope.rows(listed, label, list.key).map((row) => {
        const shown = structuredClone(row);
        if (list.isInformationSheet && WEB_PAGE_ITEM_TYPES.includes(row.type_id))
          shown.link = webAddress(row.item_url, label);
        const path = row[list.pathKey];
        if (!list.downloadable(row) || typeof path !== "string" || path === "") return shown;
        // Maccabi issues a new private path with every answer, so a path cannot name the document.
        // The reference is made of what stays put instead: which detail, which list, and the row's
        // own lasting fields.
        const reference = references.next(["appointment-document", withinKey, list.key, ...steadyIdentity(shown)]);
        if (files.has(reference)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
        const { hash, timestamp } = row;
        files.set(reference, { path, hash, timestamp, isInformationSheet: list.isInformationSheet });
        shown.pdf_reference = reference;
        return shown;
      });
    }
    return { detail, files, summary };
  }

  /** The PDF behind a `pdf_reference` of a visit detail, looked up in a detail that is read again first. */
  async fetchVisitDocumentPdf(visitId: string, reference: string): Promise<Reading<Uint8Array>> {
    const label = "clinic-visit-document-pdf";
    if (typeof visitId !== "string" || visitId === "" || !isReference(reference))
      throw refuse("NOT_THE_MEMBERS", label, "reference-malformed");
    await this.#readAgain(visitId, label);
    const file = this.#fetchable.get(visitId)?.files.get(reference);
    if (!file) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    return this.visitFilePdf(file, label);
  }

  /** The summary PDF of a visit, through a history and a detail that are both read again first. */
  async fetchVisitSummaryPdf(visitId: string): Promise<Reading<Uint8Array>> {
    const label = "clinic-visit-summary-pdf";
    await this.#readAgain(visitId, label);
    const summary = this.#fetchable.get(visitId)?.summary;
    if (!summary) throw refuse("NOT_OFFERED", label, "summary-pdf-absent");
    return this.visitFilePdf(summary, label);
  }

  /**
   * Fetches one document. The website encodes the path and then appends the timestamp and hash exactly
   * as Maccabi sent them, so the same is done here, once neither part could add or split a parameter.
   */
  async visitFilePdf(file: VisitFile, label: string): Promise<Reading<Uint8Array>> {
    const path = asString(file.path, label);
    if (path.length === 0 || path.length > MAX_PATH) throw refuse("UNEXPECTED_ANSWER", label, "file-path-unsafe");
    const route = file.isInformationSheet
      ? { api: "MedicalFileAPI", version: "v2", pathKey: "url" }
      : { api: APPOINTMENT_ORDER, version: "v1", pathKey: "path" };
    const located = `${route.pathKey}=${percentEncoded(path, label)}`;
    const timestamp = queryValue(file.timestamp, MAX_SIGNATURE_PART, label);
    const hash = queryValue(file.hash, MAX_SIGNATURE_PART, label);
    const address = `${this.scope.path(route.api, route.version, "pdf")}?${located}&timestamp=${timestamp}&hash=${hash}`;
    return this.scope.pdfAt(address, route.api, label);
  }

  /** A visit must be listed exactly once, with a summary, in a new history before its detail is read again. */
  async #readAgain(visitId: string, label: string): Promise<void> {
    const history = await this.allVisits();
    const listed = theOnly(
      history.data.filter((row) => row.appointment_id === visitId),
      label,
    );
    if (!listed.has_summery_file) throw refuse("NOT_OFFERED", label, "summary-absent");
    await this.fetchVisit(visitId);
  }
}
