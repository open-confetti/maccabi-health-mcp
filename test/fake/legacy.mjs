/**
 * Maccabi's classic website (ASP.NET, everything under /online) as the tool meets it. A number of
 * reads have no JSON API behind them, only one of these pages, so this module answers with the markup
 * of the live site and fills it with made-up content.
 *
 * What is served:
 *   - whole pages: medical summary, recommendations, notification settings, billing, hospital mailings
 *     and the three landing pages of the grids below. Each starts with the site header naming the
 *     patient it was rendered for, which is what a read checks before believing the rest.
 *   - fragments that a script service wraps as `{"d": "<markup>"}`. The billing services answer in
 *     plain JSON; the purchased-medication, saved-document and request grids answer in windows-1255
 *     bytes, as the live ones did on 8 November 2026.
 *   - the two PDF popups.
 * A script service is posted the page's own hand-written body, single quotes and all, and the fake
 * gives no answer to any other body.
 *
 * The markup helpers and the grid builders are exported: classic-pages.test.ts and multi-page-reads.test.ts
 * write their variations of these pages with them.
 */
const PORTAL = "https://online.maccabi4u.co.il";
/** The script services (.asmx) behind the pages. */
const BILLING_SERVICE = "/online/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx";
const DRUGS_SERVICE = "/online/Ajax/DrugsManager/WsPurchasedDrugsManager.asmx";
const DOCUMENTS_SERVICE = "/online/Ajax/PHR/WsPHRManager.asmx";
const REQUESTS_SERVICE = "/online/Ajax/RequestsAndApprovals/WsRequestsAndApprovalsAPI.asmx";
/** Sits wherever a page holds something no read may repeat; the tests search every result for it. */
export const PRIVATE = "MOCKPRIVATE";

// ---- markup

const VOID_ELEMENTS = new Set(["br", "hr", "input"]);

/**
 * One element as text. `el("div.box", …)` and `el("div#main", …)` abbreviate a lone class or id; any
 * other attributes come as an object and print unescaped in the order written (`true` prints the bare
 * name), because the bytes of the live pages are what the parsers are held to.
 */
export function el(selector, ...parts) {
  const [name, mark, value] = selector.split(/([.#])(.*)/);
  const short = mark ? { [mark === "#" ? "id" : "class"]: value } : {};
  const given = parts[0]?.constructor === Object ? parts.shift() : {};
  const attributes = Object.entries({ ...short, ...given }).map(([key, text]) =>
    text === true ? ` ${key}` : ` ${key}="${text}"`,
  );
  const open = `<${name}${attributes.join("")}>`;
  return VOID_ELEMENTS.has(name) ? open : `${open}${parts.flat().join("")}</${name}>`;
}
const hidden = (id, value, more = {}) => el("input", { type: "hidden", ...more, id, value });
/** One `tag` element per text: the cells of a row, the spans of a heading. */
export const each = (tag, texts) => texts.map((text) => el(tag, text));

const PATIENT =
  "ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber";
/** A whole page for `member`. The site does not display the span with their ID; it is the owner proof all the same. */
export const page = (member, ...content) =>
  el("html", el("header", el("div", { style: "display:none" }, el("span", { id: PATIENT }, member))), content);

/** The list-of-tables layout of the medical file: a heading table, then one table per row. */
export const appList = (columns, rows) =>
  el(
    "ul.appList",
    el("li", el("table", el("thead", el("tr", each("th", columns))))),
    rows.map((row) => el("li", el("table", el("tbody", el("tr", each("td", row)))))),
  );

// ---- medical summary and recommendations

const summaryPage = (member) =>
  page(
    member,
    el(
      "form",
      el(
        "div#summery",
        el("div.medicalFileDesc", "דף זה מציג נתונים מומצאים.", el("br"), "אין בו מידע אמיתי."),
        el(
          "div#drugs",
          el("div.summeryInnerTitle", el("h3", "תכשירים שנופקו"), el("p", "בחצי השנה האחרונה")),
          appList(
            ["שם התכשיר", "נופק ביום"],
            [[el("a", { href: `https://example.invalid/leaflet?key=${PRIVATE}` }, "כמוסות פלוני 20"), "14/05/2026"]],
          ),
        ),
        el(
          "div#labResults",
          el("div.summeryInnerTitle", el("div.table-cell", el("h3", "בדיקות מעבדה"), "בשלושת החודשים האחרונים")),
          appList(["שם הבדיקה", "נלקחה ביום", "הערה", "ערך"], [["בדיקת אלמוני", "02/06/2026", "ללא הערות", "17"]]),
        ),
        el("div#englishNameUpdate", el("input", { value: PRIVATE })),
      ),
    ),
  );

/** Still served although a JSON service has taken its place; the tool falls back to it. */
const recommendationsPage = (member) =>
  page(
    member,
    el(
      "form",
      el("div.personalMenu", PRIVATE),
      el("div.recommendationsTitle", el("h2", "ההמלצות שלי")),
      el(
        "div.personal-recommendations-details",
        el("input", { value: PRIVATE }),
        el("div.medicalReInfo", el("p", "רקע &amp; הסתייגויות")),
        el(
          "div.medicalReSubject",
          el("a", "מעקב תקופתי"),
          el(
            "div.medicalReSubjectInner",
            appList(
              ["גילאים", "מה מומלץ"],
              [["", el("p", "מינון יומי מומצא: &ge; 40 &mu;g.") + el("ul.actionButtons", el("li", PRIVATE))]],
            ),
          ),
        ),
        el("div.commentBlock", "הערת סיום מומצאת"),
      ),
    ),
  );

// ---- notification settings

/** The fields a group, a service and a channel have in common. */
const registration = (Code, Name, more = {}) => ({
  Code,
  Name,
  Description: "פירוט מומצא",
  IsRegistered: true,
  CanRegister: false,
  RestrictionDesc: "ללא מגבלה",
  RestrictionCode: 4,
  Order: 2,
  ...more,
});
const REMINDERS = {
  ResultMessage: { Code: 0 },
  StatusCode: 1,
  PreferredLangCode: 1,
  ContactDetails: { CellPhone: "050-0000000", Email: "reminders@example.invalid" },
  MemberRegistrationDetails: { DeviceToken: PRIVATE, UDID: PRIVATE },
  ServiceGroups: [
    registration(30, "תזכורות לתורים", {
      Services: [
        registration(3104, "תזכורת יום לפני התור", {
          TypeCode: null,
          DefaultChannelCode: 2,
          ServiceChanneIdSelected: -1,
          IsMaccabitonType: false,
          Channels: [registration(2, "מסרון", { Description: null, RestrictionCode: null })],
        }),
      ],
    }),
  ],
};

// ---- billing: quarterly statements and the yearly nursing-insurance report

const APP_ROOT = "jqe.appRoot='/online';";
/** What each catalog row hands the archive service before its PDF opens. */
const QUARTERLY_PDF = { token: "statement-archive-key", type: "quarter-statement" };
const NURSING_PDF = { token: "nursing-archive-key", type: "nursing-yearly" };

/** A year the picker offers and the quarterly service has nothing for. */
const EMPTY_YEAR = "2001";
const billingPage = (member) =>
  page(
    member,
    el("script", APP_ROOT),
    hidden("isUnderConstruction", 0),
    el(
      "select#PeriodSelectDropDownList",
      el("option", { value: "2025", selected: "selected" }, "2025"),
      el("option", { value: EMPTY_YEAR }, EMPTY_YEAR),
    ),
  );

/** The two hidden fields in which a report catalog says how much it holds. */
export const gridCounts = (results, pages) =>
  hidden("GridNumOfResultsHidden", results) + hidden("GridTotalPagesHidden", pages);
/** The table both catalogs use: three headings and one report, whose last cell opens the PDF. */
const reportTable = (period, produced, opener) =>
  el(
    "div.maintable",
    el("ul.headinggroup", el("li.headinggroup", each("span", ["תקופה", "תאריך הפקה", "דוחות"]))),
    el("ul.rowgroup", el("li", each("span", [period, produced, el("a", opener, "לצפייה")]))),
  );

const QUARTER = el(
  "div.dataGrid",
  el(
    "div.quaterly_table",
    reportTable("רבעון 2 2025", "01/07/2025", {
      class: "reportFound",
      onclick: `QuarterlyReport.OpenReportPdf(&#39;${QUARTERLY_PDF.token}&#39;,&#39;${QUARTERLY_PDF.type}&#39;)`,
    }),
  ),
  gridCounts(1, 1),
);
/**
 * What a year without statements is answered with: the no-result box three
 * wrappers deep, with both counts at zero beside it.
 */
const EMPTY_QUARTER =
  el("div.aspNetHidden") +
  el(
    "div",
    el("div.dataGrid", el("div", el("div", el("div.no_result", el("span", "לא נמצאו דוחות")))), gridCounts(0, 0)),
  ) +
  el("div.aspNetHidden", hidden("__VIEWSTATEGENERATOR", "X"));
const NURSING =
  el(
    "div.dataGrid",
    el(
      "div.more_info showinfobox",
      el(
        "div.yearly_table",
        reportTable("שנת 2024", "01/01/2025", {
          onclick: `LTCReport.OpenReportPdf('${NURSING_PDF.token}', '${NURSING_PDF.type}');`,
        }),
      ),
    ),
  ) +
  el("div#moreResults") +
  gridCounts(1, 1);

// ---- hospital and emergency-room mailings

const hospitalPage = (member) =>
  page(
    member,
    el("div#mailingsFromHospitalsController"),
    el("script", `${APP_ROOT}var pageSettings=${JSON.stringify({ YearsBack: "5" })};`),
  );
const ADMISSION = {
  NameHospital: "מרכז רפואי פלוני",
  DateHospitalization: "01/01/2025",
  Date: "01/01/2025",
  DurationHospitalization: "1",
  QuantityTreatments: "1",
  TypeCommitment: "מיון",
  Department: "מחלקה מומצאת",
  HasLink: false,
  DescriptionTreatment: [{ Description: "טיפול מומצא" }],
  DescriptionDistinction: [],
};

// ---- the three grids that multi-page-reads.test.ts also builds variations of

/**
 * The bytes the classic site sends. ASCII, the Hebrew alphabet and the sheqel sign are all the fake's
 * pages use; anything else means a page was written wrongly, so it is an error and not a guessed byte.
 */
export function windows1255(source) {
  const bytes = Array.from(source, (character) => {
    const point = character.codePointAt(0);
    if (point <= 0x7f) return point;
    if (character >= "א" && character <= "ת") return point - 0x5d0 + 0xe0;
    if (character === "₪") return 0xa4;
    throw new Error(`a fake page holds ${JSON.stringify(character)}, which has no windows-1255 byte here`);
  });
  return Buffer.from(bytes);
}

/** ASP.NET's own state field, which precedes every grid and belongs in no result. */
const VIEWSTATE = el("div.aspNetHidden", hidden("__VIEWSTATEGENERATOR", PRIVATE, { name: "__VIEWSTATEGENERATOR" }));

const DRUG_COLUMNS = ["רכישה", "תרופה/מוצר", "רופא/מטפל", "יחידות", "בית המרקחת", "מחיר", "מחיר לחברי מכבי"];
/** Three purchases over two upstream pages. */
const DRUG_PAGES = [
  [
    ["01/10/2026", "תרופה בדוי 10 מג", 'ד"ר בדוי', "30", "בית מרקחת בדוי", "12.50 ₪", "9.90 ₪"],
    ["01/09/2026", "מוצר בדוי", "", "1", "בית מרקחת אחר", "40.00 ₪", "40.00 ₪"],
  ],
  [["01/02/2026", "תרופה שנייה", 'ד"ר אחר', "2", "בית מרקחת בדוי", "5.00 ₪", "3.00 ₪"]],
];
/** Seven cells to a line; the member's price, last, is the centred one. */
const drugLine = (cell, texts) => {
  const cells = texts.map((text, at) => el(at === 6 ? `${cell}.text-center` : cell, text));
  return el("table", el("tr", cells));
};

/**
 * One page of the purchase history as Maccabi sends it: the headings in a first `li`, then an `li.item` per
 * purchase with an empty details box. Clicking a row on the site reports it to an auditing service,
 * which is why each row carries a handler the tool must never call.
 */
export function purchasedDrugs(number, purchases = DRUG_PAGES[number - 1] ?? [], totalPages = DRUG_PAGES.length) {
  const items = purchases.map((purchase, row) => {
    const audited = { class: "item", onclick: `AddAuditing('MOCKAUDIT${row}')` };
    return el("li", audited, drugLine("td", purchase), el("div.drugsDetailsOpen"));
  });
  const list = el("ul.appList", el("li", drugLine("th", DRUG_COLUMNS)), items);
  const grid = el("div", { class: "dataGrid " }, list, hidden("hdnPageNum", number));
  return VIEWSTATE + el("div", grid, hidden("hdnTotalPages", totalPages));
}

/**
 * The saved-documents grid. Its empty state is Maccabi's markup: an empty
 * file list, a no-data label, and both counts at zero. `content`, when given, is put where rows would go.
 */
export function savedDocuments(number, content = "") {
  if (content) {
    const grid = el("div.dataGrid", content, hidden("hdnTotalPages", 1), hidden("hdnPageNum", number));
    return VIEWSTATE + el("div", grid);
  }
  const empty = el(
    "div",
    { class: "dataGrid", id: "ctl01_pnlDataGrid" },
    el("ul.appList filesList"),
    hidden("hdnPageNum", 0),
    el("div#divFileDetails"),
    el("span.noDataLabel", "לא נמצאו קבצים"),
    hidden("hdnTotalPages", 0),
  );
  return VIEWSTATE + el("div", empty);
}

/**
 * The requests-and-approvals grid. Its empty state: an accordion whose list holds
 * a rule and a no-messages label, page 0 of -1, between an inline style and an inline script. `rows`
 * are `<tr>` markup for the populated table.
 */
export function requestsGrid(number, rows = "") {
  if (rows) {
    const headings = el("thead", el("tr", each("th", ["סוג הבקשה", "תאריך", "סטטוס"])));
    const table = el("table.requestsTable", headings, el("tbody", rows));
    const counts = hidden("hdnPageNumber", number) + hidden("hdnTotalPages", 1);
    return VIEWSTATE + el("div", el("div.dataGrid", table, counts));
  }
  const accordion = el(
    "div.datatable accordion",
    el("ul#appList1", el("hr.line"), el("div.no_messages", el("span", "אין בקשות להצגה"))),
    hidden("hdnPageNumber", 0, { class: "clsPageNumber" }),
    hidden("hdnTotalPages", -1, { class: "clsTotalPages" }),
  );
  const style = el("style", "ul .edit_delete li button i { color: red; }");
  return VIEWSTATE + style + accordion + el("script", 'var globalMainErrMsg = ["mock"];');
}

const drugsPage = (member) =>
  page(
    member,
    el(
      "div#purchasedDrugs",
      el("h1", "היסטוריית התרופות שלי"),
      el("a", { onclick: "PurchasedDrugs.SearchByDate()" }, "חיפוש"),
      el("a", { onclick: "sortPurchasedPrescriptions(1)" }, "מיון"),
    ),
  );
const documentsPage = (member) =>
  page(member, el("div#phrDocuments", el("h1", "שמירת מסמכים רפואיים"), el("input", { type: "file", id: "upload" })));
const requestsPage = (member) => page(member, el("div#requestsAndApprovals", el("h1", "פעולות ומידע")));

// ---- routes

const HTML = "text/html; charset=utf-8";
const html = (build) => (request) => ({ type: HTML, body: build(request.member) });
const pdf = (label) => () => ({ type: "application/pdf", body: `%PDF-1.4\n% made-up ${label}\n%%EOF\n` });
/** How these script services encode their answer live: the JSON envelope itself in windows-1255. */
const encoded = (markup) => ({
  type: "application/json; charset=windows-1255",
  body: windows1255(JSON.stringify({ d: markup })),
});

/**
 * A script service. Whatever arrives is logged as sent, so a test can read what the tool posted; only
 * a POST whose whole body is the one the page itself sends is answered.
 */
const service = (expected, answer) => (request) => {
  const sent = String(request.body);
  request.record(sent);
  const match = request.method === "POST" ? expected.exec(sent) : null;
  return match ? answer(match.groups ?? {}) : null;
};
const NO_BODY = /^$/;

const ROUTES = {
  "/online/medicalfile/summary/": html(summaryPage),
  "/online/medicalfile/personalrecommendations/": html(recommendationsPage),

  "/online/directorship/personalreminders/": html((member) => page(member, el("div#personalReminders"))),
  "/online/webapi/PersonalRemindersESB/GetReminders/": () => ({ json: REMINDERS }),

  "/online/directorship/debitsandcredits/": html(billingPage),
  [`${BILLING_SERVICE}/GetQuarterlyReport`]: service(/^\{'value':'(?<period>\d{1,4})'\}$/, ({ period }) => ({
    json: { d: period === EMPTY_YEAR ? EMPTY_QUARTER : QUARTER },
  })),
  [`${BILLING_SERVICE}/GetLTCReport`]: service(NO_BODY, () => ({ json: { d: NURSING } })),
  [`${BILLING_SERVICE}/GetDocFromArchive`]: service(
    /^\{'token':'(?<token>[^']*)', 'reportType':'(?<type>[^']*)'\}$/,
    (asked) =>
      [QUARTERLY_PDF, NURSING_PDF].some((known) => known.token === asked.token && known.type === asked.type)
        ? { json: { d: true } }
        : null,
  ),
  "/online/Pages/Popups/DebitsAndCredits/DebitsAndCreditsPdfReport.aspx": pdf("billing-statement"),

  "/online/medicalfile/mailingsfromhospitals/": html(hospitalPage),
  "/online/webapi/MailingsFromHospitals/GetMailingsFromHospitals/": (request) => {
    request.record(JSON.parse(String(request.body)));
    return { json: { ReportHospitalizations: [ADMISSION], ResultMessage: { Code: 0 } } };
  },
  "/online/Pages/Popups/MailingsFromHospitals/MailingsFromHospitals.aspx": pdf("hospital-letter"),

  "/online/medicalfile/patientdrugs/": (request) => ({
    type: "text/html; charset=windows-1255",
    body: windows1255(drugsPage(request.member)),
  }),
  [`${DRUGS_SERVICE}/GetPurchasedPrescriptionList`]: service(/^\{'pageNum':'(?<page>[1-9]\d*)'\}$/, ({ page }) =>
    encoded(purchasedDrugs(Number(page))),
  ),
  "/online/medicalfile/documentsandmedicalrecords/": html(documentsPage),
  [`${DOCUMENTS_SERVICE}/GetGridViewAjax`]: service(
    /^\{'pageNum':'(?<page>[1-9]\d*)','categoryId':'','dateFrom':'\d\d\/\d\d\/\d{4}','dateTo':'\d\d\/\d\d\/\d{4}'\}$/,
    ({ page }) => encoded(savedDocuments(Number(page))),
  ),
  "/online/directorship/RequestsAndApprovals/": html(requestsPage),
  [`${REQUESTS_SERVICE}/GetGridViewAjax`]: service(/^\{'pageNum' : '(?<page>[1-9]\d*)'\}$/, ({ page }) =>
    encoded(requestsGrid(Number(page))),
  ),
  [`${REQUESTS_SERVICE}/GetApplicationTypeManagementResponse`]: service(NO_BODY, () => encoded("null")),
};

/** The fake's answer to one request for a classic page or service, or null when it is for neither. */
export function legacy(target, method, body, member, out) {
  const route = target.origin === PORTAL ? ROUTES[target.pathname] : undefined;
  if (!route) return null;
  const record = (sent) => out.log({ kind: "classic-body", path: target.pathname, body: sent });
  const reply = route({ member, method, body, record });
  if (!reply) return null;
  if ("json" in reply) return out.json(target.href, reply.json);
  return out.respond(target.href, reply.body, 200, { "content-type": reply.type });
}
