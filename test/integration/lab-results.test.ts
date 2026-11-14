/**
 * Laboratory reads, driven through the MCP server of the built bundle with the fake Maccabi behind
 * it: the list of tests and its year filter, the values of one result, the printable report of a
 * result, the COVID report in English, the history of one analyte with its table and graph, the
 * "latest" and "followed" views, the file attached to an analyte, and the original document of a
 * listed row.
 *
 * A request and document id pair is only ever taken from the member's own, newly fetched list. One
 * live observation is reproduced: Maccabi answers 404 for the report of an older result, every time.
 * Every value here is made up.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { answerWith, bootstrap, MEMBER, memberSession, merge, type Route, SOMEONE_ELSE } from "../rig";

const session = memberSession("labs", [], "imaging");
const { box, ok, fails, file, last, query: queryOf, count: countOf } = session;

const LIST = `/${MEMBER}/tests`;
const RESULT = "/getresultsbyid";
const REPORT = `${RESULT}/report`;
const HISTORY = `/${MEMBER}/compare?`;
const HISTORY_REPORT = "/compare/report";
const LATEST = "/getlatestlabresults";
const FOLLOWED = `/${MEMBER}/followed`;
const ATTACHED = "/pdf/showresult";

/** The fake's laboratory row, and the imaging result its `imaging` scenario lists with a document. */
const bloodTest = { request_id: "assay-req-3", doc_id: "assay-doc-3" };
const scanResult = { request_id: "scan-req-8", doc_id: "scan-doc-8" };
/** The fake's first analyte, as part of that result and as the latest view names it. */
const analyteOfResult = { ...bloodTest, test_id: "mock-analyte-a" };
const analyteOfLatest = { test_id: "mock-analyte-a", source: "latest" };

type Fields = Record<string, unknown>;
/** The pair that selects `row()`. */
const theRow = { request_id: "request-17", doc_id: "document-17" };
/** A laboratory row with all 28 keys of the list's row shape. */
const row = (change: Fields = {}) => ({
  ...theRow,
  type: "lab_result",
  test_name: ["בדיקה מדומה"],
  test_category: [],
  doc_type_name: "מעבדה מדומה",
  doc_type_id: 6,
  data_type_code: 6,
  category_name: "בדיקות",
  category_original_id: 6,
  category_id: 6,
  member_id_code: 0,
  member_id: String(MEMBER),
  execute_date: "2001-03-01T08:00:00",
  result_date: "2001-03-02T00:00:00",
  result_date_desc: "01.03.2001",
  time_stamp: "row-stamp",
  hash: "row%2Fsig%3D",
  concealment: "0",
  is_read: true,
  is_partial: false,
  is_result_yesterday: false,
  result_files: null,
  file_name: null,
  procedures: null,
  executed_by: null,
  referrer_name: null,
  executing_institute: null,
  ...change,
});
const listing = (...tests: unknown[]): Route[] => [answerWith(LIST, { tests, categories: [] })];
const attaching = (result_file: string) => ({ result_files: [{ result_file }] });

/** An analyte with every field a result's detail sends for one. */
const analyte = {
  hash: null,
  time_stamp: null,
  result_file: null,
  result: 5,
  max_lim: 9,
  min_lim: 1,
  lab_date: "2000-01-01",
  message_list: [],
  units: "unit",
  test_desc: "Mock Analyte A",
  test_id: "mock-analyte-a",
};
/** The result's detail, with these analytes as its only group. */
const holding = (...group_values: unknown[]): Route[] => [
  merge(RESULT, { results: [{ group_values, group_name: "group" }] }),
];

const read = async (operation: string, args: Fields = {}, routes: Route[] = []) =>
  (await ok(operation, args, routes)).data;
const documentText = async (operation: string, args: Fields = {}, routes: Route[] = []) =>
  (await file(operation, args, routes)).toString("utf8");
/** Per analyte of a view's first group: its id, and whether a file is attached to it. */
const filesOf = (groups: any[]) => groups[0].group_values.map((value: any) => [value.test_id, value.has_result_file]);

beforeAll(session.start);

describe("the list of tests", () => {
  it("is posted for the member alone, and says which rows have a document", async () => {
    const { tests } = await read("test-results");
    expect(JSON.parse(last(LIST).body)).toEqual({
      current_user_gender: "mock",
      logged_user_gender: "mock",
      categories: [],
      members: [],
    });
    expect(tests.map((test: any) => [test.has_document, test.request_id])).toEqual([
      [false, bloodTest.request_id],
      [false, expect.stringMatching(/^2\.25\.7391\./)],
      [true, scanResult.request_id],
    ]);
  });

  it("derives has_document from the attachment, not from the type of the row", async () => {
    const rows = listing(
      row(),
      row({ doc_id: "d2", request_id: "r2", type: "imaging_result", ...attaching("dir/one") }),
      row({ doc_id: "d3", request_id: "r3", type: "a_type_nobody_observed", ...attaching("dir/two") }),
      row({ doc_id: "d4", request_id: "r4", type: "imaging_result", ...attaching("  ") }),
    );
    const { tests } = await read("test-results", {}, rows);
    expect(tests.map((test: any) => test.has_document)).toEqual([false, true, true, false]);
  });

  describe("asked for one year", () => {
    const executedAt = (execute_date: string) => row({ execute_date, request_id: execute_date });

    it("keeps the fetched rows executed in that year, and says the filter was applied locally", async () => {
      const YEAR = 2021;
      // The last second before the year, its first and last seconds, and the first second after it.
      const aroundTheYear = [
        `${YEAR - 1}-12-31T23:59:59`,
        `${YEAR}-01-01T00:00:00`,
        `${YEAR}-12-31T23:59:59`,
        `${YEAR + 1}-01-01T00:00:00`,
      ];
      const answer = await ok("test-results", { year: YEAR }, listing(...aroundTheYear.map(executedAt)));
      expect(answer.data.tests.map((test: any) => test.execute_date)).toEqual(aroundTheYear.slice(1, 3));
      expect(answer.source).toMatchObject({
        selection: { year: YEAR, field: "execute_date", mode: "local" },
        completeness: "local-filtered-subset",
      });
    });

    it("refuses an execution date that carries a time zone", async () => {
      await fails(
        "test-results",
        { year: 2021 },
        listing(executedAt("2021-05-05T05:05:05Z")),
        "UNEXPECTED_ANSWER",
        "key:execute_date",
      );
    });
  });

  it("fails as a whole over a row in an unknown shape", async () => {
    await fails("test-results", {}, listing(row({ test_name: [12] })), "UNEXPECTED_ANSWER", "key:test_name");
  });

  it("fails as a whole over a row of another member", async () => {
    await fails("test-results", {}, listing(row({ member_id: String(SOMEONE_ELSE) })), "NOT_THE_MEMBERS");
  });
});

describe("a result", () => {
  it("keeps all its values and marks the ones with a file attached", async () => {
    const { results } = await read("lab-values", bloodTest);
    expect(JSON.parse(last(RESULT).body)).toEqual({
      current_user_gender: "mock",
      logged_user_gender: "mock",
      ...bloodTest,
    });
    expect(filesOf(results)).toEqual([
      ["mock-analyte-a", false],
      ["mock-analyte-b", true],
    ]);
  });

  it("is never asked for with a pair the fresh list lacks", async () => {
    const asked = countOf(RESULT);
    const mismatched = { ...bloodTest, doc_id: scanResult.doc_id };
    await fails("lab-values", mismatched, [], "NOT_THE_MEMBERS", "id-unknown");
    expect(countOf(RESULT)).toBe(asked);
  });

  it("is asked for whatever the type of the member's row, and judged by the answer", async () => {
    expect((await read("lab-values", scanResult)).results).toHaveLength(1);
  });

  it.each<[string, Fields]>([
    ["no group and nothing else", { results: [] }],
    [
      "an analyte lacking most fields",
      {
        is_partial: false,
        execute_date: "day",
        results: [{ group_values: [{ test_desc: "only", test_id: "these" }], group_name: "group" }],
      },
    ],
    ["a partial flag that is text", { is_partial: "false", execute_date: "day", results: [] }],
  ])("is refused when the detail has %s", async (_what, detail) => {
    await fails("lab-values", bloodTest, [answerWith(RESULT, detail)], "UNEXPECTED_ANSWER");
  });
});

describe("the printable report of a result", () => {
  it("is signed with the fields of the freshly read detail and the print flags, and sent without the bearer", async () => {
    expect(await documentText("lab-values-pdf", bloodTest)).toContain("lab-report");
    const sent = last(REPORT);
    expect(sent.authorization).toBe("");
    expect(sent.url).toContain(
      `${REPORT}?request_id=assay-req-3&t=resulttime&hash=result%2Bhash&irregular_only=false&is_attachment=false` +
        "&is_partial=false&date=2001-02-01T08:00:00",
    );
  });

  it("passes on a request for the irregular values only", async () => {
    await file("lab-values-pdf", { irregular_only: true, ...bloodTest });
    expect(queryOf(REPORT)).toMatchObject({ irregular_only: "true" });
  });

  it.each<[string, unknown, string]>([
    ["missing", null, "key:hash"],
    ["able to add a parameter", "x&y", "signature-unsafe"],
  ])("is not fetched when the detail's signature is %s", async (_what, hash, detail) => {
    await fails("lab-values-pdf", bloodTest, [merge(RESULT, { hash })], "UNEXPECTED_ANSWER", detail);
  });

  it("live: the 404 of an older result is asked for once, and points at the values instead", async () => {
    const older: Route = answerWith(
      RESULT,
      {
        is_partial: false,
        execute_date: "2000-01-01",
        hash: "sig-older",
        time_stamp: "stamp-older",
        results: [{ group_values: [analyte], group_name: "קבוצה מדומה" }],
      },
      { method: "POST" },
    );
    const notFound: Route = { text: "Not Found", status: 404, match: REPORT };
    const asked = countOf(REPORT);
    const refusal = await fails(
      "lab-values-pdf",
      bloodTest,
      [older, notFound],
      "PORTAL_HTTP_ERROR",
      "status=404 report-absent",
    );
    expect(countOf(REPORT) - asked).toBe(1);
    for (const advice of ["Do not retry", "lab-values"]) expect(refusal.message).toContain(advice);
    expect(refusal).toMatchObject({
      known_issue: expect.stringContaining("Print button"),
      retry: "no",
      cause: "maccabi",
    });
  });

  it("asks for a single retry on any other upstream failure", async () => {
    const unavailable: Route = { text: "", status: 503, match: REPORT };
    const { message } = await fails("lab-values-pdf", bloodTest, [unavailable], "PORTAL_HTTP_ERROR", "status=503");
    expect(message).toContain("Retry once");
  });

  it("does not exist for a row that is no laboratory result, which has an attached document instead", async () => {
    const imaging = listing(row({ type: "imaging_result" }));
    const { message } = await fails("lab-values-pdf", theRow, imaging, "NOT_OFFERED", "not-a-lab-row");
    expect(message).toContain("test-document-pdf");
  });

  it("exists for a laboratory row that came in through the API", async () => {
    expect(await documentText("lab-values-pdf", theRow, listing(row({ type: "lab_api_result" })))).toContain("%PDF");
  });

  it("needs its pair to pick one listed row, no more and no fewer", async () => {
    await fails("lab-values-pdf", theRow, listing(row(), row()), "UNEXPECTED_ANSWER", "row-twice");
    const otherRequest = { ...theRow, request_id: "request-18" };
    await fails("lab-values-pdf", otherRequest, listing(row()), "NOT_THE_MEMBERS", "id-unknown");
  });
});

describe("the COVID report in English", () => {
  const COVID_REPORT = "/labs/corona/Report";
  const withPassport = bootstrap({ current_customer_info: { passport_number: "MOCKPASSPORT31" } });
  const printable = (signature: Fields) => merge(RESULT, { ...signature, show_print_corona_english_report: true });

  it("is not offered to a member without an English identity", async () => {
    await fails("lab-covid-report-pdf", bloodTest, [], "NOT_OFFERED", "english-identity-missing");
  });

  it("is withheld unless the result itself is flagged printable", async () => {
    await fails("lab-covid-report-pdf", bloodTest, [withPassport], "NOT_ENTITLED");
  });

  it("is signed with the result's COVID signature, and nothing is marked or changed on the way", async () => {
    const signed = printable({ corona_hash: "covid%2Bsig", corona_t: "covid+stamp" });
    expect(await documentText("lab-covid-report-pdf", bloodTest, [withPassport, signed])).toContain(
      "covid-report-in-english",
    );
    expect(last(COVID_REPORT).url).toContain(`${COVID_REPORT}?data=assay-req-3&t=covid+stamp&hash=covid%2Bsig`);
    expect(box.fetches().filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("is not fetched with a signature that could add a parameter", async () => {
    const unsafe = printable({ corona_hash: "sig", corona_t: "x&y" });
    await fails("lab-covid-report-pdf", bloodTest, [withPassport, unsafe], "UNEXPECTED_ANSWER", "signature-unsafe");
  });
});

describe("the history of one analyte", () => {
  it("is asked for at the date the freshly read result gives the analyte", async () => {
    const { other_results } = await read("lab-history", analyteOfResult);
    expect(queryOf(HISTORY)).toEqual({ date_of_result: "2001-02-01", test_id: "mock-analyte-a" });
    expect(other_results).toEqual([
      expect.objectContaining({ doc_first_name: "מדומה", result: 100, lab_date: "2001-01-01" }),
    ]);
  });

  it("of a followed test is asked for at the date of the followed row", async () => {
    const { other_results } = await read("lab-history", { test_id: "mock-analyte-a", source: "followed" });
    expect(other_results).toHaveLength(1);
    expect(queryOf(HISTORY)).toMatchObject({ date_of_result: "2001-03-01" });
  });

  it("needs the test to be one analyte of the result, with a date that is text", async () => {
    await fails(
      "lab-history",
      { ...bloodTest, test_id: "not-in-the-result" },
      [],
      "NOT_THE_MEMBERS",
      "analyte-unknown",
    );
    const dated = { ...analyte, lab_date: "2001-02-01" };
    await fails("lab-history", analyteOfResult, holding(dated, dated), "NOT_THE_MEMBERS", "ambiguous-test-id");
    await fails(
      "lab-history",
      analyteOfResult,
      holding({ ...analyte, lab_date: 20010201 }),
      "UNEXPECTED_ANSWER",
      "key:lab_date",
    );
  });

  it.each<[string, Fields]>([
    ["is about a different test", { current_result: { test_id: "another-test" } }],
    ["is about a different date", { current_result: { lab_date: "another-date" } }],
    ["has no signature", { hash: null }],
  ])("is refused as a changed shape when the answer %s", async (_how, change) => {
    await fails("lab-history", analyteOfResult, [merge(HISTORY, change)], "UNEXPECTED_ANSWER", "shape-changed");
  });

  it.each<[string, Fields]>([
    ["at the top", { member_id: SOMEONE_ELSE }],
    ["in the current result", { current_result: { member_id: SOMEONE_ELSE } }],
  ])("is refused when the answer names another member %s", async (_where, change) => {
    await fails("lab-history", analyteOfResult, [merge(HISTORY, change)], "NOT_THE_MEMBERS");
  });

  describe("as a PDF", () => {
    const table = { ...analyteOfResult, view: "list" };
    const graph = { ...analyteOfLatest, view: "graph" };

    it("of the table is signed with the fields of the comparison it prints", async () => {
      expect(await documentText("lab-history-pdf", table)).toContain("history-table");
      expect(queryOf(HISTORY_REPORT)).toEqual({
        lab_date: "2001-02-01",
        test_des: "Mock Analyte A",
        is_graph: "false",
        is_attachment: "false",
        date_of_result: "2001-02-01",
        hash: "compare+sig",
        t: "comparestamp",
        test_id: "mock-analyte-a",
      });
    });

    it("of the graph is served when some row has a limit or a value, which is when the portal offers it", async () => {
      expect(await documentText("lab-history-pdf", graph)).toContain("history-graph");
    });

    it("of the graph is withheld, and not asked for, when every limit and value is zero", async () => {
      const zeroed = {
        ...analyte,
        message: "",
        vitek_row: [],
        is_vitek: false,
        is_follow: false,
        is_messages: "0",
        numeric_percentage: 0,
        is_graph: false,
        doc_last_name: "last",
        doc_first_name: "first",
        lab_date: "2001-03-01",
        result: 0,
        max_lim: 0,
      };
      const flat = answerWith(HISTORY, {
        hash: "sig",
        timestamp: "stamp",
        other_results: [{ ...zeroed, lab_date: "2001-01-01" }],
        current_result: zeroed,
      });
      const asked = countOf(HISTORY_REPORT);
      await fails("lab-history-pdf", graph, [flat], "NOT_ENTITLED");
      expect(countOf(HISTORY_REPORT)).toBe(asked);
    });

    it("live: answers 404 for the history print of an older result, which is final and said so", async () => {
      const notFound: Route = { text: "", status: 404, match: HISTORY_REPORT };
      const refusal = await fails("lab-history-pdf", table, [notFound], "PORTAL_HTTP_ERROR", "status=404");
      // The message speaks of the command that was run, and the known issue of where the values are.
      expect(refusal.message).toContain("lab-history-pdf");
      expect(refusal).toMatchObject({
        known_issue: expect.stringContaining("lab-history"),
        retry: "no",
        cause: "maccabi",
      });
    });
  });

  it("of a test_id given with nothing else is read from the latest view, the list that names test_ids", async () => {
    const bare = await read("lab-history", { test_id: "mock-analyte-a" });
    expect(bare).toEqual(await read("lab-history", analyteOfLatest));
    const halfARow = { test_id: "mock-analyte-a", request_id: bloodTest.request_id };
    const { message } = await fails("lab-history", halfARow, [], "BAD_INPUT");
    expect(message).toContain("pass that source instead");
  });
});

describe("the latest results", () => {
  const LATEST_REPORT = `${LATEST}/report`;
  /** The view reduced to the fake's first analyte, with no file, then changed. */
  async function withAnalyte(change: Fields): Promise<Route[]> {
    const [{ group_values }] = await read("labs-latest");
    const plain = { ...group_values[0], hash: null, time_stamp: null, result_file: null, has_result_file: undefined };
    return [merge(LATEST, { results: [{ group_values: [{ ...plain, ...change }], group_name: "group" }] })];
  }

  it("mark the analytes that have a file attached", async () => {
    expect(filesOf(await read("labs-latest"))).toEqual([
      ["mock-analyte-a", false],
      ["mock-analyte-b", true],
    ]);
  });

  it("keep the bacteria of a culture with the drugs each is sensitive to", async () => {
    const vitek_row = [
      {
        drugs_and_sensitivity_list: [{ sensitivity: "R", name_of_drug: "תרופה מדומה" }],
        bacterium_name: "חיידק מדומה",
      },
    ];
    const [{ group_values }] = await read("labs-latest", {}, await withAnalyte({ vitek_row, is_vitek: true }));
    expect(group_values[0].vitek_row).toEqual(vitek_row);
  });

  it.each<[string, Fields]>([
    ["a fractional percentage", { numeric_percentage: 0.5 }],
    ["a result that is text", { result: "200" }],
    ["a file with half a signature", { hash: "sig", time_stamp: null, result_file: "dir/file" }],
    ["a signature without a file", { hash: null, time_stamp: "stamp", result_file: null }],
  ])("refuse an analyte with %s", async (_what, change) => {
    await fails("labs-latest", {}, await withAnalyte(change), "UNEXPECTED_ANSWER", "shape-changed");
  });

  it("refuse a view whose signature is a number", async () => {
    await fails("labs-latest", {}, [merge(LATEST, { hash: 7 })], "UNEXPECTED_ANSWER");
  });

  it("refuse an analyte that names another member", async () => {
    const foreign = merge(LATEST, {
      results: [{ group_values: [{ member_id: SOMEONE_ELSE, test_id: "any" }], group_name: "group" }],
    });
    await fails("labs-latest", {}, [foreign], "NOT_THE_MEMBERS");
  });

  it("print with the signature of the view itself", async () => {
    expect(await documentText("labs-latest-pdf")).toContain("latest-report");
    expect(queryOf(LATEST_REPORT)).toEqual({
      is_attachment: "false",
      irregular_only: "false",
      hash: "latest+hash",
      t: "newesttime",
    });
    await file("labs-latest-pdf", { irregular_only: true });
    expect(queryOf(LATEST_REPORT)).toMatchObject({ irregular_only: "true" });
  });
});

describe("the followed tests", () => {
  const FOLLOWED_REPORT = "/followed/report";
  const offering = (...options: unknown[]): Route[] => [merge(FOLLOWED, { options })];

  it("show what is followed now and what could be", async () => {
    const answer = await ok("labs-followed");
    expect(answer.source).toMatchObject({ schemaEvidence: "frontend-field-projection" });
    expect(answer.data.options).toEqual([{ is_follow: true, test_desc: "Mock Analyte A", test_id: "mock-analyte-a" }]);
    const candidate = { is_follow: false, test_desc: "בדיקה שאפשר לעקוב אחריה", test_id: 4410 };
    expect((await read("labs-followed", {}, offering(candidate))).options).toEqual([candidate]);
  });

  it.each<[string, Fields]>([
    ["a negative counter", { followed_counter: -3 }],
    ["an option whose id is an object", { options: [{ is_follow: false, test_desc: "any", test_id: {} }] }],
  ])("refuse a view with %s", async (_what, change) => {
    await fails("labs-followed", {}, [merge(FOLLOWED, change)], "UNEXPECTED_ANSWER", "shape-changed");
  });

  it("refuse an option that names another member", async () => {
    const foreign = offering({ member_id: SOMEONE_ELSE, is_follow: true, test_desc: "any", test_id: "any" });
    await fails("labs-followed", {}, foreign, "NOT_THE_MEMBERS");
  });

  it("print with the signature of the view itself, without following, unfollowing or marking anything", async () => {
    expect(await documentText("labs-followed-pdf")).toContain("tracked-summary");
    expect(last(FOLLOWED_REPORT).url).toContain(`${FOLLOWED_REPORT}?t=followstamp&hash=followsig&is_attachment=false`);
    expect(box.fetches().filter((request) => /toggle|\/read\//.test(request.url))).toEqual([]);
  });

  it("do not print with a signature that could add a parameter", async () => {
    const asked = countOf(FOLLOWED_REPORT);
    const unsafe = [merge(FOLLOWED, { hash: "sig&extra=1" })];
    await fails("labs-followed-pdf", {}, unsafe, "UNEXPECTED_ANSWER", "signature-unsafe");
    expect(countOf(FOLLOWED_REPORT)).toBe(asked);
  });
});

describe("the file attached to an analyte", () => {
  const withFile = {
    ...analyte,
    lab_date: "2001-02-01",
    hash: "e%2Bf%2F",
    time_stamp: "file-stamp",
    result_file: "dir+private",
    test_id: "filed",
  };
  const fileOfResult = { ...bloodTest, test_id: withFile.test_id };

  it("is signed with the fields of the freshly read latest row", async () => {
    expect(await documentText("lab-analyte-pdf", { test_id: "mock-analyte-b", source: "latest" })).toContain(
      "analyte-file",
    );
    // The path arrives percent-encoded and is encoded once more, as the portal sends it.
    expect(last(ATTACHED).url).toContain(
      `${ATTACHED}?data=%252Fmock%252Fanalyte-b-file.pdf&t=analytebstamp&hash=analytebsig`,
    );
  });

  it("is not offered for an analyte that has none", async () => {
    await fails("lab-analyte-pdf", analyteOfLatest, [], "NOT_OFFERED", "analyte-file-absent");
  });

  it("of a result's analyte is asked for with the analyte's description and date", async () => {
    expect(await documentText("lab-analyte-pdf", { ...bloodTest, test_id: "mock-analyte-b" })).toContain(
      "analyte-file",
    );
    expect(queryOf(ATTACHED)).toMatchObject({ labDate: "2001-02-01", testDes: "Mock Analyte B" });
  });

  it("of a followed test goes out with the row's signature exactly as it came", async () => {
    const followed = {
      ...withFile,
      message: "",
      vitek_row: [],
      is_vitek: false,
      is_follow: true,
      is_messages: "1",
      numeric_percentage: 3,
    };
    const routes = [merge(FOLLOWED, { followed_tests: [followed] })];
    expect(await documentText("lab-analyte-pdf", { test_id: withFile.test_id, source: "followed" }, routes)).toContain(
      "analyte-file",
    );
    expect(last(ATTACHED).url).toContain("data=dir%2Bprivate&t=file-stamp&hash=e%2Bf%2F");
  });

  it.each<[string, Fields, string]>([
    ["a signature with a space in it", { hash: "sig nature" }, "signature-unsafe"],
    // A lone surrogate is text JSON can carry and a URI cannot.
    ["a path that cannot be URI-encoded", { result_file: "\udfff" }, "link-unencodable"],
  ])("is not fetched with %s", async (_what, change, detail) => {
    await fails("lab-analyte-pdf", fileOfResult, holding({ ...withFile, ...change }), "UNEXPECTED_ANSWER", detail);
  });
});

describe("the original document of a listed row", () => {
  const OPEN = "/pdf/openfile";

  it("is asked for by doc_id, signed with the fields copied from the row", async () => {
    expect(await documentText("test-document-pdf", scanResult)).toContain(`original-of-${scanResult.doc_id}`);
    const owner = String(MEMBER);
    expect(queryOf(OPEN)).toEqual({
      memberIdCodeForHeader: "0",
      memberIdForHeader: owner,
      currentUsergender: "1",
      loggedInUserGender: "1",
      hash: "mock/scan+sig=",
      t: "scan-stamp-3",
      data: scanResult.doc_id,
      memberid: owner,
      memberidcode: "0",
    });
    // The signature is sent decoded and encoded once; a doubly encoded one would show as %25.
    expect(last(OPEN).url.includes("%25")).toBe(false);
  });

  it("carries the sex of the logged-in and of the selected member as the portal's gender codes", async () => {
    const female = { sex: "נ" };
    await file("test-document-pdf", scanResult, [
      bootstrap({ current_customer_info: female, logged_customer_info: female }),
    ]);
    expect(queryOf(OPEN)).toMatchObject({ currentUsergender: "2", loggedInUserGender: "2" });
  });

  it("is served for a row of a type nobody observed, as long as it attaches something, and never sends that path", async () => {
    const unobserved = listing(row({ type: "a_type_nobody_observed", ...attaching("private/attachment-path") }));
    expect(await documentText("test-document-pdf", theRow, unobserved)).toContain(`original-of-${theRow.doc_id}`);
    expect(last(OPEN).url).not.toContain("attachment-path");
  });

  it("is not asked for when the pair is unlisted or the row attaches nothing", async () => {
    const asked = countOf(OPEN);
    const unlisted = { ...theRow, doc_id: "document-18" };
    await fails(
      "test-document-pdf",
      unlisted,
      listing(row({ type: "imaging_result", ...attaching("dir/one") })),
      "NOT_THE_MEMBERS",
    );
    await fails("test-document-pdf", theRow, listing(row()), "NOT_OFFERED", "attachment-absent");
    expect(countOf(OPEN)).toBe(asked);
  });

  it("accepts the PDF content type in any letter case", async () => {
    const capitalised: Route = { headers: { "content-type": "APPLICATION/Pdf" }, match: OPEN };
    expect(await documentText("test-document-pdf", scanResult, [capitalised])).toContain("%PDF");
  });

  it("is not fetched when the row's signature is not valid percent-encoding", async () => {
    const garbled = listing(row({ ...scanResult, type: "imaging_result", ...attaching("dir/one"), hash: "%xy" }));
    await fails("test-document-pdf", scanResult, garbled, "UNEXPECTED_ANSWER", "signature-undecodable");
  });
});

it("asked the fake for nothing it had to refuse", () => {
  expect(box.unexpected(), "refused requests and outbound sockets").toEqual([]);
});
