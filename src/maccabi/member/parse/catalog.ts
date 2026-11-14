/**
 * Which portal calls this client is willing to make for the signed-in member, and nothing beyond them.
 *
 * The member portal is a handful of compiled sub-apps. Each call below was read out of those bundles
 * and judged, on its own, to be a pure read; what was judged otherwise is recorded in `NEVER_OFFERED`
 * at the bottom. A caller picks an entry by name and may fill only the parameters that entry declares,
 * every one held to an anchored pattern before a request exists. Service, method and path are
 * constants of the entry, and the member's own ids come from the session, never from the caller.
 *
 * POST is accepted only where the portal itself uses it to ask something (a search, a price, an
 * eligibility) and the call stores nothing. The types make each of those carry its reason in `post`.
 *
 * This module is data plus pure functions. It performs no I/O.
 */
import type { DataKind } from "../../kinds";
import { hasLonePercent } from "./guards";

/** The back ends under `/sonline/<service>/webapi/`. `TestResultsAPI` and `TestsResultsApi` are two names, not one misspelt. */
export type CatalogService =
  | "DirectorshipAPI"
  | "MainAppAPI"
  | "HomePageAPI"
  | "MedicalFileAPI"
  | "ContentAPI"
  | "TestResultsAPI"
  | "TestsResultsApi"
  | "AppointmentOrderAPI"
  | "RequestsAndApprovalsAPI"
  | "CommunicationWithDoctorAPI";

/** Facts about the signed-in member that the portal would take from its own customer record. */
export interface CatalogScope {
  memberId: number;
  memberIdCode: string;
  /** As the source writes it: ז or נ. */
  sex: string;
  /** YYYY-MM-DD. */
  birthDate: string;
  /** Today on the local calendar, YYYY-MM-DD. */
  today: string;
  /** The portal's age object; missing when the bootstrap carried none. */
  age?: { years?: number; months?: number };
  /** `insurances_groups` exactly as the bootstrap had it. */
  insurancesGroups?: unknown;
  /** The codes in `current_customer_info.remarks`, joined with commas the way the portal posts them. Missing without a remarks list. */
  remarkCodes?: string;
}

export interface CatalogParam {
  /** Anchored at both ends. A value that fails it ends the request before any of it is built. */
  pattern: RegExp;
  /** Shown to the caller, so it says where a value is found. */
  description: string;
  required?: boolean;
  /** Supplies the value when the caller gives none; undefined leaves the parameter out altogether. */
  default?: (scope: CatalogScope) => string | undefined;
}

/**
 * Ties ids a caller supplies to what the member actually has. The source entry is read first, and one
 * row of its answer has to hold every bound value; if none does, the read fails as NOT_THE_MEMBERS
 * without the caller's ids ever being sent.
 */
export interface CatalogBinding {
  /** Name of the catalog entry that lists what the member has. */
  source: string;
  /** Parameter → the field that must equal it on a row of the source answer. Rows may sit at any depth. */
  fields: Record<string, string>;
}

/** Either a path to download from, or the PDF itself as base64 text taken straight from the answer. */
export type DocumentRoute = { path: string } | { base64: string };

/** Recognises one kind of downloadable document among the objects of an answer. */
export interface DocumentRule {
  /** Goes into the reference a row is given, to keep the kinds apart. */
  kind: string;
  /** Field of the returned row that receives the opaque reference. */
  key: string;
  /**
   * Where the PDF of this object is fetched from. Undefined when the object is not such a document or
   * lacks a piece the download needs. `where` is the object's JSON path without array indexes; the
   * root is "$".
   */
  locate(row: Record<string, unknown>, where: string, scope: CatalogScope): DocumentRoute | undefined;
}

interface EntryBase {
  name: string;
  service: CatalogService;
  /**
   * Relative to `/sonline/<service>/webapi/`. `{c}/{id}` is the member (see `ME`); any other `{x}` is
   * the parameter `x`, percent-encoded on its way in.
   */
  path: string;
  summary: string;
  /** The kind of data that comes back; `portal-endpoints` filters on it. */
  category: DataKind;
  params?: Record<string, CatalogParam>;
  bind?: CatalogBinding[];
  /** Query key → a literal, or `{x}` for the parameter `x`. An optional `x` nobody supplied sends no pair. */
  query?: Record<string, string>;
  documents?: DocumentRule[];
  /** The answer is a PDF and nothing else, which leaves `portal-document` as the only way to it. */
  pdf?: true;
  /**
   * Whose data the answer may hold.
   * `deep`: wherever an object in it identifies a member, that member must be the signed-in one.
   * `family`: the call exists to list relatives or account users, so others are expected; the output
   * filter strips their national ids.
   * `none`: reference data asked for without identifying anyone. It still gets the `deep` scan, which
   * turns a surprise mention of some member into a refusal.
   */
  owner: "deep" | "family" | "none";
  /** Core medical and account reads; the integration suite calls every one of them. */
  priority?: boolean;
  /** `live-shape`: the shape of a real answer was seen live. `bundle`: known from the portal's source alone. */
  evidence: "live-shape" | "bundle";
  /** Where in the portal the call was found. */
  screen: string;
  notes?: string;
}
interface QueryByPost {
  body: (values: Record<string, string>, scope: CatalogScope) => unknown;
  /** The reason this POST is a question and not a write. */
  post: string;
}
export type CatalogEntry = EntryBase & ({ method: "GET" } | ({ method: "POST" } & QueryByPost));

type EntryDetails = Omit<EntryBase, "name" | "service" | "path">;

/** Entry constructors for one back end, so that an entry reads as method, name, path, then the rest. */
function api(service: CatalogService) {
  return {
    get: (name: string, path: string, details: EntryDetails): CatalogEntry => ({
      ...details,
      name,
      service,
      path,
      method: "GET",
    }),
    post: (name: string, path: string, details: EntryDetails & QueryByPost): CatalogEntry => ({
      ...details,
      name,
      service,
      path,
      method: "POST",
    }),
  };
}

/** The signed-in member inside a path template: id code, then id number, both filled by `catalogPath`. */
const ME = "{c}/{id}";

// ---------------------------------------------------------------------------------------- parameters

const required = (pattern: RegExp, description: string): CatalogParam => ({ pattern, description, required: true });
const optional = (pattern: RegExp, description: string): CatalogParam => ({ pattern, description });
/** Falls back to a constant, normally the one the portal itself sends. */
const preset = (pattern: RegExp, description: string, value: string): CatalogParam => ({
  pattern,
  description,
  default: () => value,
});
/** Falls back to something known about the member. */
const derived = (
  pattern: RegExp,
  description: string,
  from: (scope: CatalogScope) => string | undefined,
): CatalogParam => ({ pattern, description, default: from });

const listedIn = (source: string, fields: Record<string, string>): CatalogBinding => ({ source, fields });

/**
 * The patterns are built from these parts, and `portal-endpoints` prints each pattern's source, so a
 * part is spelt the way it is to be printed.
 */
const DAY = String.raw`\d{4}-\d{2}-\d{2}`;
const CLOCK = String.raw`\d{2}:\d{2}:\d{2}`;
/** A whole value of `least` to `most` digits. */
const digits = (least: number, most: number): RegExp => new RegExp(String.raw`^\d{${least},${most}}$`);

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const NUMBER = digits(1, 12);
const SHORT_NUMBER = digits(1, 4);
const NUMBER_LIST = /^\d{1,8}(?:,\d{1,8}){0,49}$/;
const FLAG = /^(?:true|false)$/;
const ISO_DATE = new RegExp(`^${DAY}$`);
/** A day alone or a day with its time, YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss. */
const DAY_OR_MOMENT = new RegExp(`^${DAY}(?:T${CLOCK})?$`);
/** Search words. They only ever travel in the query string: letters, digits, spaces and a few marks. */
const NAME_TEXT = /^[\p{L}\p{N} '".-]{1,60}$/u;
const SECTION_LIST =
  /^(?:info|identity|contact|address|remarks|insurance|financial)(?:,(?:info|identity|contact|address|remarks|insurance|financial)){0,6}$/;

/** A date range. Left open at either end, it runs from 1990-01-01 up to today. */
const DATE_RANGE = {
  from: preset(ISO_DATE, "First day of the range, YYYY-MM-DD; 1990-01-01 when omitted.", "1990-01-01"),
  to: derived(ISO_DATE, "Last day of the range, YYYY-MM-DD; today when omitted.", (scope) => scope.today),
};
const NAME_PAGE = {
  filter: required(NAME_TEXT, "How the name starts."),
  limit: preset(SHORT_NUMBER, "Rows per page; 50 when omitted.", "50"),
  offset: preset(digits(1, 6), "Rows to skip; 0 when omitted.", "0"),
};
const APPOINTMENT_ID = required(TOKEN, "The id of an appointment, as `appointments` returns it.");
const OWN_APPOINTMENT = listedIn("future-appointments", { appointment_id: "id" });
const OWN_REQUEST = listedIn("requests-and-cases", { interaction_id: "interaction_id" });
const PORTAL_FLAG = preset(FLAG, "A flag the portal passes along; false when omitted.", "false");
const BORN = "The member's date of birth; supplied from the session.";

/** The four keys that single out a service of the eligibility list, checked against that list as a set. */
const LISTED_SERVICE = {
  params: {
    subject_id: required(NUMBER, "The subject_id that `service-eligibilities` lists for the service."),
    service_code: required(NUMBER, "Its service_code in the same row."),
    service_enum: required(NUMBER, "Its service_enum in the same row."),
    service_type: required(/^[A-Za-z0-9_-]{1,32}$/, "Its service_type in the same row."),
  },
  bind: [
    listedIn("service-eligibilities", {
      subject_id: "subject_id",
      service_code: "service_code",
      service_enum: "service_enum",
      service_type: "service_type",
    }),
  ],
  body: (values: Record<string, string>) => ({
    subject_id: numberIfDigits(values.subject_id),
    service_code: numberIfDigits(values.service_code),
    service_enum: Number.parseInt(values.service_enum!, 10),
    service_type: numberIfDigits(values.service_type),
  }),
};

// -------------------------------------------------------------------------------------- request bodies

/** Up to 15 digits go out as a JSON number, which is exact at that length. Anything else stays the string it was. */
function numberIfDigits(text: string | undefined): number | string | undefined {
  return text !== undefined && digits(1, 15).test(text) ? Number(text) : text;
}
const memberPair = (scope: CatalogScope) => ({ member_id_code: scope.memberIdCode, member_id: scope.memberId });
/** Age in the form the portal posts: years plus twelfths, to two decimals, and 0 with no age on record. */
const ageWithMonths = ({ age }: CatalogScope): number =>
  Number(((age?.years ?? 0) + (age?.months ?? 0) / 12).toFixed(2));
const sexWord = (mark: string) => (mark === "ז" ? "male" : mark === "נ" ? "female" : null);
/** The portal names the first active (status 1) insurance group whose type is 02, 03 or 07. */
function supplementaryType({ insurancesGroups }: CatalogScope): string | null {
  const groups: unknown[] = Array.isArray(insurancesGroups) ? insurancesGroups : [];
  const active = groups.find((group) => {
    if (!group || typeof group !== "object") return false;
    const { ins_type_code: type, ins_status: status } = group as Record<string, unknown>;
    return ["02", "03", "07"].includes(type as string) && Number(status) === 1;
  }) as Record<string, unknown> | undefined;
  return active ? String(active.ins_type_code) : null;
}

// ------------------------------------------------------------------------------------- document routes

const filled = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const MAX_LINK_PART = 16384;

/**
 * Several download links are glued together by the portal from answer fields with no encoding at all.
 * Such a field is passed on untouched, but only when it cannot start, split or rename a query pair.
 */
function verbatim(value: unknown): string | undefined {
  if (!filled(value) || value.length > MAX_LINK_PART) return undefined;
  if (/[&#?=\u0000- \u007f]/.test(value)) return undefined;
  return hasLonePercent(value) ? undefined : value;
}
/** Pairs joined as they stand. A single part that `verbatim` turned down means there is no route. */
function verbatimQuery(parts: Record<string, string | undefined>): string | undefined {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(parts)) {
    if (value === undefined) return undefined;
    pairs.push(`${key}=${value}`);
  }
  return pairs.join("&");
}
/** For fields that arrive percent-encoded and leave through URLSearchParams, which would encode them twice. */
function percentDecoded(value: unknown): string | undefined {
  if (!filled(value) || value.length > MAX_LINK_PART) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
const webapi = (service: CatalogService) => `/sonline/${service}/webapi`;
/** The absolute form of `mac/<version>/members/{c}/{id}`, which every document route starts from. */
const memberRoot = (service: CatalogService, version: "v1" | "v2", { memberIdCode, memberId }: CatalogScope) =>
  `${webapi(service)}/mac/${version}/members/${encodeURIComponent(memberIdCode)}/${memberId}`;

/** Any answer may embed a PDF as `{type: "pdf", base64}`. The bytes are swapped for a reference. */
export const EMBEDDED_PDF: DocumentRule = {
  kind: "inline-pdf",
  key: "base64_reference",
  locate: ({ base64 }) => (filled(base64) ? { base64 } : undefined),
};

/** A `pdf_link` row of the documents screens (referrals, approvals), served by MedicalFileAPI v1. */
const MEDICAL_FILE_PDF: DocumentRule = {
  kind: "medical-file-pdf:pdf_link",
  key: "pdf_link_reference",
  locate(row, _where, scope) {
    const path = percentDecoded(row.pdf_link);
    const hash = percentDecoded(row.hash);
    if (!path || !hash || typeof row.timestamp !== "string") return undefined;
    const query = new URLSearchParams({ path, timestamp: row.timestamp, hash });
    return { path: `${memberRoot("MedicalFileAPI", "v1", scope)}/pdf?${query}` };
  },
};

const LETTER_PDF: DocumentRule = {
  kind: "letter",
  key: "document_reference",
  locate(row, _where, scope) {
    if (!filled(row.reference_id) || !filled(row.name_document)) return undefined;
    const hash = percentDecoded(row.hash);
    if (!hash || typeof row.timestamp !== "string") return undefined;
    const letter = `${encodeURIComponent(row.reference_id)}/${encodeURIComponent(row.name_document)}`;
    const query = new URLSearchParams({ timestamp: row.timestamp, hash });
    return { path: `${memberRoot("DirectorshipAPI", "v1", scope)}/letters_for_member/${letter}/pdf?${query}` };
  },
};

/** The certificate belongs to the answer as a whole, so only the root object counts. */
const SENIORITY_CERTIFICATE: DocumentRule = {
  kind: "seniority-certificate",
  key: "document_reference",
  locate(row, where, scope) {
    if (where !== "$" || !filled(row.hash)) return undefined;
    const query = verbatimQuery({
      hash: verbatim(row.hash),
      timestamp: verbatim(row.timestamp),
      isAttachment: "false",
    });
    return query
      ? { path: `${memberRoot("DirectorshipAPI", "v1", scope)}/insurance/seniority/pdf?${query}` }
      : undefined;
  },
};

const APPLICATION_FORM: DocumentRule = {
  kind: "application-form",
  key: "document_reference",
  locate(row, _where, scope) {
    if (row.form_id === undefined || row.form_id === null) return undefined;
    const query = verbatimQuery({
      form_id: verbatim(String(row.form_id)),
      archive_form_id: verbatim(String(row.archive_form_id ?? "")),
      timestamp: verbatim(row.timestamp),
      hash: verbatim(row.hash),
    });
    return query ? { path: `${memberRoot("MedicalFileAPI", "v1", scope)}/getAgilePointPdf?${query}` } : undefined;
  },
};

/**
 * The vaccine groups the website puts a print button on: its COVID group codes, which it reads from
 * the resource `vaccinationsCodes` and defaults to these three. Asked to print any other group,
 * Maccabi answers its "error opening document" page, so no other group is given a document.
 */
const COVID_VACCINE_GROUPS: ReadonlySet<unknown> = new Set([95884, 95885, 95886]);

const VACCINATION_BOOKLET: DocumentRule = {
  kind: "vaccination-group-pdf",
  key: "document_reference",
  locate(row, _where, scope) {
    if (!COVID_VACCINE_GROUPS.has(row.vaccine_group_code) || !filled(row.hash)) return undefined;
    const query = verbatimQuery({
      vaccine_group_code: String(row.vaccine_group_code),
      birth_date: scope.birthDate.slice(0, 10),
      hash: verbatim(row.hash),
      timestamp: verbatim(row.timestamp),
      is_attachment: "false",
    });
    return query ? { path: `${memberRoot("MedicalFileAPI", "v1", scope)}/vaccinations/pdf?${query}` } : undefined;
  },
};

/** Among tutorials, type 1 is the kind that comes with a file. */
const TUTORIAL_PDF: DocumentRule = {
  kind: "tutorial",
  key: "document_reference",
  locate(row, _where, scope) {
    if (row.type_id !== 1 || !filled(row.url)) return undefined;
    const url = percentDecoded(row.url);
    const hash = percentDecoded(row.hash);
    if (!url || !hash || typeof row.timestamp !== "string") return undefined;
    const query = new URLSearchParams({ url, timestamp: row.timestamp, hash });
    return { path: `${memberRoot("MedicalFileAPI", "v2", scope)}/pdf?${query}` };
  },
};

/** The inquiry list belongs to one service while the file it points at is served by another. */
const INQUIRY_FORM_DOCUMENT: DocumentRule = {
  kind: "inquiry-form-document",
  key: "document_reference",
  locate(row, _where, scope) {
    if (!filled(row.result_file)) return undefined;
    const query = verbatimQuery({
      path: encodeURIComponent(row.result_file),
      timestamp: verbatim(row.timestamp),
      hash: verbatim(row.hash),
    });
    return query ? { path: `${memberRoot("AppointmentOrderAPI", "v1", scope)}/pdf?${query}` } : undefined;
  },
};

/** One report covers the entire answer, and here the source spells its timestamp `time_stamp`. */
const LATEST_LAB_REPORT: DocumentRule = {
  kind: "latest-lab-report",
  key: "document_reference",
  locate(row, where, scope) {
    if (where !== "$" || !filled(row.hash)) return undefined;
    const hash = percentDecoded(row.hash);
    if (!hash || typeof row.time_stamp !== "string") return undefined;
    const query = new URLSearchParams({ t: row.time_stamp, hash, irregular_only: "false", is_attachment: "false" });
    return { path: `${memberRoot("TestResultsAPI", "v1", scope)}/getlatestlabresults/report?${query}` };
  },
};

// ------------------------------------------------------------------------------------------ the catalog

const directorship = api("DirectorshipAPI");
const mainApp = api("MainAppAPI");
const homePage = api("HomePageAPI");
const medicalFile = api("MedicalFileAPI");
const appointmentOrder = api("AppointmentOrderAPI");
const withDoctor = api("CommunicationWithDoctorAPI");
const requestsAndApprovals = api("RequestsAndApprovalsAPI");
const testResults = api("TestResultsAPI");

export const CATALOG: readonly CatalogEntry[] = [
  // Account, billing and settings.
  directorship.get("entitlement", `mac/v1/members/${ME}/entitlement`, {
    summary:
      "The people on the account: per family member the payer, treatment code, eligibility status, insurance and relationship, along with the next-month date.",
    category: "account",
    owner: "family",
    priority: true,
    evidence: "live-shape",
    screen: "directorship: account and family",
  }),
  directorship.get("payer-billing-subjects", `mac/v1/members/${ME}/payer_billing_subjects`, {
    summary:
      "For the paying member, the people billed together, with each one's member status and status in the family.",
    category: "billing",
    owner: "family",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/DebitsAndCredits",
    notes: "Two other services, HomePageAPI and CommunicationWithDoctorAPI, answer this path identically.",
  }),
  directorship.get("account-users", `mac/v1/members/${ME}/accounts`, {
    summary:
      "People authorized on the account, including the fields `authorized-users` trims. National ids that are not the member's are removed.",
    category: "account",
    owner: "family",
    evidence: "live-shape",
    screen: "directorship/AuthAccountsManager",
  }),
  directorship.get("biobank", `mac/v1/members/${ME}/biobank`, {
    summary:
      "Enrollment in the biobank research project and the interactions recorded for it. A member who never enrolled gets an empty 204.",
    category: "account",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/biobank/Lobby",
    notes: "Documents per interaction (biobank/document/{id}) have no mapping so far.",
  }),
  directorship.get("biobank-stats", "mac/v1/biobank/stats", {
    summary: "Biobank enrollment figures open to anyone (total_enrolled, updated_on); the request identifies nobody.",
    category: "reference",
    owner: "none",
    evidence: "live-shape",
    screen: "directorship/biobank/Lobby",
    notes: 'Shape seen live on 2026-10-28: total_enrolled is a number and updated_on a "YYYY-MM-DDTHH:mm:ss" string.',
  }),
  directorship.get("letters", `mac/v1/members/${ME}/letters_for_member`, {
    summary:
      "Mail the fund sent the member between two dates, through the GET form of the call: dates, mailing type, letter code with its description, and whether a document exists.",
    category: "notifications",
    params: DATE_RANGE,
    query: { from_date: "{from}", to_date: "{to}" },
    documents: [LETTER_PDF],
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/personal mail",
  }),
  directorship.get("notification-settings", `mac/v1/members/${ME}/online_notification`, {
    summary:
      "How the member is notified online: the groups and their services, channels, push registration, whether each is registered or restricted, and the contact details notifications go to.",
    category: "account",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/personalreminders",
  }),
  directorship.get("notification-group", `mac/v1/members/${ME}/online_notification/group`, {
    summary: "The services inside a single notification group, fetched the way the settings screen does.",
    category: "account",
    params: {
      group_code: required(NUMBER, "A group's basic_data.item_code, taken from `notification-settings`."),
      service_codes: required(NUMBER_LIST, "The item_code of each service in the group, joined by commas."),
    },
    query: { group_code: "{group_code}", service_codes: "{service_codes}" },
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/personalreminders",
  }),
  directorship.get("insurance-seniority", `mac/v1/members/${ME}/insurance/seniority`, {
    summary:
      "Whether the membership is active and when it ends, then for every insurance group its type, status and seniority date. A reference to the seniority certificate PDF comes with it.",
    category: "account",
    documents: [SENIORITY_CERTIFICATE],
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/EditInformation/Profile",
  }),
  directorship.get("finance-debts", `mac/v1/members/${ME}/finance/debts`, {
    summary:
      "What the member owes in total, split into the health fund (kupa), supplementary insurance (shaban) and other charges.",
    category: "billing",
    params: { person_type: preset(/^[12]$/, "The portal sends 1 and also 2; 1 when omitted.", "1") },
    query: { person_type: "{person_type}" },
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/DebitsAndCredits",
  }),
  directorship.get("debt-details", `mac/v1/members/${ME}/debts/details`, {
    summary: "Each debt of a single debt type, and their sum.",
    category: "billing",
    params: { debt_type: preset(SHORT_NUMBER, "Code of the debt type; 1 when omitted.", "1") },
    query: { debt_type: "{debt_type}" },
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/DebtPayment",
  }),
  directorship.get("payer-debt-details", `mac/v1/payers/${ME}/debts/details`, {
    summary: "v1 of the payer's debt: amounts, the payees and any messages.",
    category: "billing",
    owner: "family",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/DebtPayment",
  }),
  directorship.get("payer-debt-summary", `mac/v2/payers/${ME}/debts/details`, {
    summary:
      "v2 of the payer's debt: health-fund and supplementary amounts broken down by family member, and whether they can be paid.",
    category: "billing",
    owner: "family",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/DebtPayment",
  }),
  directorship.get("debit-authorization", `mac/v1/payers/${ME}/debit_authorization`, {
    summary:
      "The standing payment arrangement, direct debit or credit card, with all of its fields; the complete account number is withheld.",
    category: "billing",
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/CreditsAndDebits",
    notes: "`payment-methods` returns a fixed selection of this same answer.",
  }),
  directorship.get("oncogenetic-eligibility", `mac/oncogenetic/${ME}/oncogenetic/eligibility`, {
    summary: "Tells if the member has a hereditary-cancer (oncogenetic) questionnaire on file.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/OncogeneticOnline",
  }),
  directorship.get("banks", `mac/v1/banks/${ME}`, {
    summary: "Reference list of banks, as offered in the direct-debit form.",
    category: "reference",
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/CreditsAndDebits/BankDebit",
  }),
  directorship.get("bank-branches", `mac/v1/banks/${ME}/branches/`, {
    summary: "Reference list of the branches a given bank has.",
    category: "reference",
    params: { bank_code: required(SHORT_NUMBER, "A bank's code, as listed by `banks`.") },
    query: { bankCode: "{bank_code}" },
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/CreditsAndDebits/BankDebit",
  }),
  directorship.get("infant-eligibility", `mac/v1/members/${ME}/infant/eligibility`, {
    summary: "The check the portal runs ahead of baby registration: may this newborn be added to the member's account.",
    category: "account",
    params: {
      infant_id_code: preset(/^\d$/, "Id code of the newborn; 0 when omitted, which is the usual one.", "0"),
      infant_id: required(digits(5, 9), "National ID number of the newborn."),
    },
    query: { infant_id_code: "{infant_id_code}", infant_id: "{infant_id}" },
    owner: "family",
    evidence: "bundle",
    screen: "directorship/BabyRegistration",
  }),
  directorship.post("magnetic-card-cost", `mac/v1/members/${ME}/magnetic_card/cost`, {
    summary:
      "What a replacement membership card would cost the member. Nothing is ordered: ordering is another call, left out of the catalog.",
    category: "billing",
    body: (_values, scope) => [{ mem_code: scope.memberIdCode, mem_id: scope.memberId }],
    post: "Quotes a price for the members in the body. Placing the order is a POST to magnetic_card, which this client never sends.",
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/OrderMagneticCard",
  }),
  directorship.post("service-eligibilities", "mac/eligibilities", {
    summary:
      "Behind the 'what am I entitled to' screen: the subjects and the services under them, with codes, for the member's age, sex and insurance.",
    category: "account",
    params: {
      ins_type_code: optional(
        /^\d{2}$/,
        "Supplementary-insurance type: 02, 03 or 07. Left out, it is read off the member's active insurance groups, as the portal does.",
      ),
    },
    body: (values, scope) => ({
      age: ageWithMonths(scope),
      ins_type_code: values.ins_type_code ?? String(supplementaryType(scope)),
      sex: sexWord(scope.sex),
    }),
    post: "Looks up a list by sex, age and insurance type. No member is identified and nothing is saved.",
    owner: "deep",
    priority: true,
    evidence: "bundle",
    screen: "directorship/ServiceEligibilityLobby",
    notes:
      'The website posts {age, ins_type_code, sex}. For a member with no active group of type 02, 03 or 07 the website sends ins_type_code "null" (String(null)), which gets 403 as well, and the site falls back to its generic error popup.',
  }),
  directorship.post("service-history", `mac/eligibilities/${ME}/member_service_history`, {
    summary: "How the member has used a single service from the eligibility list so far.",
    category: "account",
    params: LISTED_SERVICE.params,
    bind: LISTED_SERVICE.bind,
    body: LISTED_SERVICE.body,
    post: "Fetches past usage only; the portal fires it as soon as a service is picked.",
    owner: "deep",
    priority: true,
    evidence: "bundle",
    screen: "directorship/ServiceEligibilityLobby",
  }),
  directorship.post("service-rights", `mac/eligibilities/${ME}/member_service_rights`, {
    summary:
      "What the member is entitled to for a single service from the eligibility list: participation, deductible, refunds and utilization.",
    category: "account",
    params: LISTED_SERVICE.params,
    bind: LISTED_SERVICE.bind,
    body: (values) => ({ ...LISTED_SERVICE.body(values), channel: "h", applicant: "1" }),
    post: "Fetches entitlements only; the portal fires it on picking a service, ahead of anything the member could do.",
    owner: "deep",
    priority: true,
    evidence: "bundle",
    screen: "directorship/ServiceEligibilityLobby",
  }),
  directorship.get("bank-terms-pdf", `mac/v1/payer/${ME}/termsofuse`, {
    summary: "The terms of use for paying by standing order, as a PDF, in the bank or the credit-card version.",
    category: "billing",
    params: {
      bank: preset(FLAG, "Which version: true for the bank's, false for the credit card's; true when omitted.", "true"),
    },
    query: { isBankTermsOfUse: "{bank}" },
    pdf: true,
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/CreditsAndDebits/DirectDebit",
  }),

  // Profile, feature switches, content and consents.
  mainApp.get("member-details", `mac/v2/members/${ME}`, {
    summary:
      "The member record behind the profile screen, limited to the sections named in `filters`. Identity numbers are removed.",
    category: "account",
    params: {
      filters: preset(
        SECTION_LIST,
        "Sections to return, joined by commas; everything but identity when omitted.",
        "info,contact,address,remarks,insurance,financial",
      ),
    },
    query: { checksum: "{checksum}", filters: "{filters}" },
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "directorship/EditInformation/Profile",
    notes: "The checksum the portal attaches is added inside this client too, and is never part of a result.",
  }),
  mainApp.get("member-details-v1", `mac/v1/members/${ME}`, {
    summary: "The same member record from the older v1 call.",
    category: "account",
    params: { filters: preset(SECTION_LIST, "Sections to return, joined by commas; info alone when omitted.", "info") },
    query: { checksum: "{checksum}", filters: "{filters}" },
    owner: "deep",
    evidence: "bundle",
    screen: "dialog for changing the English name or passport",
  }),
  mainApp.get("features", `mac/v1/members/${ME}/features`, {
    summary: "Which portal features are switched on for the member: an id and an on/off flag each.",
    category: "account",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "every sub-app",
  }),
  mainApp.get("consent-status", `mac/v1/members/${ME}/patient/approvals/{approval_type}`, {
    summary: "Where one kind of patient consent stands: its approval id and when it last changed.",
    category: "account",
    params: {
      approval_type: preset(
        SHORT_NUMBER,
        "Code of the consent kind. 10, used when omitted, is consent to Maccabi-group appointments; the appointments popup asks about a different, configured code.",
        "10",
      ),
    },
    query: { pathJson: "" },
    owner: "deep",
    priority: true,
    evidence: "bundle",
    screen: "appointmentOrder/FutureAppointments",
  }),
  mainApp.get("medical-form-approval", `mac/v1/members/${ME}/approvals/{document_id}`, {
    summary:
      "Details of the approval document for a medical form, as shown when it is opened from the doctor-request timeline.",
    category: "medical",
    params: { document_id: required(TOKEN, "A medical form's document_id, found in the detail of an inquiry.") },
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/Lobby",
  }),
  mainApp.get("content-page", "mac/v1/content/{key}", {
    summary: "One content resource of the portal, addressed by its key.",
    category: "reference",
    params: { key: required(TOKEN, "The node_id of the content; deep links into the portal carry it.") },
    owner: "deep",
    evidence: "bundle",
    screen: "content",
  }),
  mainApp.get("content-resources", "mac/v2/content/resource", {
    summary: "The texts and settings the portal loads as content resources.",
    category: "reference",
    owner: "deep",
    evidence: "bundle",
    screen: "every sub-app",
  }),
  mainApp.get("site-settings", "mac/v1/site/settings", {
    summary: "Site-wide portal settings as of a given day.",
    category: "reference",
    params: { date: derived(ISO_DATE, "The day, YYYY-MM-DD; today when omitted.", (scope) => scope.today) },
    query: { current_date: "{date}" },
    owner: "deep",
    evidence: "bundle",
    screen: "every sub-app",
  }),
  mainApp.get("cities", "mac/v1/content/city", {
    summary: "Reference lookup of cities by name, as the address and doctor-search forms use it.",
    category: "reference",
    params: NAME_PAGE,
    query: { filter: "{filter}", limit: "{limit}", offset: "{offset}" },
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/EditInformation",
  }),
  mainApp.get("city-streets", "mac/v1/content/city/{city_code}/street", {
    summary: "Reference lookup of the streets in a given city.",
    category: "reference",
    params: { city_code: required(NUMBER, "A city's code, as listed by `cities`."), ...NAME_PAGE },
    query: { filter: "{filter}", limit: "{limit}", offset: "{offset}" },
    owner: "deep",
    evidence: "bundle",
    screen: "directorship/EditInformation",
  }),

  // Home page.
  homePage.get("notifications-and-updates", `mac/v1/members/${ME}/{birth_date}/{age}/get_notification_and_updates`, {
    summary:
      "What the home page announces to the member: new results, documents and visit summaries, each with its date, provider, object id and read flag.",
    category: "notifications",
    params: {
      birth_date: derived(ISO_DATE, BORN, (scope) => scope.birthDate.slice(0, 10)),
      age: derived(digits(1, 3), "The member's age in whole years; supplied from the session.", ({ age }) =>
        age?.years === undefined ? undefined : String(age.years),
      ),
    },
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "homepage/NotificationAndUpdates",
  }),

  // Medical file.
  medicalFile.get("applications", `mac/v1/members/${ME}/applications`, {
    summary:
      "Applications and forms the member has filed, such as a mental-health intake, and where each stands. A filed form's PDF is returned as a document reference.",
    category: "requests",
    documents: [APPLICATION_FORM],
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "medicalFile/MentalHealth/Lobby",
  }),
  medicalFile.get("assigned-practitioners", `mac/v1/members/${ME}/assigned_practitioners`, {
    summary:
      "The practitioners assigned to the member personally: name and gender, professions, the clinic's address and assignment status, and the practitioner, position and employee ids.",
    category: "providers",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "medicalfile/MyDoctorsAndTherapists",
  }),
  medicalFile.get("personal-recommendations", `mac/v1/members/${ME}/personal_recommendations`, {
    summary: "Medical recommendations addressed to the member, as JSON. A null list means there are none.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "medicalfile/PersonalRecommendations",
  }),
  medicalFile.get("child-development-diagnoses", `mac/v1/members/${ME}/child_development/diagnosis_summary`, {
    summary: "Summaries of the diagnoses made in child development.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "medicalfile/ChildDevelopment/Lobby",
  }),
  medicalFile.get("child-development-forms", `mac/v1/members/${ME}/child_development/forms`, {
    summary: "The forms of child development together with the answers given.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "medicalfile/ChildDevelopment/Lobby",
  }),
  medicalFile.get("doctor-assignment-eligibility", `mac/v1/practitioner_affiliation/${ME}/eligibilities`, {
    summary:
      "Can the member pick a personal doctor at present: the doctor assigned today, the earliest date a change is allowed, the latest visit and any appointments ahead.",
    category: "providers",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "MedicalFile/MyDoctor",
  }),
  medicalFile.get("practitioner-search", `mac/v1/practitioner_affiliation/${ME}/name`, {
    summary: "Name search over practitioners, used when picking a personal doctor.",
    category: "providers",
    params: { query: required(NAME_TEXT, "Part of the practitioner's name.") },
    query: { query: "{query}" },
    owner: "deep",
    evidence: "bundle",
    screen: "MedicalFile/MyDoctor/Search",
  }),
  medicalFile.post("doctor-assignment-search", "mac/v1/practitioners/clinics_assignment_eligibility_results", {
    summary: "The doctors the member could take as personal doctor, narrowed by name, profession or city.",
    category: "providers",
    params: {
      city: optional(NAME_TEXT, "Name of the city."),
      profession_group: optional(NAME_TEXT, "Name of the profession group."),
      practitioner_first_name: optional(NAME_TEXT, "The practitioner's first name."),
      practitioner_last_name: optional(NAME_TEXT, "The practitioner's last name."),
    },
    body: (values, scope) => ({ eligibility_request: { ...memberPair(scope), ...values } }),
    post: "Only searches. Assigning goes through nominated_practitioner_assignment, which this client never calls.",
    owner: "deep",
    evidence: "bundle",
    screen: "MedicalFile/MyDoctor/Results",
  }),
  medicalFile.get("daytwo-last-purchase", `mac/v1/suppliers/${ME}/daytwo/deal/lastpurchase`, {
    summary: "Tells if a purchase of DayTwo, the nutrition program, is on record for the member.",
    category: "billing",
    owner: "deep",
    evidence: "live-shape",
    screen: "medicalfile/documents",
  }),
  medicalFile.get("vaccination-groups", `mac/v1/members/${ME}/vaccinations_grouped`, {
    summary:
      "Vaccination timeline grouped by vaccine (every field). A COVID group's printable record is a document reference; the website offers that print for COVID groups only, so other groups have none.",
    category: "medical",
    documents: [VACCINATION_BOOKLET],
    owner: "deep",
    evidence: "live-shape",
    screen: "medicalFile/Vaccinations/Lobby",
  }),
  medicalFile.get("vaccinations", `mac/v1/members/${ME}/vaccinations`, {
    summary: "The individual doses within a vaccine group, in full.",
    category: "medical",
    params: {
      group: required(NUMBER, "A group's vaccine_group_code, as listed by `vaccination-groups`."),
      birth_date: derived(ISO_DATE, BORN, (scope) => scope.birthDate),
    },
    bind: [listedIn("vaccination-groups", { group: "vaccine_group_code" })],
    query: { vaccine_group_code: "{group}", birth_date: "{birth_date}" },
    owner: "deep",
    evidence: "bundle",
    screen: "medicalFile/Vaccinations/Lobby",
  }),
  medicalFile.get("sensitivities-full", `mac/v1/members/${ME}/sensitivity`, {
    summary: "Recorded allergies and sensitivities, in full.",
    category: "medical",
    owner: "deep",
    evidence: "live-shape",
    screen: "medicalFile/Sensitivity/Lobby",
  }),
  medicalFile.get("referrals-full", `mac/v1/members/${ME}/referrals`, {
    summary:
      "Referrals issued between two dates, in full: classification, general data, type codes, the provider's id and specialization. A referral's PDF is returned as a document reference.",
    category: "medical",
    params: DATE_RANGE,
    query: { from_date: "{from}", to_date: "{to}" },
    documents: [MEDICAL_FILE_PDF],
    owner: "deep",
    evidence: "live-shape",
    screen: "medicalfile/documents/referrals",
  }),
  medicalFile.get("medical-approvals", `mac/v1/members/${ME}/approvals`, {
    summary: "Approvals and medical certificates issued between two dates, in full, with a document reference per PDF.",
    category: "medical",
    params: {
      ...DATE_RANGE,
      approval_type_codes: optional(NUMBER_LIST, "Keep only these approval type codes, joined by commas."),
    },
    query: { from_date: "{from}", to_date: "{to}", approval_type_codes: "{approval_type_codes}" },
    documents: [MEDICAL_FILE_PDF],
    owner: "deep",
    evidence: "bundle",
    screen: "medicalfile/documents/approvals",
  }),
  medicalFile.get("tutorials", `mac/v1/members/${ME}/tutorials`, {
    summary:
      "Tutorials, the extra information handed out after a visit, between two dates and in full. Those of type 1 are documents and get a reference.",
    category: "medical",
    params: DATE_RANGE,
    query: { from_date: "{from}", to_date: "{to}" },
    documents: [TUTORIAL_PDF],
    owner: "deep",
    evidence: "live-shape",
    screen: "medicalfile/documents/tutorials",
  }),
  medicalFile.get("purchased-medication-report", `mac/v1/members/${ME}/prescriptions/purchased/report`, {
    summary: "The report of medication the member bought; its PDF arrives as a document reference.",
    category: "medical",
    owner: "deep",
    evidence: "live-shape",
    screen: "medicalfile/Medications/MedicationsHistory",
  }),
  medicalFile.get("corona-certificate", `mac/v2/members/${ME}/coronaCertificate`, {
    summary:
      "The member's COVID certificate, v2 call. Without a certificate the service answers HTTP 500, and the website shows its generic error popup.",
    category: "medical",
    owner: "deep",
    evidence: "bundle",
    screen: "content: vaccination certificate",
  }),

  // Appointments, apart from scheduling itself.
  appointmentOrder.get("flu-vaccine-eligibility", `mac/v1/members/${ME}/eligibility/vaccines/flu`, {
    summary: "Flu vaccine: is the member in the target population, eligible, and in need of Fluzone.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "appointmentOrder/NewAppointment",
  }),
  appointmentOrder.get("corona-test-eligibility", `mac/v1/members/${ME}/eligibility_for_corona_test`, {
    summary: "A single indicator: may the member take a COVID test.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "appointmentOrder/NewAppointment",
  }),
  appointmentOrder.get("corona-vaccine-eligibility", `mac/v1/members/${ME}/vaccines/corona/eligibilities`, {
    summary:
      "COVID vaccine: indicators for eligibility, for having had the disease and for a completed vaccination course.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "appointmentOrder/NewAppointment",
  }),
  appointmentOrder.get("appointment-files", `mac/v1/members/${ME}/appointments/{appointment_id}`, {
    summary:
      "A single upcoming appointment, fetched the way the appointment-files screen does; channel and time window default to the portal's configuration.",
    category: "appointments",
    params: {
      appointment_id: APPOINTMENT_ID,
      summoning_channel: preset(/^[A-Z]$/, "One capital letter; D when omitted, as the portal sends.", "D"),
      date_range_in_hours: preset(SHORT_NUMBER, "Hours; 3 when omitted, as the portal sends.", "3"),
    },
    bind: [OWN_APPOINTMENT],
    query: { summoning_channel: "{summoning_channel}", date_range_in_hours: "{date_range_in_hours}" },
    owner: "deep",
    priority: true,
    evidence: "bundle",
    screen: "appointmentOrder/Files/Lobby",
  }),
  appointmentOrder.get("appointment-request-id", `mac/v1/members/${ME}/appointments/{appointment_id}/request_id`, {
    summary:
      "The id of the service request attached to an upcoming appointment; the appointment-files flow starts from it.",
    category: "appointments",
    params: { appointment_id: APPOINTMENT_ID },
    bind: [OWN_APPOINTMENT],
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/FutureAppointments/AppointmentInfo",
  }),
  appointmentOrder.get("appointment-service-request", `mac/v1/members/${ME}/service_requests/{interaction_id}`, {
    summary: "The service request attached to an upcoming appointment: its correspondence and files.",
    category: "appointments",
    params: { interaction_id: required(TOKEN, "The request_id that `appointment-request-id` returns.") },
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/FutureAppointments/AppointmentInfo",
  }),
  appointmentOrder.get("uploaded-files", `mac/v1/members/${ME}/files/uploaded`, {
    summary: "What the member has uploaded for one appointment event.",
    category: "appointments",
    params: {
      events: required(TOKEN, "Id of the event: `event` in the query of the appointment-files link."),
      event_source_id: required(TOKEN, "Source of the event: `s` in the query of the same link."),
    },
    query: { events: "{events}", event_source_id: "{event_source_id}" },
    owner: "deep",
    priority: true,
    evidence: "bundle",
    screen: "appointmentOrder/Files/Lobby",
  }),
  appointmentOrder.post("appointment-documents-indication", `mac/v1/members/${ME}/appointments/documents/indication`, {
    summary: "Tells if documents are attached to an upcoming appointment.",
    category: "appointments",
    params: { appointment_id: APPOINTMENT_ID },
    bind: [OWN_APPOINTMENT],
    body: ({ appointment_id }) => ({ appointment_id }),
    post: "Answers yes or no and changes nothing; the portal sends it on opening the appointment.",
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/FutureAppointments/AppointmentInfo",
  }),
  appointmentOrder.post("visit-triage", `mac/v1/members/${ME}/visits/triage`, {
    summary: "The triage details the appointment screen requests for a provider on a given date.",
    category: "appointments",
    params: {
      object_type: required(/^[A-Z]{1,2}$/, "object_type of the provider."),
      object_id: required(NUMBER, "object_id of the provider."),
      employee_id: required(NUMBER, "employee_id of the provider."),
      appointment_date: required(
        DAY_OR_MOMENT,
        "Day of the appointment, with or without a time: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss.",
      ),
      is_treatareatype: PORTAL_FLAG,
    },
    body: ({ object_type, object_id, employee_id, appointment_date, is_treatareatype }, scope) => ({
      members: [memberPair(scope)],
      object_type,
      object_id,
      employee_id,
      appointment_date,
      is_treatareatype: is_treatareatype === "true",
    }),
    post: "Asks what triage a date with a provider would require. No booking results.",
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/NewAppointment",
  }),
  appointmentOrder.post("future-appointments-v1", `mac/v1/members/${ME}/appointments/future`, {
    summary: "Upcoming appointments from the v1 list call, in full.",
    category: "appointments",
    // The v1 call takes the id number as a string, where every other body here sends a number.
    body: (_values, scope) => ({
      members: [{ member_id_code: scope.memberIdCode, member_id: String(scope.memberId) }],
    }),
    post: "This is how the portal lists appointments; the body does no more than name the member.",
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/FutureAppointments/Lobby",
  }),
  appointmentOrder.post("future-appointments", `mac/v2/members/${ME}/appointments/future`, {
    summary: "Upcoming appointments from the v2 list call, in full; id and external_id are among the fields.",
    category: "appointments",
    body: (_values, scope) => ({
      members: [{ ...memberPair(scope), member_consent_for_subsidiary_information: 0 }],
      is_with_ascribed_doctor: true,
    }),
    post: "This is how the portal lists appointments; the body does no more than name the member.",
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/FutureAppointments/Lobby",
    notes: "`appointments` is a projection of this same answer.",
  }),
  appointmentOrder.get(
    "switchit-registrations",
    `mac/v2/members/${ME}/appointments/switchit-registrations/{registration_id}`,
    {
      summary:
        "A single Switchit (appointment swap) registration, looked up by id. The website never reads the path without an id, which answers HTTP 405; POST, PUT and DELETE on it change state and are not offered.",
      category: "appointments",
      params: { registration_id: required(TOKEN, "Id of the Switchit registration; it cannot be empty.") },
      owner: "deep",
      priority: true,
      evidence: "live-shape",
      screen: "appointmentOrder/Switchit",
    },
  ),
  appointmentOrder.get("switchit-matches", `mac/v2/members/${ME}/appointments/switchit/matches/`, {
    summary: "The swaps proposed for a given appointment.",
    category: "appointments",
    params: {
      appointment_id: required(TOKEN, "The appointment id a Switchit registration holds."),
      match_id: preset(/^[A-Za-z0-9_-]{0,64}$/, "Id of one match; empty when omitted.", ""),
    },
    query: { appointment_id: "{appointment_id}", match_id: "{match_id}" },
    owner: "deep",
    evidence: "bundle",
    screen: "appointmentOrder/Switchit/Matches",
  }),
  appointmentOrder.get("recent-providers-full", `mac/v1/members/${ME}/providers/appointment_service_providers`, {
    summary: "The providers of the member's recent visits, in full.",
    category: "providers",
    params: { is_minor: preset(FLAG, "Whether the account is a minor's; false when omitted.", "false") },
    query: { is_minor: "{is_minor}" },
    owner: "deep",
    evidence: "live-shape",
    screen: "appointmentOrder/NewAppointment/Recent/Providers",
  }),

  // Requests to a doctor.
  withDoctor.get("inquiries-full", `mac/v1/members/${ME}/inquiries`, {
    summary:
      "The member's inquiries, meaning requests to a doctor, with all list fields. A document attached by an automatic sick note is returned as a reference.",
    category: "medical",
    documents: [INQUIRY_FORM_DOCUMENT],
    owner: "deep",
    evidence: "live-shape",
    screen: "communicationWithDoctor/Lobby",
  }),
  withDoctor.get("read-status-counters", `mac/v1/members/${ME}/read_status/counters`, {
    summary: "Counts of doctor-request messages still unread or unapproved.",
    category: "notifications",
    params: {
      family: optional(FLAG, "Set true to count the family as well, which is what the portal's family view requests."),
    },
    query: { isFamily: "{family}" },
    owner: "family",
    priority: true,
    evidence: "live-shape",
    screen: "communicationWithDoctor/Lobby",
  }),
  withDoctor.get("inquiry-drugs", `mac/v1/members/${ME}/drugs`, {
    summary: "v1 list of the drugs a prescription request to the doctor may name.",
    category: "medical",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest/Doctor/Request/DrugsPrescription",
  }),
  withDoctor.get("inquiry-drugs-v2", `mac/v2/members/${ME}/drugs`, {
    summary: "v2 list of the drugs a prescription request to the doctor may name.",
    category: "medical",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest/Doctor/Request/DrugsPrescription",
  }),
  withDoctor.get("inquiry-service-providers", `mac/v1/members/${ME}/inquiries/service_providers`, {
    summary: "v1 list of the doctors open to a request from the member.",
    category: "providers",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest/Doctor",
  }),
  withDoctor.get("inquiry-service-providers-v2", `mac/v2/members/${ME}/inquiries/service_providers`, {
    summary: "v2 list of the doctors open to a request from the member.",
    category: "providers",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest/Doctor",
  }),
  withDoctor.get("medical-forms-wizard", "mac/v1/content/wizard/medical_forms", {
    summary: "Content of the wizard that requests medical forms.",
    category: "medical",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest/DocumentRequest",
  }),
  withDoctor.post("inquiry-eligibility", `mac/v1/members/${ME}/inquiries/eligibility`, {
    summary: "Tells if the member is allowed to open a doctor request for a given service.",
    category: "medical",
    params: {
      service_code: required(
        NUMBER,
        "A doctor's service_code, from the family_doctors or connected_doctors rows of `inquiry-service-providers`.",
      ),
      is_from_recommendation: PORTAL_FLAG,
    },
    bind: [listedIn("inquiry-service-providers", { service_code: "service_code" })],
    body: ({ service_code, is_from_recommendation }, { remarkCodes }) => ({
      service_code: numberIfDigits(service_code),
      is_from_recommendation: is_from_recommendation === "true",
      ...(remarkCodes === undefined ? {} : { patient_codes: remarkCodes }),
    }),
    post: "Checks eligibility ahead of showing the request form. Sending the request is a POST to inquiries, which this client never makes.",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest",
    notes:
      "Mirrors the request wizard: service_code comes from the doctor list and patient_codes is the member's remark codes joined by commas.",
  }),
  withDoctor.post("sick-note-eligibility", `mac/v1/members/${ME}/automatic/request/eligibility`, {
    summary: "Tells if the member could get an automatic sick note covering the given days.",
    category: "medical",
    params: {
      from: required(ISO_DATE, "First day of absence, YYYY-MM-DD."),
      to: required(ISO_DATE, "Last day of absence, YYYY-MM-DD."),
      total_days: required(SHORT_NUMBER, "How many days the absence spans."),
    },
    body: ({ from, to, total_days }, { age }) => ({
      from_date: from,
      to_date: to,
      age: age?.years ?? null,
      total_days: numberIfDigits(total_days),
    }),
    post: "Checks eligibility only. A note is issued by a POST to kafka/message, which this client never makes.",
    owner: "deep",
    evidence: "bundle",
    screen: "communicationWithDoctor/NewRequest/OfficeRequest",
  }),

  // Administrative requests and approvals.
  requestsAndApprovals.get("request-topics", `mac/v1/members/${ME}/topics`, {
    summary:
      "What an administrative request (a refund, an obligation) can be about: topics and their sub-topics with names, codes, the documents each requires and links on eligibility.",
    category: "requests",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "requestsAndApprovals/RefundRequest/TopicSelect",
  }),
  requestsAndApprovals.get("pending-referrals", `mac/v1/members/${ME}/pending/referrals`, {
    summary: "Referrals still waiting for approval; an empty 204 when there are none.",
    category: "requests",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "requestsAndApprovals/ObligationRequest/New",
  }),
  requestsAndApprovals.post("requests-and-cases", `mac/v1/members/${ME}/requests_and_cases`, {
    summary: "The member's administrative cases and requests, in full.",
    category: "requests",
    body: (_values, scope) => ({ members: [memberPair(scope)] }),
    post: "This is how the portal lists requests; the body does no more than name the member.",
    owner: "deep",
    evidence: "bundle",
    screen: "requestsAndApprovals/StatusRequest/Lobby",
  }),
  requestsAndApprovals.get("case", `mac/v1/members/${ME}/cases/{interaction_id}`, {
    summary: "A single administrative case, in full.",
    category: "requests",
    params: { interaction_id: required(TOKEN, "The interaction_id of a Case row in `requests-and-cases`.") },
    bind: [OWN_REQUEST],
    owner: "deep",
    evidence: "bundle",
    screen: "requestsAndApprovals/StatusRequest/Lobby",
  }),
  requestsAndApprovals.get("service-request", `mac/v1/members/${ME}/service_requests/{interaction_id}`, {
    summary: "A single administrative service request, in full.",
    category: "requests",
    params: { interaction_id: required(TOKEN, "The interaction_id of a ServiceRequest row in `requests-and-cases`.") },
    bind: [OWN_REQUEST],
    owner: "deep",
    evidence: "bundle",
    screen: "requestsAndApprovals/StatusRequest/Lobby",
  }),

  // Test results.
  testResults.get("followed-test-list", `mac/v1/members/${ME}/followed/testlist`, {
    summary: "The lab tests the member has chosen to follow.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "testsResults/TestsResults/Follow",
  }),
  testResults.get("followed-test-options", `mac/v1/members/${ME}/followed/options`, {
    summary: "Every test that can be followed: id, description, and a flag on those already followed.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "testsResults/TestsResults/Follow",
  }),
  testResults.get("followed-test-counter", `mac/v1/members/${ME}/followed/counter`, {
    summary: "How many tests the member follows.",
    category: "medical",
    owner: "deep",
    priority: true,
    evidence: "live-shape",
    screen: "testsResults/TestsResults/Follow",
  }),
  testResults.get("latest-lab-results-full", `mac/v1/members/${ME}/getlatestlabresults`, {
    summary:
      "The most recent result of each laboratory test, in full, plus a document reference to the PDF report of those results.",
    category: "medical",
    documents: [LATEST_LAB_REPORT],
    owner: "deep",
    evidence: "live-shape",
    screen: "testsResults/TestsResults/Latest",
  }),
];

// ------------------------------------------------------------------------------------- using the catalog

const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));
export const catalogEntry = (name: string): CatalogEntry | undefined => BY_NAME.get(name);

type RefusalReason =
  | "unknown-endpoint"
  | "excluded-endpoint"
  | "unknown-parameter"
  | "invalid-parameter"
  | "missing-parameter"
  | "pdf-only";

/** The catalog turned a request down, by name or by parameter, before anything was sent to Maccabi. */
export class CatalogRefusal extends Error {
  override readonly name = "PortalRequestError";
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Everything that can be decided about a request without knowing who is signed in: the name exists,
 * each argument is one the entry declares and fits its pattern, and no required one is absent. A
 * surface runs this first so that a bad request never opens a session.
 */
export function vetCatalogRequest(name: string, args: Record<string, string>): CatalogEntry {
  const entry = catalogEntry(name);
  if (!entry) {
    // A name that was reviewed and kept out is answered with the reason on record for it, which for a
    // removed read says where the same data is found. Any other name gets the general refusal.
    const keptOut = NEVER_OFFERED.find((call) => call.name === name);
    if (keptOut) throw new CatalogRefusal("excluded-endpoint", `That endpoint is not offered: ${keptOut.reason}`);
    throw new CatalogRefusal(
      "unknown-endpoint",
      "No catalog entry has that name. `portal-endpoints` shows the names that exist; calls that change anything are not among them.",
    );
  }
  // A Map of the declared names: `constructor` or `toString` can then never match something inherited.
  const rules = new Map(Object.entries(entry.params ?? {}));
  for (const [key, value] of Object.entries(args)) {
    const rule = rules.get(key);
    if (!rule) {
      const accepted = [...rules.keys()].join(", ");
      throw new CatalogRefusal(
        "unknown-parameter",
        accepted
          ? `${entry.name} has no parameter by that name; its parameters are: ${accepted}.`
          : `${entry.name} accepts no parameters at all.`,
      );
    }
    if (typeof value !== "string" || !rule.pattern.test(value)) {
      throw new CatalogRefusal(
        "invalid-parameter",
        `The value given for ${key} is not in the expected form. ${rule.description}`,
      );
    }
  }
  for (const [key, rule] of rules) {
    if (rule.required && !rule.default && !Object.hasOwn(args, key)) {
      throw new CatalogRefusal("missing-parameter", `${entry.name} cannot be read without ${key}. ${rule.description}`);
    }
  }
  return entry;
}

/** A vetted request plus the values the caller left to their defaults, now that the member is known. */
export function fillCatalogRequest(
  name: string,
  args: Record<string, string>,
  scope: CatalogScope,
): { entry: CatalogEntry; values: Record<string, string> } {
  const entry = vetCatalogRequest(name, args);
  const values: Record<string, string> = {};
  for (const [key, rule] of Object.entries(entry.params ?? {})) {
    const given = Object.hasOwn(args, key) ? args[key] : rule.default?.(scope);
    if (given !== undefined) values[key] = given;
  }
  return { entry, values };
}

/** The path and query of the request. Only vetted values and the session's own ids enter the template. */
export function catalogPath(
  entry: CatalogEntry,
  values: Record<string, string>,
  scope: CatalogScope,
  internal: { checksum?: string } = {},
): string {
  const path = entry.path.replace(/\{([a-z_]+)\}/g, (_placeholder, key: string) => {
    switch (key) {
      case "c":
        return encodeURIComponent(scope.memberIdCode);
      case "id":
        return String(scope.memberId);
      default:
        return encodeURIComponent(values[key] ?? "");
    }
  });
  const query = new URLSearchParams();
  for (const [key, template] of Object.entries(entry.query ?? {})) {
    const param = /^\{([a-z_]+)\}$/.exec(template)?.[1];
    // The checksum is the one query value that is neither a literal nor something a caller can set.
    const value = param === undefined ? template : param === "checksum" ? (internal.checksum ?? "") : values[param];
    if (value !== undefined) query.append(key, value);
  }
  const base = `${webapi(entry.service)}/${path}`;
  return query.size > 0 ? `${base}?${query}` : base;
}

export interface CatalogListing {
  name: string;
  category: DataKind;
  summary: string;
  service: string;
  method: string;
  path: string;
  params: Record<string, { description: string; required: boolean; pattern: string }>;
  pdf: boolean;
  priority: boolean;
  screen: string;
  evidence: string;
  notes?: string;
  post?: string;
  boundTo?: string[];
}

/** An entry as `portal-endpoints` prints it: the data, with functions and patterns turned into text. */
function listing(entry: CatalogEntry): CatalogListing {
  const params: CatalogListing["params"] = {};
  for (const [key, { description, required: needed, pattern }] of Object.entries(entry.params ?? {})) {
    params[key] = { description, required: needed === true, pattern: pattern.source };
  }
  const { name, category, summary, service, method, path, screen, evidence } = entry;
  const row: CatalogListing = {
    name,
    category,
    summary,
    service,
    method,
    path,
    params,
    pdf: entry.pdf === true,
    priority: entry.priority === true,
    screen,
    evidence,
  };
  if (entry.notes) row.notes = entry.notes;
  if (entry.method === "POST") row.post = entry.post;
  if (entry.bind) row.boundTo = entry.bind.map(({ source }) => source);
  return row;
}

export function listCatalog(category?: DataKind): CatalogListing[] {
  const wanted = category ? CATALOG.filter((entry) => entry.category === category) : CATALOG;
  return wanted.map(listing);
}

// ------------------------------------------------------------------------------------------ left out

interface LeftOut {
  name: string;
  service: string;
  method: string;
  path: string;
  reason: string;
}
const leftOut = (service: string, calls: Record<string, [method: string, path: string, reason: string]>): LeftOut[] =>
  Object.entries(calls).map(([name, [method, path, reason]]) => ({ name, service, method, path, reason }));

/**
 * The other half of the review: portal calls that were looked at and kept out. Most of them write
 * something, hand out a token or a signed link, or exist for logging. A few are reads which the
 * production website itself never performs, and two were catalog entries until it turned out that no
 * list supplies an id they accept. Paths are written without the leading `mac/`, and no name in this
 * list is a catalog entry. A request for one of these names is refused with the reason given here, so
 * each reason is written to be shown to a caller.
 */
export const NEVER_OFFERED: readonly LeftOut[] = [
  ...leftOut("TestsResultsApi", {
    "test-information": [
      "GET",
      `v1/members/${ME}/tests/getresultsbyid?test_id`,
      "Reached only from a content landing page that a Maccabi SMS or message opens, with its own code. No list gives an agent that code. Test values are in `lab-values` and `lab-history`.",
    ],
  }),
  ...leftOut("ContentAPI", {
    "medicine-name": [
      "GET",
      `v1/members/${ME}/medicine_name/{code}/`,
      "Reached only from a medicine landing page that a Maccabi SMS or message opens, with its own code, which no list gives an agent. Medicine names are already in `prescriptions` and `pharmacy-purchases`.",
    ],
  }),
  ...leftOut("AppointmentOrderAPI", {
    "odoro-session": [
      "POST",
      `v1/members/${ME}/odoro/session`,
      "Starts a scheduling dialogue, and that alone alters the appointment system.",
    ],
    "odoro-dialog": ["POST", `v1/members/${ME}/odoro/dialog`, "Replies to one step of a scheduling dialogue."],
    "summon-appointment": ["POST", `v1/members/${ME}/appointments/summon_appointment`, "Makes a booking."],
    "update-appointment": ["PUT", `v1/members/${ME}/appointments/update_appointment`, "Alters a booking."],
    "replace-appointment-provider": [
      "PUT",
      `v1/members/${ME}/appointments/replace_for_different_provider`,
      "Moves a booking to another provider.",
    ],
    "cancel-appointment": ["DELETE", `v2/members/${ME}/appointments/cancel`, "Calls a booking off."],
    "join-waiting-list": ["POST", `v1/members/${ME}/joinwaitinglist`, "Puts the member on a waiting list."],
    "remove-from-waiting-list": [
      "PUT",
      `v1/members/${ME}/removefromwaitinglist`,
      "Takes the member off a waiting list.",
    ],
    "switchit-register": [
      "POST",
      `v2/members/${ME}/appointments/switchit-registrations/`,
      "Signs up to swap an appointment.",
    ],
    "switchit-update": ["PUT", `v2/members/${ME}/appointments/switchit-registrations/{n}`, "Edits a swap sign-up."],
    "switchit-delete": [
      "DELETE",
      `v2/members/${ME}/appointments/switchit-registrations/{n}`,
      "Removes a swap sign-up.",
    ],
    "switchit-accept-match": [
      "PUT",
      `v2/members/${ME}/appointments/switchit/matches/{n}`,
      "Takes or turns down a proposed swap.",
    ],
    "upload-files": ["POST", `v1/members/${ME}/files`, "An upload."],
    "upload-service-request-document": ["POST", `v1/members/${ME}/{uri}`, "An upload into a service request."],
    "files-description": ["PATCH", `v1/members/${ME}/files/description`, "Rewrites the descriptions of uploads."],
    "delete-files": ["DELETE", `v1/members/${ME}/files`, "Removes uploads."],
    "delete-service-request-document": [
      "DELETE",
      `v1/members/${ME}/service_requests_document`,
      "Removes a document from a service request.",
    ],
    "update-service-request": ["PUT", `v1/members/${ME}/service_requests/{n}`, "Files a service request."],
    "convert-pdf": [
      "POST",
      `v1|v2/members/${ME}/convert/pdf`,
      "Part of uploading: converts what the caller sends and gives back nothing of the member's.",
    ],
    "visit-mark-read": ["PATCH", `v1/members/${ME}/visits/{n}/read`, "Flags a visit summary as read."],
  }),
  ...leftOut("AppointmentOrderAPI|MainAppAPI", {
    "client-error-log": ["POST", "v1/logs/client_error", "Writes to a log."],
  }),
  ...leftOut("CommunicationWithDoctorAPI", {
    "inquiry-create": ["POST", `v1|v2/members/${ME}/inquiries`, "Submits a request to a doctor."],
    "inquiry-update": ["PATCH", `v1/members/${ME}/inquiries/{n}`, "Rewrites a submitted request."],
    "inquiry-status": ["PATCH", `v1/members/${ME}/inquiries/{n}/status`, "Moves a request to another status."],
    "inquiry-viewed": [
      "PATCH|POST",
      `v1/members/${ME}/inquiries/{n}/viewed, inquiries/viewed, automatic/request/viewed`,
      "Flags requests as seen.",
    ],
    "inquiry-read-approval": [
      "POST",
      `v1/members/${ME}/inquiries/{n}/read_approval`,
      "Records the member's confirmation of having read.",
    ],
    "sick-note-issue": ["POST", `v1/members/${ME}/kafka/message`, "Produces an automatic sick note."],
  }),
  ...leftOut("DirectorshipAPI", {
    "notification-settings-save": [
      "PATCH",
      `v1/members/${ME}/online_notification[?is_family_update]`,
      "Stores new notification settings.",
    ],
    "password-reset": ["PATCH", `v1/members/${ME}/password/reset`, "Replaces the password."],
    "magnetic-card-order": ["POST", `v1/members/${ME}/magnetic_card`, "Places an order for a card."],
    remarks: ["POST", `v1/members/${ME}/remarks`, "Rewrites the remarks on the profile."],
    "patient-relations": [
      "POST|PUT",
      `v1/membership/${ME}/patient_relations`,
      "Gives somebody access to the account, or takes it away.",
    ],
    "caregiver-candidate": [
      "POST",
      `v1/members/${ME}/check_caregiver_candidate`,
      "One step of giving access, and it is fed another person's national id.",
    ],
    "insurances-add": ["POST", `v1/members/${ME}/insurances/add`, "Signs the member up to an insurance plan."],
    "biobank-enroll": ["POST", `v1/members/${ME}/biobank/enroll`, "Signs the member up to the biobank."],
    "infant-registration": ["POST", `v1/members/${ME}/infant/registration`, "Adds a newborn to the account."],
    "finance-update": ["PUT", `v1/members/${ME}/finance`, "Switches the way debts are collected."],
    "debt-payment": [
      "POST",
      `v1/members/${ME}/finance/creditcard/transactions/process_debt_payment, finance/payers/debits-payment, v1/payer/${ME}/transactions/prepare, creditcard/authorization_and_archive, transaction/details`,
      "The steps of paying a debt.",
    ],
    "bank-create-debit": ["POST", `v1/member/${ME}/bank/createdebit`, "Sets up a direct debit."],
    "bank-validate": [
      "GET",
      `v1/payers/${ME}/bank/validate/`,
      "The direct-debit form checks an entire bank account number with it; the member learns nothing from the answer.",
    ],
    "oncogenetic-form": [
      "POST",
      `oncogenetic/${ME}/cellosignForm, oncogenetic/${ME}/token`,
      "Hands out a token, or opens a form to be signed.",
    ],
    "travel-insurance-token": [
      "GET",
      `v1/members/${ME}/travel_abroad_insurance/token`,
      "Hands out a token to a site outside the portal.",
    ],
    "no-card-visit": [
      "GET",
      `v1/members/${ME}/allow_no_card_visit`,
      "A GET that acts: it grants permission to visit without the card.",
    ],
  }),
  ...leftOut("DirectorshipAPI|MedicalFileAPI", {
    "timestamp-and-hash": [
      "GET",
      `v1/members/${ME}/timestampAndHash`,
      "Signing material for downloads. The PDF readers fetch it for themselves and nobody else may.",
    ],
  }),
  ...leftOut("MainAppAPI", {
    "member-details-v3": [
      "GET",
      `v3/members/${ME}?checksum&filters`,
      "No read of the production site: it stays on v2 (member-details). v3 sits behind a development flag and needs a user header that exists in development alone.",
    ],
    "member-update": [
      "PATCH",
      `v1/members/${ME}, login_status, non_member_parent_contact, non_member_parent_phone`,
      "Rewrites profile fields.",
    ],
    "consent-change": [
      "PATCH|DELETE",
      `v1/members/${ME}/patient/approvals/{n}, approvals/{n}`,
      "Grants a consent or takes one back.",
    ],
    messages: [
      "POST|PATCH",
      `v1/members/${ME}/messages[/{n}]`,
      "Posts or dismisses messages. Unprompted, the home page POSTs {members:[{member_id_code, member_id, message_ids:[...]}]} here to flag its updates as seen (seen live on 2026-10-28).",
    ],
    "digital-otp": [
      "GET|POST",
      `v1/members/${ME}/digital_otp_number[/{n}]`,
      "A code that identifies the member, which makes it a credential.",
    ],
    "whats-new": ["GET", `v1/members/${ME}/show_what_new`, "Notes down that the what's-new popup has been displayed."],
    "ibm-log": ["GET", `v1/members/${ME}/ibm/log`, "Writes to a log, and is handed a cookie value to do it."],
    "mac-pharm-token": ["GET", `v1/navigation/macPharmToken/${ME}`, "Hands out a token to a site outside the portal."],
  }),
  ...leftOut("MainAppAPI|DirectorshipAPI", {
    "centralized-log": ["POST", `v1/members/${ME}/log/centralized`, "Writes to a log."],
  }),
  ...leftOut("TokenServerAPI", {
    "token-full": [
      "GET",
      "v2|v4/members/token/full",
      "Bootstraps the session with an API token. What it knows of the profile is available from profile and contact-details.",
    ],
  }),
  ...leftOut("MedicalFileAPI", {
    "medical-file-visits": [
      "GET",
      `v1/members/${ME}/visits`,
      "Present in the portal bundle, yet nothing calls it. Visits come from clinic-visits (AppointmentOrderAPI visits/history).",
    ],
    "external-token": ["GET", `v1/members/${ME}/externalToken`, "Hands out a token to a site outside the portal."],
    "supplier-redirect": [
      "GET|POST",
      `v1/members/${ME}/suppliers/redirecturl/{a}/{b}, v1/suppliers/${ME}/deal/participation`,
      "Joins a supplier's deal, or returns a signed redirect to the supplier.",
    ],
    "generate-guid": [
      "GET",
      `v1/members/${ME}/generateguid`,
      "Issues a single-use identifier for a form that is about to be submitted.",
    ],
    "child-form-url": [
      "POST",
      `v1/members/${ME}/child_development/form_url_params`,
      "Hands out a signed link to a form.",
    ],
    "child-form-delete": ["PATCH", `v1/members/${ME}/child_development/forms/delete_form`, "Removes a form."],
    "vaccine-summary-delete": [
      "DELETE",
      `v1/members/${ME}/vaccines/{a}/summary/{b}`,
      "Removes a vaccine the member reported.",
    ],
    "set-document-read": ["POST", `v1/members/${ME}/setDocumentRead`, "Flags a document as read."],
    "assign-practitioner": [
      "POST",
      "v1/practitioners/nominated_practitioner_assignment",
      "Makes a doctor the member's personal doctor.",
    ],
  }),
  ...leftOut("RequestsAndApprovalsAPI", {
    "case-update": ["PUT", `v1/members/${ME}/cases/{n}, service_requests/{n}`, "Files an update to a case."],
  }),
  ...leftOut("TestResultsAPI", {
    "follow-toggle": ["PUT", `v1/members/${ME}/followed/toggletest`, "Starts or stops following a test."],
    "test-mark-read": ["GET", `v1/members/${ME}/read/{doc}`, "A GET that acts: it flags a test result as read."],
    "latest-results-share-url": [
      "POST",
      `v1/members/${ME}/results/lab/latest/url`,
      "Hands out a link for sharing the latest results.",
    ],
    "meddream-token": [
      "GET",
      `pdf/members/${ME}/meddream/token/{n}`,
      "The token of the imaging viewer. The imaging reads obtain it for themselves.",
    ],
  }),
];
