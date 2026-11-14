/**
 * What the member is billed. The quarterly reports and the yearly nursing-insurance reports are both
 * read off the classic billing page and the web service behind it: a catalog of reports first, then a
 * report's original PDF. The debt total of an account that somebody else pays for comes from the
 * current API. Nothing here itemises a charge.
 */
import { ReadRefusal, refuse } from "../faults";
import type { MemberScope } from "./context";
import { billingQuartersIn, type QuarterCatalog, quarterFilesIn, quarterRowsIn } from "./parse/billing-reports";
import { ClassicPageShapeError } from "./parse/classic-pages";
import { isDigits } from "./parse/guards";
import { type NursingCatalog, nursingFilesIn, nursingRowsIn } from "./parse/nursing-reports";
import { asObject, classicBody, type Fields, getJson, mustBeReference, type Reading } from "./shared";

const BILLING_PAGE = "directorship/debitsandcredits/";
const BILLING_SERVICE = "/online/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx";
const REPORT_POPUP = "/online/Pages/Popups/DebitsAndCredits/DebitsAndCreditsPdfReport.aspx";
/** The name both catalogs and their PDFs are reported under; the classic pages have no API name. */
const CATALOG = "LegacyBillingCatalog";
/** A period is the value of one option in the page's period list: up to four digits. */
const isPeriod = (value: unknown): value is string => typeof value === "string" && isDigits(value, 1, 4);
const PERIOD_NOT_LISTED = "period is not one of the values under availablePeriods";
const DEBT_AMOUNTS = ["kupa_debt", "shaban_debt", "additional_charges_debt"];

/** What the archive needs to produce one report. Held here, never returned to a caller. */
interface ArchivedReport {
  token: string;
  reportType: string;
}

/** The catalog's rows, each with the reference of its own report file. */
function withReferences<Row>(rows: Row[], files: { reference: string }[]): (Row & { reference: string })[] {
  return rows.map((row, at) => ({ ...row, reference: files[at]!.reference }));
}

const byReference = (files: (ArchivedReport & { reference: string })[]): Map<string, ArchivedReport> =>
  new Map(files.map(({ reference, token, reportType }) => [reference, { token, reportType }]));

export class Billing {
  /** The archive arguments of the reports in the latest catalog of each kind, by reference. */
  #quarterly = new Map<string, ArchivedReport>();
  #nursing = new Map<string, ArchivedReport>();

  constructor(private readonly scope: MemberScope) {}

  /**
   * The quarterly reports of one period, the page's default period unless another listed one is named.
   * Only the first page of the catalog is read, which the result's pagination says.
   */
  async allQuarterlyBillingReports(period?: string): Promise<Reading<QuarterCatalog>> {
    if (period !== undefined && !isPeriod(period)) throw new TypeError(PERIOD_NOT_LISTED);
    const label = "quarterly-statements";
    const page = await this.scope.classicPage(BILLING_PAGE, label);
    try {
      const { availablePeriods, defaultPeriod } = billingQuartersIn(page);
      const selectedPeriod =
        period === undefined ? defaultPeriod : availablePeriods.find((listed) => listed.value === period);
      if (!selectedPeriod) throw refuse("NOT_OFFERED", label, "period-unlisted");
      // The page's own script posts this single-quoted body. The value placed in it is one of the
      // page's option values, and the page parser lets only digits through.
      const body = `{'value':'${selectedPeriod.value}'}`;
      const grid = await this.#callService("GetQuarterlyReport", body, label, "body-unparsable");
      if (typeof grid !== "string") throw refuse("UNEXPECTED_ANSWER", label, "key:d");
      const { reports, pagination } = quarterRowsIn(grid);
      const files = quarterFilesIn(grid, reports);
      this.#quarterly = byReference(files);
      const catalog = { availablePeriods, selectedPeriod, reports: withReferences(reports, files), pagination };
      return this.scope.result(catalog, CATALOG, label);
    } catch (error) {
      throw error instanceof ClassicPageShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
  }

  /** A quarterly report as the PDF Maccabi archived, found in the period's catalog read anew. */
  async fetchQuarterlyBillingReportPdf(reference: string, period: string): Promise<Reading<Uint8Array>> {
    const label = "quarterly-statement-pdf";
    mustBeReference(reference, label);
    if (!isPeriod(period)) throw new TypeError(PERIOD_NOT_LISTED);
    await this.allQuarterlyBillingReports(period);
    const report = this.#quarterly.get(reference);
    if (!report) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    return this.#archivedPdf(report, "token", label);
  }

  /** The yearly nursing-insurance reports the member's billing page shows; first page only. */
  async allNursingInsuranceReports(): Promise<Reading<NursingCatalog>> {
    const label = "nursing-statements";
    // The page is opened for what it establishes - a classic session, and that it is this member's -
    // not for its markup: the reports come from the service.
    await this.scope.classicPage(BILLING_PAGE, label);
    const grid = await this.#callService("GetLTCReport", "", label);
    if (typeof grid !== "string") throw refuse("UNEXPECTED_ANSWER", label, "key:d");
    try {
      const catalog = nursingRowsIn(grid);
      const files = nursingFilesIn(grid, catalog.reports);
      this.#nursing = byReference(files);
      return this.scope.result({ ...catalog, reports: withReferences(catalog.reports, files) }, CATALOG, label);
    } catch (error) {
      throw error instanceof ClassicPageShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
  }

  /** A nursing-insurance report as the PDF Maccabi archived, found in the catalog read anew. */
  async fetchNursingInsuranceReportPdf(reference: string): Promise<Reading<Uint8Array>> {
    const label = "nursing-statement-pdf";
    mustBeReference(reference, label);
    await this.allNursingInsuranceReports();
    const report = this.#nursing.get(reference);
    if (!report) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    return this.#archivedPdf(report, "Token", label);
  }

  /**
   * What the account owes, split the way Maccabi splits it. Read only for a member whose bills go to
   * another payer; for a member who is their own payer it is not offered. The figures are passed on
   * with no currency or meaning added.
   */
  async fetchOutstandingDebt(): Promise<Reading<Fields>> {
    const label = "billing-totals";
    if (this.scope.bootstrap.billedToAnotherPayer !== true) throw refuse("NOT_OFFERED", label, "payer-is-member");
    const route = this.scope.path("DirectorshipAPI", "v1", "finance/debts");
    const sent = asObject(await getJson(this.scope.http, `${route}?person_type=1`, label), label);
    for (const key of DEBT_AMOUNTS)
      if (!Number.isFinite(sent[key])) throw refuse("UNEXPECTED_ANSWER", label, `key:${key}`);
    const reading = this.scope.result(sent, "DirectorshipAPI", label);
    reading.source.scope = "payer-account-aggregate";
    return reading;
  }

  /**
   * Posts to one method of the billing page's web service and hands back the single value its JSON
   * envelope carries under `d`. `unparsable` is the detail reported for a body that is not JSON.
   */
  async #callService(method: string, body: string, label: string, unparsable = "shape-changed"): Promise<unknown> {
    const route = `${BILLING_SERVICE}/${method}`;
    const headers = { "content-type": "application/json; charset=utf-8" };
    const reply = await this.scope.classicJson(route, label, { method: "POST", headers, body });
    const text = await classicBody(reply, label);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw refuse("UNEXPECTED_ANSWER", label, unparsable);
    }
    const envelope = asObject(parsed, label);
    if (Object.keys(envelope).length !== 1) throw refuse("UNEXPECTED_ANSWER", label, "key:d");
    return envelope.d;
  }

  /**
   * A report's PDF, in the website's two steps: the service is asked to take the report out of the
   * archive, and once it says it has, the popup page serves the file. The popup spells its token
   * parameter differently for the two kinds of report.
   */
  async #archivedPdf(
    report: ArchivedReport,
    tokenParam: "token" | "Token",
    label: string,
  ): Promise<Reading<Uint8Array>> {
    const { token, reportType } = report;
    const prepared = await this.#callService(
      "GetDocFromArchive",
      `{'token':'${token}', 'reportType':'${reportType}'}`,
      label,
    );
    if (typeof prepared !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:d");
    if (!prepared) throw new ReadRefusal("PORTAL_REPORTED_ERROR", label);
    const query = `${tokenParam}=${token}&ReportType=${reportType}&FileName=DebitsAndCreditsReportInformation`;
    return this.scope.pdfAt(`${REPORT_POPUP}?${query}`, CATALOG, label);
  }
}
