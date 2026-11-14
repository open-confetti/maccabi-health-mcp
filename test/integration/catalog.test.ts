/**
 * `portal` and `portal-document` end to end: the built bundle as an MCP server, the fake Maccabi behind
 * it. The catalog is an allowlist, and this file looks at it from three sides. What it lists: read-only
 * path templates, each priority endpoint answering. What it lets in: only its own names and documented
 * parameters, and only ids found in the member's own fresh data. What comes back: every field Maccabi
 * sent, signatures and private links included, without the identity numbers, and a reference beside
 * each document that still opens it after the signature has changed. The CLI is used twice, for what
 * only it has: the listing with nobody signed in, and `--params`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  answerWith,
  bootstrap,
  call,
  carriesNone,
  ID,
  MEMBER,
  memberSession,
  merge,
  type Route,
  SOMEONE_ELSE,
  type ToolResult,
} from "../rig";

/**
 * What test/fake/portal.mjs writes into its answers and no result may show: a relative's id number, and
 * the owner's checksum, passport and technical id. Signatures and private links are missing from this
 * list deliberately. Maccabi gives those to the member's browser, so the tool passes them on.
 */
const CHECKSUM = "MOCKMEMBERSUM63";
const WITHHELD = ["31415926", CHECKSUM, "MOCKTRAVELDOC18", "MOCKTECHREF52"];
const session = memberSession("portal", WITHHELD);
const { box, ok, fails } = session;

type Params = Record<string, string>;
type Args = Record<string, unknown>;
/** How `portal-endpoints` describes one endpoint. */
interface Entry {
  name: string;
  method: string;
  path: string;
  priority: boolean;
  post?: string;
  boundTo?: string[];
  params: Record<string, { pattern: string }>;
}

const OPAQUE = /^[0-9a-f]{64}$/;
const FLU = "/eligibility/vaccines/flu";
/** The one service the fake's eligibility list holds, as parameters. */
const OPTICS: Params = { subject_id: "37", service_code: "8120", service_enum: "5", service_type: "T" };

const reading = (endpoint: string, params?: Params): Args => (params ? { endpoint, params } : { endpoint });
/** The `data` one endpoint returns while the fake answers with `routes` instead of its own. */
const dataGiven = async (routes: Route[], endpoint: string, params?: Params): Promise<any> =>
  (await ok("portal", reading(endpoint, params), routes)).data;
const dataOf = (endpoint: string, params?: Params): Promise<any> => dataGiven([], endpoint, params);

/** The fake writes a name into each PDF it serves. Downloads one document and reads that name back. */
async function pdfNamed(endpoint: string, reference?: string): Promise<string> {
  const args = reference ? { endpoint, reference } : { endpoint };
  const pdf = (await session.file("portal-document", args)).toString("latin1");
  expect(pdf.slice(0, 5)).toBe("%PDF-");
  return pdf.match(/^% mock (\S+)$/m)?.[1] ?? "";
}

/**
 * A single read with the fake switched to another scenario. The session's own helpers put the normal
 * scenario back before every call, so this goes to the server directly and repeats their leak check.
 */
async function inScenario(scenario: string, operation: string, args: Args): Promise<ToolResult> {
  box.override({ scenario });
  const result = await call(session.client(), "maccabi_read", { operation, arguments: args });
  carriesNone(result, WITHHELD, operation);
  return result;
}

/** Input the catalog turns down by itself: BAD_INPUT, and the fake hears nothing. */
async function turnedDown(operation: string, args: Args): Promise<void> {
  const heard = box.fetches().length;
  await fails(operation, args, [], "BAD_INPUT");
  expect(box.fetches(), JSON.stringify(args)).toHaveLength(heard);
}

/** JSON bodies the fake logged for catalog POSTs to paths ending in `tail`, oldest first. */
const posted = (tail: string): unknown[] =>
  box.log().flatMap((entry) => (entry.kind === "portal-body" && `${entry.path}`.endsWith(tail) ? [entry.body] : []));

beforeAll(session.start);

describe("the listing", () => {
  /** Pieces of the paths the website changes state, mints a credential or logs through. */
  const WRITE_PIECES = [
    ...["/read/", "token", "process_debt_payment", "createdebit", "enroll", "patient_relations", "kafka"],
    ...["setDocumentRead", "toggle", "viewed", "read_approval", "joinwaitinglist", "cancel"],
    ...["summon_appointment", "odoro"],
  ];
  /** Parameters for the priority endpoints that cannot be read without any. */
  const NEEDED: Record<string, Params> = {
    "switchit-registrations": { registration_id: "swap-52" },
    "uploaded-files": { event_source_id: "K7", events: "event-40" },
    "service-rights": OPTICS,
    "service-history": OPTICS,
    "appointment-files": { appointment_id: "booking-3" },
  };
  let catalog: Entry[] = [];
  beforeAll(async () => {
    catalog = (await ok("portal-endpoints")).endpoints;
  });

  it("is printed by the CLI with nobody signed in and nothing requested", () => {
    const heard = box.fetches().length;
    const printed = box.cli(["portal-endpoints"], { config: "signed-out" });
    expect([printed.code, printed.json().endpoints.length]).toEqual([0, 83]);
    expect(box.fetches()).toHaveLength(heard);
  });

  it("names each endpoint once, as a GET or as a POST that states why it only asks", () => {
    const names = catalog.map(({ name }) => name);
    expect(names).toEqual([...new Set(names)]);
    for (const { name, method, post, boundTo = [] } of catalog) {
      expect(method, name).toMatch(/^(?:GET|POST)$/);
      if (method === "POST") expect(post, name).toBeTruthy();
      expect(names, name).toEqual(expect.arrayContaining(boundTo));
    }
  });

  it("holds only fixed templates below mac/, closed to traversal, to a query and to every write path", () => {
    for (const { name, path, params } of catalog) {
      expect(path.startsWith("mac/"), name).toBe(true);
      expect(path, name).not.toMatch(/\.\.|\/\/|[?#]/);
      const writes = WRITE_PIECES.filter((piece) => path.includes(piece));
      expect(writes, name).toEqual([]);
      // Every parameter pattern is anchored at both ends, so a value cannot smuggle anything past it.
      for (const [param, { pattern }] of Object.entries(params))
        expect(pattern, `${name}.${param}`).toMatch(/^\^.*\$$/);
    }
  });

  it("has every priority endpoint answer, bar the one bound to a list the fake leaves empty", async () => {
    const priority = catalog.filter((entry) => entry.priority);
    expect(priority.length).toBeGreaterThan(30);
    for (const { name } of priority) {
      const args = reading(name, NEEDED[name]);
      // The fake has no upcoming appointment, so no appointment id can be the member's.
      if (name === "appointment-files") await fails("portal", args, [], "NOT_THE_MEMBERS");
      else expect((await ok("portal", args)).source.operation).toBe(name);
    }
  });
});

describe("what a read returns", () => {
  it("leaves dates, codes and nulls of the doctor-assignment eligibility as they were sent", async () => {
    expect(await dataOf("doctor-assignment-eligibility")).toMatchObject({
      permanent_ascription_indication: null,
      last_visit_date: "2001-01-01",
      facility_code: 9000,
      next_possible_assign_date: "2030-01-01",
    });
  });

  it("drops the member id from a notification and keeps the ids that route it", async () => {
    const [notice] = (await dataOf("notifications-and-updates")).notification_and_updates;
    expect(notice).not.toHaveProperty("member_id");
    expect(notice).toMatchObject({
      doc_type_name: "הפניה לבדיקה",
      timestamp_sequence: "000001",
      pernr: 1001,
      object_id: 1000,
      appointment_id: "visit-1",
    });
  });

  // The private link is one Maccabi hands, token and all, to the member's own browser.
  it("flags a private portal link as present and returns it whole, and leaves a public page unflagged", async () => {
    const [refunds] = await dataOf("request-topics");
    expect(refunds).not.toHaveProperty("eligibility_link_present");
    expect(refunds.eligibility_link).toBe("https://www.maccabi4u.co.il/new/eligibilites/6/");
    expect(refunds.subtopic_array[0]).toMatchObject({
      crm_code: 46,
      eligibility_link_present: true,
      eligibility_link: "/sonline/private/refund-form?token=MOCKFORMTOKEN",
    });
  });

  it("treats a link on the portal's host, and one with a signature in its query, as private too", async () => {
    const sent = {
      leaflet_url: "https://online.maccabi4u.co.il/sonline/leaflets/flu.pdf",
      booking_link: "https://clinic.example.invalid/book?signature=made-up",
    };
    const returned = await dataGiven([answerWith(FLU, sent)], "flu-vaccine-eligibility");
    expect(returned).toEqual({ ...sent, booking_link_present: true, leaflet_url_present: true });
  });

  it("refuses to return more than 4 MiB", async () => {
    const huge = answerWith(FLU, { padding: "0".repeat(4 * 1024 * 1024) });
    await fails("portal", reading("flu-vaccine-eligibility"), [huge], "UNEXPECTED_ANSWER", "oversized");
  });

  it("keeps a relative's name, role and status, and nobody's national id", async () => {
    const { payer_billing_subjects: billed } = await dataOf("payer-billing-subjects");
    expect(billed).toEqual([
      {
        member_status: "חבר פעיל",
        member_last_name: "אלמוני",
        member_first_name: "פלוני",
        status_in_family: "ראש משפחה",
      },
    ]);
  });

  it("removes a credential or identity key however it is spelled or nested, never the prose around it", async () => {
    const remark = "the words token and member_id are only text here";
    const spelled = {
      idToken: "t",
      "Set-Cookie": { inner: { shown: 1 } },
      MEMBER_ID: 9,
      "Member Id": 9,
      "member.id": 9,
    };
    const upstream = answerWith(FLU, { groups: [{ card: { lines: [{ ...spelled, remark }] } }] });
    expect(await dataGiven([upstream], "flu-vaccine-eligibility")).toEqual({
      groups: [{ card: { lines: [{ remark }] } }],
    });
  });

  it("strips the patient group from a DICOM tag bag, and reads a list of that name as an ordinary list", async () => {
    const tags = { "00100020": "patient", "00180015": "MOCKPART" };
    const upstream = answerWith(FLU, {
      attributes: [{ label: "plain row", MEMBER_ID: 1 }],
      studies: [{ Attributes: tags }],
    });
    expect(await dataGiven([upstream], "flu-vaccine-eligibility")).toEqual({
      attributes: [{ label: "plain row" }],
      studies: [{ Attributes: { "00180015": "MOCKPART" } }],
    });
  });
});

describe("a POST query is sent with the website's body, built here and never by the caller", () => {
  const ASKED = "/inquiries/eligibility";
  const owner = { member_id_code: "0", member_id: MEMBER };
  const clinic = { appointment_date: "2027-02-08", employee_id: "0", object_id: "4410", object_type: "O" };
  const leave = { total_days: "4", to: "2027-01-21", from: "2027-01-18" };

  it("asks for the service eligibilities by the member's age and insurance type", async () => {
    await dataOf("service-eligibilities");
    expect(posted("/eligibilities").at(-1)).toEqual({ sex: null, ins_type_code: "02", age: 26 });
  });

  it("live: says of a 403 for the service eligibilities that it is final, and why", async () => {
    const forbidden: Route = { match: "/eligibilities", text: "", status: 403 };
    const refusal = await fails("portal", reading("service-eligibilities"), [forbidden], "HTTP_REFUSED", "status=403");
    expect(refusal).toMatchObject({ known_issue: expect.stringContaining("website"), retry: "no", cause: "maccabi" });
  });

  // The request wizard sends the numeric service_code of the doctor list and the member's remark codes
  // joined by commas; the fake answers a body of any other shape with HTTP 400.
  it("asks about a doctor of the member's own list the way the request wizard does", async () => {
    const answer = await dataOf("inquiry-eligibility", { service_code: "27" });
    expect(answer).toMatchObject({ limit_count: 4, requests_count: 1, is_valid_request: true });
    expect(posted(ASKED).at(-1)).toEqual({
      patient_codes: "31,47",
      is_from_recommendation: false,
      service_code: 27,
    });
  });

  it("leaves patient_codes out for an account whose bootstrap has no remarks", async () => {
    const result = await inScenario("no-remarks", "portal", reading("inquiry-eligibility", { service_code: "10" }));
    expect(result.isError).not.toBe(true);
    expect(posted(ASKED).at(-1)).toEqual({ is_from_recommendation: false, service_code: 10 });
  });

  it("stops at a service code that belongs to none of the member's doctors", async () => {
    const before = posted(ASKED).length;
    await fails("portal", reading("inquiry-eligibility", { service_code: "98" }), [], "NOT_THE_MEMBERS");
    expect(posted(ASKED)).toHaveLength(before);
  });

  it.each([
    {
      endpoint: "doctor-assignment-search",
      params: { city: "קרית דוגמה" },
      path: "/clinics_assignment_eligibility_results",
      body: { eligibility_request: { ...owner, city: "קרית דוגמה" } },
    },
    {
      endpoint: "visit-triage",
      params: clinic,
      path: "/visits/triage",
      body: { ...clinic, is_treatareatype: false, members: [owner] },
    },
    {
      endpoint: "sick-note-eligibility",
      params: leave,
      path: "/automatic/request/eligibility",
      body: { total_days: 4, age: 26, to_date: leave.to, from_date: leave.from },
    },
  ])("$endpoint posts a body made of its parameters and the account", async ({ endpoint, params, path, body }) => {
    await dataGiven([answerWith(path, { heard: 1 })], endpoint, params);
    expect(JSON.parse(session.last(path).body)).toEqual(body);
  });
});

describe("nothing is requested for input the catalog does not know", () => {
  it("has no endpoint under a write's name, a path, an unused read, an inherited name or another casing", async () => {
    const names = ["summon-appointment", "../kafka/message", "member-details-v3", "valueOf", "Entitlement"];
    for (const name of names) await turnedDown("portal", reading(name));
  });

  it("says of an endpoint that was removed why it is gone and where its data is found", async () => {
    const heard = box.fetches().length;
    const { message } = await fails("portal", reading("test-information", { test_id: "1" }), [], "BAD_INPUT");
    for (const said of ["SMS", "lab-history"]) expect(message).toContain(said);
    expect(box.fetches()).toHaveLength(heard);
  });

  it("takes no parameter that is undocumented, inherited, absent though required, empty or a path", async () => {
    await turnedDown("portal", reading("letters", { url: "/sonline/elsewhere" }));
    await turnedDown("portal", reading("letters", { toString: "1" }));
    await turnedDown("portal", reading("switchit-registrations"));
    await turnedDown("portal", reading("switchit-registrations", { registration_id: "" }));
    await turnedDown("portal", reading("letters", { to: "../../kafka/message" }));
    await turnedDown("portal", reading("service-history", { ...OPTICS, service_code: "81/20" }));
  });

  it("reads a document only as a document, and a JSON endpoint as one only through a reference", async () => {
    await turnedDown("portal", reading("bank-terms-pdf"));
    await turnedDown("portal-document", reading("letters"));
    await turnedDown("portal-document", { endpoint: "letters", reference: "reference-of-nothing" });
  });

  it("does not say back the name, the parameter or the value it turned down", async () => {
    const marker = "ECHO-51c9";
    const attempts = [reading(marker), reading("letters", { [marker]: "1" }), reading("letters", { to: marker })];
    for (const args of attempts) {
      const result = await session.run("portal", args);
      expect(result.structuredContent.error.code).toBe("BAD_INPUT");
      carriesNone(result, [marker]);
    }
  });
});

describe("parameters", () => {
  it("puts a swap registration's id into the path", async () => {
    const registration = await dataOf("switchit-registrations", { registration_id: "swap-52" });
    expect(registration).toMatchObject({ appointment_id: "booking-18", registration_id: "swap-52" });
  });

  it("defaults the letters' range to everything from 1990 until today", async () => {
    await dataOf("letters");
    const { from_date, to_date } = session.query("/letters_for_member?");
    expect(from_date).toBe("1990-01-01");
    const dayAndAHalf = 36 * 60 * 60 * 1000;
    expect(Math.abs(Date.parse(`${to_date}T12:00:00Z`) - Date.now())).toBeLessThan(dayAndAHalf);
  });

  it("sends the member checksum where the website's member-details request has it, and returns none", async () => {
    const withChecksum = bootstrap({ current_customer_info: { checksum_id: CHECKSUM } });
    const details = await dataGiven([withChecksum], "member-details");
    expect(details).toMatchObject({ buy_services_organization_code: 2, language_code: 2 });
    expect(session.query(`/MainAppAPI/webapi/mac/v2/members/0/${ID}?`).checksum).toBe(CHECKSUM);
  });

  it("come from the CLI as one --params KEY=VALUE each", () => {
    const flags = Object.entries(OPTICS).flatMap((pair) => ["--params", pair.join("=")]);
    const rights = box.cli(["portal", "--endpoint", "service-rights", ...flags], { config: "portal" });
    expect(rights.code, rights.err).toBe(0);
    expect(rights.json().source.operation).toBe("service-rights");
    const printed = rights.out + rights.err;
    for (const value of WITHHELD) expect(printed).not.toContain(value);
  });
});

describe("ids must be the member's own", () => {
  const RIGHTS = "member_service_rights";
  /** `params` is refused as not the member's, and the rights query is never sent. */
  async function neverAsked(params: Params, routes: Route[] = []): Promise<void> {
    const sent = session.count(RIGHTS);
    await fails("portal", reading("service-rights", params), routes, "NOT_THE_MEMBERS", "id-unknown");
    expect(session.count(RIGHTS)).toBe(sent);
  }

  it("refuses a service the fresh eligibility list does not hold", async () => {
    await neverAsked({ ...OPTICS, subject_id: "98" });
  });

  it("refuses ids that are each the member's but come from two different rows", async () => {
    const lenses = { service_type: "T", service_enum: "5", service_code: 8120, subject_id: 37 };
    const frames = { ...lenses, service_code: 8121, subject_id: 38 };
    const subjects = [{ services: [lenses] }, { services: [frames] }];
    const twoRows = answerWith("=/sonline/DirectorshipAPI/webapi/mac/eligibilities", { subjects });
    await neverAsked({ ...OPTICS, service_code: "8121" }, [twoRows]);
  });

  it.each([
    ["at the top of a row", { member_id: `${SOMEONE_ELSE}` }],
    ["deep inside the member's row", { member_id: MEMBER, inner: { rows: [{ member_id: SOMEONE_ELSE }] } }],
    ["by the id code alone", { member_id_code: "1", member_id: MEMBER }],
  ])("fails closed on an answer that names another member %s", async (_where, row) => {
    const feed = answerWith("/get_notification_and_updates", { notification_and_updates: [row] });
    const args = reading("notifications-and-updates");
    await fails("portal", args, [feed], "NOT_THE_MEMBERS", "names-another-member");
  });
});

describe("documents", () => {
  const letterOf = async () => (await dataOf("letters")).letters[0];
  /** The fake's two vaccine groups: an ordinary one, and one with a COVID group code. */
  const vaccineGroups = async () => (await dataOf("vaccination-groups")).timeline;

  it("lists a letter with Maccabi's signature untouched and without the link that names the checksum", async () => {
    const letter = await letterOf();
    expect(Object.keys(letter).filter((key) => key.startsWith("preview_url"))).toEqual([]);
    expect(letter).toMatchObject({
      hash: expect.stringMatching(/^sig%2F/),
      timestamp: expect.stringMatching(/^issued-at-/),
      item_date: "2026-03-17",
      letter_code: 58,
      reference_id: "mail-ref-7",
    });
  });

  it("opens a letter by the reference of an older listing, after its signature has changed", async () => {
    const older = await letterOf();
    const newer = await letterOf();
    expect(newer.timestamp).not.toBe(older.timestamp);
    expect(await pdfNamed("letters", older.document_reference)).toBe("mailing-7");
  });

  it("opens the insurance-seniority certificate by the reference next to its signature", async () => {
    const seniority = await dataOf("insurance-seniority");
    expect(seniority).toMatchObject({
      document_reference: expect.stringMatching(OPAQUE),
      hash: expect.stringMatching(/^sig\d/),
      timestamp: expect.stringMatching(/^at\d/),
    });
    expect(seniority.insurance_groups).toEqual([
      { ins_status: "1", ins_seniority_date: "2001-01-01", ins_type_code: "07" },
    ]);
    expect(await pdfNamed("insurance-seniority", seniority.document_reference)).toBe("seniority-letter");
  });

  it("opens a referral by the reference next to its link", async () => {
    const [referral] = (await dataOf("referrals-full")).referrals;
    expect(referral).toMatchObject({ pdf_link: "%2Fmock%2Freferral.pdf", referral_id: "ref-1" });
    expect(await pdfNamed("referrals-full", referral.pdf_link_reference)).toBe("referral");
  });

  it("gives a document to a COVID vaccination group alone, the one kind the website has a print button for", async () => {
    const [ordinary, covid] = await vaccineGroups();
    expect(ordinary).not.toHaveProperty("document_reference");
    expect(await pdfNamed("vaccination-groups", covid.document_reference)).toBe("vaccine-group-card");
  });

  // Live, a PDF route can answer with Maccabi's HTML error page; the website then says the document
  // cannot be opened.
  it("reports Maccabi's HTML error page on a PDF route as that, not as a broken PDF", async () => {
    const [, { document_reference: reference }] = await vaccineGroups();
    const result = await inScenario("pdf-error-page", "portal-document", { reference, endpoint: "vaccination-groups" });
    expect(result.structuredContent.error).toMatchObject({
      detail: "maccabi-error-page:document-cannot-be-opened",
      code: "PORTAL_REPORTED_ERROR",
      known_issue: expect.stringContaining("vaccine-doses"),
      retry: "no",
      cause: "maccabi",
    });
  });

  it("opens an application's form by its reference", async () => {
    const [application] = (await dataOf("applications")).results;
    expect(application).toMatchObject({
      hash: expect.stringMatching(/^sig\d/),
      status: "בבדיקה",
      archive_form_id: 15,
      form_id: 7260,
    });
    expect(await pdfNamed("applications", application.document_reference)).toBe("health-declaration-form");
  });

  it("opens a report that arrives as base64 by its reference", async () => {
    const { base64_reference } = await dataOf("purchased-medication-report");
    expect(await pdfNamed("purchased-medication-report", base64_reference)).toBe("purchased-report");
  });

  it("live: opens a base64 report by its reference although Maccabi builds the PDF anew for every request", async () => {
    const endpoint = "purchased-medication-report";
    const { base64_reference: reference } = await dataOf(endpoint);
    const rebuilt = Buffer.from("%PDF-1.4\n% mock rebuilt-report\n%%EOF\n").toString("base64");
    const secondTime = answerWith("/prescriptions/purchased/report", { base64: rebuilt, type: "pdf" });
    const pdf = await session.file("portal-document", { reference, endpoint }, [secondTime]);
    expect(pdf.toString("utf8")).toContain("rebuilt-report");
  });

  const leaflet = {
    hash: "leaflet%2Fsig",
    timestamp: "leaflet-stamp",
    url: "%2Fmock%2Fleaflet%2Fsheet.pdf",
    type_id: 1,
  };
  const sickNote = { hash: "permit%2Fsig", timestamp: "permit-stamp", result_file: "%2Fmock%2Fpermit%2Fnote.pdf" };
  const permit = { medical_forms_documents: [sickNote], type: "automatic_sick_permit", request_id: "inq-41" };
  it.each<{ endpoint: string; routes: Route[]; pick: (data: any) => string; route: string; signed: Params }>([
    {
      endpoint: "tutorials",
      routes: [answerWith("/tutorials?", { tutorials: [leaflet] })],
      pick: (data) => data.tutorials[0].document_reference,
      route: "/MedicalFileAPI/webapi/mac/v2/",
      signed: { hash: "leaflet/sig", timestamp: "leaflet-stamp", url: "/mock/leaflet/sheet.pdf" },
    },
    {
      endpoint: "inquiries-full",
      routes: [answerWith("/inquiries", { inquiries: [permit] })],
      pick: (data) => data.inquiries[0].medical_forms_documents[0].document_reference,
      route: `/AppointmentOrderAPI/webapi/mac/v1/members/0/${ID}/pdf`,
      signed: { hash: "permit/sig", timestamp: "permit-stamp", path: sickNote.result_file },
    },
    {
      endpoint: "latest-lab-results-full",
      routes: [],
      pick: (data) => data.document_reference,
      route: "/getlatestlabresults/report",
      signed: { is_attachment: "false", irregular_only: "false", hash: "latest+hash", t: "newesttime" },
    },
  ])("$endpoint: fetches the document from its own route, signed with the row's fields", async (row) => {
    const reference = row.pick(await dataGiven(row.routes, row.endpoint));
    const pdf = await session.file("portal-document", { reference, endpoint: row.endpoint }, row.routes);
    expect(pdf.toString("latin1")).toContain("%PDF-");
    expect(session.query(row.route)).toEqual(row.signed);
  });

  it("gives no reference to a row whose signature or link could not be sent on unchanged", async () => {
    const unsendable = merge("/insurance/seniority", { hash: "sig#1" });
    expect(await dataGiven([unsendable], "insurance-seniority")).not.toHaveProperty("document_reference");
    const undecodable = { timestamp: "stamp", hash: "sig", pdf_link: "%E0%A4%A", referral_id: "ref-77" };
    const listed = answerWith("/referrals?", { referrals: [undecodable] });
    const { referrals } = await dataGiven([listed], "referrals-full");
    expect(referrals).toEqual([{ ...undecodable, pdf_link_present: true }]);
  });

  it("refuses a base64 report that would decode to more than the 2 MiB a document may have", async () => {
    const base64 = "A".repeat(Math.ceil((2 * 1024 * 1024) / 3) * 4 + 4);
    const bloated = [answerWith("/prescriptions/purchased/report", { base64, type: "pdf" })];
    const endpoint = "purchased-medication-report";
    const { base64_reference: reference } = await dataGiven(bloated, endpoint);
    await fails("portal-document", { reference, endpoint }, bloated, "UNEXPECTED_ANSWER", "file:oversized");
  });

  it("reads a document-only endpoint without a reference, and refuses one offered for it", async () => {
    const endpoint = "bank-terms-pdf";
    expect(await pdfNamed(endpoint)).toBe("direct-debit-terms");
    await fails("portal-document", { endpoint, reference: "f".repeat(64) }, [], "BAD_INPUT");
  });

  it("refuses a well-formed reference that no row of a fresh listing carries", async () => {
    await fails("portal-document", { reference: "e".repeat(64), endpoint: "letters" }, [], "NOT_THE_MEMBERS");
  });
});

it("asked the fake for nothing it does not serve, and opened no socket", () => {
  expect(box.unexpected()).toEqual([]);
});
