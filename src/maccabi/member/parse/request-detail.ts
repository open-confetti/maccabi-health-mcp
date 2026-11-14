import { createHash } from "node:crypto";
import { absent, type Guard, guardFor, type Json } from "./guards";

export type CaseKind = "Case" | "ServiceRequest";
export type CaseValue = string | number;

export interface CaseMessage {
  body: string;
  created_on: string;
  from_maccabi: boolean;
}

export interface CaseAttachment {
  reference: string;
  file_name: string | null;
}

/** The portal's feature switches that decide whether a case shows the documents on its root. */
export interface CaseFeatures {
  IsCaseRejected: boolean;
  IshurMakdim: boolean;
  EnablePartlyApprovedObligation: boolean;
}

export interface CaseObligation {
  department_description?: string;
  doctor_referral?: { name?: string; code?: CaseValue };
  service_provider_name?: string;
  treatment_date?: string;
  treatments: { treatment_name?: string; health_ministry_code?: CaseValue }[];
}

const DECISION_KINDS = ["medication_approval", "obligation", "refund", "preauthorization", "ombudsman"] as const;

export interface CaseDecision {
  kind: (typeof DECISION_KINDS)[number];
  approval_number?: CaseValue;
  obligation_number?: CaseValue;
  service_provider?: string;
  print_decision_type?: string;
  print_decision_message?: string;
  medication?: {
    largo_code?: CaseValue;
    medication_name?: string;
    participation?: CaseValue;
    pharmacies?: string;
    valid_from_date?: string;
    valid_to_date?: string;
  };
}

export interface CaseDetail {
  classification: CaseKind;
  coverage: "common";
  body: string | null;
  messages: CaseMessage[];
  attachments: CaseAttachment[];
  decision?: CaseDecision | null;
  obligation_details?: CaseObligation | null;
  /** Parts of the answer that were there and are not represented above. */
  unsupported_sections: ("extended_properties" | "feature_gated_case_documents" | "provider_document")[];
}

/** What the reader keeps to fetch an attachment by: its signed address, or the base64 text that arrived with the detail. */
export type CaseFile =
  | { held: "signed"; reference: string; address: string; issuedAt: string; signature: string }
  | { held: "inline"; reference: string; encoded: string };

export class CaseShapeError extends Error {
  constructor() {
    super("A Maccabi administrative request is not laid out the way the portal's expanded row reads it");
    this.name = "CaseShapeError";
  }
}

const check: Guard = guardFor(() => new CaseShapeError());
const TEXT_LIMIT = 64 * 1024;
const INLINE_DOCUMENT_LIMIT = 3 * 1024 * 1024;

const text = (value: unknown): string =>
  typeof value === "string" && value.length <= TEXT_LIMIT ? value : check.fail();
function filled(value: unknown): string {
  const given = text(value);
  return given === "" ? check.fail() : given;
}
/** A list, or nothing at all where Maccabi has none to send. */
const rows = (value: unknown): unknown[] => (absent(value) ? [] : check.list(value, 1000));
/** A nested object, or null where Maccabi has none to send. */
const section = (value: unknown): Json | null => (absent(value) ? null : check.object(value));

/**
 * The portal's renderer skips a field that is missing, null, empty or zero. A field it would print
 * has to be text or a finite number.
 */
function shown(value: unknown): CaseValue | undefined {
  if (absent(value) || value === "" || value === 0) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : check.fail();
  return text(value);
}
function shownText(value: unknown): string | undefined {
  const visible = shown(value);
  return typeof visible === "number" ? check.fail() : visible;
}
/** The fields that have a value, in the order they are written; the rest leave no key behind. */
function printed<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Collects a request's attachments: what the member sees of each, and beside it what the reader needs
 * to fetch it.
 *
 * A reference stands for a place in the request - which list, which row, under which title - and
 * not for the document's bytes. Maccabi signs a fresh address, timestamp and hash into every answer,
 * so a reference built from any of those would not survive from the list to the download.
 */
class Attachments {
  readonly listed: CaseAttachment[] = [];
  readonly files: CaseFile[] = [];
  readonly #references = new Set<string>();
  readonly #request: [CaseKind, string];

  constructor(classification: CaseKind, caseId: string | number) {
    this.#request = [classification, String(caseId)];
  }

  /** A document behind a signed address; the portal prefers the print address when a row has both. */
  addSigned(row: Json, place: string, file_name: string | null): void {
    const address = filled(row.print_document_uri || row.uri);
    const issuedAt = filled(row.timestamp);
    const signature = filled(row.hash);
    const reference = this.#reference(place, file_name);
    this.listed.push({ file_name, reference });
    this.files.push({ held: "signed", reference, address, issuedAt, signature });
  }

  /** A document whose bytes came inside the answer. */
  addInline(file_name: string, base64: string): void {
    const reference = this.#reference("provider", file_name);
    this.listed.push({ file_name, reference });
    this.files.push({ held: "inline", reference, encoded: base64 });
  }

  #reference(place: string, title: string | null): string {
    const reference = createHash("sha256")
      .update(JSON.stringify([...this.#request, place, title]))
      .digest("hex");
    if (this.#references.has(reference)) check.fail();
    this.#references.add(reference);
    return reference;
  }
}

function message(entry: Json): CaseMessage {
  return {
    created_on: filled(entry.created_on),
    body: text(entry.body),
    from_maccabi: check.flag(entry.from_maccabi),
  };
}

function obligation(extended: Json, body: Json): CaseObligation | null {
  const source = section(extended.obligation_details);
  if (!source) return null;
  const doctor = section(source.doctor_referral);
  const referral = printed<NonNullable<CaseObligation["doctor_referral"]>>({
    code: doctor ? shown(doctor.doctor_referral_code) : undefined,
    name: doctor ? shownText(doctor.doctor_referral_name) : undefined,
  });
  const department = section(source.department);
  const provider = section(source.service_provider);
  return printed<CaseObligation>({
    // The date of treatment sits on the request itself, not inside the obligation.
    treatment_date: shownText(body.treatment_date),
    doctor_referral: Object.keys(referral).length > 0 ? referral : undefined,
    treatments: rows(source.treatment_array).map((entry) => {
      const treatment = check.object(entry);
      return printed({
        health_ministry_code: shown(treatment.health_ministry_code),
        treatment_name: shownText(treatment.treatment_name),
      });
    }),
    department_description: department ? shownText(department.department_description) : undefined,
    service_provider_name: provider ? shownText(provider.service_provider_name) : undefined,
  });
}

/** The statuses at which the portal prints the medication block of an approval. */
const MEDICATION_STATUSES: readonly unknown[] = [51, 57];
/** An obligation's decision can be printed only when it says so itself; every other kind always can. */
const PRINTABLE_OBLIGATIONS: readonly unknown[] = ["Print", "Print_ProviderChangeDisabled"];

function decide(
  kind: CaseDecision["kind"],
  source: Json,
  status: unknown,
  answeredByMaccabi: boolean,
): { decision: CaseDecision; printable: boolean } {
  const decision = {
    kind,
    ...printed<Omit<CaseDecision, "kind" | "medication">>({
      service_provider: shownText(source.service_provider),
      approval_number: shown(source.approval_number),
      obligation_number: shown(source.obligation_number),
      print_decision_message: shownText(source.print_decision_message),
      print_decision_type: shownText(source.print_decision_type),
    }),
  };
  const printable = kind !== "obligation" || PRINTABLE_OBLIGATIONS.includes(source.print_decision_type);
  // The medication block belongs to an approval that carries its number, at one of two statuses, and
  // only until Maccabi has written back. Outside that the portal does not read these fields at all.
  const withMedication =
    kind === "medication_approval" &&
    decision.approval_number !== undefined &&
    !answeredByMaccabi &&
    MEDICATION_STATUSES.includes(status);
  if (!withMedication) return { decision, printable };
  const medication = printed<NonNullable<CaseDecision["medication"]>>({
    medication_name: shownText(source.medication_name),
    largo_code: shown(source.largo_code),
    valid_from_date: shownText(source.valid_from_date),
    valid_to_date: shownText(source.valid_to_date),
    participation: shown(source.participation),
    pharmacies: shownText(source.pharmacies),
  });
  return { decision: { ...decision, medication }, printable };
}

/**
 * What the portal's expanded row shows of one administrative request, be it a case or a service
 * request, each field within a fixed size. Payment state is not read. The documents on a case's root
 * are read only under the feature switches the portal itself consults, and a provider's inline
 * document only where the portal would offer it; whatever is skipped is named in `unsupported_sections`.
 */
export function shapeCase(
  answer: unknown,
  classification: CaseKind,
  caseId: string | number,
  switches?: CaseFeatures,
): { detail: CaseDetail; documents: CaseFile[] } {
  if (classification !== "Case" && classification !== "ServiceRequest") check.fail();
  const usableId =
    typeof caseId === "number"
      ? Number.isFinite(caseId)
      : typeof caseId === "string" && caseId !== "" && caseId.length <= 512;
  if (!usableId) check.fail();
  const body = check.object(answer);
  const isCase = classification === "Case";
  const attachments = new Attachments(classification, caseId);

  // The portal draws a case as a thread of messages and a service request as a single body.
  const thread = isCase ? rows(body.messages).map(check.object) : [];
  const messages = thread.map(message);

  // It also takes the common documents from different places: off the request for a service request,
  // off the opening message for a case.
  const common = isCase ? rows(thread[0]?.documents) : rows(body.documents);
  common.forEach((entry, index) => {
    const row = check.object(entry);
    attachments.addSigned(row, `common:${index}`, filled(row.file_name));
  });

  const extended = section(body.extended_properties);
  const obligation_details = extended ? obligation(extended, body) : null;

  let decision: CaseDecision | null = null;
  let printable = false;
  const decided = isCase && extended ? DECISION_KINDS.find((kind) => !absent(extended[kind])) : undefined;
  if (extended && decided) {
    const source = check.object(extended[decided]);
    const answeredByMaccabi = messages.some((sent) => sent.from_maccabi);
    ({ decision, printable } = decide(decided, source, body.unified_status_code, answeredByMaccabi));
    const title = printable ? shownText(source.print_document_title) : undefined;
    if (title !== undefined) attachments.addSigned(source, "decision", title);
  }

  const providerDocument = printable ? section(body.provider_document) : null;
  if (providerDocument) {
    const { file_base64string: bytes } = providerDocument;
    if (typeof bytes !== "string" || bytes === "" || bytes.length > INLINE_DOCUMENT_LIMIT) check.fail();
    // The key's spelling is Maccabi's.
    attachments.addInline(filled(providerDocument.last_doc_name_reviced), bytes);
  }

  const hasRootDocuments = isCase && rows(body.documents).length > 0;
  if (switches && hasRootDocuments) {
    if (!Object.values(switches).every((value) => typeof value === "boolean")) check.fail();
    const caseType = body.case_type_code;
    const rendered =
      (switches.IshurMakdim && decided === "preauthorization") ||
      (switches.IsCaseRejected && body.has_documents_from_maccabi === true && (caseType === 53 || caseType === 75)) ||
      (switches.EnablePartlyApprovedObligation && caseType === 53 && body.unified_status_code === 91);
    if (rendered)
      rows(body.documents).forEach((entry, index) => {
        const row = check.object(entry);
        // A root document with no address is not offered; one with no title still is.
        if (!row.uri && !row.print_document_uri) return;
        const untitled = absent(row.title) || row.title === "";
        attachments.addSigned(row, `case-root:${index}`, untitled ? null : filled(row.title));
      });
  }

  const unsupported_sections: CaseDetail["unsupported_sections"] = [];
  if (extended && !obligation_details && !decision) unsupported_sections.push("extended_properties");
  if (hasRootDocuments && !switches) unsupported_sections.push("feature_gated_case_documents");
  if (!absent(body.provider_document) && !providerDocument) unsupported_sections.push("provider_document");

  const detail: CaseDetail = {
    classification,
    coverage: "common",
    body: isCase || absent(body.body) ? null : text(body.body),
    messages,
    attachments: attachments.listed,
    obligation_details,
    decision,
    unsupported_sections,
  };
  return { detail: check.bounded(detail, 256 * 1024), documents: attachments.files };
}
