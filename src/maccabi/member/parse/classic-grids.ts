/**
 * The grids that three classic .asmx script services send as an HTML fragment inside a `{"d": "..."}`
 * envelope (seen live on 2026-10-28). The caller has already dealt with the session, the owner's page,
 * the route and the charset.
 *
 * A grid is read for the text of its cells and for nothing else. Its links, form controls and onclick
 * handlers are not followed, run or returned: a purchased-drug row, for one, carries an
 * `AddAuditing(...)` call, and that call writes.
 */
import { attribute, childElements, type Document, type Element, innerText, query, toDom } from "../../html";
import { classic, dropUnseen, PAGE_BYTES, plainText } from "./classic-pages";

export interface GridPaging {
  page: number;
  totalPages: number;
}
/** A purchase under fixed English keys, with the row's cell texts as the page printed them alongside. */
export interface Purchase {
  purchase_date: string;
  drug: string;
  units: string;
  price: string;
  member_price: string;
  provider: string;
  pharmacy: string;
  cells: string[];
}
export interface PurchaseHistory {
  columns: string[];
  rows: Purchase[];
  pagination: GridPaging;
}
/**
 * A grid nobody has seen filled in. `columns` are its header labels and each row is its cell texts.
 * A row also gets `fields`, keyed by label, when the labels are all present and distinct and the row
 * has one cell per label. A grid without rows reports whatever it does say (a "no results" line, for
 * instance) as `text`.
 */
export interface ClassicGrid {
  columns: string[];
  rows: { cells: string[]; fields?: Record<string, string> }[];
  pagination: GridPaging;
  text?: string;
}

const RESULT_BYTES = 128 * 1024;
const textOf = (cell: Element): string => plainText(innerText(cell));

function fragment(markup: string): Document {
  if (typeof markup !== "string" || Buffer.byteLength(markup) > PAGE_BYTES || markup.trim() === "") classic.fail();
  // A table inside a table is a layout neither grid reader was written for.
  const dom = toDom(markup);
  return query("table table", dom).length > 0 ? classic.fail() : dom;
}

/** The number in the single hidden input with one of `ids`; undefined when there is no such input or it is empty. */
function hiddenNumber(dom: Document, ids: readonly string[]): number | undefined {
  const inputs = query(ids.map((id) => `input#${id}`).join(", "), dom);
  if (inputs.length > 1) classic.fail();
  const value = attribute(inputs[0], "value");
  if (value === undefined || value === "") return undefined;
  return /^-?\d{1,6}$/.test(value) ? Number(value) : classic.fail();
}

interface Paging {
  pagination: GridPaging;
  /** The grid itself says it has no pages. */
  none: boolean;
}

/** Reads the grid's hidden page counters, which has to happen while the inputs are still in the document. */
function pagingOf(dom: Document, pageIds: readonly string[], askedPage: number): Paging {
  const total = hiddenNumber(dom, ["hdnTotalPages"]) ?? classic.fail();
  const page = hiddenNumber(dom, pageIds) ?? askedPage;
  // A grid with nothing in it reports page 0, with 0 total pages (saved
  // documents) or -1 (requests and approvals). That page 0 is the one answer allowed to name a page
  // other than the page asked for.
  if (total < -1 || (page !== askedPage && page !== 0)) classic.fail();
  return { pagination: { page: askedPage, totalPages: Math.max(total, 0) }, none: page === 0 || total <= 0 };
}

/** Rows can only come from a page that exists. */
function mustAgree({ pagination, none }: Paging, rowCount: number): void {
  if (rowCount === 0) return;
  if (none || rowCount > 1000 || pagination.totalPages < 1 || pagination.page > pagination.totalPages) classic.fail();
}

const onlyContent = (dom: Document): void => dropUnseen(dom, { apart: "p, div, li, span, td, th" });

/** The purchased-drug grid's header as the page prints it, and the key each column's cells are filed under. */
const PURCHASE_HEADER = ["רכישה", "תרופה/מוצר", "רופא/מטפל", "יחידות", "בית המרקחת", "מחיר", "מחיר לחברי מכבי"];
const PURCHASE_KEYS = ["purchase_date", "drug", "provider", "units", "pharmacy", "price", "member_price"] as const;

/**
 * The answer of GetPurchasedPrescriptionList, the service behind `/online/medicalfile/patientdrugs/`.
 * As seen live, the fragment holds one `.dataGrid ul.appList`. The list's first `li` wraps a table with
 * the seven header labels; each `li.item` after it wraps a table of seven cells (and an empty
 * `.drugsDetailsOpen`). The hidden inputs hdnPageNum and hdnTotalPages sit next to the list.
 */
export function purchasesIn(markup: string, askedPage: number): PurchaseHistory {
  const dom = fragment(markup);
  const lists = query(".dataGrid ul.appList", dom);
  if (lists.length !== 1) classic.fail();
  const purchases = childElements(lists[0]!, "li.item");
  const headers = childElements(lists[0]!, "li:not(.item)");
  if (headers.length !== 1 || query("table", headers[0]).length !== 1) classic.fail();
  const paging = pagingOf(dom, ["hdnPageNum"], askedPage);
  mustAgree(paging, purchases.length);
  onlyContent(dom);

  const labelled = query("th", headers[0]);
  const columns = (labelled.length > 0 ? labelled : query("td", headers[0])).map(textOf);
  if (columns.length !== PURCHASE_HEADER.length || columns.some((label, at) => label !== PURCHASE_HEADER[at]))
    classic.fail();
  const rows = purchases.map((item): Purchase => {
    const tables = childElements(item, "table");
    const cells = tables.length === 1 ? query("td", tables[0]).map(textOf) : [];
    if (cells.length !== PURCHASE_KEYS.length) classic.fail();
    const keyed = Object.fromEntries(PURCHASE_KEYS.map((key, at) => [key, cells[at]!]));
    return { ...(keyed as Omit<Purchase, "cells">), cells };
  });
  return classic.bounded({ columns, rows, pagination: paging.pagination }, RESULT_BYTES);
}

/**
 * A grid whose filled-in layout is not known from the live site: the
 * saved-documents grid of the PHR and the requests-and-approvals grid. Labels are taken from `th`
 * cells, or from a heading list where there are none; rows from table rows that have `td` cells, and
 * from a row list. The page counters are held to the same rules as for the purchases grid.
 */
export function classicGridIn(markup: string, askedPage: number, pageIds: readonly string[]): ClassicGrid {
  const dom = fragment(markup);
  const paging = pagingOf(dom, pageIds, askedPage);
  onlyContent(dom);

  const labelled = query("th", dom);
  const columns = (labelled.length > 0 ? labelled : query("ul.headinggroup > li > span", dom)).map(textOf);
  const distinct = columns.length > 0 && !columns.includes("") && new Set(columns).size === columns.length;
  const tableRows = query("tr", dom).map((line) => childElements(line, "td"));
  const listRows = query("ul.rowgroup > li", dom).map((line) => childElements(line, "span"));
  const rows = [...tableRows.filter((cells) => cells.length > 0), ...listRows].map((line) => {
    const cells = line.map(textOf);
    if (!distinct || cells.length !== columns.length) return { cells };
    return { cells, fields: Object.fromEntries(columns.map((label, at) => [label, cells[at]!])) };
  });
  mustAgree(paging, rows.length);

  const text = rows.length === 0 ? plainText(innerText(dom)) : "";
  return classic.bounded({ columns, rows, pagination: paging.pagination, ...(text ? { text } : {}) }, RESULT_BYTES);
}
