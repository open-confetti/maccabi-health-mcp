/**
 * The medical file: recommendations, the selected summary, hospital history, medications bought, saved
 * documents, the classic requests grid, vaccinations and sensitivities, with the reports that go with them.
 */
import { ReadRefusal, refuse } from "../faults";
import { jsonUpTo, PORTAL_SITE } from "../http";
import type { MemberScope } from "./context";
import { type ClassicGrid, classicGridIn, type PurchaseHistory, purchasesIn } from "./parse/classic-grids";
import {
  ClassicPageShapeError,
  type ClassicRecommendations,
  type ClassicSummary,
  hospitalSettingsIn,
  recommendationsIn,
  selectedSummaryIn,
} from "./parse/classic-pages";
import {
  asObject,
  asString,
  checkDaySpan,
  checkOptional,
  classicBody,
  type DaySpan,
  type Fields,
  getJson,
  isCount,
  mustBelongToMemberDeep,
  mustBeOk,
  mustBeReference,
  pdfFromBase64,
  pdfFromEnvelope,
  type Reading,
  SteadyReferences,
  todayLocal,
  turnAway,
  unescapeComponent,
  valuesOf,
  yearsBefore,
  yearUpTo,
} from "./shared";

export interface VaccineGroup extends Fields {
  vaccine_group_name: string;
  vaccine_group_code: number;
  vaccinations_amount: number;
  last_date: string;
  first_date: string;
  timestamp: string;
}

/** What a hospital report download needs from its row, under the query names the popup takes. */
interface HospitalReport {
  path: string;
  typeCommitment: string;
}

/** The text columns of a hospital row. With the commitment key appended they are also what identifies the row. */
const HOSPITAL_TEXT_COLUMNS = [
  "NameHospital",
  "DateHospitalization",
  "Date",
  "DurationHospitalization",
  "QuantityTreatments",
  "TypeCommitment",
  "Department",
] as const;

/** The grid page to ask Maccabi for: the first unless the caller names one, and never past the thousandth. */
function gridPage(pageNo = 1): number {
  if (Number.isSafeInteger(pageNo) && pageNo >= 1 && pageNo <= 1000) return pageNo;
  throw new TypeError("a grid page is a whole number between 1 and 1000");
}

/** A YYYY-MM-DD day turned day-first, the way the classic pages write dates. */
const dayFirst = (dayText: string, separator: string): string => dayText.split("-").reverse().join(separator);

/** Both hospital reads take the caller's local date and an optional range, and check them alike. */
function checkHospitalWindow(onDay: string, span: DaySpan | undefined): string {
  checkDaySpan({ from: onDay, to: onDay });
  if (span) checkDaySpan(span);
  return JSON.stringify([onDay, span ?? null]);
}

/** Runs a classic-page parser. A page the parser no longer recognises becomes the read's own refusal. */
function parsed<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (caught) {
    if (caught instanceof ClassicPageShapeError) throw refuse("UNEXPECTED_ANSWER", label, "shape-changed");
    throw caught;
  }
}

function jsonOf(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw refuse("UNEXPECTED_ANSWER", label, "body-unparsable");
  }
}

/** JSON carried inside a string is read as JSON. Anything else, unparsable text included, is left as it came. */
function jsonWithin(sent: unknown): unknown {
  if (typeof sent !== "string") return sent;
  try {
    return JSON.parse(sent);
  } catch {
    return sent;
  }
}

export class Records {
  private readonly knownVaccineGroups = new Set<number>();
  /** The last hospital list that validated, with the day and range it was asked for. */
  private hospital?: { window: string; reports: Map<string, HospitalReport> };

  constructor(private readonly scope: MemberScope) {}

  private async medicalFile(tail: string, label: string): Promise<Fields> {
    const where = this.scope.path("MedicalFileAPI", "v1", tail);
    return asObject(await getJson(this.scope.http, where, label), label);
  }

  /**
   * The recommendations the current portal shows, from its JSON service. The service can send
   * `recommendations: null`, and that reads as an empty list. Rows go out whole.
   */
  async fetchPersonalRecommendations(): Promise<Reading<{ recommendations: Fields[] }>> {
    const label = "health-recommendations";
    const payload = await this.medicalFile("personal_recommendations", label);
    if (!Object.hasOwn(payload, "recommendations")) throw refuse("UNEXPECTED_ANSWER", label, "key:recommendations");
    const { recommendations: sent, ...rest } = structuredClone(payload);
    const recommendations = sent === null ? [] : this.scope.rows(sent, label, "recommendations");
    return this.scope.result({ ...rest, recommendations }, "MedicalFileAPI", label);
  }

  /**
   * Asks the JSON service, which is what the portal itself reads today. The classic page is the
   * fallback when that service errors or answers in a shape unknown here. Any other refusal stands.
   */
  async fetchRecommendations(): Promise<Reading<{ recommendations: Fields[] } | ClassicRecommendations>> {
    return this.fetchPersonalRecommendations().catch((caught: unknown) => {
      const serviceFailed =
        caught instanceof ReadRefusal && (caught.code === "PORTAL_HTTP_ERROR" || caught.code === "UNEXPECTED_ANSWER");
      if (!serviceFailed) throw caught;
      return this.fetchMedicalRecommendations();
    });
  }

  async fetchMedicalRecommendations(): Promise<Reading<ClassicRecommendations>> {
    const label = "health-recommendations";
    const markup = await this.scope.classicPage("medicalfile/personalrecommendations/", label);
    return this.scope.result(
      parsed(label, () => recommendationsIn(markup)),
      "LegacyMedicalFile",
      label,
    );
  }

  async fetchSelectedMedicalSummary(): Promise<Reading<ClassicSummary>> {
    const label = "medical-summary";
    const markup = await this.scope.classicPage("medicalfile/summary/", label);
    return this.scope.result(
      parsed(label, () => selectedSummaryIn(markup)),
      "LegacyMedicalFile",
      label,
    );
  }

  /**
   * Hospital and emergency-room history. With no range it covers the look-back the page configures for
   * itself, counted from `onDay`, the caller's local date. A range has to fit inside that look-back.
   */
  async allHospitalHistory(onDay: string, span?: DaySpan): Promise<Reading<Fields[]>> {
    const window = checkHospitalWindow(onDay, span);
    const label = "hospital-visits";
    const markup = await this.scope.classicPage("medicalfile/mailingsfromhospitals/", label);
    const { lookBackYears } = parsed(label, () => hospitalSettingsIn(markup));
    const choice = this.hospitalChoice(onDay, lookBackYears, span, label);

    const where = "/online/webapi/MailingsFromHospitals/GetMailingsFromHospitals/";
    const reply = await this.scope.http.request(where, { ...this.scope.post(choice), bearer: false });
    await mustBeOk(reply, label);
    const landedAt = new URL(reply.url || where, PORTAL_SITE);
    await this.scope.mustStillBeSignedIn(landedAt, reply);
    const onRoute = landedAt.origin === PORTAL_SITE && landedAt.pathname.toLowerCase() === where.toLowerCase();
    const declared = reply.headers.get("content-type") ?? "";
    if (!onRoute || !declared.toLowerCase().includes("application/json"))
      await turnAway(reply, refuse("UNEXPECTED_ANSWER", label, "wrong-route-or-type"));

    const payload = asObject(await jsonUpTo(reply, refuse("UNEXPECTED_ANSWER", label, "body-unreadable")), label);
    const { Code: code } = asObject(payload.ResultMessage, label, "ResultMessage");
    if (typeof code !== "number") throw refuse("UNEXPECTED_ANSWER", label, "key:Code");
    if (code !== 0) throw new ReadRefusal("PORTAL_REPORTED_ERROR", label);

    const reports = new Map<string, HospitalReport>();
    const addresses = new Set<string>();
    const references = new SteadyReferences();
    const entries = this.scope.rows(payload.ReportHospitalizations, label, "ReportHospitalizations").map((entry) => {
      for (const column of HOSPITAL_TEXT_COLUMNS) asString(entry[column], label, column);
      if (typeof entry.HasLink !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:HasLink");
      let reference: string | undefined;
      if (entry.HasLink) {
        const path = asString(entry.LinkPDF, label, "LinkPDF");
        const typeCommitment = asString(entry.TypeCommitmentEgenKey, label, "TypeCommitmentEgenKey");
        if (path === "" || typeCommitment === "") throw refuse("UNEXPECTED_ANSWER", label, "key:LinkPDF");
        const address = JSON.stringify([path, typeCommitment]);
        const identity = valuesOf(entry, [...HOSPITAL_TEXT_COLUMNS, "TypeCommitmentEgenKey"]);
        reference = references.next(["hospital", ...identity]);
        // One report listed under two rows, or two rows under one reference, and neither can be told apart later.
        if (addresses.has(address) || reports.has(reference)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
        addresses.add(address);
        reports.set(reference, { path, typeCommitment });
      }
      for (const column of ["DescriptionTreatment", "DescriptionDistinction"])
        for (const line of this.scope.rows(entry[column], label, column))
          asString(line.Description, label, "Description");
      // Checked, not reshaped: a row goes out as Maccabi sent it, plus a reference when it has a report.
      return reference === undefined ? structuredClone(entry) : { ...structuredClone(entry), reference };
    });
    this.hospital = { window, reports };
    return this.scope.result(entries, "LegacyHospitalMailings", label);
  }

  /** The body the hospital page posts: its own look-back from `onDay`, or the range the caller picked. */
  private hospitalChoice(onDay: string, lookBackYears: number, span: DaySpan | undefined, label: string) {
    if (!span) {
      // The page's controller subtracts from the DDMMYYYY number itself, where the year is the low
      // digits. No Date takes part, so no timezone can move the boundary.
      const toDate = Number(dayFirst(onDay, ""));
      return { isDateSelected: false, fromDate: toDate - lookBackYears, toDate };
    }
    // The portal's earliest day is the same calendar day `lookBackYears` years before. Counting years
    // of 365 days instead lands a day off for every leap day inside the look-back.
    const earliest = yearsBefore(onDay, lookBackYears);
    if (span.from < earliest) throw refuse("NOT_OFFERED", label, `range-before-earliest-allowed-from=${earliest}`);
    if (span.to > onDay) throw refuse("NOT_OFFERED", label, "range-past-as-of");
    return { isDateSelected: true, fromDate: dayFirst(span.from, ""), toDate: dayFirst(span.to, "") };
  }

  /**
   * The original report behind one hospital row. The reference is resolved in the member's list for
   * the same day and range, which is fetched now unless it is the list already held.
   */
  async fetchHospitalReportPdf(handle: string, onDay: string, span?: DaySpan): Promise<Reading<Uint8Array>> {
    const window = checkHospitalWindow(onDay, span);
    const label = "hospital-visit-pdf";
    mustBeReference(handle, label);
    if (this.hospital?.window !== window) await this.allHospitalHistory(onDay, span);
    const report = this.hospital?.reports.get(handle);
    if (!report) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    const lookup = new URLSearchParams({ path: report.path, typeCommitment: report.typeCommitment });
    const popup = "/online/Pages/Popups/MailingsFromHospitals/MailingsFromHospitals.aspx";
    return this.scope.pdfAt(`${popup}?${lookup}`, "LegacyHospitalMailings", label);
  }

  /**
   * Medications bought, as the classic page at /online/medicalfile/patientdrugs/ lists them, one of
   * Maccabi's pages per call. Searching by date and sorting are left out because those requests were
   * never observed. The handlers the page runs to audit a click on a row are never invoked.
   */
  async allPurchasedMedicationHistory(pageNo?: number): Promise<Reading<PurchaseHistory>> {
    const label = "pharmacy-purchases";
    const pageNum = gridPage(pageNo);
    await this.scope.classicPage("medicalfile/patientdrugs/", label);
    const service = "/online/Ajax/DrugsManager/WsPurchasedDrugsManager.asmx";
    const grid = await this.classicMarkup(`${service}/GetPurchasedPrescriptionList`, `{'pageNum':'${pageNum}'}`, label);
    return this.scope.result(
      parsed(label, () => purchasesIn(grid, pageNum)),
      "LegacyMedicalFile",
      label,
    );
  }

  /**
   * Documents the member saved to their personal health record, from the grid at
   * /online/medicalfile/documentsandmedicalrecords/. The range defaults to the year ending today,
   * which is what the website asks for when the page loads. All categories are included. The page can
   * also upload, edit and save; none of those postbacks is ever sent.
   */
  async allSavedMedicalDocuments(span?: DaySpan, pageNo?: number): Promise<Reading<ClassicGrid & { range: DaySpan }>> {
    const label = "saved-documents";
    if (span) checkDaySpan(span);
    const pageNum = gridPage(pageNo);
    const range = span ?? yearUpTo(todayLocal());
    await this.scope.classicPage("medicalfile/documentsandmedicalrecords/", label);
    const [dateFrom, dateTo] = [dayFirst(range.from, "/"), dayFirst(range.to, "/")];
    const sent = `{'pageNum':'${pageNum}','categoryId':'','dateFrom':'${dateFrom}','dateTo':'${dateTo}'}`;
    const grid = await this.classicMarkup("/online/Ajax/PHR/WsPHRManager.asmx/GetGridViewAjax", sent, label);
    const shaped = parsed(label, () => classicGridIn(grid, pageNum, ["hdnPageNum"]));
    return this.scope.result({ range, ...shaped }, "LegacyMedicalFile", label);
  }

  /**
   * The classic requests-and-approvals grid at /online/directorship/RequestsAndApprovals/, a page of
   * it per call. The page makes a second call, GetApplicationTypeManagementResponse, whose answer is
   * returned next to the grid as it came, after a size check and the member check.
   */
  async allLegacyRequestsAndApprovals(
    pageNo?: number,
  ): Promise<Reading<ClassicGrid & { applicationTypeManagement: unknown }>> {
    const label = "requests-and-approvals";
    const pageNum = gridPage(pageNo);
    await this.scope.classicPage("directorship/RequestsAndApprovals/", label);
    const service = "/online/Ajax/RequestsAndApprovals/WsRequestsAndApprovalsAPI.asmx";
    const markup = await this.classicMarkup(`${service}/GetGridViewAjax`, `{'pageNum' : '${pageNum}'}`, label);
    const grid = parsed(label, () => classicGridIn(markup, pageNum, ["hdnPageNumber"]));
    // The answer is JSON text inside the envelope's string: a null comes as the four characters `null`.
    const applicationTypeManagement = jsonWithin(
      await this.classicService(`${service}/GetApplicationTypeManagementResponse`, "", label),
    );
    const size = Buffer.byteLength(JSON.stringify(applicationTypeManagement ?? null));
    if (size > 128 * 1024) throw refuse("UNEXPECTED_ANSWER", label, "oversized");
    mustBelongToMemberDeep(applicationTypeManagement, this.scope.owner, label);
    return this.scope.result({ ...grid, applicationTypeManagement }, "LegacyRequestsAndApprovals", label);
  }

  /**
   * Posts to a classic .asmx script service the body its page would post, single quotes and all, and
   * unwraps the answer. The answer has to come from the route that was asked, be typed as JSON in a
   * charset this client reads (windows-1255 live), and be the envelope `{"d": ...}` with no second member.
   */
  private async classicService(where: string, sent: string, label: string): Promise<unknown> {
    const reply = await this.scope.classicJson(where, label, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: sent,
    });
    const envelope = asObject(jsonOf(await classicBody(reply, label), label), label);
    const members = Object.keys(envelope);
    if (members.length !== 1 || members[0] !== "d") throw refuse("UNEXPECTED_ANSWER", label, "key:d");
    return envelope.d;
  }

  /** A script-service answer that has to be text: the grids arrive as markup inside the envelope. */
  private async classicMarkup(where: string, sent: string, label: string): Promise<string> {
    const answer = await this.classicService(where, sent, label);
    if (typeof answer !== "string") throw refuse("UNEXPECTED_ANSWER", label, "key:d");
    return answer;
  }

  /**
   * Vaccinations by group: a row per vaccine group with how many doses and when the first and last
   * were given. Single doses are a separate read.
   */
  async allVaccinationGroups(): Promise<Reading<VaccineGroup[]>> {
    const label = "vaccine-groups";
    const payload = await this.medicalFile("vaccinations_grouped", label);
    const entries = this.scope.rows(payload.timeline, label, "timeline").map((entry) => {
      for (const column of ["vaccine_group_code", "vaccinations_amount"])
        if (!isCount(entry[column])) throw refuse("UNEXPECTED_ANSWER", label, `key:${column}`);
      for (const column of ["vaccine_group_name", "first_date", "last_date", "timestamp"])
        asString(entry[column], label, column);
      return structuredClone(entry) as VaccineGroup;
    });
    this.knownVaccineGroups.clear();
    for (const { vaccine_group_code: groupCode } of entries) {
      if (this.knownVaccineGroups.has(groupCode)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
      this.knownVaccineGroups.add(groupCode);
    }
    return this.scope.result(entries, "MedicalFileAPI", label);
  }

  /**
   * The doses inside one vaccine group. The group code has to be one that the member's own group list
   * returned. The fields checked are the ones the portal's group-expansion view renders.
   */
  async fetchVaccinationDoses(groupCode: number): Promise<Reading<Fields[]>> {
    const label = "vaccine-doses";
    if (!isCount(groupCode)) throw new TypeError("a vaccine group code is a whole number, zero or more");
    if (this.knownVaccineGroups.size === 0) await this.allVaccinationGroups();
    if (!this.knownVaccineGroups.has(groupCode)) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    const { birth_date } = this.scope.profile;
    const lookup = new URLSearchParams({ vaccine_group_code: `${groupCode}`, birth_date });
    const where = `${this.scope.path("MedicalFileAPI", "v1", "vaccinations")}?${lookup}`;
    const entries = this.scope.rows(await getJson(this.scope.http, where, label), label).map((entry) => {
      asString(entry.vaccination_date, label, "vaccination_date");
      checkOptional(entry, ["vaccination_place", "age_on_vaccination", "remark", "source"], ["string"], label);
      return structuredClone(entry);
    });
    return this.scope.renderedResult(entries, "MedicalFileAPI", label);
  }

  /**
   * Recorded sensitivities. What is checked in each row is the set of fields the portal's sensitivity
   * timeline displays, as the front end shows them.
   */
  async allSensitivities(): Promise<Reading<Fields[]>> {
    const label = "sensitivities";
    const payload = await this.medicalFile("sensitivity", label);
    const shown = [
      "registration_date",
      "sensitivity",
      "practitioner_name",
      "speciality",
      "sensitivity_presentation",
      "classification",
    ];
    const entries = this.scope.rows(payload.intolerance, label, "intolerance").map((entry) => {
      if (!Object.hasOwn(entry, "registration_date") || !Object.hasOwn(entry, "sensitivity"))
        throw refuse("NOT_OFFERED", label, "row-incomplete");
      checkOptional(entry, shown, ["string", "number"], label);
      return structuredClone(entry);
    });
    return this.scope.renderedResult(entries, "MedicalFileAPI", label);
  }

  async fetchSensitivityPdf(): Promise<Reading<Uint8Array>> {
    const label = "sensitivities-pdf";
    const { base64 } = await this.medicalFile("sensitivity/pdf", label);
    return this.scope.result(pdfFromBase64(base64, label), "MedicalFileAPI", label);
  }

  /** The member's vaccination certificate as Maccabi issues it. Expect personal identifiers printed on it. */
  async fetchVaccinationCertificatePdf(): Promise<Reading<Uint8Array>> {
    const label = "vaccine-certificate-pdf";
    const envelope = await this.medicalFile("vaccination/certificates/report", label);
    return this.scope.result(pdfFromEnvelope(envelope, label), "MedicalFileAPI", label);
  }

  /** The report of purchased prescriptions that the medication screen's report button produces, unaltered. */
  async fetchMedicationReportPdf(): Promise<Reading<Uint8Array>> {
    const label = "pharmacy-purchases-pdf";
    const envelope = await this.medicalFile("prescriptions/purchased/report", label);
    return this.scope.result(pdfFromEnvelope(envelope, label), "MedicalFileAPI", label);
  }

  /**
   * The English medical summary, fetched with a timestamp and signature requested for this member just
   * before. The identity details the portal can store for English reports are never written.
   */
  async fetchEnglishMedicalSummaryPdf(): Promise<Reading<Uint8Array>> {
    const label = "medical-summary-english-pdf";
    const directorship = (tail: string) => this.scope.path("DirectorshipAPI", "v1", tail);
    const access = asObject(await getJson(this.scope.http, directorship("timestampAndHash"), label), label);
    const timestamp = asString(access.timestamp, label, "timestamp");
    const lookup = new URLSearchParams({ timestamp, hash: unescapeComponent(access.hash, label) });
    return this.scope.pdfAt(`${directorship("report/english/")}?${lookup}`, "DirectorshipAPI", label);
  }
}
