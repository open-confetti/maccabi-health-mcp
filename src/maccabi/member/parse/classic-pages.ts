/**
 * The classic (server-rendered) pages of the portal, read as HTML: the error both kinds of mismatch
 * raise, the helpers every classic parser shares, and the parsers of three whole pages.
 *
 * Nothing here knows whose page it was handed or where it came from. The caller settles the session,
 * the owner and the address the markup was served from before any of this runs.
 */
import { decodeHTML } from "entities";
import {
  attribute,
  type Document,
  detach,
  type Element,
  innerText,
  query,
  surroundWithSpaces,
  swapForSpace,
  toDom,
  toMarkup,
} from "../../html";
import { type Guard, guardFor, isDigits } from "./guards";

/** The markup is not built the way it was when the page was seen live, so nothing can be read off it. */
export class ClassicPageShapeError extends Error {
  constructor() {
    super("A classic Maccabi page is not built the way it was when this reader was written");
    this.name = "ClassicPageShapeError";
  }
}
/**
 * The page says, readably, that it shows another member. This is a different event from a
 * ClassicPageShapeError and calls for a different reaction: there the parser failed to find out whose
 * page it holds, here it found out and the answer is "not the owner's".
 */
export class ClassicPageOwnerError extends Error {
  constructor() {
    super("A classic Maccabi page names a member other than the owner");
    this.name = "ClassicPageOwnerError";
  }
}

export interface ClassicTable {
  columns: string[];
  rows: string[][];
}
export interface ClassicRecommendations {
  introduction: string;
  sections: { title: string; table: ClassicTable }[];
  closingNote: string;
}
interface SummaryBlock {
  title: string;
  context: string;
  table: ClassicTable;
}
export interface ClassicSummary {
  description: string;
  medications: SummaryBlock;
  laboratory: SummaryBlock;
}

export const classic: Guard = guardFor(() => new ClassicPageShapeError());
/** No classic page or fragment comes near this size. */
export const PAGE_BYTES = 1024 * 1024;
const RESULT_BYTES = 128 * 1024;

/** Text as the member reads it: entities resolved, every run of whitespace a single space, no padding. */
export const plainText = (raw: string): string => decodeHTML(raw).replace(/\s+/gu, " ").trim();

export const scriptsOf = (dom: Document): string[] => query("script", dom).map((script) => innerText(script));

/** Every statement in the scripts that assigns `value` to `target`; both are regular-expression source. */
function assignments(scripts: readonly string[], target: string, value: string): RegExpExecArray[] {
  const statement = new RegExp(String.raw`\b${target}\s*=\s*${value}\s*;`, "g");
  return scripts.flatMap((source) => [...source.matchAll(statement)]);
}
/** A string literal in either kind of quote, with no quote of either kind inside it. */
const QUOTED_TEXT = String.raw`(?<quote>["'])(?<text>[^"']*)\k<quote>`;
const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
/** An object literal with nothing nested in it; a brace counts only outside its strings. */
const FLAT_OBJECT = String.raw`(?<object>\{(?:${JSON_STRING}|[^"{}])*\})`;

/** True when the page's scripts set the application root exactly once, and to the portal's `/online`. */
export function isOnlineApp(scripts: readonly string[]): boolean {
  const roots = assignments(scripts, String.raw`jqe\.appRoot`, QUOTED_TEXT);
  return roots.length === 1 && roots[0]?.groups?.text === "/online";
}

/** Elements that are never something the member reads, whatever else is true of them. */
const NEVER_CONTENT =
  "script, style, noscript, template, input, textarea, select, button, meta, link, iframe, object, .aspNetHidden";

/** The two CSS declarations that take an element off the page, each as its property and its value. */
const HIDING_DECLARATIONS = [
  ["display", "none"],
  ["visibility", "hidden"],
] as const;
const IMPORTANT = "!important";

/** Whether one declaration of a style attribute is a hiding one, with or without `!important`. */
function hides(declaration: string): boolean {
  const sides = declaration.toLowerCase().split(":");
  if (sides.length !== 2) return false;
  const [property, setting] = sides.map((side) => side.trim()) as [string, string];
  const value = setting.endsWith(IMPORTANT) ? setting.slice(0, -IMPORTANT.length).trimEnd() : setting;
  return HIDING_DECLARATIONS.some(([name, off]) => property === name && value === off);
}

/**
 * Whether a style attribute hides its element. Normally one of its declarations has to be a hiding
 * one from end to end. With `anywhere`, the rule the nursing fragment is read by, such a declaration
 * counts wherever it stands in the attribute and whatever is written around it.
 */
export function styleHides(style: string, anywhere = false): boolean {
  if (!anywhere) return style.split(";").some(hides);
  const sides = style.toLowerCase().split(":");
  return sides.some((before, at) => {
    const after = sides[at + 1];
    if (after === undefined) return false;
    return HIDING_DECLARATIONS.some(
      ([name, off]) => before.trimEnd().endsWith(name) && after.trimStart().startsWith(off),
    );
  });
}

/** Whether the element says of itself that it is not shown: by attribute, or by one of `classes`. */
export function marksItselfHidden(tag: Element, classes: readonly string[] = []): boolean {
  if (attribute(tag, "aria-hidden") === "true" || attribute(tag, "hidden") !== undefined) return true;
  const worn = (attribute(tag, "class") ?? "").toLowerCase().split(/\s+/);
  return worn.some((name) => classes.includes(name));
}

export interface Unseen {
  /** Further selectors to drop, for furniture particular to one kind of page. */
  furniture?: string;
  /** Class names, in lower case, that hide their element on this kind of page. */
  hidingClasses?: readonly string[];
  /** Elements whose text must not run into its neighbours' once the tags are gone. */
  apart: string;
}

/**
 * Leaves in the document only what a browser would put in front of the member. Forms stay: these
 * ASP.NET pages put their whole visible content inside one.
 */
export function dropUnseen(dom: Document, { furniture, hidingClasses, apart }: Unseen): void {
  detach(query(furniture ? `${NEVER_CONTENT}, ${furniture}` : NEVER_CONTENT, dom));
  const unseen = (tag: Element): boolean =>
    marksItselfHidden(tag, hidingClasses) || styleHides(attribute(tag, "style") ?? "");
  detach(query("*", dom).filter(unseen));
  swapForSpace(query("br", dom));
  surroundWithSpaces(query(apart, dom));
}

/** A whole page reduced to its visible content. */
function visiblePage(given: string): Document {
  if (Buffer.byteLength(given) > PAGE_BYTES || given.trim() === "") classic.fail();
  const dom = toDom(given);
  dropUnseen(dom, {
    furniture: ".actionButtons, .tooltipR, .termsOfUse",
    hidingClasses: ["hidden", "hide"],
    apart: "p, div, li",
  });
  // Written out and read back on purpose: pieces of text that the removals left side by side come
  // back as one, and that is the form in which these pages were checked against the live site.
  return toDom(toMarkup(dom));
}

const count = (dom: Document, css: string): number => query(css, dom).length;

/** The text of the only element matching `css`. No match, several, or a blank one is a mismatch. */
function theText(dom: Document, css: string): string {
  const found = query(css, dom);
  const text = found.length === 1 ? plainText(innerText(found[0]!)) : "";
  return text === "" ? classic.fail() : text;
}

function table(dom: Document, css: string, width: number): ClassicTable {
  const columns = query(`${css} thead th`, dom).map((cell) => plainText(innerText(cell)));
  const lines = query(`${css} tbody tr`, dom);
  const cells = query(`${css} tbody td`, dom).map((cell) => plainText(innerText(cell)));
  if (columns.length !== width || columns.includes("")) classic.fail();
  if (lines.length === 0 || lines.length > 1000 || cells.length !== lines.length * width) classic.fail();
  // The totals can agree while individual rows do not, so every row is measured too.
  if (lines.some((line) => query("td", line).length !== width)) classic.fail();
  return { columns, rows: lines.map((_, at) => cells.slice(at * width, (at + 1) * width)) };
}

export function recommendationsIn(given: string): ClassicRecommendations {
  const page = visiblePage(given);
  const box = ".personal-recommendations-details";
  theText(page, ".recommendationsTitle h2");
  if (count(page, box) !== 1 || count(page, `${box} .medicalReSubject`) !== 1) classic.fail();
  // What a page with several subjects looks like is not known, so only a page with one is read.
  const section = {
    title: theText(page, `${box} .medicalReSubject > a`),
    table: table(page, `${box} .medicalReSubjectInner .appList`, 2),
  };
  return classic.bounded(
    {
      introduction: theText(page, `${box} .medicalReInfo`),
      sections: [section],
      closingNote: theText(page, `${box} .commentBlock`),
    },
    RESULT_BYTES,
  );
}

export function selectedSummaryIn(given: string): ClassicSummary {
  const page = visiblePage(given);
  // The spelling of the page's ids and classes is the page's own.
  const box = "#summery";
  const block = (id: string, context: string, width: number): SummaryBlock => {
    if (count(page, `${box} ${id}`) !== 1) classic.fail();
    return {
      title: theText(page, `${box} ${id} h3`),
      context: theText(page, `${box} ${id} .summeryInnerTitle ${context}`),
      table: table(page, `${box} ${id} .appList`, width),
    };
  };
  if (count(page, box) !== 1) classic.fail();
  return classic.bounded(
    {
      description: theText(page, `${box} .medicalFileDesc`),
      medications: block("#drugs", "p", 2),
      laboratory: block("#labResults", ".table-cell", 4),
    },
    RESULT_BYTES,
  );
}

/** Where the page header prints the identity number of the member being viewed. */
const VIEWED_MEMBER =
  "span#ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber";

/**
 * Ties a classic page to the owner by the one place where the server prints whose page it is: a named
 * span in the header, holding the member number the modern portal's bootstrap also reports. The
 * number is compared and never returned. Only that span counts; the same digits in a script, a form
 * field or an attribute prove nothing.
 *
 * The span sits in a menu that starts out collapsed, so it is read from the page as served, apart
 * from the visible content the other parsers work on.
 *
 * A span that is missing, repeated, outside the header or not one to nine digits is a
 * ClassicPageShapeError: whose page this is could not be established. Only a span that reads cleanly
 * and differs from the owner is a ClassicPageOwnerError.
 */
export function mustBeMembersPage(given: string, rightfulMemberId: number): void {
  if (!Number.isSafeInteger(rightfulMemberId) || rightfulMemberId < 0) classic.fail();
  if (Buffer.byteLength(given) > PAGE_BYTES) classic.fail();
  const page = toDom(given);
  if (count(page, VIEWED_MEMBER) !== 1) classic.fail();
  const printed = theText(page, `header ${VIEWED_MEMBER}`);
  if (!isDigits(printed, 1, 9)) classic.fail();
  if (Number(printed) !== rightfulMemberId) throw new ClassicPageOwnerError();
}

/**
 * The one setting of the hospital-mailings page that the read depends on, taken from the settings
 * object its script declares. The object is parsed as JSON; no script is run, and none of the
 * addresses in it is returned.
 */
export function hospitalSettingsIn(given: string): { lookBackYears: number } {
  if (Buffer.byteLength(given) > PAGE_BYTES) classic.fail();
  const page = toDom(given);
  if (count(page, "#mailingsFromHospitalsController") !== 1) classic.fail();
  const scripts = scriptsOf(page);
  const declared = assignments(scripts, String.raw`var\s+pageSettings`, FLAT_OBJECT);
  const literal = declared.length === 1 ? declared[0]?.groups?.object : undefined;
  if (literal === undefined || !isOnlineApp(scripts)) classic.fail();
  let settings: unknown;
  try {
    settings = JSON.parse(literal);
  } catch {
    return classic.fail();
  }
  // One or two digits and no leading zero: a look-back of 1 to 99 years.
  const years = classic.object(settings).YearsBack;
  if (typeof years !== "string" || !isDigits(years, 1, 2) || years.startsWith("0")) classic.fail();
  return { lookBackYears: Number(years) };
}
