/**
 * The quarterly billing page and its report catalog, plus what the yearly nursing-insurance catalog
 * (./nursing-reports.ts) has in common with it: both are a three-column list of reports beside two
 * hidden counters, and both open a report's PDF from a link in the third column.
 */
import { createHash } from "node:crypto";
import { decodeHTML } from "entities";
import {
  attribute,
  childElements,
  type Document,
  detach,
  type Element,
  fits,
  innerText,
  query,
  toDom,
} from "../../html";
import { classic, isOnlineApp, PAGE_BYTES, plainText, scriptsOf } from "./classic-pages";
import { hasLonePercent, isDigits } from "./guards";

export interface BillingQuarter {
  value: string;
  label: string;
}
/** One report as its row describes it. The reader adds `reference` once it has filed the row's access arguments. */
export interface ReportRow {
  period: string;
  productionDate: string;
  viewLabel: string;
  reference?: string;
}
/** How much of the catalog this is: the service sends its first page and says how much there is in all. */
export interface ReportPaging {
  returned: number;
  reportedResultCount: number;
  totalPages: number;
  currentPage: 1;
}
export interface ReportCatalog {
  reports: ReportRow[];
  pagination: ReportPaging;
}
export interface QuarterCatalog extends ReportCatalog {
  availablePeriods: BillingQuarter[];
  selectedPeriod: BillingQuarter;
}
/** What opens one report's PDF. The reader keeps these to itself; no result carries a token. */
export interface ReportAccess {
  reference: string;
  token: string;
  reportType: string;
}

export function fragment(markup: string): Document {
  if (markup.trim() === "" || Buffer.byteLength(markup) > PAGE_BYTES) classic.fail();
  return toDom(markup);
}

/** The count in the one hidden input with this id. */
export function hiddenCount(dom: Document, id: string): number {
  const inputs = query(`input#${id}`, dom);
  const digits = inputs.length === 1 ? (attribute(inputs[0], "value") ?? "") : "";
  const count = /^\d+$/.test(digits) ? Number(digits) : classic.fail();
  return Number.isSafeInteger(count) ? count : classic.fail();
}

/**
 * Builds the catalog out of the rows' cell texts and the two counters, which have to tell one story:
 * no more rows than the service says exist, no rows missing when it says there are some, and a page
 * for the rows to be on.
 */
export function reportCatalog(
  rows: string[][],
  reportedResultCount: number,
  totalPages: number,
  longestCell = Number.POSITIVE_INFINITY,
): ReportCatalog {
  const returned = rows.length;
  if (returned > 1000 || returned > reportedResultCount) classic.fail();
  if (returned === 0 ? reportedResultCount > 0 : totalPages < 1) classic.fail();
  const reports = rows.map((cells) => {
    if (cells.length !== 3 || cells.some((cell) => cell === "" || cell.length > longestCell)) classic.fail();
    const [period, productionDate, viewLabel] = cells as [string, string, string];
    return { period, productionDate, viewLabel };
  });
  const pagination: ReportPaging = { returned, reportedResultCount, totalPages, currentPage: 1 };
  return classic.bounded({ reports, pagination }, 128 * 1024);
}

/**
 * The page's own script puts both arguments, unescaped, between single quotes and then into the query
 * string of the window it opens. An argument that could break out of either is not one the page made.
 */
const BREAKS_OUT = /['\\&#?=\u0000-\u0020\u007f]/;

/**
 * The two quoted arguments of a handler that is `<opener>.OpenReportPdf('…', '…')` and nothing else,
 * give or take surrounding whitespace and one closing semicolon. Undefined for any other handler.
 */
function openReportCall(handler: string, opener: string): [string, string] | undefined {
  const opening = `${opener}.OpenReportPdf('`;
  const closing = "')";
  const trimmed = handler.trim();
  const call = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (!call.startsWith(opening) || !call.endsWith(closing)) return undefined;
  // Between the outer quotes: the first argument, the comma that separates the two, the second.
  const pieces = call.slice(opening.length, -closing.length).split("'");
  if (pieces.length !== 3) return undefined;
  const [first, between, second] = pieces as [string, string, string];
  return between.startsWith(",") && between.slice(1).trim() === "" ? [first, second] : undefined;
}

/** The two arguments of the report link in a row's third cell, which has to be the cell's only link. */
export function openReportArguments(
  row: Element,
  opener: "QuarterlyReport" | "LTCReport",
): Pick<ReportAccess, "token" | "reportType"> {
  const links = query("a[onclick]", childElements(row, "span")[2]);
  if (links.length !== 1) classic.fail();
  const call = openReportCall(decodeHTML(attribute(links[0], "onclick") ?? ""), opener);
  if (!call) return classic.fail();
  const [token, reportType] = call;
  for (const argument of call)
    if (argument === "" || argument.length > 8192 || BREAKS_OUT.test(argument) || hasLonePercent(argument))
      classic.fail();
  return { token, reportType };
}

/**
 * A reference names a report by what the member sees of it, so it means the same report from one
 * answer to the next while the token behind it changes. Two rows of a catalog may not share one.
 */
export function reportReference(visible: readonly string[], taken: Set<string>): string {
  const reference = createHash("sha256").update(JSON.stringify(visible)).digest("hex");
  if (taken.has(reference)) classic.fail();
  taken.add(reference);
  return reference;
}

const PERIOD_SELECT = "select#PeriodSelectDropDownList";

/**
 * The quarters the billing page offers, read from a page fetched for the owner just now, and the one
 * it would open with. Only the page's markup is looked at; its scripts are not run.
 */
export function billingQuartersIn(markup: string): {
  availablePeriods: BillingQuarter[];
  defaultPeriod: BillingQuarter;
} {
  const dom = fragment(markup);
  const underConstruction = query("#isUnderConstruction", dom);
  if (underConstruction.length !== 1 || attribute(underConstruction[0], "value") === "1") classic.fail();
  if (query(PERIOD_SELECT, dom).length !== 1 || !isOnlineApp(scriptsOf(dom))) classic.fail();

  const options = query(`${PERIOD_SELECT} > option`, dom);
  if (options.length === 0 || options.length > 100) classic.fail();
  const quarters = options.map((option) => ({
    value: attribute(option, "value") ?? "",
    label: plainText(innerText(option)),
  }));
  if (quarters.some((quarter) => !isDigits(quarter.value, 1, 4) || quarter.label === "")) classic.fail();
  if (new Set(quarters.map((quarter) => quarter.value)).size !== quarters.length) classic.fail();

  const preselected = quarters.filter((_, at) => attribute(options[at], "selected") !== undefined);
  if (preselected.length > 1) classic.fail();
  return { availablePeriods: quarters, defaultPeriod: { ...(preselected[0] ?? quarters[0]!) } };
}

// "quaterly" is how the page spells it.
const QUARTER_ROWS = ".dataGrid > .quaterly_table > .maintable > ul.rowgroup > li";
const QUARTER_HEADINGS = ".dataGrid > .quaterly_table > .maintable > ul.headinggroup > li.headinggroup > span";

/**
 * A quarter without reports: the grid has
 * no table, only the two hidden counters and a `.no_result` box wrapped as `div > div > .no_result`.
 * Nothing looser counts: the box has to be reached through elements that are each an only child. A
 * grid that lacks a table for any other reason is a page this reader does not know.
 */
function hasNoReports(dom: Document): boolean {
  const grids = query(".dataGrid", dom);
  if (grids.length !== 1 || query(".quaterly_table", dom).length > 0) return false;
  if (query(".dataGrid .no_result", dom).length !== 1) return false;
  let level = childElements(grids[0]!, ":not(input)");
  for (let depth = 0; depth < 4 && level.length === 1 && !fits(level[0]!, ".no_result"); depth += 1)
    level = childElements(level);
  return level.length === 1 && fits(level[0]!, ".no_result");
}

/** The quarterly catalog as the service's fragment lists it: three cells a report, the first page only. */
export function quarterRowsIn(markup: string): ReportCatalog {
  const dom = fragment(markup);
  detach(
    query("script, style, input:not([id=GridNumOfResultsHidden]):not([id=GridTotalPagesHidden]), iframe, object", dom),
  );
  if (hasNoReports(dom)) return reportCatalog([], 0, 0);
  if (query(".dataGrid > .quaterly_table > .maintable", dom).length !== 1) classic.fail();
  if (query(QUARTER_HEADINGS, dom).length !== 3) classic.fail();
  const rows = query(QUARTER_ROWS, dom).map((row) =>
    childElements(row, "span").map((cell) => plainText(innerText(cell))),
  );
  return reportCatalog(rows, hiddenCount(dom, "GridNumOfResultsHidden"), hiddenCount(dom, "GridTotalPagesHidden"));
}

/** The access arguments behind each row of the quarterly catalog, in the rows' order, for the reader alone. */
export function quarterFilesIn(markup: string, reports: ReportRow[]): ReportAccess[] {
  const rows = query(QUARTER_ROWS, fragment(markup));
  if (rows.length !== reports.length) classic.fail();
  const taken = new Set<string>();
  return rows.map((row, at) => {
    const { token, reportType } = openReportArguments(row, "QuarterlyReport");
    const { period, productionDate } = reports[at]!;
    return { reference: reportReference([period, productionDate, reportType], taken), token, reportType };
  });
}
