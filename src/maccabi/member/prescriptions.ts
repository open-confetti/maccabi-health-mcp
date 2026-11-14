/**
 * Medicines prescribed to the member and referrals written for them, both out of the medical file.
 * A prescription's or a referral's PDF is fetched only for a row of a list this reader has read itself.
 */
import { refuse } from "../faults";
import type { MemberScope } from "./context";
import {
  asObject,
  asString,
  checkDaySpan,
  type DaySpan,
  type Fields,
  getJson,
  mustBelongToMember,
  type Reading,
  unescapeComponent,
} from "./shared";

const MEDICAL_FILE = "MedicalFileAPI";
/** Maccabi's public page about a medicine, addressed by the medicine's largo code. */
const MEDICINE_GUIDE = "https://www.maccabi4u.co.il/healthguide/medicines/תרופות";
const LARGO_CODE = /^[1-9]\d{0,31}$/;
const MAX_ID = 512;
const MAX_NAME = 16384;
const MAX_ALTERNATIVES = 1000;

const PRESCRIPTION_TEXT = ["doc_id", "drug_name", "drug_instructions", "from_date", "to_date"] as const;
const REFERRAL_TEXT = ["referral_id", "referral_date", "displaying_name", "pdf_link"] as const;

export type PrescriptionRow = Fields & Record<(typeof PRESCRIPTION_TEXT)[number], string>;
export type ReferralRow = Fields & Record<(typeof REFERRAL_TEXT)[number], string>;
type Alternative = Fields & { largo_code: string | number; name: string };

/** The status tabs of the website's prescription page, each with the `purchase_status` values it shows. */
const TAB_STATUSES = {
  valid: [1, 2, 3, 7],
  history: [4, 5, 6],
  purchased: [4, 5],
  expired: [6],
  // The same rows as `history`, narrowed further to those the portal marks renewable.
  renewable: [4, 5, 6],
};
type Tab = keyof typeof TAB_STATUSES;
const KNOWN_STATUSES: readonly unknown[] = [1, 2, 3, 4, 5, 6, 7];
/** Statuses in which a pharmacy can still dispense the prescription. */
const DISPENSABLE: readonly unknown[] = [1, 2, 3];

export interface PrescriptionFilter {
  permanent?: boolean;
  status?: Tab | "all";
}

export class Prescriptions {
  /** The rows of the latest prescription list, grouped by document id. An id may repeat. */
  #prescriptions = new Map<string, Fields[]>();
  /** The rows of the latest referral list, by referral id. */
  #referrals = new Map<string, ReferralRow>();

  constructor(private readonly scope: MemberScope) {}

  /**
   * The prescriptions this call returned. A filter is applied here, to the answer, and the result is
   * then marked as a subset; Maccabi is always asked for the whole list.
   */
  async allPrescriptions({ status, permanent }: PrescriptionFilter = {}): Promise<Reading<PrescriptionRow[]>> {
    const tab = status === undefined || status === "all" ? undefined : status;
    if (tab !== undefined && !Object.hasOwn(TAB_STATUSES, tab))
      throw new TypeError("status is not one of the prescription page's tabs");
    if (permanent !== undefined && typeof permanent !== "boolean")
      throw new TypeError("permanent is either true or false");
    const label = "prescriptions";
    const route = this.scope.path(MEDICAL_FILE, "v1", "prescriptions");
    const asked = this.scope.post({ members: [this.scope.member()] });
    const sent = asObject(await getJson(this.scope.http, route, label, asked), label);
    const rows = this.scope.rows(sent.results, label, "results") as PrescriptionRow[];
    const byDocument = new Map<string, Fields[]>();
    for (const row of rows) {
      for (const key of PRESCRIPTION_TEXT) asString(row[key], label, key);
      byDocument.set(row.doc_id, [...(byDocument.get(row.doc_id) ?? []), row]);
    }
    this.#prescriptions = byDocument;

    // A field is required only of a filter that reads it, so an unfiltered list tolerates its absence.
    const selected = rows.filter((row) => {
      if (permanent !== undefined && typeof row.is_permanent_drug !== "boolean")
        throw refuse("UNEXPECTED_ANSWER", label, "key:is_permanent_drug");
      if (tab !== undefined && !KNOWN_STATUSES.includes(row.purchase_status))
        throw refuse("UNEXPECTED_ANSWER", label, "key:purchase_status");
      if (tab === "renewable" && typeof row.is_prescription_renewal !== "boolean")
        throw refuse("UNEXPECTED_ANSWER", label, "key:is_prescription_renewal");
      if (permanent !== undefined && row.is_permanent_drug !== permanent) return false;
      if (tab === undefined) return true;
      if (tab === "renewable" && !row.is_prescription_renewal) return false;
      return TAB_STATUSES[tab].includes(row.purchase_status as number);
    });
    // The cached rows stay as sent; the caller gets copies, each with a link to the medicine's page.
    const shown = selected.map((row) => {
      const copy = structuredClone(row);
      const code = row.drug_largo_code;
      if (code === undefined || code === null) return copy;
      if (typeof code !== "string" || !LARGO_CODE.test(code))
        throw refuse("UNEXPECTED_ANSWER", label, "key:drug_largo_code");
      copy.medicine_info_link = `${MEDICINE_GUIDE}/${code}`;
      return copy;
    });
    const reading = this.scope.result(shown, MEDICAL_FILE, label);
    if (tab !== undefined || permanent !== undefined) reading.source.completeness = "local-filtered-subset";
    return reading;
  }

  /** The PDF of a digital prescription that can still be dispensed. */
  async fetchPrescriptionPdf(documentId: string): Promise<Reading<Uint8Array>> {
    const label = "prescription-pdf";
    if (this.#prescriptions.size === 0) await this.allPrescriptions();
    const row = this.#theOneListed(documentId, label);
    if (row.is_digital_prescription !== true || !DISPENSABLE.includes(row.purchase_status))
      throw refuse("NOT_OFFERED", label, "not-a-live-digital-prescription");
    const query = new URLSearchParams({
      timestamp: asString(row.timestamp, label, "timestamp"),
      hash: unescapeComponent(row.hash, label),
      data: asString(row.doc_id, label, "doc_id"),
      path: asString(row.file_link, label, "file_link"),
    });
    const route = this.scope.path(MEDICAL_FILE, "v1", "getprescriptionpdf");
    return this.scope.pdfAt(`${route}?${query}`, MEDICAL_FILE, label);
  }

  /**
   * The substitutes the website lists for a prescription. It lists them only while the prescription can
   * be dispensed, and so does this; the prescription list is read anew to establish that.
   */
  async allPrescriptionAlternatives(documentId: string): Promise<Reading<Alternative[]>> {
    const label = "prescription-substitutes";
    if (typeof documentId !== "string" || documentId === "" || documentId.length > MAX_ID)
      throw refuse("NOT_THE_MEMBERS", label, "id-malformed");
    await this.allPrescriptions();
    const prescription = this.#theOneListed(documentId, label);
    if (!DISPENSABLE.includes(prescription.purchase_status)) throw refuse("NOT_OFFERED", label, "not-purchasable-now");
    const query = new URLSearchParams({
      largoCode: asString(prescription.drug_largo_code, label, "drug_largo_code"),
    });
    const route = this.scope.path(MEDICAL_FILE, "v1", "alternativeDrugs");
    const sent = asObject(await getJson(this.scope.http, `${route}?${query}`, label), label);
    mustBelongToMember(sent, this.scope.owner, label);
    const drugs = this.scope.rows(sent.drugs, label, "drugs") as Alternative[];
    if (drugs.length > MAX_ALTERNATIVES) throw refuse("UNEXPECTED_ANSWER", label, "key:drugs");
    const codes = new Set<string>();
    for (const drug of drugs) {
      const code: unknown = drug.largo_code;
      const isCode = typeof code === "string" ? code !== "" && code.length <= MAX_ID : Number.isSafeInteger(code);
      if (!isCode) throw refuse("UNEXPECTED_ANSWER", label, "key:largo_code");
      if (codes.has(String(code))) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
      codes.add(String(code));
      const name = asString(drug.name, label, "name");
      if (name === "" || name.length > MAX_NAME) throw refuse("UNEXPECTED_ANSWER", label, "key:name");
    }
    return this.scope.renderedResult(drugs, MEDICAL_FILE, label);
  }

  /**
   * The referrals this call returned. With no dates the query carries the word "undefined" for both
   * bounds, which is what the website's home page sends; its referrals page sends real dates.
   */
  async allReferrals(span?: DaySpan): Promise<Reading<ReferralRow[]>> {
    const label = "referrals";
    if (span) checkDaySpan(span);
    const bounds = span ? { from_date: span.from, to_date: span.to } : { from_date: "undefined", to_date: "undefined" };
    const query = new URLSearchParams(bounds);
    const route = this.scope.path(MEDICAL_FILE, "v1", "referrals");
    const sent = asObject(await getJson(this.scope.http, `${route}?${query}`, label), label);
    const rows = this.scope.rows(sent.referrals, label, "referrals") as ReferralRow[];
    for (const row of rows) for (const key of REFERRAL_TEXT) asString(row[key], label, key);
    this.#referrals = new Map(rows.map((row) => [row.referral_id, structuredClone(row)]));
    return this.scope.result(rows, MEDICAL_FILE, label);
  }

  /** A referral's PDF. The website also reports the referral as read when it opens one; this does not. */
  async fetchReferralPdf(referralId: string): Promise<Reading<Uint8Array>> {
    const label = "referral-pdf";
    if (!this.#referrals.has(referralId)) await this.allReferrals();
    const row = this.#referrals.get(referralId);
    if (!row) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    return this.scope.medicalFilePdf(row, label);
  }

  /** The listed prescription with this document id, provided the id is listed exactly once. */
  #theOneListed(documentId: string, label: string): Fields {
    const [row, ...others] = this.#prescriptions.get(documentId) ?? [];
    if (!row) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    if (others.length > 0) throw refuse("NOT_THE_MEMBERS", label, "ambiguous-id-in-fresh-list");
    return row;
  }
}
