import { attribute, childElements, detach, type Element, innerText, parentsOf, query } from "../../html";
import {
  fragment,
  hiddenCount,
  openReportArguments,
  type ReportAccess,
  type ReportCatalog,
  type ReportRow,
  reportCatalog,
  reportReference,
} from "./billing-reports";
import { classic, marksItselfHidden, plainText, styleHides } from "./classic-pages";

export type NursingCatalog = ReportCatalog;

const YEARLY_TABLE = ".dataGrid > .more_info > .yearly_table > .maintable";

/** Class names that count as hiding their element in this fragment. */
const HIDING_CLASSES = ["d-none", "hidden", "hide"];

const isHidden = (tag: Element): boolean =>
  marksItselfHidden(tag, HIDING_CLASSES) || styleHides(attribute(tag, "style") ?? "", true);

/** The catalog, and next to it the row elements it was read from, which still hold the report links. */
function read(markup: string): { rows: Element[]; catalog: NursingCatalog } {
  const dom = fragment(markup);
  const tables = query(YEARLY_TABLE, dom);
  if (tables.length !== 1) classic.fail();
  const table = tables[0]!;
  // Only a table that is on show counts, and it is not on show under a hidden ancestor.
  if (isHidden(table) || parentsOf(table).some(isHidden)) classic.fail();
  const reportedResultCount = hiddenCount(dom, "GridNumOfResultsHidden");
  const totalPages = hiddenCount(dom, "GridTotalPagesHidden");

  detach(query("script, style, input, iframe, object, form", dom));
  detach(query("*", dom).filter(isHidden));
  const headings = childElements(childElements(childElements(table, "ul.headinggroup"), "li.headinggroup"), "span");
  if (headings.length !== 3) classic.fail();
  const rows = childElements(childElements(table, "ul.rowgroup"), "li");
  const cells = rows.map((row) => childElements(row, "span").map((cell) => plainText(innerText(cell))));
  return { rows, catalog: reportCatalog(cells, reportedResultCount, totalPages, 4096) };
}

/**
 * The yearly nursing-insurance reports the page lists, first page only. Whose insurance a report
 * covers is not something the list says, and this makes no claim about it.
 */
export function nursingRowsIn(markup: string): NursingCatalog {
  return read(markup).catalog;
}

/**
 * The access arguments behind each row, for the reader alone. `reports` is the catalog as it was read
 * for the member; the markup has to list those same reports, row for row, or the arguments would be
 * filed under the wrong report.
 */
export function nursingFilesIn(markup: string, reports: ReportRow[]): ReportAccess[] {
  const { rows, catalog } = read(markup);
  const sameList =
    reports.length === catalog.reports.length &&
    !reports.some((shown, at) => {
      const listed = catalog.reports[at]!;
      return (
        shown.period !== listed.period ||
        shown.productionDate !== listed.productionDate ||
        shown.viewLabel !== listed.viewLabel
      );
    });
  if (!sameList) classic.fail();
  const taken = new Set<string>();
  return rows.map((row, at) => {
    const { token, reportType } = openReportArguments(row, "LTCReport");
    const { period, productionDate } = reports[at]!;
    return {
      reference: reportReference(["nursing-insurance", period, productionDate, reportType], taken),
      token,
      reportType,
    };
  });
}
