/**
 * What the member asked of Maccabi and what came back. Two unrelated portal services are read here:
 * administrative cases (approvals, refunds, commitments) and inquiries sent to a doctor. Each has a
 * list, a detail and documents, and a document is only ever fetched through a list read anew.
 */
import { refuse } from "../faults";
import type { MemberScope } from "./context";
import { ClinicalAskShapeError, type ClinicalAsks, shapeClinicalAsks } from "./parse/doctor-inquiry";
import { type CaseDetail, type CaseFeatures, type CaseFile, CaseShapeError, shapeCase } from "./parse/request-detail";
import {
  asObject,
  asString,
  checkOptional,
  digestOf,
  type Fields,
  fitsQueryValue,
  getJson,
  isIdentifier,
  isPresent,
  isRecord,
  isReference,
  MAX_PDF_BYTES,
  mustBelongToMember,
  mustBeReference,
  namesMember,
  overSource,
  pdfFromBase64,
  percentEncoded,
  queryValue,
  type Reading,
  SteadyReferences,
  steadyReference,
} from "./shared";
import type { VisitFile, Visits } from "./visits";

const CASES = "RequestsAndApprovalsAPI";
const DOCTOR_MAIL = "CommunicationWithDoctorAPI";
const APPOINTMENT_ORDER = "AppointmentOrderAPI";
const MAIN_APP = "MainAppAPI";
const MAX_ID = 512;
const MAX_PATH = 16384;
const MAX_SIGNATURE_PART = 8192;

const TEXT_OR_NUMBER = ["string", "number"] as const;
const YES_OR_NO = ["boolean"] as const;
/**
 * What the case list renders, in alphabetical order, with the types each field may arrive as. Any of
 * them may also be missing or null.
 */
const CASE_ROW_TYPES: Record<string, readonly string[]> = {
  classification: TEXT_OR_NUMBER,
  create_date: TEXT_OR_NUMBER,
  drug_largo_code: TEXT_OR_NUMBER,
  drug_names_for_approval: TEXT_OR_NUMBER,
  has_content: YES_OR_NO,
  interaction_id: TEXT_OR_NUMBER,
  is_maccabi_file_attached: YES_OR_NO,
  is_read: YES_OR_NO,
  item_code: TEXT_OR_NUMBER,
  obligation_provider_name: TEXT_OR_NUMBER,
  obligation_treatment_date: TEXT_OR_NUMBER,
  request_create_date: TEXT_OR_NUMBER,
  status: TEXT_OR_NUMBER,
  status_code: TEXT_OR_NUMBER,
  status_update_date: TEXT_OR_NUMBER,
  subject: TEXT_OR_NUMBER,
  type_code: TEXT_OR_NUMBER,
  type_name: TEXT_OR_NUMBER,
};
/** The portal switches a case's own documents depend on. */
const CASE_SWITCHES = ["EnablePartlyApprovedObligation", "IsCaseRejected", "IshurMakdim"] as const;
/** The parts of a case's extended properties that may carry a member of their own. */
const EXTENDED_SECTIONS = [
  "obligation_details",
  "medication_approval",
  "obligation",
  "refund",
  "preauthorization",
  "ombudsman",
];
const OBLIGATION_PARTIES = ["doctor_referral", "department", "service_provider"];

const INQUIRY_ROW_TEXT = [
  "request_id",
  "type",
  "service_provider_name",
  "request_status",
  "status_update_date",
] as const;
const INQUIRY_DETAIL_TEXT = [
  "patient_remark",
  "doctor_remark",
  "creation_date",
  "update_date",
  "doctor_name",
  "request_status_desc",
];
/** An inquiry of this type is a sick note issued without a doctor: it has one PDF and no detail. */
const SICK_PERMIT = "automatic_sick_permit";
/** The website shows the forms' PDFs for inquiries in these statuses, and for these form types. */
const STATUSES_SHOWING_FORMS: readonly unknown[] = ["1", "8"];
const FORM_TYPES_WITH_PDF: readonly unknown[] = [1, 2, 3, 4, 5];

export type InquiryRow = Fields & Record<(typeof INQUIRY_ROW_TEXT)[number], string>;

/** What a later read needs to remember of a listed inquiry. */
interface ListedInquiry {
  type: string;
  statusCode: unknown;
  sickPermit?: { reference: string; file: VisitFile };
}

/** The id an automatic sick permit's document goes by: short printable text or a positive whole number. */
function isPermitDocumentId(value: unknown): boolean {
  if (typeof value === "string") return value !== "" && value.length <= MAX_ID && !/[\x00-\x1f\x7f]/.test(value);
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * A case detail as it is returned: the rendered projection laid over everything Maccabi sent, with two
 * exceptions. The bytes of an inline provider document are a file, fetched through its attachment
 * reference, so the detail says only whether they were there. And a service request's own messages,
 * which the website never renders, are handed on exactly as sent.
 */
function overEverythingSent(sent: Fields, detail: CaseDetail): CaseDetail {
  const source = structuredClone(sent);
  const inline = source.provider_document;
  if (isRecord(inline) && Object.hasOwn(inline, "file_base64string")) {
    const bytes = inline.file_base64string;
    inline.file_base64string_present = typeof bytes === "string" && bytes !== "";
    delete inline.file_base64string;
  }
  const merged = overSource(source, detail);
  const keepsMessages = detail.classification === "ServiceRequest" && Array.isArray(source.messages);
  return keepsMessages ? Object.assign(merged, { messages: source.messages }) : merged;
}

export class Requests {
  /** Per case, the documents its latest detail read made fetchable. */
  readonly #caseFiles = new Map<string, Map<string, CaseFile>>();
  /** The inquiries of the latest list read. */
  #listedInquiries = new Map<string, ListedInquiry>();
  /** Per inquiry, the documents its latest detail read made fetchable. */
  readonly #inquiryFiles = new Map<string, Map<string, VisitFile>>();

  constructor(
    private readonly scope: MemberScope,
    private readonly visits: Visits,
  ) {}

  /** The member's administrative cases as this call returned them; the checked fields are the ones the website lists. */
  async allAdministrativeRequests(): Promise<Reading<Fields[]>> {
    const label = "requests";
    const route = this.scope.path(CASES, "v1", "requests_and_cases");
    const asked = this.scope.post({ members: [this.scope.member()] });
    const rows = this.scope.rows(await getJson(this.scope.http, route, label, asked), label);
    for (const row of rows) {
      if (String(row.member_id) !== String(this.scope.owner.memberId))
        throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
      if (!isIdentifier(row.interaction_id) || typeof row.classification !== "string")
        throw refuse("NOT_OFFERED", label, "row-shape-unknown");
      for (const [column, types] of Object.entries(CASE_ROW_TYPES)) checkOptional(row, [column], types, label);
    }
    return this.scope.renderedResult(rows, CASES, label);
  }

  /**
   * One case with its correspondence. Only the kinds of content every case has are projected; sections
   * this reader does not interpret are named in `unsupported_sections` rather than dropped silently.
   */
  async fetchAdministrativeRequest(caseId: string): Promise<Reading<CaseDetail>> {
    const label = "request";
    if (typeof caseId !== "string" || caseId === "" || caseId.length > MAX_ID)
      throw refuse("NOT_THE_MEMBERS", label, "id-malformed");
    const listing = await this.allAdministrativeRequests();
    const [listed, ...others] = listing.data.filter((row) => String(row.interaction_id) === caseId);
    if (!listed) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    if (others.length > 0) throw refuse("NOT_THE_MEMBERS", label, "ambiguous-id-in-fresh-list");
    const kind = listed.classification;
    if (kind !== "Case" && kind !== "ServiceRequest") throw refuse("NOT_OFFERED", label, "case-kind-unknown");
    const collection = kind === "Case" ? "cases" : "service_requests";
    const route = this.scope.path(CASES, "v1", `${collection}/${encodeURIComponent(caseId)}`);
    const sent = asObject(await getJson(this.scope.http, route, label), label);
    mustBelongToMember(sent, this.scope.owner, label);
    if (sent.interaction_id !== undefined && String(sent.interaction_id) !== caseId)
      throw refuse("NOT_THE_MEMBERS", label, "detail-names-another-id");
    this.#mustBeMembersThroughout(sent, label);
    // Which of a case's own documents the website shows depends on three portal switches.
    const hasDocuments = Array.isArray(sent.documents) && sent.documents.length > 0;
    const features = kind === "Case" && hasDocuments ? await this.#caseFeatures(label) : undefined;
    let shaped: ReturnType<typeof shapeCase>;
    try {
      shaped = shapeCase(sent, kind, caseId, features);
    } catch (error) {
      throw error instanceof CaseShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    this.#caseFiles.set(caseId, new Map(shaped.documents.map((file) => [file.reference, file])));
    return this.scope.renderedResult(overEverythingSent(sent, shaped.detail), CASES, label);
  }

  /** A case attachment, by the reference its detail gave. The detail is read again before anything is fetched. */
  async fetchAdministrativeRequestPdf(caseId: string, reference: string): Promise<Reading<Uint8Array>> {
    const label = "request-attachment-pdf";
    mustBeReference(reference, label);
    await this.fetchAdministrativeRequest(caseId);
    const file = this.#caseFiles.get(caseId)?.get(reference);
    if (!file) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    if (file.held === "inline") {
      const oversized = () => refuse("UNEXPECTED_ANSWER", label, "file:oversized");
      // Four characters of base64 hold three bytes, so the text's length bounds the PDF before decoding.
      if (file.encoded.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) throw oversized();
      const pdf = pdfFromBase64(file.encoded, label);
      if (pdf.byteLength > MAX_PDF_BYTES) throw oversized();
      return this.scope.result(pdf, CASES, label);
    }
    const uri = queryValue(file.address, MAX_PATH, label);
    const timestamp = queryValue(file.issuedAt, MAX_PATH, label);
    const hash = queryValue(file.signature, MAX_PATH, label);
    const route = this.scope.path(CASES, "v1", "service_requests_document");
    return this.scope.pdfAt(`${route}?doc_uri=${uri}&timestamp=${timestamp}&hash=${hash}`, CASES, label);
  }

  /** The member's inquiries to doctors as this call returned them. */
  async allInquiries(): Promise<Reading<InquiryRow[]>> {
    const label = "doctor-inquiries";
    const route = this.scope.path(DOCTOR_MAIL, "v1", "inquiries");
    const sent = asObject(await getJson(this.scope.http, route, label), label);
    const listed = new Map<string, ListedInquiry>();
    const rows = this.scope.rows(sent.inquiries, label, "inquiries").map((row) => {
      for (const key of INQUIRY_ROW_TEXT) asString(row[key], label, key);
      const { request_id: id, type } = row as InquiryRow;
      if (id === "" || type === "" || listed.has(id)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
      if (!namesMember(row.member_id, row.member_id_code, this.scope.owner))
        throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
      if (isPresent(row.request_subjects))
        for (const subject of this.scope.rows(row.request_subjects, label, "request_subjects"))
          asString(subject.name, label, "name");
      const sickPermit = type === SICK_PERMIT ? this.#sickPermitFile(row, label) : undefined;
      listed.set(id, { type, statusCode: row.request_status_code, sickPermit });
      // The row goes back whole, a permit's short-lived link and signature included. Fetching never
      // trusts a caller's copy of those: it goes by `pdf_reference` against a list read anew.
      return (sickPermit ? { ...row, pdf_reference: sickPermit.reference } : row) as InquiryRow;
    });
    this.#listedInquiries = listed;
    return this.scope.result(rows, DOCTOR_MAIL, label);
  }

  /**
   * One inquiry with the doctor's answer, its forms and the visit it led to. Opening an inquiry on the
   * website also reports it as viewed; that report is not part of this read.
   */
  async fetchInquiry(inquiryId: string): Promise<Reading<Fields>> {
    const label = "doctor-inquiry";
    if (!this.#listedInquiries.has(inquiryId)) await this.allInquiries();
    const listed = this.#listedInquiries.get(inquiryId);
    if (!listed) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    if (listed.type === SICK_PERMIT) throw refuse("NOT_OFFERED", label, "sick-permit-has-no-detail");
    const route = this.scope.path(DOCTOR_MAIL, "v1", `inquiries/${encodeURIComponent(inquiryId)}/details`);
    const sent = asObject(await getJson(this.scope.http, route, label), label);
    if (String(sent.request_id) !== inquiryId || !namesMember(sent.user_id, sent.user_code, this.scope.owner))
      throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
    for (const key of INQUIRY_DETAIL_TEXT) asString(sent[key], label, key);
    // Everything is kept, the doctor's id and the forms' short-lived links too (by the project's rule,
    // clinicians' ids stay). The two fields that repeat the member's own id are the exception.
    const detail: Fields = structuredClone(sent);
    delete detail.user_id;
    delete detail.user_code;
    let asks: ClinicalAsks;
    try {
      asks = shapeClinicalAsks(sent);
    } catch (error) {
      throw error instanceof ClinicalAskShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    const { prescription_largo_code_list, approval_request_details, open_medical_record_number: visitNumber } = sent;
    Object.assign(detail, overSource({ prescription_largo_code_list, approval_request_details }, asks));

    const files = new Map<string, VisitFile>();
    const formReferences = new SteadyReferences();
    const formsSeen = new Set<string>();
    const showsFormPdfs = STATUSES_SHOWING_FORMS.includes(listed.statusCode) && !isPresent(visitNumber);
    detail.medical_forms_details = this.scope
      .rows(sent.medical_forms_details, label, "medical_forms_details")
      .map((form) => {
        const { form_type: formType, link_pdf: path, document_id: sentId } = form;
        if (!showsFormPdfs || !FORM_TYPES_WITH_PDF.includes(formType) || typeof path !== "string" || path === "")
          return form;
        // One form type under one private link, listed twice, is a single document and not two.
        const formKey = JSON.stringify([formType, path]);
        if (formsSeen.has(formKey)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
        formsSeen.add(formKey);
        const documentId = isIdentifier(sentId) ? sentId : null;
        const reference = formReferences.next(["inquiry-form", inquiryId, formType, documentId]);
        if (files.has(reference)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
        files.set(reference, { path, hash: form.hash, timestamp: form.timestamp, isInformationSheet: false });
        return { ...form, pdf_reference: reference };
      });
    if (isPresent(visitNumber) && visitNumber !== "") {
      const recordNumber = asString(visitNumber, label, "open_medical_record_number");
      detail.visit_summary = await this.#visitOfInquiry(inquiryId, recordNumber, files, label);
    }
    this.#inquiryFiles.set(inquiryId, files);
    return this.scope.result(detail, DOCTOR_MAIL, label);
  }

  /**
   * A document of an inquiry or of the visit it led to, as Maccabi rendered it. The inquiry list, and
   * the detail where there is one, are read again before the reference is looked up.
   */
  async fetchInquiryDocumentPdf(inquiryId: string, reference: string): Promise<Reading<Uint8Array>> {
    const label = "doctor-inquiry-pdf";
    if (typeof inquiryId !== "string" || inquiryId === "" || !isReference(reference))
      throw refuse("NOT_THE_MEMBERS", label, "reference-malformed");
    await this.allInquiries();
    const listed = this.#listedInquiries.get(inquiryId);
    if (!listed) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    let file: VisitFile | undefined;
    if (listed.type !== SICK_PERMIT) {
      await this.fetchInquiry(inquiryId);
      file = this.#inquiryFiles.get(inquiryId)?.get(reference);
    } else if (listed.sickPermit?.reference === reference) {
      file = listed.sickPermit.file;
    }
    if (!file) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    return this.visits.visitFilePdf(file, label);
  }

  /** Every nested part of a case detail that can name a member has to name this one, or nobody. */
  #mustBeMembersThroughout(sent: Fields, label: string): void {
    const { owner } = this.scope;
    if (isPresent(sent.documents)) this.scope.rows(sent.documents, label, "documents");
    if (isPresent(sent.provider_document))
      mustBelongToMember(asObject(sent.provider_document, label, "provider_document"), owner, label);
    if (isPresent(sent.messages))
      for (const message of this.scope.rows(sent.messages, label, "messages"))
        if (isPresent(message.documents)) this.scope.rows(message.documents, label, "documents");
    if (!isPresent(sent.extended_properties)) return;
    const extended = asObject(sent.extended_properties, label, "extended_properties");
    mustBelongToMember(extended, owner, label);
    for (const name of EXTENDED_SECTIONS) {
      if (!isPresent(extended[name])) continue;
      const section = asObject(extended[name], label);
      mustBelongToMember(section, owner, label);
      if (name !== "obligation_details") continue;
      for (const party of OBLIGATION_PARTIES)
        if (isPresent(section[party])) mustBelongToMember(asObject(section[party], label), owner, label);
      if (isPresent(section.treatment_array)) this.scope.rows(section.treatment_array, label, "treatment_array");
    }
  }

  /** The portal switches that decide which case documents the website shows. A switch not sent is off. */
  async #caseFeatures(label: string): Promise<CaseFeatures> {
    const route = this.scope.path(MAIN_APP, "v1", "features");
    const sent = this.scope.rows(await getJson(this.scope.http, route, label), label);
    const isOn = (id: string): boolean => {
      const entries = sent.filter((one) => one.feature_id === id);
      if (entries.length === 0) return false;
      const state = entries.length === 1 ? entries[0]?.feature_enabled : undefined;
      if (typeof state !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:feature_enabled");
      return state;
    };
    return Object.fromEntries(CASE_SWITCHES.map((id) => [id, isOn(id)])) as Record<keyof CaseFeatures, boolean>;
  }

  /** The single PDF an automatic sick permit may carry, under a reference made of the permit's own ids. */
  #sickPermitFile(row: Fields, label: string): ListedInquiry["sickPermit"] {
    const forms = this.scope.rows(row.medical_forms_documents, label, "medical_forms_documents");
    if (forms.length > 1) throw refuse("UNEXPECTED_ANSWER", label, "key:medical_forms_documents");
    const [form] = forms;
    if (!form || typeof form.result_file !== "string" || form.result_file === "") return undefined;
    const { result_file: path, timestamp, hash } = form;
    if (!isPermitDocumentId(row.document_id)) throw refuse("UNEXPECTED_ANSWER", label, "oversized");
    if (path.length > MAX_PATH) throw refuse("UNEXPECTED_ANSWER", label, "key:result_file");
    percentEncoded(path, label);
    for (const part of [timestamp, hash])
      if (typeof part !== "string" || !fitsQueryValue(part, MAX_SIGNATURE_PART))
        throw refuse("UNEXPECTED_ANSWER", label, "signature-unsafe");
    const reference = digestOf([row.request_id, "automatic", row.document_id]);
    return { reference, file: { path, hash, timestamp, isInformationSheet: false } };
  }

  /**
   * The visit an inquiry was answered in, read by the record number the inquiry carries. Its documents
   * join `files`, so one reference map serves the whole inquiry. Null when the portal has no such visit.
   */
  async #visitOfInquiry(
    inquiryId: string,
    recordNumber: string,
    files: Map<string, VisitFile>,
    label: string,
  ): Promise<Reading<Fields> | null> {
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", `visits/${encodeURIComponent(recordNumber)}/`);
    const answer = await getJson(this.scope.http, `${route}?isOpenMedicalRecordNumber=true`, label, undefined, true);
    // Seen live: for some medical-form inquiries this lookup answers 204 for the record number they
    // carry. The website then renders the inquiry with no visit, and this read does the same.
    if (answer === null) return null;
    const sent = asObject(answer, label);
    if (!namesMember(sent.member_id, sent.member_id_code, this.scope.owner))
      throw refuse("NOT_THE_MEMBERS", label, "names-another-member");
    const visit = this.visits.shapeVisitFiles(sent, `inquiry:${inquiryId}`, label);
    delete visit.detail.member_id;
    delete visit.detail.member_id_code;
    for (const [reference, file] of visit.files) files.set(reference, file);
    if (visit.summary) {
      const reference = steadyReference(["inquiry-visit-summary", inquiryId], 0);
      visit.detail.summary_pdf_reference = reference;
      files.set(reference, visit.summary);
    }
    return this.scope.result(visit.detail, APPOINTMENT_ORDER, "inquiry-associated-visit");
  }
}
