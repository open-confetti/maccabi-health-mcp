/**
 * directory-specialties, directory-search and directory-provider, run over MCP against
 * test/fake/directory.mjs. A lookup is a chain: the landing page gives the catalog, a search gives rows,
 * a card is opened from a row. The suite follows that chain link by link and, for each one, replaces
 * the fake's answer with what the real host is known or feared to send instead: a robot check, a
 * redirect, a changed shape. The point of most cases is that such an answer comes back as an error and
 * can never be mistaken for "no provider matched". A member is signed in throughout, which is how the
 * last section can show that nothing of theirs travels to the directory. Providers are made up.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { carriesNone, memberSession, merge, type Route } from "../rig";

const directory = memberSession("directory");
const { box } = directory;

/** A URL fragment for each of the directory's four addresses. */
const LANDING = "/heb/doctors/";
const SETTINGS_API = "/GetSettingsForSearch/";
const SEARCH_API = "/GetSearchPageSearch/";
const CARD = "/api/ProviderDetails/";

/** A search for the fake's one specialty, in each of the two categories. */
const AMONG_DOCTORS = { field: "101", category: "doctors" };
const AMONG_LABS = { field: "101", category: "labs-and-therapists" };
const NOBODY_FOUND = merge(SEARCH_API, { TotalItems: 0, NumOfPages: 0, Items: [] });
const AS_HTML = { "content-type": "text/html" };
const AS_JSON = { "content-type": "application/json" };
/** The tool takes a search page of up to this many rows. */
const MOST_ROWS_ON_A_PAGE = 100;

type Arguments = Record<string, unknown>;

const find = async (wanted: Arguments, routes: Route[] = []) =>
  (await directory.ok("directory-search", wanted, routes)).data;
/** For a failure whose exact code is not the point: the error, once the call is seen to have failed. */
async function errorOf(operation: string, given: Arguments, routes: Route[]) {
  const outcome = await directory.run(operation, given, routes);
  expect(outcome.isError).toBe(true);
  return outcome.structuredContent.error;
}

const requestsSoFar = () => box.fetches().length;
/** The JSON most recently posted to an address. */
const posted = (address: string) => JSON.parse(directory.last(address).body);
/** Every search body posted after the first `mark` requests, oldest first. */
function searchesAfter(mark: number) {
  const later = box.fetches().slice(mark);
  return later.filter(({ url }) => url.includes(SEARCH_API)).map(({ body }) => JSON.parse(body));
}

const catalogOf = (specialties: unknown[] = [{ V: "פיזיותרפיה", K: "101" }]) => ({
  Cities: [{ V: "גבעת אלמוני", K: "7300" }],
  Fields: specialties,
});
/**
 * A landing page stating `catalog`. The script goes on after the state with `next` and then a function
 * that throws: the tool reads the state as text, and running any of it would be the bug.
 */
function landingPage(catalog: unknown, { category = "Doctors_001", next = "" } = {}): string {
  const state = JSON.stringify({ settings: { doctors: { Data: catalog, Settings: { category } } } });
  const tripwire = "window.tripwire = () => { throw new Error('the page script was run') };";
  return `<html><script>window.__INITIAL_STATE__ = ${state}; ${next}${tripwire}</script></html>`;
}
const landing = (answer: Partial<Route>): Route => ({ match: LANDING, ...answer });

const ROW_TEXTS = [
  ...["TITEL", "FIRST_NAME", "LAST_NAME", "SERVICE_NAME", "CITY_NAME", "PARTIALLY_ADRESS"],
  ...[1, 2, 3, 4, 5, 6].map((n) => `TREAT_AREA_${n}`),
];
/** A search row lacking nothing: its own position, and `key` to open its card with. */
const row = (position: number, key = `row-${position}`) => ({
  ...Object.fromEntries(ROW_TEXTS.map((name) => [name, ""])),
  PHONENUMBERS: [],
  ItemKeyIndex: key,
  PositionId: position,
  EmployeeNumber: 1000 + position,
  CHAPTER_CODE: "001",
});

beforeAll(directory.start);

describe("finding a provider", () => {
  const narrowed = { ...AMONG_DOCTORS, name: "אלמוני", city: "7300", page: 2 };

  test("page two of a narrowed search repeats what page one asked, request id included", async () => {
    const mark = requestsSoFar();
    const { selection } = await find(narrowed);
    expect(selection).toEqual({ ...AMONG_DOCTORS, options: { name: "אלמוני", city: "7300", page: 2 } });

    const [pageOne, pageTwo] = searchesAfter(mark);
    expect(pageTwo.RequestId).toBe(pageOne.RequestId);
    expect(pageTwo).toMatchObject({ DocName: "אלמוני", City: "7300", PageNumber: 2 });
    expect(pageTwo).toMatchObject({ ModuleName: "doctorssearchresults", Source: "SearchPage" });
    // A name the caller typed is never put in a URL.
    expect(new URL(directory.last(SEARCH_API).url).search).toBe("");
  });

  test("a card is opened from a search made afresh, under a request id of its own", async () => {
    const mark = requestsSoFar();
    const [listed] = (await find(narrowed)).providers;
    const [firstSearch] = searchesAfter(mark);

    const card = (await directory.ok("directory-provider", { ...narrowed, reference: listed.reference })).data;
    const repeated = posted(SEARCH_API);
    expect(repeated.RequestId).not.toBe(firstSearch.RequestId);
    expect(posted(CARD)).toEqual({
      RequestId: repeated.RequestId,
      ItemKeyIndex: expect.stringMatching(/^made-up-row-\d+$/),
      Source: "SearchPageResults",
      InitiatorCode: "001",
      ChapterId: "001",
      IsMobileApplication: 0,
      IsKosher: 0,
    });

    expect(card.reference).toBe(listed.reference);
    const [slot] = card.Schedules[0].Schedule_Details;
    expect(slot).toMatchObject({ Week_Day_Eng: null, Remark_Desc: "בתיאום מראש בלבד" });
    // The fake's remark also carries a link.
    const shown = { Mlh: "", NewLine: true, Line_Number: "2", Remark_Text: "המרפאה סגורה בחגים" };
    expect(card.remarks.BoldComments).toEqual([shown]);
  });

  test("labs and therapists get their specialties from the settings call", async () => {
    const { data } = await directory.ok("directory-specialties", { category: "labs-and-therapists" });
    expect(data).toEqual([{ label: "נוירולוגיה", field: "101" }]);
    expect(posted(SETTINGS_API)).toEqual({ initiatorCode: "001", ModuleName: "labsandtherapists" });
  });

  test("labs and therapists are searched, and their cards opened, under chapter 003", async () => {
    const [lab] = (await find(AMONG_LABS)).providers;
    expect(posted(SEARCH_API)).toMatchObject({ PageNumber: 1, ChapterId: "003" });
    await directory.ok("directory-provider", { ...AMONG_LABS, reference: lab.reference });
    expect(posted(CARD)).toMatchObject({ IsKosher: 0, ChapterId: "003" });
  });

  test("page two of a labs search names the labs results module, and no tab", async () => {
    const { coverage } = await find({ ...AMONG_LABS, page: 2 });
    expect(coverage.page).toBe(2);
    const second = posted(SEARCH_API);
    expect(second).toMatchObject({ ModuleName: "labsandtherapistssearchresults", PageNumber: 2, ChapterId: "003" });
    expect(second).not.toHaveProperty("SelectedTab");
  });

  test("a search that matches nobody says so with an empty list", async () => {
    const { providers } = await find(AMONG_DOCTORS, [NOBODY_FOUND]);
    expect(providers).toEqual([]);
  });
});

describe("a search the tool does not make", () => {
  test("page 5 of a three-page result is past its end", async () => {
    await directory.fails("directory-search", { ...AMONG_DOCTORS, page: 5 }, [], "LISTING_PAGE_PAST_END");
  });

  test.each([
    ["specialty", { field: "999" }, "LISTING_UNKNOWN_SPECIALTY"],
    ["city", { city: "nowhere" }, "LISTING_UNKNOWN_CITY"],
  ])("a %s missing from the catalog is turned down with no search sent", async (_which, unlisted, code) => {
    const before = directory.count(SEARCH_API);
    await directory.fails("directory-search", { ...AMONG_DOCTORS, ...unlisted }, [], code);
    expect(directory.count(SEARCH_API)).toBe(before);
  });

  test("ill-formed input, in any argument, costs no request at all", async () => {
    const before = requestsSoFar();
    const twoKeys = `${AMONG_DOCTORS.field},${AMONG_LABS.field}`;
    await directory.fails("directory-search", { ...AMONG_DOCTORS, field: twoKeys }, [], "BAD_INPUT");
    await directory.fails("directory-search", { ...AMONG_DOCTORS, name: "שורה\n" }, [], "BAD_INPUT");
    const climbing = `provider-${"c".repeat(32)}/..`;
    await directory.fails("directory-provider", { ...AMONG_DOCTORS, reference: climbing }, [], "BAD_INPUT");
    expect(requestsSoFar()).toBe(before);
  });
});

describe("a search answer the tool does not trust", () => {
  const pageTwo = { ...AMONG_DOCTORS, page: 2 };

  test("a first page whose tab is not a number ends the search before page two is asked for", async () => {
    const before = directory.count(SEARCH_API);
    const oddTab = merge(SEARCH_API, { SelectedTab: "overview" });
    await directory.fails("directory-search", pageTwo, [oddTab], "LISTING_UNEXPECTED_ANSWER");
    expect(directory.count(SEARCH_API)).toBe(before + 1);
  });

  test("page two arriving under another tab than page one", async () => {
    // `after: 1` leaves page one alone; `case` keeps this rule's count apart from any other's.
    const otherTab = { ...merge(SEARCH_API, { SelectedTab: "7" }), after: 1, case: "tab moved" };
    await directory.fails("directory-search", pageTwo, [otherTab], "LISTING_UNEXPECTED_ANSWER");
  });

  test("a body that does not parse is an error and not zero providers", async () => {
    const garbled: Route = { match: SEARCH_API, headers: AS_JSON, text: '{"Items": [' };
    await directory.fails("directory-search", AMONG_DOCTORS, [garbled], "LISTING_UNEXPECTED_ANSWER");
  });

  test.each<[string, Arguments]>([
    ["admits to failing", { Errors: ["MOCKUNTRUSTED"], Success: false }],
    ["holds a row from chapter 002", { Items: [{ ...row(1), CHAPTER_CODE: "002" }] }],
    ["holds a row whose city is not text", { Items: [{ ...row(1), CITY_NAME: {} }] }],
    ["holds a row with no key to open it by", { Items: [row(1, "")] }],
  ])("an answer that %s fails as a directory error, in none of the host's words", async (_how, change) => {
    const error = await errorOf("directory-search", AMONG_DOCTORS, [merge(SEARCH_API, change)]);
    expect(error.code).toMatch(/^LISTING_/);
    carriesNone(error, ["MOCKUNTRUSTED"]);
  });

  test("one row more than a page may hold is one too many", async () => {
    const rows = [...Array(MOST_ROWS_ON_A_PAGE + 1).keys()].map((at) => row(at + 1));
    const crowded = merge(SEARCH_API, { Items: rows, TotalItems: rows.length });
    await directory.fails("directory-search", AMONG_DOCTORS, [crowded], "LISTING_UNEXPECTED_ANSWER");
  });
});

describe("the landing page's inline state", () => {
  const twice = catalogOf([
    { V: "first", K: "101" },
    { V: "second", K: "101" },
  ]);

  test.each([
    ["repeats a key", landingPage(twice)],
    ["is for a different category", landingPage(catalogOf(), { category: "Pharmacies_004" })],
    ["is a script literal and not JSON", "<html><script>window.__INITIAL_STATE__ = {settings: 1};</script></html>"],
    ["is assigned a second time further on", landingPage(catalogOf(), { next: "__INITIAL_STATE__ = {}; " })],
    ["never closes its object", '<html><script>window.__INITIAL_STATE__ = {"settings": {};</script></html>'],
    ["never closes a string", '<html><script>window.__INITIAL_STATE__ = {"settings": "};</script></html>'],
  ])("state that %s stops the lookup short of any search", async (_how, text) => {
    const before = directory.count(SEARCH_API);
    await directory.fails("directory-search", AMONG_DOCTORS, [landing({ text })], "LISTING_UNEXPECTED_ANSWER");
    expect(directory.count(SEARCH_API)).toBe(before);
  });

  test("is taken as data, so a label made of braces, quotes and semicolons arrives intact", async () => {
    const awkward = 'מרפאה }; { " ; פלונית';
    const text = landingPage(catalogOf([{ V: awkward, K: "101" }]));
    const { data } = await directory.ok("directory-specialties", { category: "doctors" }, [landing({ text })]);
    expect(data[0].label).toBe(awkward);
  });
});

describe("a robot check where the directory should be", () => {
  test("as the landing page: the error tells the caller nothing was searched, and no search follows", async () => {
    const before = directory.count(SEARCH_API);
    const text = "<html><script>window.checks = [];</script><body>One moment, please</body></html>";
    const error = await directory.fails("directory-search", AMONG_DOCTORS, [landing({ text })], "LISTING_CHALLENGED");
    expect(error.message).toContain("not a search that found nobody");
    // Live, the check can stand in front of every search: the advice must not promise that a retry helps.
    expect(error).toMatchObject({ cause: "maccabi", retry: "no" });
    expect(error.message).toContain("does not get past it");
    expect(directory.count(SEARCH_API)).toBe(before);
  });

  test("as the answer to a search, here to its second page: the same error", async () => {
    const check = {
      match: SEARCH_API,
      after: 1,
      case: "check on page two",
      text: "<html>Verifying your browser</html>",
    };
    await directory.fails("directory-search", { ...AMONG_DOCTORS, page: 2 }, [check], "LISTING_CHALLENGED");
  });
});

describe("the landing page on the wire", () => {
  const LIMIT = 4 * 1024 * 1024;
  const doctors = { category: "doctors" };
  const text = landingPage(catalogOf());

  test("a page of 4 MiB to the byte is still accepted", async () => {
    const bytes = Buffer.from(text);
    const filled = landing({ headers: AS_HTML, base64: bytes.toString("base64"), pad: LIMIT - bytes.length });
    const { data } = await directory.ok("directory-specialties", doctors, [filled]);
    expect(data).toHaveLength(1);
  });

  test.each<[string, Partial<Route>]>([
    ["a redirect", { status: 302, headers: { location: "https://example.invalid/elsewhere" }, text: "" }],
    ["a page that claims to come from another address", { url: "https://example.invalid/heb/doctors/", text }],
    ["a page typed as JSON", { headers: AS_JSON, text }],
    ["one byte over 4 MiB", { headers: AS_HTML, base64: "", pad: LIMIT + 1 }],
    ["no body at all", { headers: AS_HTML, empty: true }],
    ["bytes that are not UTF-8", { headers: AS_HTML, base64: "/w==" }],
  ])("%s ends the lookup with that single request", async (_what, answer) => {
    const before = directory.count(LANDING);
    const error = await errorOf("directory-specialties", doctors, [landing(answer)]);
    expect(error.code).toMatch(/^LISTING_|^TIMED_OUT|^REQUEST_/);
    expect(directory.count(LANDING)).toBe(before + 1);
  });

  test.each<[string, Partial<Route>, string]>([
    ["a request that times out", { throw: "TimeoutError" }, "TIMED_OUT"],
    ["a request that is cancelled", { throw: "AbortError" }, "REQUEST_CANCELLED"],
    ["a network that fails", { throw: "Error" }, "LISTING_UNREACHABLE"],
    ["a body that times out halfway", { headers: AS_HTML, streamError: "TimeoutError" }, "TIMED_OUT"],
  ])("%s has a code of its own", async (_what, answer, code) => {
    await directory.fails("directory-specialties", doctors, [landing(answer)], code);
  });

  // Where a network policy blocks the directory host, fetch fails with a TypeError.
  test("a host the network refuses to connect to is the network's failure, worth another try later", async () => {
    const blocked = landing({ throw: "TypeError" });
    const error = await directory.fails("directory-specialties", doctors, [blocked], "LISTING_UNREACHABLE");
    expect(error).toMatchObject({ retry: "later", cause: "network" });
    expect(error.message).toContain("could not be reached");
  });
});

describe("a provider's card", () => {
  let listed: Arguments;
  beforeAll(async () => {
    const [provider] = (await find(AMONG_DOCTORS)).providers;
    listed = { ...AMONG_DOCTORS, reference: provider.reference };
  });

  test("a provider the repeated search has lost is gone, and no card is asked for", async () => {
    await directory.fails("directory-provider", listed, [NOBODY_FOUND], "LISTING_REFERENCE_GONE");
    expect(box.fetches().at(-1)?.url).toContain(SEARCH_API);
  });

  test("résumé lines and treatments keep their fixed fields and lose the link beside them", async () => {
    const link = { URL: "https://example.invalid/never-shown" };
    const headings = [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [
      [`Title${n}`, `סעיף ${n}`],
      [`Title${n}_Contents`, ""],
    ]);
    const resume = { ...Object.fromEntries(headings), Resume_Topic: "התמחות" };
    const note = { Mlh: "", NewLine: false, Line_Number: "4", Remark_Text: "נדרשת התחייבות" };
    const treatment = {
      Remark_Text: [note],
      Cpt_Code: "8140",
      Is_Personal: "",
      Cpt_Pubt_Name: "כינוי לציבור",
      Sg_Treat_Name: "הזרקה",
    };
    const linked = merge(CARD, { Treatments: [{ ...link, ...treatment }], ResumeLines: [{ ...link, ...resume }] });
    const { data } = await directory.ok("directory-provider", listed, [linked]);
    expect(data.Treatments).toEqual([treatment]);
    expect(data.ResumeLines).toEqual([resume]);
  });

  test.each<[string, Arguments]>([
    ["is for another position", { PositionId: "31" }],
    ["admits to failing", { Success: false }],
    ["has a contact whose type is text", { ContactDetails: [{ Type: "1" }] }],
    ["has an address of 16,385 characters", { Full_Adress: "y".repeat(16_385) }],
  ])("a card that %s is not shown", async (_how, change) => {
    const error = await errorOf("directory-provider", listed, [merge(CARD, change)]);
    expect(error.code).toMatch(/^LISTING_/);
  });
});

describe("what the directory gets to see", () => {
  test("every request above went to serguide alone: no cookie, no authorization, no redirect followed", () => {
    const sent = box
      .fetches()
      .filter(({ url }) => [LANDING, SETTINGS_API, SEARCH_API, CARD].some((part) => url.includes(part)));
    expect(sent.length).toBeGreaterThan(20);
    const anonymous = { redirect: "manual", authorization: "", cookie: "", origin: "https://serguide.maccabi4u.co.il" };
    for (const request of sent) expect(request).toMatchObject(anonymous);
  });

  test("the fake was asked for nothing it does not serve, and no socket was opened", () => {
    expect(box.unexpected()).toEqual([]);
  });
});
