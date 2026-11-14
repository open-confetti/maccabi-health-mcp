/**
 * Test results: the list of tests, the detail of a laboratory result, the latest and the followed
 * results, the history of a single test, and the documents and printable reports behind them.
 */
import { ReadRefusal, refuse } from "../faults";
import { type MemberScope, servicePath } from "./context";
import {
  type AnalyteHistory,
  type FollowedAnalytes,
  type RecentGroup,
  RecentLabShapeError,
  shapeAnalyteHistory,
  shapeFollowedAnalytes,
  shapeRecentLabs,
} from "./parse/recent-labs";
import {
  asObject,
  asString,
  type Fields,
  getJson,
  isPortalMoment,
  isRecord,
  mustBelongToMember,
  overSource,
  percentEncoded,
  queryValue,
  type Reading,
  theOnly,
  unescapeComponent,
} from "./shared";

export interface TestFilter {
  year?: number;
}

export interface ReportChoice {
  irregularOnly?: boolean;
}

/** One analyte, named by where the caller saw it: inside a listed result, or among the latest or followed ones. */
export type AnalyteChoice =
  | { seenIn: "followed" | "latest"; analyte: string }
  | { seenIn: "result"; analyte: string; askId: string; documentKey: string };

export interface TestRow extends Fields {
  type: string;
  request_id: string;
  doc_id: string;
  test_name: string[];
  result_date: string;
  execute_date: string;
  /** Added here, not sent by Maccabi: a document is attached to the row and the document read can fetch it. */
  has_document: boolean;
}

export interface LabDetail extends Fields {
  is_partial: boolean;
  execute_date: string;
  results: (Fields & { group_values: Fields[]; group_name: string })[];
}

/** The row types that have a printable laboratory report. Asked for any other type, the report endpoint says 404. */
const LAB_REPORT_ROW_TYPES = new Set(["lab_result", "lab_api_result"]);

const pairKey = (askId: string, documentKey: string): string => JSON.stringify([askId, documentKey]);

/**
 * True for a test row with a file behind it. `result_files` decides, for every type of row alike,
 * types this reader has never met included; a rule per type would miss those. The paths in the field
 * are only checked for being there, never requested: the download goes by doc_id.
 */
function hasAttachment(line: Fields): boolean {
  const files = line.result_files;
  if (!Array.isArray(files)) return false;
  // Maccabi writes a blank path for "nothing attached". Untrimmed, a lone space would count as a
  // document, and a download would go out for a file that is not there.
  return files.some((file) => isRecord(file) && typeof file.result_file === "string" && file.result_file.trim() !== "");
}

/**
 * The calendar year written in a `YYYY-MM-DDTHH:MM:SS` stamp, or undefined for text that is not such
 * a moment. Execution dates arrive without a timezone, so the year is read as written.
 */
function writtenYear(stamp: string): number | undefined {
  return isPortalMoment(stamp) ? Number(stamp.slice(0, 4)) : undefined;
}

/**
 * The portal's own code builds the report addresses without encoding the values in them, and this
 * client sends what the portal sends. Each value therefore goes through `queryValue`, under one of
 * these two lengths: the first for ids and signature parts, the second for the parts of the address
 * of an analyte's file.
 */
const MAX_QUERY_VALUE = 8192;
const MAX_FILE_QUERY_VALUE = 16384;

/** Runs a projection of lab results. An answer it does not recognise becomes the read's own refusal. */
function shaped<T>(label: string, shape: () => T): T {
  try {
    return shape();
  } catch (caught) {
    if (caught instanceof RecentLabShapeError) throw refuse("UNEXPECTED_ANSWER", label, "shape-changed");
    throw caught;
  }
}

function checkReportChoice(opts: ReportChoice): void {
  if (opts.irregularOnly !== undefined && typeof opts.irregularOnly !== "boolean")
    throw new TypeError("irregularOnly is true, false or left out");
}

/** What a selection consists of, by the view it points into. */
const CHOICE_PARTS: Record<AnalyteChoice["seenIn"], readonly string[]> = {
  followed: ["analyte", "seenIn"],
  latest: ["analyte", "seenIn"],
  result: ["analyte", "askId", "documentKey", "seenIn"],
};

/** A selection names a view and carries exactly that view's parts, each a short non-empty string. */
function checkAnalyteChoice(choice: AnalyteChoice): void {
  const view: unknown = choice ? choice.seenIn : undefined;
  if (view !== "result" && view !== "latest" && view !== "followed")
    throw new TypeError("a lab selection comes from result, latest or followed");
  const parts = CHOICE_PARTS[view];
  const given = choice as unknown as Fields;
  const isShortText = (part: unknown): boolean => typeof part === "string" && part !== "" && part.length <= 512;
  const wellFormed =
    parts.every((name) => isShortText(given[name])) && Object.keys(given).every((name) => parts.includes(name));
  if (!wellFormed) throw new TypeError("a lab selection has only its own fields, each a short string");
}

export class Labs {
  /** The rows of the last test list that validated, by (request_id, doc_id). */
  private readonly knownTests = new Map<string, Fields>();

  constructor(private readonly scope: MemberScope) {}

  private api(tail: string): string {
    return this.scope.path("TestResultsAPI", "v1", tail);
  }

  /** The comparison service puts the member after `compare`, where every other service has `members`. */
  private get comparePath(): string {
    return servicePath("TestResultsAPI", `v1/compare/${this.scope.ownerSegments}/compare`);
  }

  /** The service wants the member's sex twice, as the signed-in user and as the user being viewed. */
  private genders() {
    const { sex } = this.scope.profile;
    return { logged_user_gender: sex, current_user_gender: sex };
  }

  /**
   * The test list as the portal asks for it by default: laboratory results together with every other
   * kind. Nothing observed shows the service paging or filtering by date, so `year` is applied here,
   * to the answer, and the result says so.
   */
  async allTests(opts: TestFilter = {}): Promise<Reading<{ categories: Fields[]; tests: TestRow[] }>> {
    const label = "test-results";
    const { year } = opts;
    if (year !== undefined && !(Number.isInteger(year) && year >= 1000 && year <= 9999))
      throw new TypeError("year is a whole number of four digits");
    const sent = this.scope.post({ members: [], categories: [], ...this.genders() });
    const payload = asObject(await getJson(this.scope.http, this.api("tests"), label, sent), label);
    const listed = this.scope.rows(payload.tests, label, "tests");
    const categories = this.scope.rows(payload.categories, label, "categories");
    for (const line of listed) {
      for (const column of ["request_id", "doc_id", "type", "execute_date", "result_date"])
        asString(line[column], label, column);
      const names = line.test_name;
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
        throw refuse("UNEXPECTED_ANSWER", label, "key:test_name");
      // The very test the document read applies, published on each row, so that a caller can tell
      // which rows have a file without trying every download and reading the refusals.
      line.has_document = hasAttachment(line);
    }
    // Only a list that validated in full, owner checks included, replaces what is remembered.
    this.knownTests.clear();
    for (const line of listed as TestRow[])
      this.knownTests.set(pairKey(line.request_id, line.doc_id), structuredClone(line));

    const reading = this.scope.result({ categories, tests: listed as TestRow[] }, "TestResultsAPI", label);
    if (year === undefined) return reading;
    reading.data.tests = reading.data.tests.filter((line) => {
      const executed = writtenYear(line.execute_date);
      // A date in a form not seen before fails the read. Leaving the row out would hide a medical
      // record without a word.
      if (executed === undefined) throw refuse("UNEXPECTED_ANSWER", label, "key:execute_date");
      return executed === year;
    });
    const selection = { mode: "local", field: "execute_date", year } as const;
    reading.source = { ...reading.source, completeness: "local-filtered-subset", selection };
    return reading;
  }

  /** Settles ownership and nothing else: lists the member's tests now and returns the one row the pair names. */
  private async mustBeListedTest(askId: string, documentKey: string, label: string): Promise<TestRow> {
    const { tests } = (await this.allTests()).data;
    return theOnly(
      tests.filter((line) => line.request_id === askId && line.doc_id === documentKey),
      label,
    );
  }

  /** The remembered list row of a pair. A pair that is not remembered gets one fresh listing before it is refused. */
  private async rememberedTest(askId: string, documentKey: string, label: string): Promise<Fields> {
    const pair = pairKey(askId, documentKey);
    if (!this.knownTests.has(pair)) await this.allTests();
    const line = this.knownTests.get(pair);
    if (!line) throw refuse("NOT_THE_MEMBERS", label, "id-unknown");
    return line;
  }

  /**
   * The original document attached to a listed test row, of whatever type. Fetching it does not mark
   * the result as read. Two questions are kept apart. Is the pair a row of the member's own list? If
   * not, it is not theirs. Does that row have a document? If not, this read has nothing to offer:
   * laboratory results have a report of their own, and imaging studies open in the viewer.
   */
  async fetchImagingResultPdf(askId: string, documentKey: string): Promise<Reading<Uint8Array>> {
    const label = "test-document-pdf";
    const line = await this.rememberedTest(askId, documentKey, label);
    if (!hasAttachment(line)) throw refuse("NOT_OFFERED", label, "attachment-absent");
    const { memberIdCode, memberId } = this.scope.owner;
    const data = asString(line.doc_id, label, "doc_id");
    const t = asString(line.time_stamp, label, "time_stamp");
    const hash = unescapeComponent(line.hash, label);
    const gender = this.scope.profile.sex === "נ" ? "2" : "1";
    const lookup = new URLSearchParams({
      memberidcode: memberIdCode,
      memberid: `${memberId}`,
      data,
      t,
      hash,
      loggedInUserGender: gender,
      currentUsergender: gender,
      memberIdForHeader: `${memberId}`,
      memberIdCodeForHeader: memberIdCode,
    });
    return this.scope.pdfAt(`${servicePath("TestResultsAPI", "pdf/openfile")}?${lookup}`, "TestResultsAPI", label);
  }

  /** The latest-results answer as sent, owner-checked and known to project, with its report signature. */
  private async latest(): Promise<{ payload: Fields; clusters: RecentGroup[] }> {
    const label = "labs-latest";
    const payload = asObject(await getJson(this.scope.http, this.api("getlatestlabresults"), label), label);
    mustBelongToMember(payload, this.scope.owner, label);
    for (const cluster of this.scope.rows(payload.results, label, "results"))
      this.scope.rows(cluster.group_values, label, "group_values");
    const clusters = shaped(label, () => overSource(payload.results, shapeRecentLabs(payload.results)));
    for (const column of ["time_stamp", "hash"]) asString(payload[column], label, column);
    return { payload, clusters };
  }

  /** The most recent result of each laboratory test, in the groups the service arranges them in. */
  async allLatestLabResults(): Promise<Reading<RecentGroup[]>> {
    const { clusters } = await this.latest();
    return this.scope.result(clusters, "TestResultsAPI", "labs-latest");
  }

  /**
   * The printable report of the latest results, signed by a listing made for this call and sent with
   * the flags the portal's print button uses.
   */
  async fetchLatestLabResultsPdf(opts: ReportChoice = {}): Promise<Reading<Uint8Array>> {
    const label = "labs-latest-pdf";
    checkReportChoice(opts);
    const { payload } = await this.latest();
    const t = asString(payload.time_stamp, label, "time_stamp");
    const hash = unescapeComponent(payload.hash, label);
    const irregular_only = `${opts.irregularOnly ?? false}`;
    const lookup = new URLSearchParams({ t, hash, irregular_only, is_attachment: "false" });
    return this.scope.pdfAt(`${this.api("getlatestlabresults/report")}?${lookup}`, "TestResultsAPI", label);
  }

  /** The followed-tests answer as sent, owner-checked and known to project. */
  private async followed(): Promise<{ payload: Fields; shapedAs: FollowedAnalytes }> {
    const label = "labs-followed";
    const payload = asObject(await getJson(this.scope.http, this.api("followed"), label), label);
    mustBelongToMember(payload, this.scope.owner, label);
    for (const column of ["followed_tests", "options"]) this.scope.rows(payload[column], label, column);
    return { payload, shapedAs: shaped(label, () => overSource(payload, shapeFollowedAnalytes(payload))) };
  }

  /** The tests the member already follows. The selection is read; no test is ever followed or unfollowed. */
  async allFollowedLabResults(): Promise<Reading<FollowedAnalytes>> {
    const { shapedAs } = await this.followed();
    return this.scope.renderedResult(shapedAs, "TestResultsAPI", "labs-followed");
  }

  async fetchFollowedLabResultsPdf(): Promise<Reading<Uint8Array>> {
    const label = "labs-followed-pdf";
    const { payload } = await this.followed();
    const t = queryValue(payload.timestamp, MAX_QUERY_VALUE, label);
    const lookup = `t=${t}&hash=${queryValue(payload.hash, MAX_QUERY_VALUE, label)}&is_attachment=false`;
    return this.scope.pdfAt(`${this.api("followed/report")}?${lookup}`, "TestResultsAPI", label);
  }

  /**
   * The structured detail of one listed test, as sent and validated. The pair has to be in the
   * member's own test list; an account is never taken from the caller. Detail may be asked for any
   * listed row. Where Maccabi has none, the read fails on what Maccabi answers, which says more than
   * a guess from the row's type would.
   */
  private async labDetail(askId: string, documentKey: string): Promise<Fields> {
    const label = "lab-values";
    await this.rememberedTest(askId, documentKey, label);
    const sent = this.scope.post({ request_id: askId, doc_id: documentKey, ...this.genders() });
    const payload = asObject(await getJson(this.scope.http, this.api("getresultsbyid"), label, sent), label);
    for (const cluster of this.scope.rows(payload.results, label, "results")) {
      asString(cluster.group_name, label, "group_name");
      for (const line of this.scope.rows(cluster.group_values, label, "group_values")) {
        for (const column of ["test_id", "test_desc"]) asString(line[column], label, column);
        // Values, units, limits, messages and flags pass through as sent. Nothing here reads a
        // result clinically; it only has to be there.
        if (!("result" in line)) throw refuse("UNEXPECTED_ANSWER", label, "key:result");
        line.has_result_file = typeof line.result_file === "string" && line.result_file !== "";
      }
    }
    asString(payload.execute_date, label, "execute_date");
    if (typeof payload.is_partial !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:is_partial");
    return payload;
  }

  async fetchLabResult(askId: string, documentKey: string): Promise<Reading<LabDetail>> {
    const detail = await this.labDetail(askId, documentKey);
    return this.scope.result(detail as LabDetail, "TestResultsAPI", "lab-values");
  }

  /** Every analyte the selection's source currently holds for the member, fetched now. */
  private async analytesFrom(choice: AnalyteChoice, label: string): Promise<Fields[]> {
    const inGroups = (clusters: unknown) =>
      this.scope
        .rows(clusters, label, "results")
        .flatMap((cluster) => this.scope.rows(cluster.group_values, label, "group_values"));
    if (choice.seenIn === "result") {
      await this.mustBeListedTest(choice.askId, choice.documentKey, label);
      return inGroups((await this.labDetail(choice.askId, choice.documentKey)).results);
    }
    if (choice.seenIn === "latest") return inGroups((await this.latest()).payload.results);
    return this.scope.rows((await this.followed()).payload.followed_tests, label);
  }

  /** The one analyte a selection names, as its source sent it. */
  private async knownAnalyte(choice: AnalyteChoice, label: string): Promise<Fields> {
    checkAnalyteChoice(choice);
    const fits = (await this.analytesFrom(choice, label)).filter((line) => line.test_id === choice.analyte);
    if (fits.length !== 1)
      throw refuse("NOT_THE_MEMBERS", label, fits.length === 0 ? "analyte-unknown" : "ambiguous-test-id");
    return structuredClone(fits[0]!);
  }

  private async analyteHistory(choice: AnalyteChoice): Promise<{ raw: Fields; data: AnalyteHistory; date: string }> {
    const label = "lab-history";
    const analyte = await this.knownAnalyte(choice, label);
    const analyteId = choice.analyte;
    const date = asString(analyte.lab_date, label, "lab_date");
    const lookup = new URLSearchParams({ test_id: analyteId, date_of_result: date });
    const raw = asObject(await getJson(this.scope.http, `${this.comparePath}?${lookup}`, label), label);
    mustBelongToMember(raw, this.scope.owner, label);
    mustBelongToMember(asObject(raw.current_result, label, "current_result"), this.scope.owner, label);
    this.scope.rows(raw.other_results, label, "other_results");
    const data = shaped(label, () => overSource(raw, shapeAnalyteHistory(raw, analyteId, date)));
    return { raw, data, date };
  }

  /**
   * The history of one test. Which test, and the date it is compared from, come out of the member's
   * own results as fetched for this call, by the selection given.
   */
  async fetchLabComparison(choice: AnalyteChoice): Promise<Reading<AnalyteHistory>> {
    const { data } = await this.analyteHistory(choice);
    return this.scope.result(data, "TestResultsAPI", "lab-history");
  }

  /**
   * The comparison as Maccabi prints it, as a list or as a graph. There is a graph only when some
   * result in the history has a value or an upper limit other than zero.
   */
  async fetchLabComparisonPdf(choice: AnalyteChoice, view: "list" | "graph" = "list"): Promise<Reading<Uint8Array>> {
    const label = "lab-history-pdf";
    if (view !== "graph" && view !== "list") throw new TypeError("a comparison is printed as a list or as a graph");
    const { raw, data, date } = await this.analyteHistory(choice);
    const current = data.current_result;
    const flat = [current, ...data.other_results].every((line) => line.result === 0 && line.max_lim === 0);
    if (view === "graph" && flat) throw new ReadRefusal("NOT_ENTITLED", label);
    const t = asString(raw.timestamp, label, "timestamp");
    const lookup = new URLSearchParams({
      test_id: choice.analyte,
      t,
      hash: unescapeComponent(raw.hash, label),
      date_of_result: date,
      is_attachment: "false",
      is_graph: `${view === "graph"}`,
      test_des: current.test_desc,
      lab_date: current.lab_date,
    });
    return this.scope.pdfAt(`${this.comparePath}/report?${lookup}`, "TestResultsAPI", label);
  }

  /** The file attached to a single analyte, for the analytes that have one. */
  async fetchLabResultFilePdf(choice: AnalyteChoice): Promise<Reading<Uint8Array>> {
    const label = "lab-analyte-pdf";
    const analyte = await this.knownAnalyte(choice, label);
    const file = analyte.result_file;
    if (typeof file !== "string" || file === "") throw refuse("NOT_OFFERED", label, "analyte-file-absent");
    // The portal encodes the file path and nothing else in this address. The description and the date
    // are wording, so a space may stand in them.
    const data = percentEncoded(file, label);
    const signed = (sent: unknown) => queryValue(sent, MAX_FILE_QUERY_VALUE, label);
    const worded = (sent: unknown) => queryValue(sent, MAX_FILE_QUERY_VALUE, label, true);
    const lookup = [
      `data=${data}`,
      `t=${signed(analyte.time_stamp)}`,
      `hash=${signed(analyte.hash)}`,
      `testDes=${worded(analyte.test_desc)}`,
      `labDate=${worded(analyte.lab_date)}`,
    ].join("&");
    return this.scope.pdfAt(`${servicePath("TestResultsAPI", "pdf/showresult")}?${lookup}`, "TestResultsAPI", label);
  }

  /**
   * The full printable report of one laboratory result, signed by detail fetched for this call and
   * sent with the portal's print flags.
   */
  async fetchLabReportPdf(askId: string, documentKey: string, opts: ReportChoice = {}): Promise<Reading<Uint8Array>> {
    const label = "lab-values-pdf";
    checkReportChoice(opts);
    const listed = await this.mustBeListedTest(askId, documentKey, label);
    // For imaging and external rows the report endpoint only has a 404. What such a row has is its attached file.
    if (!LAB_REPORT_ROW_TYPES.has(listed.type)) throw refuse("NOT_OFFERED", label, "not-a-lab-row");
    const detail = await this.labDetail(askId, documentKey);
    for (const column of ["time_stamp", "hash", "execute_date"]) asString(detail[column], label, column);
    const plain = (sent: unknown) => queryValue(sent, MAX_QUERY_VALUE, label);
    const lookup = [
      `request_id=${plain(askId)}`,
      `t=${plain(detail.time_stamp)}`,
      `hash=${plain(detail.hash)}`,
      `irregular_only=${opts.irregularOnly ?? false}`,
      "is_attachment=false",
      `is_partial=${detail.is_partial}`,
      `date=${plain(detail.execute_date)}`,
    ].join("&");
    return this.scope
      .pdfAt(`${this.api("getresultsbyid/report")}?${lookup}`, "TestResultsAPI", label)
      .catch((caught: unknown) => {
        // Seen live: some older results get a 404 here on every attempt; which ones is not known. The code and
        // the status stay as they were; the reason swaps the usual "retry once" advice for one that
        // fits. Nothing is retried.
        const absent = caught instanceof ReadRefusal && caught.code === "PORTAL_HTTP_ERROR" && caught.status === 404;
        throw absent ? new ReadRefusal("PORTAL_HTTP_ERROR", label, 404, "report-absent") : caught;
      });
  }

  /**
   * The English COVID report, and only down the path where the portal prints straight away because
   * the member's English identity is already on file. The form that submits identity details is never sent.
   */
  async fetchEnglishCovidLabReportPdf(askId: string, documentKey: string): Promise<Reading<Uint8Array>> {
    const label = "lab-covid-report-pdf";
    if (this.scope.bootstrap.englishIdentityOnFile !== true)
      throw refuse("NOT_OFFERED", label, "english-identity-missing");
    await this.mustBeListedTest(askId, documentKey, label);
    const detail = await this.labDetail(askId, documentKey);
    if (detail.show_print_corona_english_report !== true) throw new ReadRefusal("NOT_ENTITLED", label);
    for (const column of ["corona_t", "corona_hash"]) asString(detail[column], label, column);
    const plain = (sent: unknown) => queryValue(sent, MAX_QUERY_VALUE, label);
    const data = plain(askId);
    const signature = `t=${plain(detail.corona_t)}&hash=${plain(detail.corona_hash)}`;
    return this.scope.pdfAt(`${this.api("labs/corona/Report")}?data=${data}&${signature}`, "TestResultsAPI", label);
  }
}
