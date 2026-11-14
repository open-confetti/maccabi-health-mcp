/**
 * Three legacy grids and one public count, read by the built bundle over MCP from the fake Maccabi.
 *
 * The grids (medications bought, documents saved, requests and approvals) work alike on the website: a
 * page is opened, then an ASP.NET script service is posted to and answers `{"d": "<html>"}` encoded as
 * windows-1255. One reader serves all three, so its distrust of an answer (where it came from, its
 * type, its envelope, its status, a logout page in its place) is tested on the medications grid only,
 * and the other two add what is theirs alone. The biobank count is the one catalog endpoint that names
 * no member. The last test reads the fake's log: no row's auditing handler and no write was ever called.
 */
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error the fakes are plain ESM and ship no type declarations
import { purchasedDrugs, requestsGrid, savedDocuments, windows1255 } from "../fake/legacy.mjs";
import { answerWith, carriesNone, LOGOUT_PAGE, memberSession, type Route, SOMEONE_ELSE } from "../rig";

/** Markup the fake's grids carry that no result may repeat: hidden page state, and what a row's click would audit. */
const session = memberSession("grids", ["MOCKPRIVATE", "MOCKAUDIT"]);
const { box, ok, fails } = session;

/** ISO date to the DD/MM/YYYY the documents grid is asked in. */
function slashed(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Each grid's page and script service, as fragments of the request URL, with the body its page posts
 * for one page of rows. The bodies are the website's own, single quotes and stray spaces included.
 */
const MEDICATIONS = {
  page: "/online/medicalfile/patientdrugs/",
  service: "/WsPurchasedDrugsManager.asmx/GetPurchasedPrescriptionList",
  body: (pageNumber: number): string => `{'pageNum':'${pageNumber}'}`,
};
const DOCUMENTS = {
  page: "/online/medicalfile/documentsandmedicalrecords/",
  service: "/PHR/WsPHRManager.asmx/GetGridViewAjax",
  body: (pageNumber: number, from: string, to: string): string =>
    `{'pageNum':'${pageNumber}','categoryId':'','dateFrom':'${slashed(from)}','dateTo':'${slashed(to)}'}`,
};
const REQUESTS = {
  page: "/online/directorship/RequestsAndApprovals/",
  service: "/WsRequestsAndApprovalsAPI.asmx/GetGridViewAjax",
  types: "/GetApplicationTypeManagementResponse",
  body: (pageNumber: number): string => `{'pageNum' : '${pageNumber}'}`,
};
const AJAX = "/online/Ajax";

/** The medications header in Maccabi's wording, and the first purchase test/fake/legacy.mjs lists. */
const COLUMNS = ["רכישה", "תרופה/מוצר", "רופא/מטפל", "יחידות", "בית המרקחת", "מחיר", "מחיר לחברי מכבי"];
const FIRST_PURCHASE = ["01/10/2026", "תרופה בדוי 10 מג", 'ד"ר בדוי', "30", "בית מרקחת בדוי", "12.50 ₪", "9.90 ₪"];

const typed = (type: string) => ({ "content-type": type });
const tr = (tag: "td" | "th", cells: string[]): string =>
  `<tr>${cells.map((cell) => `<${tag}>${cell}</${tag}>`).join("")}</tr>`;

/** A script service's answer as it is on the wire: the `d` envelope in windows-1255 bytes, labelled so. */
function scriptAnswer(match: string, d: unknown, change: Partial<Route> = {}): Route {
  const bytes: Buffer = windows1255(JSON.stringify({ d }));
  const headers = typed("application/json; charset=windows-1255");
  return { match, headers, base64: bytes.toString("base64"), ...change };
}

/** A legacy page of `member`: the collapsed header menu names the patient the page was rendered for. */
function pageFor(match: string, member: number): Route {
  const id = "ctl00_ctl00_wcSiteHeaderLobby1_wcSiteHeaderCurrentPatient_wcSiteHeaderChildrenList_lblCustomerIDNumber";
  const patient = `<span id="${id}">${member}</span>`;
  const text = `<html><header><div style="display:none">${patient}</div></header></html>`;
  return { match, text, headers: typed("text/html; charset=utf-8") };
}

/** The way the grids write a hidden input's id and value. */
const idAndValue = (id: string, value: string | number): string => `id="${id}" value="${value}"`;
const withPageCount = (grid: string, pages: number): string =>
  grid.replace(idAndValue("hdnTotalPages", 1), idAndValue("hdnTotalPages", pages));

/** Bodies of the requests to paths ending in `tail`, oldest first, whether or not a test changed the answer. */
const sentTo = (tail: string): unknown[] =>
  box.fetches().flatMap((request) => (new URL(request.url).pathname.endsWith(tail) ? [request.body] : []));

/** A page is opened the way the website navigates to it: in a fresh navigation session. */
const openedAfresh = (page: string): void => expect(session.query(page)).toMatchObject({ relative: "-1" });

/** Bad input: refused for each of `inputs`, with `page` never opened. */
async function refusedUnopened(operation: string, page: string, inputs: Record<string, unknown>[]): Promise<void> {
  const opened = session.count(page);
  for (const input of inputs) await fails(operation, input, [], "BAD_INPUT");
  expect(session.count(page)).toBe(opened);
}

beforeAll(session.start);

describe("medications bought", () => {
  const read = "pharmacy-purchases";
  const { page, service, body } = MEDICATIONS;
  const grid: string = purchasedDrugs(1);
  const elsewhere = (url: string): Route => scriptAnswer(service, grid, { url });
  const changed = (from: string | RegExp, to: string): Route => scriptAnswer(service, grid.replace(from, to));

  it("names the cells of a row in English and keeps Hebrew and ₪ whole, asking as the page itself does", async () => {
    const result = await ok(read);
    const { data, source } = result;
    // Bytes decoded under the wrong charset would surface as the replacement character.
    carriesNone(result, [/�/]);
    expect(data.columns).toEqual(COLUMNS);
    const [purchase_date, drug, provider, units, pharmacy, price, member_price] = FIRST_PURCHASE;
    const [newest, older] = data.rows;
    expect(newest).toEqual({
      cells: FIRST_PURCHASE,
      purchase_date,
      drug,
      provider,
      units,
      pharmacy,
      price,
      member_price,
    });
    expect(older).toMatchObject({ member_price: "40.00 ₪", provider: "" });
    expect(data.pagination).toEqual({ totalPages: 2, page: 1 });
    expect(source).toMatchObject({ operation: "pharmacy-purchases", service: "LegacyMedicalFile" });
    // The service takes the page's own single-quoted body, and goes without the API authorization.
    openedAfresh(page);
    const posted = session.last(service);
    expect([posted.method, posted.authorization, posted.body]).toEqual(["POST", "", "{'pageNum':'1'}"]);
  });

  it("reads exactly the upstream page it is asked for", async () => {
    const { rows, pagination } = (await ok(read, { page: 2 })).data;
    expect(sentTo(service).at(-1)).toBe(body(2));
    expect(pagination).toEqual({ totalPages: 2, page: 2 });
    expect(rows).toMatchObject([{ drug: "תרופה שנייה" }]);
  });

  it("returns no rows for a page that has none", async () => {
    const { data } = await ok(read, {}, [scriptAnswer(service, purchasedDrugs(1, [], 0))]);
    expect(data).toMatchObject({ pagination: { totalPages: 0, page: 1 }, rows: [] });
  });

  it("reads a header whose cells are td rather than th", async () => {
    const plainHeader = grid.replaceAll(/<(\/?)th\b/g, "<$1td");
    const { data } = await ok(read, {}, [scriptAnswer(service, plainHeader)]);
    expect(data.rows).toHaveLength(2);
  });

  it("takes the page asked for as the page read when the grid's page-number field has no value", async () => {
    const valueless = purchasedDrugs(2).replace(idAndValue("hdnPageNum", 2), 'id="hdnPageNum"');
    const { data } = await ok(read, { page: 2 }, [scriptAnswer(service, valueless)]);
    expect(data.pagination).toEqual({ totalPages: 2, page: 2 });
  });

  it("opens nothing for a page number out of range, or for an argument that belongs to another read", async () => {
    await refusedUnopened(read, page, [{ page: 1001 }, { page: 0 }, { status: "valid" }]);
  });

  it("does not call the service once the page turns out to be another member's", async () => {
    const called = session.count(service);
    await fails(read, {}, [pageFor(page, SOMEONE_ELSE)], "NOT_THE_MEMBERS", "names-another-member");
    expect(session.count(service)).toBe(called);
  });

  it.each<[string, Route, string]>([
    [
      "comes from another method of the service",
      elsewhere(`https://online.maccabi4u.co.il${AJAX}/DrugsManager/WsPurchasedDrugsManager.asmx/Other`),
      "wrong-route-or-type",
    ],
    [
      "comes from another host",
      elsewhere(`https://example.invalid${AJAX}/DrugsManager${service}`),
      "wrong-route-or-type",
    ],
    [
      "is labelled HTML",
      scriptAnswer(service, grid, { headers: typed("text/html; charset=windows-1255") }),
      "wrong-route-or-type",
    ],
    [
      "is not JSON",
      { match: service, headers: typed("application/json"), text: "{d: never closed" },
      "body-unparsable",
    ],
    ["holds a second key beside d", answerWith(service, { d: grid, also: true }), "key:d"],
    ["holds a d that is not text", answerWith(service, { d: 404 }), "key:d"],
    ["words a column differently", changed(COLUMNS[6] as string, "מחיר מבצע"), "shape-changed"],
    ["is one cell short", changed(`<td class="text-center">${FIRST_PURCHASE[6]}</td>`, ""), "shape-changed"],
    ["says it is another page", changed(idAndValue("hdnPageNum", 1), idAndValue("hdnPageNum", 2)), "shape-changed"],
    // As in a browser, a checkbox without a value reads "on", which is no page number.
    [
      "keeps its page number in a checkbox",
      changed(`type="hidden" ${idAndValue("hdnPageNum", 1)}`, 'type="checkbox" id="hdnPageNum"'),
      "shape-changed",
    ],
    ["has no page count", changed(`<input type="hidden" ${idAndValue("hdnTotalPages", 2)}>`, ""), "shape-changed"],
    ["lists its rows under another class", changed('<ul class="appList">', '<ul class="rowList">'), "shape-changed"],
    ["is empty", scriptAnswer(service, ""), "shape-changed"],
  ])("fails closed on an answer that %s", async (_how, route, detail) => {
    await fails(read, {}, [route], "UNEXPECTED_ANSWER", detail);
  });

  it("reports a failing service as an upstream error, and a logout page as a session that ended", async () => {
    await fails(read, {}, [{ match: service, text: "", status: 500 }], "PORTAL_HTTP_ERROR");
    await session.expired(read, {}, [elsewhere(LOGOUT_PAGE)]);
  });
});

describe("documents saved", () => {
  const read = "saved-documents";
  const { page, service, body } = DOCUMENTS;

  it("lists nothing for an empty grid, over the year up to today that the website defaults to", async () => {
    const { data } = await ok(read);
    const now = new Date();
    const [year, month, day] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
    const monthAndDay = [month, day].map((part) => `${part}`.padStart(2, "0")).join("-");
    const to = `${year}-${monthAndDay}`;
    // 29 February has no day a year earlier; the website counts back to the 28th.
    const from = `${year - 1}-${monthAndDay === "02-29" ? "02-28" : monthAndDay}`;
    expect(data).toEqual({
      text: "לא נמצאו קבצים",
      pagination: { totalPages: 0, page: 1 },
      rows: [],
      columns: [],
      range: { to, from },
    });
    expect(sentTo(service).at(-1)).toBe(body(1, from, to));
    openedAfresh(page);
  });

  it("sends a range it is given as DD/MM/YYYY", async () => {
    const range = { to: "2026-10-31", from: "2001-01-01" };
    expect((await ok(read, range)).data.range).toEqual(range);
    expect(sentTo(service).at(-1)).toBe(
      "{'pageNum':'1','categoryId':'','dateFrom':'01/01/2001','dateTo':'31/10/2026'}",
    );
  });

  it("returns a filled grid as its labels and the text of its cells, without link targets or hidden text", async () => {
    const title = '<a onclick="Show(83)" href="/online/private?file=83">מסמך מדומה</a>';
    const uploaded = "01/04/2026<i hidden>MOCKPRIVATE</i>";
    const head = tr("th", ["הועלה", "כותרת"]);
    const table = `<table><thead>${head}</thead><tbody>${tr("td", [uploaded, title])}</tbody></table>`;
    const filled = scriptAnswer(service, withPageCount(savedDocuments(2, table), 3));
    const result = await ok(read, { page: 2, to: "2026-09-30", from: "2026-04-01" }, [filled]);
    carriesNone(result, [/online\/private|Show\(83\)/]);
    expect(result.data).toMatchObject({
      pagination: { totalPages: 3, page: 2 },
      rows: [
        {
          fields: { כותרת: "מסמך מדומה", הועלה: "01/04/2026" },
          cells: ["01/04/2026", "מסמך מדומה"],
        },
      ],
      columns: ["הועלה", "כותרת"],
    });
    expect(sentTo(service).at(-1)).toBe(body(2, "2026-04-01", "2026-09-30"));
  });

  it("opens nothing for one end of a range, a range that runs backwards or a day no month has", async () => {
    await refusedUnopened(read, page, [
      { to: "2026-06-30" },
      { from: "2026-08-15", to: "2026-08-14" },
      { from: "2026-04-31", to: "2026-05-02" },
    ]);
  });

  it("refuses a page that is another member's", async () => {
    await fails(read, {}, [pageFor(page, SOMEONE_ELSE)], "NOT_THE_MEMBERS");
  });

  const oneCell = `<table>${tr("td", ["cell"])}</table>`;
  it.each<[string, string]>([
    ["states its page count twice", `${savedDocuments(1)}<input type="hidden" ${idAndValue("hdnTotalPages", 1)}>`],
    ["nests a table in a cell", savedDocuments(1, `<table>${tr("td", [oneCell])}</table>`)],
    ["has rows and a page count of zero", withPageCount(savedDocuments(1, oneCell), 0)],
  ])("fails closed on a grid that %s", async (_how, grid) => {
    await fails(read, {}, [scriptAnswer(service, grid)], "UNEXPECTED_ANSWER", "shape-changed");
  });
});

describe("requests and approvals", () => {
  const read = "requests-and-approvals";
  const { page, service, types, body } = REQUESTS;

  // An empty grid as Maccabi sends it: headerless, with a no-messages label, page 0 of -1 pages.
  it("keeps the message of an empty grid, and puts the application-type value next to it", async () => {
    const { data, source } = await ok(read);
    expect(data).toEqual({
      applicationTypeManagement: null,
      text: "אין בקשות להצגה",
      pagination: { totalPages: 0, page: 1 },
      rows: [],
      columns: [],
    });
    expect(source).toMatchObject({ operation: "requests-and-approvals", service: "LegacyRequestsAndApprovals" });
    openedAfresh(page);
    expect(sentTo(service).at(-1)).toBe(body(1));
    // The application types are asked for by an empty POST.
    expect([session.last(types).method, sentTo(types).at(-1)]).toEqual(["POST", ""]);
  });

  it("reads a filled later page, with an application-type answer that is JSON parsed", async () => {
    const row = ["התחייבות", "01/07/2026", "אושרה"];
    const kinds = { kinds: [{ title: "התחייבות", id: 4 }] };
    const routes = [
      scriptAnswer(types, JSON.stringify(kinds)),
      scriptAnswer(service, withPageCount(requestsGrid(2, tr("td", row)), 2)),
    ];
    const { data } = await ok(read, { page: 2 }, routes);
    expect(Object.keys(data)).not.toContain("text");
    expect(data).toMatchObject({
      applicationTypeManagement: kinds,
      pagination: { totalPages: 2, page: 2 },
      rows: [{ fields: { סטטוס: row[2], תאריך: row[1], "סוג הבקשה": row[0] }, cells: row }],
    });
    expect(sentTo(service).at(-1)).toBe("{'pageNum' : '2'}");
  });

  it("returns an application-type value that is not JSON as the text it is", async () => {
    const { data } = await ok(read, {}, [scriptAnswer(types, "just words")]);
    expect(data.applicationTypeManagement).toBe("just words");
  });

  it("refuses an application-type value above 128 KiB", async () => {
    const tooLong = scriptAnswer(types, "t".repeat(128 * 1024 + 1));
    await fails(read, {}, [tooLong], "UNEXPECTED_ANSWER", "oversized");
  });

  it("does not read the grid once the page turns out to be another member's", async () => {
    const called = session.count(service);
    await fails(read, {}, [pageFor(page, SOMEONE_ELSE)], "NOT_THE_MEMBERS");
    expect(session.count(service)).toBe(called);
  });

  it("refuses application types that name another member", async () => {
    const theirs = scriptAnswer(types, JSON.stringify({ member_id: SOMEONE_ELSE }));
    await fails(read, {}, [theirs], "NOT_THE_MEMBERS", "names-another-member");
  });

  it("fails closed on a grid whose page number is no number", async () => {
    const lettered = requestsGrid(1).replace(idAndValue("hdnPageNumber", 0), idAndValue("hdnPageNumber", "two"));
    await fails(read, {}, [scriptAnswer(service, lettered)], "UNEXPECTED_ANSWER", "shape-changed");
  });
});

describe("the biobank's public statistics", () => {
  it("come back as sent, from a path that carries no member", async () => {
    const { data } = await ok("portal", { endpoint: "biobank-stats" });
    expect(data).toEqual({ updated_on: "2001-01-01T00:00:00", total_enrolled: 10000 });
    const asked = new URL(session.last("/biobank/stats").url);
    expect(asked.pathname).toBe("/sonline/DirectorshipAPI/webapi/mac/v1/biobank/stats");
  });
});

it("left no trace of an auditing call, a write or a request the fake does not serve", () => {
  expect(box.unexpected()).toEqual([]);
  const writing = /\/messages\b|setDocumentRead|save|upload|Auditing/i;
  expect(box.fetches().filter((request) => writing.test(request.url))).toEqual([]);
});
