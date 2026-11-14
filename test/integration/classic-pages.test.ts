/**
 * The reads that still depend on Maccabi's classic website, run over MCP against test/fake/legacy.mjs:
 * medical-summary, health-recommendations (where the page is only a fallback), notification-settings, the
 * quarterly billing and yearly nursing-insurance reports with their PDFs, and hospital mailings with
 * theirs.
 *
 * A classic page is HTML rendered for whoever the portal believes is signed in. So before any content
 * counts, a read has to get the page by the right road (a navigation the session vouches for, with no
 * API token), find the member's own ID in the page header, and decode the bytes as what they are
 * declared to be. The first block checks that once, on the summary. Every later block is about one
 * page's own content and about the answers it must not accept: someone else's page, an answer from
 * another address, markup that is no longer the captured one, a logout page.
 *
 * What a PDF download itself refuses is covered for all documents together in medical-file.test.ts. The
 * pages here are written with the fake's markup helpers and hold nothing real.
 */
import { beforeAll, describe, expect, test } from "vitest";
// @ts-expect-error the fake is plain ESM and has no declarations
import { appList, each, el, gridCounts, PRIVATE, page, windows1255 } from "../fake/legacy.mjs";
import {
  answerWith,
  bootstrap,
  carriesNone,
  LOGOUT_PAGE,
  MEMBER,
  memberSession,
  type Route,
  SOMEONE_ELSE,
} from "../rig";

/** `PRIVATE` marks what the pages hold and no result may: every result is searched for it. */
const site = memberSession("legacy-pages", [PRIVATE]);
const { box } = site;

const ONLINE = "https://online.maccabi4u.co.il/online";
const ELSEWHERE = "https://example.invalid/elsewhere";
/** A visibly made-up, well-formed ID belonging to neither of the fake's two members. */
const A_STRANGER = 999999999;
const SHA256 = /^[0-9a-f]{64}$/;
const NEVER_LISTED = "e".repeat(64);
const MIB = 1024 * 1024;
/** How a read reports an answer that came from the wrong address or in the wrong content type. */
const MISROUTED = "wrong-route-or-type";

const UTF8_PAGE = { "content-type": "text/html; charset=utf-8" };
const HEBREW_PAGE = { "content-type": "text/html; charset=windows-1255" };
const JSON_BODY = { "content-type": "application/json" };

type Arguments = Record<string, unknown>;
/** One refusal: the changed answers, the error code they must produce, and its detail when that matters. */
type Refusal = [what: string, routes: Route[], code: string, detail?: string];

/** `markup` as the answer at `match`: a UTF-8 page, unless `more` changes that. */
const serving = (match: string, markup: string, more: Partial<Route> = {}): Route => ({
  match,
  headers: UTF8_PAGE,
  text: markup,
  ...more,
});
const unparsable = (match: string): Route => ({ match, headers: JSON_BODY, text: "{ nearly: json" });
const failing = (match: string, status = 500): Route => ({ match, status, text: "" });
const inWindows1255 = (text: string): string => windows1255(text).toString("base64");
/** The verdict on markup or JSON that is not what was captured from the live site. */
const changed = (operation: string, given: Arguments, routes: Route[]) =>
  site.fails(operation, given, routes, "UNEXPECTED_ANSWER", "shape-changed");
/** The text of the PDF an operation returns. */
const pdf = async (operation: string, given: Arguments, routes: Route[] = []): Promise<string> =>
  (await site.file(operation, given, routes)).toString("latin1");

beforeAll(site.start);

describe("any classic page: how it is fetched, decoded and tied to the member", () => {
  const SUMMARY = "/online/medicalfile/summary/";
  const GREETING = "ברוכים הבאים";

  /** A summary whose cells are numbered, so a result shows which cell ended up where. */
  function summaryPage(member: number | string = MEMBER, description = "A description in English"): string {
    const numbered = (width: number, word: string) => Array.from({ length: width }, (_, at) => `${word} ${at}`);
    const table = (width: number) => appList(numbered(width, "Heading"), [numbered(width, "Cell")]);
    const dispensed = [el("h3", "Dispensed"), el("div.summeryInnerTitle", el("p", "lately")), table(2)];
    const measured = [el("h3", "Measured"), el("div.summeryInnerTitle", el("div.table-cell", "lately")), table(4)];
    const sections = [
      el("div.medicalFileDesc", description),
      el("div#drugs", dispensed),
      el("div#labResults", measured),
    ];
    return page(member, el("div#summery", sections));
  }
  const summary = (markup: string, more?: Partial<Route>): Route => serving(SUMMARY, markup, more);
  const hebrewBytes: Route = {
    match: SUMMARY,
    headers: HEBREW_PAGE,
    base64: inWindows1255(summaryPage(MEMBER, GREETING)),
  };

  test("the page is asked for without the API token, through a navigation the session vouches for", async () => {
    const { data } = await site.ok("medical-summary", {}, [summary(summaryPage())]);
    expect(data.laboratory.table.rows).toEqual([["Cell 0", "Cell 1", "Cell 2", "Cell 3"]]);

    const request = site.last(SUMMARY);
    expect(request.authorization).toBe("");
    const { pathname, searchParams } = new URL(request.url);
    expect(pathname).toBe(SUMMARY);
    expect(searchParams.get("sr_id")).toBeTruthy();
    expect(searchParams.get("relative")).toBe("-1");
  });

  test("a link contributes its text and never its address, and a line break counts as a space", async () => {
    const { data } = await site.ok("medical-summary");
    expect(data.description).toBe("דף זה מציג נתונים מומצאים. אין בו מידע אמיתי.");
    expect(data.medications.table.rows).toEqual([["כמוסות פלוני 20", "14/05/2026"]]);
  });

  test("Hebrew sent as windows-1255 comes out as Hebrew", async () => {
    const result = await site.ok("medical-summary", {}, [hebrewBytes]);
    expect(result.data.description).toBe(GREETING);
    // U+FFFD is what a decoder leaves where it could not read a byte.
    carriesNone(result, ["�"]);
  });

  test.each(["utf-8", "utf-16", "utf-8; charset=windows-1255"])(
    "the same bytes declared as charset=%s are refused, not decoded on a guess",
    async (charset) => {
      const mislabelled = { ...hebrewBytes, headers: { "content-type": `text/html; charset=${charset}` } };
      await site.fails("medical-summary", {}, [mislabelled], "UNEXPECTED_ANSWER", "page-charset");
    },
  );

  test("one byte more than 1 MiB is too much page", async () => {
    const huge: Route = { match: SUMMARY, headers: HEBREW_PAGE, base64: "", pad: MIB + 1 };
    await site.fails("medical-summary", {}, [huge], "UNEXPECTED_ANSWER", "body-unreadable");
  });

  test("the limit also holds for a page that is under it on the wire and over it once decoded", async () => {
    // A Hebrew letter is one byte in windows-1255 and two in the text the parser gets.
    const swelling = { ...hebrewBytes, base64: inWindows1255(summaryPage(MEMBER, "ת".repeat(600 * 1024))) };
    await changed("medical-summary", {}, [swelling]);
  });

  test("a page rendered for somebody else is reported as theirs", async () => {
    const theirs = summary(summaryPage(A_STRANGER));
    await site.fails("medical-summary", {}, [theirs], "NOT_THE_MEMBERS", "names-another-member");
  });

  test.each([
    ["with the patient's ID outside the site header", summaryPage().replaceAll("header>", "aside>")],
    ["with an ID that is not a number", summaryPage("12a")],
    ["naming its patient twice", summaryPage() + summaryPage()],
  ])("a page %s says nothing reliable about whose it is", async (_how, markup) => {
    await changed("medical-summary", {}, [summary(markup)]);
  });

  test.each<Refusal>([
    [
      "from another address",
      [summary(summaryPage(), { url: `${ONLINE}/medicalfile/else/` })],
      "UNEXPECTED_ANSWER",
      MISROUTED,
    ],
    ["typed as JSON", [summary(summaryPage(), { headers: JSON_BODY })], "UNEXPECTED_ANSWER", MISROUTED],
    ["with status 502", [summary("Bad gateway", { status: 502 })], "PORTAL_HTTP_ERROR", "status=502"],
  ])("an answer %s is told apart from a changed page", async (_how, routes, code, detail) => {
    await site.fails("medical-summary", {}, routes, code, detail);
  });

  test.each([
    ["one of its two sections", summaryPage().replace('id="drugs"', 'id="pills"')],
    ["its rows", summaryPage().replaceAll(/<tbody>.*?<\/tbody>/g, "")],
    ["a cell of a row", summaryPage().replace("<td>Cell 1</td>", "")],
  ])("a summary missing %s is a changed page", async (_what, markup) => {
    await changed("medical-summary", {}, [summary(markup)]);
  });

  test("an account whose bootstrap carries no navigation session cannot reach the classic site", async () => {
    const unable = bootstrap({ session_id: null });
    await site.fails("medical-summary", {}, [unable], "NOT_OFFERED", "classic-navigation-missing");
  });

  test.each([
    ["the sign-in page", summary("<script>window.originJWT = 'a-login-token';</script>")],
    ["the logout page", summary(summaryPage(), { url: LOGOUT_PAGE })],
  ])("%s in the page's place means the session has ended", async (_which, route) => {
    await site.expired("medical-summary", {}, [route]);
  });
});

describe("recommendations", () => {
  const SERVICE = "/personal_recommendations";
  const PAGE = "/online/medicalfile/personalrecommendations/";
  const serviceDown = failing(SERVICE);

  /** The classic page with a single recommendation, whose wording cell is `cell`. */
  function classicPage(cell: string): Route {
    const subject = [el("a", "Topic"), el("div.medicalReSubjectInner", appList(["Who", "What"], [["Everyone", cell]]))];
    const details = [
      el("div.medicalReInfo", "Preamble"),
      el("div.medicalReSubject", subject),
      el("div.commentBlock", "Postscript"),
      el("div.termsOfUse", PRIVATE),
    ];
    const title = el("div.recommendationsTitle", el("h2", "Heading"));
    return serving(PAGE, page(MEMBER, title, el("div.personal-recommendations-details", details)));
  }

  test("come from the JSON service when it answers; its null list means there are none", async () => {
    const { data } = await site.ok("health-recommendations");
    expect(data).toEqual({ recommendations: [] });
  });

  test("keep the rows of the service, and any field beside them, exactly as sent", async () => {
    const answer = { more: { than: "expected" }, recommendations: [{ title: "מעקב", recommendation_id: 31 }] };
    const { data } = await site.ok("health-recommendations", {}, [answerWith(SERVICE, answer)]);
    expect(data).toEqual(answer);
  });

  test.each([
    ["fails", serviceDown],
    ["answers in a shape of its own", answerWith(SERVICE, { advice: [] })],
  ])("fall back to the classic page when the service %s", async (_how, service) => {
    const { data } = await site.ok("health-recommendations", {}, [service]);
    expect(site.last(PAGE).url).toContain(`${PAGE}?relative=-1`);
    expect(data).toMatchObject({ closingNote: "הערת סיום מומצאת", introduction: "רקע & הסתייגויות" });
    const [section] = data.sections;
    expect(section.table).toEqual({ rows: [["", "מינון יומי מומצא: ≥ 40 μg."]], columns: ["גילאים", "מה מומלץ"] });
  });

  test("a service row about another member is an ownership error, which the fallback does not paper over", async () => {
    const theirs = answerWith(SERVICE, { recommendations: [{ member_id: SOMEONE_ELSE }] });
    await site.fails("health-recommendations", {}, [theirs], "NOT_THE_MEMBERS");
  });

  test("a cell keeps only what somebody looking at the page would see", async () => {
    const invisible = [
      `<!-- ${PRIVATE} -->`,
      el("script", PRIVATE),
      el("textarea", PRIVATE),
      el("span", { hidden: true }, PRIVATE),
      el("span", { "aria-hidden": "true" }, PRIVATE),
      el("span.Hidden", PRIVATE),
      el("span", { style: "display: none !important" }, PRIVATE),
    ];
    const { data } = await site.ok("health-recommendations", {}, [
      serviceDown,
      classicPage(`Shown${invisible.join("")}`),
    ]);
    expect(data.sections[0].table.rows).toEqual([["Everyone", "Shown"]]);
  });

  test.each([
    ["holds no recommendations", serving(PAGE, page(MEMBER, "Please sign in"))],
    ["has a cell of 128 KiB", classicPage("w".repeat(128 * 1024))],
  ])("a fallback page that %s is a changed page", async (_how, fallback) => {
    await changed("health-recommendations", {}, [serviceDown, fallback]);
  });
});

describe("notification settings", () => {
  const PAGE = "/online/directorship/personalreminders/";
  const SETTINGS_API = "/PersonalRemindersESB/GetReminders/";
  const group = {
    Order: 3,
    RestrictionCode: null,
    RestrictionDesc: "none",
    CanRegister: true,
    IsRegistered: false,
    Description: "about",
    Name: "group",
    Code: 5,
    Services: [],
  };
  /** A complete answer around `groups`. */
  const settings = (groups: unknown = []) => ({
    ServiceGroups: groups,
    ContactDetails: { Email: "mail", CellPhone: "phone" },
    PreferredLangCode: 2,
    StatusCode: 0,
    ResultMessage: { Code: 0 },
  });
  const answering = (body: unknown, more?: Partial<Route>): Route => answerWith(SETTINGS_API, body, more);

  test("are read with two GETs and come back without the device tokens stored beside them", async () => {
    const { data } = await site.ok("notification-settings");
    expect(data.contact.email).toBe("reminders@example.invalid");
    const [service] = data.groups[0].services;
    expect(service).toMatchObject({ canRegister: false, registered: true, typeCode: null, selectedChannelCode: -1 });
    expect(service.channels).toMatchObject([{ registered: true, description: null, code: 2 }]);

    expect(site.last(PAGE).method).toBe("GET");
    expect(site.last(SETTINGS_API).method).toBe("GET");
    expect(new URL(site.last(SETTINGS_API).url).search).toBe("");
  });

  test("somebody else's settings page ends the read before the settings are asked for", async () => {
    const asked = site.count(SETTINGS_API);
    await site.fails("notification-settings", {}, [serving(PAGE, page(A_STRANGER))], "NOT_THE_MEMBERS");
    expect(site.count(SETTINGS_API)).toBe(asked);
  });

  test.each<Refusal>([
    [
      "reports an error of its own",
      [answering({ ...settings(), ResultMessage: { Code: 4 } })],
      "PORTAL_REPORTED_ERROR",
    ],
    [
      "gives its result code as text",
      [answering({ ...settings(), ResultMessage: { Code: "0" } })],
      "UNEXPECTED_ANSWER",
      "key:Code",
    ],
    ["names another member", [answering({ ...settings(), member_id: SOMEONE_ELSE })], "NOT_THE_MEMBERS"],
    ["is down", [failing(SETTINGS_API)], "PORTAL_HTTP_ERROR", "status=500"],
    ["answers from another host", [answering(settings(), { url: ELSEWHERE })], "UNEXPECTED_ANSWER", MISROUTED],
    [
      "answers with a query added",
      [answering(settings(), { url: `${ONLINE}/webapi${SETTINGS_API}?page=2` })],
      "UNEXPECTED_ANSWER",
      MISROUTED,
    ],
  ])("a service that %s has an error to match", async (_how, routes, code, detail) => {
    await site.fails("notification-settings", {}, routes, code, detail);
  });

  test.each([
    ["a body that is not JSON", unparsable(SETTINGS_API)],
    ["two groups under one code", answering(settings([group, group]))],
    ["a flag sent as text", answering(settings([{ ...group, IsRegistered: "false" }]))],
    ["an object where the groups should be listed", answering(settings({}))],
    ["the settings wrapped in an envelope", answering({ ResultMessage: { Code: 0 }, Data: settings() })],
  ])("%s is a changed answer", async (_what, route) => {
    await changed("notification-settings", {}, [route]);
  });

  test("the logout page in the service's place means the session has ended", async () => {
    await site.expired("notification-settings", {}, [answering(settings(), { url: LOGOUT_PAGE })]);
  });
});

describe("billing", () => {
  const PAGE = "/online/directorship/debitsandcredits/";
  const QUARTERLY = "/GetQuarterlyReport";
  const NURSING = "/GetLTCReport";
  const ARCHIVE = "/GetDocFromArchive";
  const POPUP = "/DebitsAndCreditsPdfReport.aspx";
  const FILE_NAME = "FileName=DebitsAndCreditsReportInformation";
  /** The year the fake's picker has selected. */
  const YEAR = "2025";
  const archiveAgrees = answerWith(ARCHIVE, { d: true });
  const headings = el("ul.headinggroup", el("li.headinggroup", each("span", ["Period", "Made on", "Report"])));

  /** The billing page with these `<option>`s in its period picker. */
  function billingPage(...options: string[]): Route {
    const flag = el("input", { id: "isUnderConstruction", value: "0" });
    const picker = el("select#PeriodSelectDropDownList", options);
    return serving(PAGE, page(MEMBER, el("script", "jqe.appRoot='/online';"), flag, picker));
  }

  describe("the period picker", () => {
    test("offers the page's options in the page's order, the selected one as the default", async () => {
      const first = { label: "Earlier", value: "8" };
      const second = { label: "Later", value: "0" };
      const options = [el("option", { value: "8" }, "Earlier"), el("option", { value: "0", selected: true }, "Later")];
      const { data } = await site.ok("quarterly-statements", {}, [billingPage(...options)]);
      expect(data.availablePeriods).toEqual([first, second]);
      expect(data.selectedPeriod).toEqual(second);
    });

    test("takes an option's text for its value when it has no value attribute, as a browser would", async () => {
      const { data } = await site.ok("quarterly-statements", {}, [billingPage(el("option", "2019"))]);
      const only = { label: "2019", value: "2019" };
      expect(data.availablePeriods).toEqual([only]);
      expect(data.selectedPeriod).toEqual(only);
    });

    test("with one value under two labels is a changed page", async () => {
      const options = [el("option", { value: "4" }, "One"), el("option", { value: "4" }, "Other")];
      await changed("quarterly-statements", {}, [billingPage(...options)]);
    });

    test("on somebody else's page serves neither catalog", async () => {
      const theirs = serving(PAGE, page(A_STRANGER));
      await site.fails("quarterly-statements", {}, [theirs], "NOT_THE_MEMBERS");
      await site.fails("nursing-statements", {}, [theirs], "NOT_THE_MEMBERS");
    });
  });

  describe("quarterly reports", () => {
    const TYPE = "test-statement";
    const listedRow = { period: "תקופת ניסוי", productionDate: "not parsed as a date", viewLabel: "לצפייה" };

    /** A catalog row whose link opens the PDF with `token`. */
    function quarterRow(
      token = "first%2Btoken+as-sent",
      { opener = "QuarterlyReport.OpenReportPdf", type = TYPE } = {},
    ) {
      const onclick = `${opener}(&#39;${token}&#39;,&#39;${type}&#39;)`;
      const view = el("a", { class: "reportFound", onclick }, listedRow.viewLabel);
      return el("li", each("span", [listedRow.period, listedRow.productionDate, view]));
    }
    /** The fragment the service wraps: the table of `rows`, then a count that claims `total` of them. */
    function fragment(rows = quarterRow(), total = 1): string {
      const table = el("div.maintable", headings, el("ul.rowgroup", rows));
      return el("div.dataGrid", el("div.quaterly_table", table)) + gridCounts(total, 1);
    }
    /** The catalog as the live service sends it: the JSON envelope itself in windows-1255. */
    const catalog = (rows?: string, total?: number): Route => ({
      match: QUARTERLY,
      headers: { "content-type": "application/json; charset=windows-1255" },
      base64: inWindows1255(JSON.stringify({ d: fragment(rows, total) })),
    });
    const wrapped = (d: unknown, more?: Partial<Route>): Route => answerWith(QUARTERLY, { d }, more);
    const besideNoResult = el("div.dataGrid", el("div.no_result", "nothing"), el("div.notice", "and yet"));

    test("a report is its three visible cells and a reference, with nothing of what opens its PDF", async () => {
      const { data } = await site.ok("quarterly-statements", { period: YEAR }, [catalog()]);
      expect(data.reports).toEqual([{ ...listedRow, reference: expect.stringMatching(SHA256) }]);
    });

    test("a period answered with the no-result box holds no reports", async () => {
      const { data } = await site.ok("quarterly-statements", { period: "2001" });
      expect(data.pagination).toEqual({ currentPage: 1, totalPages: 0, reportedResultCount: 0, returned: 0 });
      expect(data.reports).toEqual([]);
    });

    test.each<Refusal>([
      ["a flag where the markup belongs", [wrapped(true)], "UNEXPECTED_ANSWER", "key:d"],
      [
        "a second key beside the markup",
        [answerWith(QUARTERLY, { d: fragment(), token: "t" })],
        "UNEXPECTED_ANSWER",
        "key:d",
      ],
      ["an answer from another address", [wrapped(fragment(), { url: ELSEWHERE })], "UNEXPECTED_ANSWER", MISROUTED],
      ["a body that is not JSON", [unparsable(QUARTERLY)], "UNEXPECTED_ANSWER", "body-unparsable"],
      ["a count of one over no rows", [wrapped(fragment("", 1))], "UNEXPECTED_ANSWER", "shape-changed"],
      ["a count of none over one row", [wrapped(fragment(quarterRow(), 0))], "UNEXPECTED_ANSWER", "shape-changed"],
      ["a no-result box with company", [wrapped(besideNoResult)], "UNEXPECTED_ANSWER", "shape-changed"],
      ["a failing service", [failing(QUARTERLY)], "PORTAL_HTTP_ERROR"],
    ])("no catalog is made of %s", async (_what, routes, code, detail) => {
      await site.fails("quarterly-statements", {}, routes, code, detail);
    });

    describe("as PDFs", () => {
      let listed: { reference: string; period: string };
      beforeAll(async () => {
        const [report] = (await site.ok("quarterly-statements", { period: YEAR }, [catalog()])).data.reports;
        listed = { period: YEAR, reference: report.reference };
      });

      test("the catalog is read again, so a token that changed since the listing still opens the PDF", async () => {
        const token = "second%2Btoken+as-sent";
        const document = await pdf("quarterly-statement-pdf", listed, [catalog(quarterRow(token)), archiveAgrees]);
        expect(document).toContain("billing-statement");
        // The token goes to the archive and into the popup's query exactly as the page wrote it.
        expect(site.last(ARCHIVE).body).toBe(`{'token':'${token}', 'reportType':'${TYPE}'}`);
        expect(site.last(POPUP).url).toContain(`${POPUP}?token=${token}&ReportType=${TYPE}&${FILE_NAME}`);
        expect(site.last(POPUP).authorization).toBe("");
      });

      test("a year the picker does not offer has no PDFs", async () => {
        await site.fails(
          "quarterly-statement-pdf",
          { ...listed, period: "1999" },
          [],
          "NOT_OFFERED",
          "period-unlisted",
        );
      });

      test.each<Refusal>([
        [
          "a row of another report type",
          [catalog(quarterRow(undefined, { type: "other-statement" }))],
          "NOT_THE_MEMBERS",
          "reference-unknown",
        ],
        [
          "the listed row twice over",
          [catalog(quarterRow() + quarterRow("a-different-token"), 2)],
          "UNEXPECTED_ANSWER",
        ],
        ["a token with a broken escape", [catalog(quarterRow("ends-in%2"))], "UNEXPECTED_ANSWER"],
        ["a token that would add a parameter", [catalog(quarterRow("token&extra"))], "UNEXPECTED_ANSWER"],
        [
          "a link with another handler",
          [catalog(quarterRow(undefined, { opener: "Reports.Open" }))],
          "UNEXPECTED_ANSWER",
        ],
        ["an archive that declines", [catalog(), answerWith(ARCHIVE, { d: false })], "PORTAL_REPORTED_ERROR"],
        ["an archive that agrees in text", [catalog(), answerWith(ARCHIVE, { d: "true" })], "UNEXPECTED_ANSWER"],
        [
          "an archive that says more than yes",
          [catalog(), answerWith(ARCHIVE, { d: true, also: 1 })],
          "UNEXPECTED_ANSWER",
        ],
        [
          "an archive answering under a longer address",
          [
            catalog(),
            {
              ...archiveAgrees,
              url: `${ONLINE}/Ajax/DebitsAndCredits/WcDebitsAndCreditsManager.asmx${ARCHIVE}?again=1`,
            },
          ],
          "UNEXPECTED_ANSWER",
          MISROUTED,
        ],
        ["an archive answer that is not JSON", [catalog(), unparsable(ARCHIVE)], "UNEXPECTED_ANSWER", "shape-changed"],
        ["a failing archive", [catalog(), failing(ARCHIVE)], "PORTAL_HTTP_ERROR"],
      ])("%s ends the read before the PDF is asked for", async (_what, routes, code, detail) => {
        const opened = site.count(POPUP);
        await site.fails("quarterly-statement-pdf", listed, routes, code, detail);
        expect(site.count(POPUP)).toBe(opened);
      });

      test("a reference the catalog never listed opens nothing", async () => {
        const opened = site.count(POPUP);
        const unlisted = { ...listed, reference: NEVER_LISTED };
        await site.fails("quarterly-statement-pdf", unlisted, [catalog()], "NOT_THE_MEMBERS", "reference-unknown");
        expect(site.count(POPUP)).toBe(opened);
      });
    });

    test("the logout page in the catalog's place means the session has ended", async () => {
      await site.expired("quarterly-statements", {}, [wrapped(fragment(), { url: LOGOUT_PAGE })]);
    });
  });

  describe("the yearly nursing-insurance report", () => {
    /** What the fake lists. A test changing the token keeps these, and with them the report's reference. */
    const ISSUED = "01/01/2025";
    const TYPE = "nursing-yearly";

    function nursingRow(period = "שנת 2024", token = "nursing-archive-key"): string {
      const view = el("a", { onclick: `LTCReport.OpenReportPdf('${token}', '${TYPE}');` }, "לצפייה");
      return el("li", each("span", [period, ISSUED, view]));
    }
    function fragment(rows = nursingRow(), total = 1, pages = 1): string {
      const table = el("div.maintable", headings, el("ul.rowgroup", rows));
      return (
        el("div.dataGrid", el("div.more_info showinfobox", el("div.yearly_table", table))) + gridCounts(total, pages)
      );
    }
    const wrapped = (d: unknown, more?: Partial<Route>): Route => answerWith(NURSING, { d }, more);

    test("is listed by a POST with an empty body", async () => {
      const { data } = await site.ok("nursing-statements");
      const report = { viewLabel: "לצפייה", productionDate: ISSUED, period: "שנת 2024" };
      expect(data.reports).toEqual([{ ...report, reference: expect.stringMatching(SHA256) }]);
      const bodies = box.log().filter((entry) => entry.kind === "classic-body" && String(entry.path).endsWith(NURSING));
      expect(bodies.at(-1)?.body).toBe("");
    });

    test("says how much a longer catalog holds beyond the one page returned", async () => {
      const { data } = await site.ok("nursing-statements", {}, [wrapped(fragment(nursingRow(), 7, 4))]);
      expect(data.pagination).toEqual({ currentPage: 1, totalPages: 4, reportedResultCount: 7, returned: 1 });
    });

    test("is an empty list when the catalog counts nothing", async () => {
      const { data } = await site.ok("nursing-statements", {}, [wrapped(fragment("", 0, 0))]);
      expect(data.reports).toEqual([]);
    });

    test("keeps in a cell only what somebody looking at the page would see", async () => {
      const invisible = el("script", PRIVATE) + el("input", { value: PRIVATE }) + el("span", { hidden: true }, PRIVATE);
      const period = `The year ${invisible}${el("em", " in question")}`;
      const { data } = await site.ok("nursing-statements", {}, [wrapped(fragment(nursingRow(period)))]);
      expect(data.reports[0].period).toBe("The year in question");
    });

    test.each([
      ["counts a report it does not list", fragment("", 1)],
      ["lists a report it does not count", fragment(nursingRow(), 0)],
      ["is hidden by a class", fragment().replace('class="dataGrid"', 'class="dataGrid Hidden"')],
      [
        "is hidden by its style",
        fragment().replace('class="dataGrid"', 'class="dataGrid" style="top:0;Display : none"'),
      ],
      ["has two headings", fragment().replace("<span>Made on</span>", "")],
      ["has a row of two cells", fragment().replace(`<span>${ISSUED}</span>`, "")],
      ["gives a count that is no number", fragment().replace('value="1"', 'value="some"')],
      ["opens its PDF through the quarterly handler", fragment().replace("LTCReport", "QuarterlyReport")],
      ["carries a token that would add a parameter", fragment(nursingRow(undefined, "token&extra"))],
      ["lists the same report twice", fragment(nursingRow() + nursingRow(), 2)],
    ])("a fragment that %s is a changed page", async (_how, markup) => {
      await changed("nursing-statements", {}, [wrapped(markup)]);
    });

    test.each<Refusal>([
      ["a body that is not JSON", [unparsable(NURSING)], "UNEXPECTED_ANSWER", "shape-changed"],
      ["a flag where the markup belongs", [wrapped(true)], "UNEXPECTED_ANSWER", "key:d"],
      [
        "a whole page where the fragment belongs",
        [wrapped(el("html", "Please sign in"))],
        "UNEXPECTED_ANSWER",
        "shape-changed",
      ],
      ["an answer from another address", [wrapped("", { url: ELSEWHERE })], "UNEXPECTED_ANSWER", MISROUTED],
      ["a service answering 503", [failing(NURSING, 503)], "PORTAL_HTTP_ERROR"],
    ])("no catalog is made of %s", async (_what, routes, code, detail) => {
      await site.fails("nursing-statements", {}, routes, code, detail);
    });

    test("the logout page in the catalog's place means the session has ended", async () => {
      await site.expired("nursing-statements", {}, [wrapped("", { url: LOGOUT_PAGE })]);
    });

    test("its PDF opens with the token of the moment, under the popup's capital-T Token", async () => {
      const [{ reference }] = (await site.ok("nursing-statements")).data.reports;
      const renewed = wrapped(fragment(nursingRow(undefined, "a-newer-nursing-key")));
      const document = await pdf("nursing-statement-pdf", { reference }, [renewed, archiveAgrees]);
      expect(document).toContain("billing-statement");
      expect(site.last(ARCHIVE).body).toBe(`{'token':'a-newer-nursing-key', 'reportType':'${TYPE}'}`);
      expect(site.last(POPUP).url).toContain(`?Token=a-newer-nursing-key&ReportType=${TYPE}&${FILE_NAME}`);
    });

    test("a reference the catalog never listed opens nothing", async () => {
      const unlisted = { reference: NEVER_LISTED };
      await site.fails("nursing-statement-pdf", unlisted, [], "NOT_THE_MEMBERS", "reference-unknown");
    });
  });
});

describe("hospital and emergency-room mailings", () => {
  const PAGE = "/online/medicalfile/mailingsfromhospitals/";
  const HISTORY = "/GetMailingsFromHospitals/";
  const POPUP = "/MailingsFromHospitals.aspx";
  const today = { as_of: "2026-10-05" };
  const stay = {
    DescriptionDistinction: [],
    DescriptionTreatment: [{ Description: "טיפול מדומה" }],
    TypeCommitmentEgenKey: "ER/2",
    LinkPDF: "ward+7/letter",
    HasLink: true,
    Department: "מחלקה מדומה",
    TypeCommitment: "מיון",
    QuantityTreatments: "2",
    DurationHospitalization: "0",
    Date: "02/01/2026",
    DateHospitalization: "01/01/2026",
    NameHospital: "מרכז רפואי אלמוני",
  };
  const history = (rows: unknown[], code: unknown = 0): Route =>
    answerWith(HISTORY, { ResultMessage: { Code: code }, ReportHospitalizations: rows });
  const oneStay = [history([stay])];

  const controller = el("div#mailingsFromHospitalsController");
  /** The inline script carrying the page's lookback, with `settings` as written in its source. */
  const script = (settings: string, root = "/online") =>
    el("script", `jqe.appRoot='${root}';var pageSettings=${settings};`);
  const hospitalPage = (member: number, ...content: string[]): Route => serving(PAGE, page(member, ...content));
  const FIVE_YEARS = '{"YearsBack":"5"}';

  test("a row keeps every field it was sent with and gains a reference", async () => {
    const { data } = await site.ok("hospital-visits", today, oneStay);
    expect(data).toEqual([{ ...stay, reference: expect.stringMatching(SHA256) }]);
    expect(site.last(HISTORY).authorization).toBe("");
  });

  test("a report is found in a fresh listing for the same date, then read from the popup by its two keys", async () => {
    const [{ reference }] = (await site.ok("hospital-visits", today, oneStay)).data;
    expect(await pdf("hospital-visit-pdf", { ...today, reference }, oneStay)).toContain("hospital-letter");
    const { pathname, searchParams } = new URL(site.last(POPUP).url);
    expect(pathname).toBe("/online/Pages/Popups/MailingsFromHospitals/MailingsFromHospitals.aspx");
    expect(Object.fromEntries(searchParams)).toEqual({
      typeCommitment: stay.TypeCommitmentEgenKey,
      path: stay.LinkPDF,
    });
  });

  test("a reference listed under a date range is looked up in that same range", async () => {
    const range = { ...today, from: "2024-11-30", to: "2026-08-12" };
    const [{ reference }] = (await site.ok("hospital-visits", range, oneStay)).data;
    expect(await pdf("hospital-visit-pdf", { ...range, reference }, oneStay)).toContain("%PDF");
    expect(JSON.parse(site.last(HISTORY).body)).toEqual({
      toDate: "12082026",
      fromDate: "30112024",
      isDateSelected: true,
    });
  });

  test("a reference the listing never gave opens no report", async () => {
    const unlisted = { ...today, reference: NEVER_LISTED };
    await site.fails("hospital-visit-pdf", unlisted, oneStay, "NOT_THE_MEMBERS", "reference-unknown");
  });

  test("no stays is an empty list", async () => {
    const { data } = await site.ok("hospital-visits", today, [history([])]);
    expect(data).toEqual([]);
  });

  test("a range from before the page's lookback is refused; 29 February counts back to 28 February", async () => {
    const leapDay = { as_of: "2028-02-29", from: "2023-02-27", to: "2028-02-29" };
    const earliest = "range-before-earliest-allowed-from=2023-02-28";
    await site.fails("hospital-visits", leapDay, [], "NOT_OFFERED", earliest);
  });

  test("somebody else's page ends the read before the history is asked for", async () => {
    const asked = site.count(HISTORY);
    const theirs = hospitalPage(A_STRANGER, controller, script(FIVE_YEARS));
    await site.fails("hospital-visits", today, [theirs], "NOT_THE_MEMBERS");
    expect(site.count(HISTORY)).toBe(asked);
  });

  test.each([
    ["a lookback of no years", [controller, script('{"YearsBack":"0"}')]],
    ["a lookback of 100000 years", [controller, script('{"YearsBack":"100000"}')]],
    ["a lookback that is code to run", [controller, script('{"YearsBack":elapsed()}')]],
    ["no controller element", [script(FIVE_YEARS)]],
    ["another application root", [controller, script(FIVE_YEARS, "/portal")]],
    ["its settings assigned twice", [controller, script(FIVE_YEARS), el("script", `var pageSettings=${FIVE_YEARS};`)]],
  ])("a page with %s is a changed page", async (_what, content) => {
    await changed("hospital-visits", today, [hospitalPage(MEMBER, ...content)]);
  });

  test.each<[string, unknown[], string]>([
    ["the same stay twice", [stay, stay], "row-twice"],
    ["a link flag that is text", [{ ...stay, HasLink: "true" }], "key:HasLink"],
    ["a link that is empty", [{ ...stay, LinkPDF: "" }], "key:LinkPDF"],
    ["a department that is a number", [{ ...stay, Department: 12 }], "key:Department"],
    [
      "a treatment described by a number",
      [{ ...stay, DescriptionTreatment: [{ Description: 12 }] }],
      "key:Description",
    ],
  ])("a history with %s is refused by that name", async (_what, rows, detail) => {
    await site.fails("hospital-visits", today, [history(rows)], "UNEXPECTED_ANSWER", detail);
  });

  test.each<Refusal>([
    ["an error of its own", [history([], 6)], "PORTAL_REPORTED_ERROR"],
    ["its result code as text", [history([], "0")], "UNEXPECTED_ANSWER", "key:Code"],
    ["an answer from another address", [{ ...history([]), url: ELSEWHERE }], "UNEXPECTED_ANSWER", MISROUTED],
    ["status 500", [failing(HISTORY)], "PORTAL_HTTP_ERROR"],
  ])("a history service giving %s has an error to match", async (_what, routes, code, detail) => {
    await site.fails("hospital-visits", today, routes, code, detail);
  });

  test("the logout page in the history's place means the session has ended", async () => {
    await site.expired("hospital-visits", today, [{ ...history([]), url: LOGOUT_PAGE }]);
  });
});

test("the fake was asked for nothing it does not serve, and no socket was opened", () => {
  expect(box.unexpected()).toEqual([]);
});
