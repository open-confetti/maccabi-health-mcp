/**
 * Account and medical-file reads, driven through the MCP server of the built bundle with the fake
 * Maccabi behind it. One signed-in session covers: who may access the account, the member's contact
 * and payment details, a payer's totals, mailings and the three ways their documents are fetched,
 * sensitivities, vaccinations, certificates, additional information, the account-wide PDFs,
 * administrative requests with their attachments, prescriptions and referrals.
 *
 * Three rules recur. A read answers for the signed-in member alone: a row of somebody else, of a
 * dependent, or a reference the newly fetched list lacks, is refused. An upstream answer in a shape
 * nobody observed is reported as this client's gap and never as "no records". A row that has a
 * document keeps the link and signature Maccabi sent, and gains a stable reference to download it by.
 * What every PDF download checks (route, content type, size, PDF header, logout page) is spelled out
 * once, on the English summary. Every value here is made up.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { answerWith, bootstrap, LOGOUT_PAGE, MEMBER, memberSession, merge, type Route, SOMEONE_ELSE } from "../rig";

/** The fake's standing order carries an account number; like the other member's id, no result may. */
const ACCOUNT_NUMBER = "99999999";
const session = memberSession("records", [ACCOUNT_NUMBER, String(SOMEONE_ELSE)]);
const { box, ok, fails, file, expired, last, query: queryOf, count: countOf } = session;

const RANGE = { from: "2026-02-23", to: "2026-10-31" };
const SHA256_HEX = /^[0-9a-f]{64}$/;
const NO_SUCH_REFERENCE = "e3".repeat(32);
const MIB = 1024 * 1024;
/** The longest list of authorized users the tool takes. */
const MOST_USERS = 100;
/** A portal address no read requests, for an answer that claims to come from the wrong place. */
const ELSEWHERE = new URL("/sonline/somewhere-else", LOGOUT_PAGE).href;
const asBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

type Args = Record<string, unknown>;
/** The `data` of a read that must succeed. */
const read = async (operation: string, args: Args = {}, routes: Route[] = []) =>
  (await ok(operation, args, routes)).data;
/** The text of the document a read returned. */
const documentText = async (operation: string, args: Args = {}, routes: Route[] = []) =>
  (await file(operation, args, routes)).toString("utf8");
/** The portal's feature list holding exactly these switches (on, unless a value is given). */
const switches = (...named: [id: string, enabled?: unknown][]): Route =>
  answerWith(
    "/features",
    named.map(([feature_id, feature_enabled = true]) => ({ feature_id, feature_enabled })),
  );

beforeAll(session.start);

describe("who may use the account", () => {
  const ACCOUNTS = "/accounts";
  const granted = [{ message: "ok", type: "S-Success" }];
  const person = { user_id: 7, last_name: "אלמוני", first_name: "פלוני", authentication_end_date: "some day" };
  const accounts = (body: unknown): Route[] => [answerWith(ACCOUNTS, body)];

  it("lists the authorized users in full, minus each one's identity number", async () => {
    expect(await read("authorized-users")).toEqual({
      users: [
        {
          last_name: "מדומה",
          first_name: "נציג",
          patient_relation_id: "MOCKRELATION19",
          user_technical_id: "MOCKTECHNICAL07",
          authentication_end_date: "2031-06-30",
        },
      ],
      messages: [{ message: "אישור מדומה", type: "S-Success" }],
      state: "viewer-list",
    });
    expect(last(ACCOUNTS)).toMatchObject({ method: "GET" });
  });

  it("reads `users: null` under a warning as nobody authorized yet", async () => {
    const messages = [{ message: "אין מורשים", type: "W-Warning" }];
    const nobody = await read("authorized-users", {}, accounts({ messages, users: null }));
    expect(nobody).toEqual({ messages, users: [], state: "creation-available" });
  });

  it("takes an identity number that arrives as a number", async () => {
    await ok("authorized-users", {}, accounts({ messages: granted, users: [person] }));
  });

  it("refuses a list that names a different member", async () => {
    const foreign = accounts({ users: [], member_id: SOMEONE_ELSE });
    await fails("authorized-users", {}, foreign, "NOT_THE_MEMBERS");
  });

  it.each<[string, unknown]>([
    ["an empty object", {}],
    ["users that are not a list", { messages: granted, users: {} }],
    ["a message of an unknown type", { messages: [{ message: "ok", type: "E-Error" }], users: null }],
    ["two messages", { messages: [...granted, ...granted], users: null }],
    ["one user more than the list may hold", { messages: granted, users: Array(MOST_USERS + 1).fill(person) }],
    ["a user without a first name", { messages: granted, users: [{ ...person, first_name: null }] }],
    ["a negative identity number", { messages: granted, users: [{ ...person, user_id: -1 }] }],
    ["a control character in a date", { messages: granted, users: [{ ...person, authentication_end_date: "\u0000" }] }],
    ["users listed under a warning", { messages: [{ message: "ok", type: "W-Warning" }], users: [person] }],
  ])("refuses %s as a changed shape", async (_what, body) => {
    await fails("authorized-users", {}, accounts(body), "UNEXPECTED_ANSWER", "shape-changed");
  });

  it("asks for nothing while a dependent is the selected member", async () => {
    // The member's own number under another id code is how the bootstrap names a dependent.
    const dependentSelected = bootstrap({ current_customer_info: { member_id_code: "1" } });
    const asked = countOf(ACCOUNTS);
    await fails("authorized-users", {}, [dependentSelected], "OTHER_MEMBER_SELECTED");
    expect(countOf(ACCOUNTS)).toBe(asked);
  });
});

describe("the member's own details", () => {
  const DEBIT = "/debit_authorization";
  const loggedIn = (logged_customer_info: Args): Route[] => [bootstrap({ logged_customer_info })];
  const phone = { phone_no: 0, phone_prefix: "050", phone_type: "ב", fax_special_prefix: "", line_note: "as sent" };

  it("profile: every bootstrap field is kept except the id, the passport and the checksums", async () => {
    const secret = { id_tech: "MOCKIDTECH08", checksum_id: "MOCKCHECKSUM62", passport_number: "MOCKPASSPORT31" };
    const harmless = { marital_status: "mock-status", preferred_language: "ru" };
    const profile = await read("profile", {}, loggedIn({ ...secret, ...harmless }));
    expect(profile).toMatchObject({
      ...harmless,
      age: { years: 26 },
      birth_date: "2000-01-01",
      f_name_hebrew: "בדויה",
    });
    const withheld = [...Object.keys(secret), "member_id", "member_id_code"];
    expect(Object.keys(profile).filter((key) => withheld.includes(key))).toEqual([]);
    const printed = JSON.stringify(profile);
    expect(Object.values(secret).filter((value) => printed.includes(value))).toEqual([]);
  });

  it("contact details: taken from the bootstrap, a phone with all its fields", async () => {
    const contact = await read("contact-details");
    expect(contact.phones).toEqual([]);
    expect(contact.email).toBe("specimen@example.invalid");
    expect(contact.addresses).toEqual([expect.objectContaining({ po_box: 0, city_name: "עיר בדוי" })]);
    expect((await read("contact-details", {}, loggedIn({ phones: [phone] }))).phones).toEqual([phone]);
  });

  it("contact details: the field that changed is the one reported", async () => {
    const [address] = (await read("contact-details")).addresses;
    await fails(
      "contact-details",
      {},
      loggedIn({ phones: [{ ...phone, phone_no: "0" }] }),
      "UNEXPECTED_ANSWER",
      "key:phone_no",
    );
    await fails(
      "contact-details",
      {},
      loggedIn({ addresses: [{ po_box: 2 }] }),
      "UNEXPECTED_ANSWER",
      // Every text field is missing here; the one named is the first the reader checks, alphabetically.
      "key:address_for_mail",
    );
    await fails(
      "contact-details",
      {},
      loggedIn({ addresses: [{ ...address, po_box: -2 }] }),
      "UNEXPECTED_ANSWER",
      "key:po_box",
    );
  });

  it("payment methods: the standing order without its account number or its token", async () => {
    const order = await read("payment-methods");
    expect(order).toMatchObject({
      is_shaban_auth_only: false,
      auth_start_date: "2001-01-01",
      payment_method: 2,
      branch_code: 999,
      bank_code: 99,
      bank_name: "בנק מדומה",
    });
    for (const withheld of ["token", "account_number"]) expect(order).not.toHaveProperty(withheld);
    expect(last(DEBIT).url).toContain(`/payers/0/${MEMBER}${DEBIT}`);
  });

  it.each<[string, unknown]>([
    ["is_active_auth_exists", "true"],
    ["payment_method", "2"],
    ["bank_name", 99],
    ["auth_start_date", 20010101],
  ])("payment methods: a %s of the wrong type is reported by name", async (field, value) => {
    await fails("payment-methods", {}, [merge(DEBIT, { [field]: value })], "UNEXPECTED_ANSWER", `key:${field}`);
  });

  it("payment methods: a standing order without a start date keeps null there", async () => {
    const undated = await read("payment-methods", {}, [merge(DEBIT, { auth_start_date: null })]);
    expect(undated).toHaveProperty("auth_start_date", null);
  });

  describe("billing totals", () => {
    const DEBTS = "/finance/debts";
    const paidBy = (pays_id: number) => bootstrap({ logged_customer_info: { pays_id } });

    it("are not offered to a member who is their own payer", async () => {
      for (const routes of [[], [paidBy(MEMBER)]]) {
        await fails("billing-totals", {}, routes, "NOT_OFFERED", "payer-is-member");
      }
    });

    it("of somebody else's payer are labelled as that payer's aggregate", async () => {
      const totals = await ok("billing-totals", {}, [paidBy(SOMEONE_ELSE)]);
      expect(totals.source).toMatchObject({ scope: "payer-account-aggregate" });
      expect(totals.data).toEqual({ additional_charges_debt: 0, shaban_debt: 12.5, kupa_debt: 0 });
      expect(last(DEBTS).url).toContain(`${DEBTS}?person_type=1`);
    });

    it("with a sum that is not a number are refused", async () => {
      const asText = merge(DEBTS, { shaban_debt: "12.50" });
      await fails("billing-totals", {}, [paidBy(SOMEONE_ELSE), asText], "UNEXPECTED_ANSWER", "key:shaban_debt");
    });
  });
});

describe("mailings", () => {
  const LIST = "/all/letters_for_member";
  const BLOB = "/MainAppAPI/webapi/mac/v2/";
  const own = { original_item_date: "2026-04-02", item_date: "2026-04-01", member_id_code: "0", member_id: MEMBER };
  const letter = {
    ...own,
    letter_desc: "מכתב כלשהו",
    letter_type: 1,
    child_info: false,
    recipient_id_code: "0",
    recipient_id: MEMBER,
  };
  const record = { ...own, letter_type: 2, status: 1, hash: "sig", timestamp: "stamp", link: "one-link" };
  const sheet = { display_text: "sheet", tutorial_type: "pdf", hash: "sig", timestamp: "stamp", url: "sheet-path" };
  const listing = (...letters: unknown[]): Route[] => [answerWith(LIST, { letters })];
  const guidance = (...tutorials: unknown[]): Route[] =>
    listing({ ...own, letter_type: 3, practitioner_name: "someone", service_type_text: "a service", tutorials });
  const blobSwitch = switches(["isOpenPdfByLinkHandlerV2"]);
  const mailings = (routes: Route[] = []): Promise<any[]> => read("mailings", RANGE, routes);
  const download = (reference: string, routes: Route[] = [], range = RANGE) =>
    documentText("mailing-pdf", { reference, ...range }, routes);

  describe("the list", () => {
    it("is asked for the signed-in member only and holds one mailing of each kind", async () => {
      const answer = await ok("mailings", RANGE);
      expect(JSON.parse(last(LIST).body)).toEqual({
        members: [{ member_id: MEMBER, member_id_code: "0" }],
        to_date: RANGE.to,
        from_date: RANGE.from,
      });
      expect(answer.source).toMatchObject({ schemaEvidence: "frontend-field-projection" });
      const [, requested] = answer.data;
      expect(answer.data.map((row: any) => row.letter_type)).toEqual([1, 2, 3]);
      expect(requested).toMatchObject({ has_document: true, status: 1 });
    });

    it("keeps a tutorial as sent, private path and signature included", async () => {
      const [, , { tutorials }] = await mailings();
      const article = "https://www.maccabi4u.co.il/healthguide/mock-article";
      expect(tutorials).toEqual([
        {
          pdf_reference: expect.stringMatching(SHA256_HEX),
          display_text: "עלון תרגילים",
          tutorial_type: "pdf",
          hash: "sheetsig9",
          timestamp: "sheetstamp9",
          url: "%2Fmock%2Fexercise-sheet.pdf",
        },
        { link: article, url: article, display_text: "קריאה נוספת", tutorial_type: "webpage" },
      ]);
    });

    it("gives a video tutorial its link", async () => {
      const clip = { url: "https://example.invalid/clip", display_text: "סרטון קצר", tutorial_type: "video" };
      const [row] = await mailings(guidance(clip));
      expect(row.tutorials).toEqual([{ ...clip, link: clip.url }]);
    });

    it("gives no reference to a record that is not ready or to a letter without a document", async () => {
      const [pending] = await mailings(listing({ ...own, letter_type: 2, status: 0 }));
      expect(pending).toEqual({
        has_document: false,
        status: 0,
        letter_type: 2,
        original_item_date: own.original_item_date,
        item_date: own.item_date,
      });
      const [bare] = await mailings(listing(letter));
      expect(bare).not.toHaveProperty("reference");
    });

    it.each<[string, Args, string, string]>([
      ["of another member", { member_id: SOMEONE_ELSE }, "NOT_THE_MEMBERS", "names-another-member"],
      ["naming no member", { member_id: undefined }, "NOT_THE_MEMBERS", "names-another-member"],
      ["addressed to another member", { recipient_id: SOMEONE_ELSE }, "NOT_THE_MEMBERS", "recipient-is-another-member"],
      ["about a child", { child_info: true }, "NOT_THE_MEMBERS", "row-of-a-dependent"],
      [
        "that does not say whether it is about a child",
        { child_info: undefined },
        "UNEXPECTED_ANSWER",
        "key:child_info",
      ],
    ])("refuses the whole list over a letter %s", async (_whose, change, code, detail) => {
      await fails("mailings", RANGE, listing({ ...letter, ...change }), code, detail);
    });

    it.each<[string, unknown[], string, string]>([
      ["a kind nobody observed", [{ ...letter, letter_type: 8 }], "NOT_OFFERED", "letter-kind-unknown"],
      ["a description that is not text", [{ ...letter, letter_desc: 4 }], "UNEXPECTED_ANSWER", "key:letter_desc"],
      ["a record status out of range", [{ ...own, letter_type: 2, status: 9 }], "UNEXPECTED_ANSWER", "shape-changed"],
      ["the same record twice", [record, record], "UNEXPECTED_ANSWER", "row-twice"],
    ])("names what is wrong with %s", async (_what, letters, code, detail) => {
      await fails("mailings", RANGE, listing(...letters), code, detail);
    });

    it("refuses the same letter document listed twice", async () => {
      const carryingDocument = { ...letter, name_document: "doc", reference_id: "ref" };
      await fails("mailings", RANGE, listing(carryingDocument, carryingDocument), "UNEXPECTED_ANSWER", "row-twice");
    });

    it("refuses the same tutorial sheet listed twice", async () => {
      await fails("mailings", RANGE, guidance(sheet, sheet), "UNEXPECTED_ANSWER", "row-twice");
    });

    it.each<[string, Args]>([
      ["a sheet without a signature", { ...sheet, hash: undefined }],
      ["a tutorial of an unknown type", { ...sheet, tutorial_type: "leaflet" }],
      ["a script link", { tutorial_type: "webpage", display_text: "t", url: "javascript:void(0)" }],
      [
        "a link with credentials in it",
        { tutorial_type: "video", display_text: "t", url: "https://me:secret@example.invalid/v" },
      ],
      ["a link that is no URL", { tutorial_type: "video", display_text: "t", url: "see the clinic" }],
      [
        "a link with a line break",
        { tutorial_type: "webpage", display_text: "t", url: "https://example.invalid/a\nb" },
      ],
    ])("refuses %s as a changed shape", async (_what, tutorial) => {
      await fails("mailings", RANGE, guidance(tutorial), "UNEXPECTED_ANSWER", "shape-changed");
    });
  });

  describe("a document", () => {
    it("of a letter is fetched under the letter's two ids with its own signature", async () => {
      const [{ reference }] = await mailings();
      expect(await download(reference)).toContain("post-9");
      expect(queryOf("/post-doc-9/pdf")).toEqual({ hash: "letter+signature", timestamp: "letter-stamp-7" });
    });

    it("of a letter is looked up in a fresh list of whatever range the download names", async () => {
      const [{ reference }] = await mailings();
      const narrower = { from: "2026-05-15", to: "2026-07-15" };
      expect(await download(reference, [], narrower)).toContain("post-9");
      expect(JSON.parse(last(LIST).body)).toMatchObject({ to_date: narrower.to, from_date: narrower.from });
    });

    it("of a requested record goes by the PDF-link switch: signed v1 when off, the unsigned v2 blob when on", async () => {
      const [, { reference }] = await mailings();
      expect(await download(reference)).toContain("requested-record");
      const signed = last("/pdf?file_path=").url;
      expect(signed).toContain("/MainAppAPI/webapi/mac/v1/");
      expect(signed).toContain("?file_path=%2Fmock%2Frequested-record.pdf&timestamp=recordstamp4&hash=recordsig4");
      expect(await download(reference, [blobSwitch])).toContain("requested-record-blob");
      expect(new URL(last(BLOB).url).searchParams.has("hash")).toBe(false);
    });

    it("of a requested record is not fetched when the feature list lacks the switch", async () => {
      const [, { reference }] = await mailings();
      await fails("mailing-pdf", { reference, ...RANGE }, [switches()], "UNEXPECTED_ANSWER", "key:feature_enabled");
    });

    it("of a tutorial has a reference of its own", async () => {
      const [, , { tutorials }] = await mailings();
      expect(await download(tutorials[0].pdf_reference)).toContain("mailing-guide");
      expect(last("/pdf/http").url).toContain(
        "/pdf/http?file_path=%2Fmock%2Fexercise-sheet.pdf&timestamp=sheetstamp9&hash=sheetsig9",
      );
    });

    it("is refused before any download when its link or path would break out of the query", async () => {
      const brokenRecord = listing({ ...record, link: "x&y" });
      const [{ reference }] = await mailings(brokenRecord);
      await fails("mailing-pdf", { reference, ...RANGE }, brokenRecord, "UNEXPECTED_ANSWER", "signature-unsafe");

      const brokenSheet = guidance({ ...sheet, url: "x&y" });
      const [{ tutorials }] = await mailings(brokenSheet);
      const sheetArgs = { reference: tutorials[0].pdf_reference, ...RANGE };
      await fails("mailing-pdf", sheetArgs, brokenSheet, "UNEXPECTED_ANSWER", "signature-unsafe");
    });

    it("is refused for a reference the fresh list does not hold", async () => {
      await fails(
        "mailing-pdf",
        { ...RANGE, reference: NO_SUCH_REFERENCE },
        [],
        "NOT_THE_MEMBERS",
        "reference-unknown",
      );
    });
  });

  describe("the v2 blob", () => {
    const blob = (answer: Partial<Route>): Route[] => [blobSwitch, { match: BLOB, ...answer }];
    const recordArgs = async () => ({ ...RANGE, reference: (await mailings())[1].reference });

    it("is asked for a second time after a 202", async () => {
      // The portal's own page does this: 202 means the blob is still being prepared, so it waits and asks again.
      const preparing = blob({ times: 1, text: "", status: 202 });
      expect(await documentText("mailing-pdf", await recordArgs(), preparing)).toContain("requested-record-blob");
    });

    it.each<[string, Partial<Route>, string, string]>([
      ["a server error", { text: "", status: 500 }, "PORTAL_HTTP_ERROR", "status=500"],
      ["an HTML answer", { headers: { "content-type": "text/html" } }, "UNEXPECTED_ANSWER", "file:content-type"],
      ["a declared 3 MiB", { headers: { "content-length": `${3 * MIB}` } }, "UNEXPECTED_ANSWER", "file:oversized"],
      ["bytes that are no PDF", { base64: asBase64("plain text") }, "UNEXPECTED_ANSWER", "file:not-a-pdf"],
      ["an answer from another page", { url: ELSEWHERE }, "UNEXPECTED_ANSWER", "wrong-route-or-type"],
    ])("is refused on %s", async (_what, answer, code, detail) => {
      await fails("mailing-pdf", await recordArgs(), blob(answer), code, detail);
    });

    it("answered by the logout page means the session ended", async () => {
      await expired("mailing-pdf", await recordArgs(), blob({ url: LOGOUT_PAGE }));
    });
  });
});

describe("sensitivities", () => {
  const SENSITIVITY = "/sensitivity";
  const intolerance = (...rows: unknown[]): Route[] => [answerWith(SENSITIVITY, { intolerance: rows })];

  it("keep a populated row whole", async () => {
    const answer = await ok("sensitivities");
    expect(answer.source).toMatchObject({ schemaEvidence: "frontend-field-projection" });
    expect(answer.data).toEqual([
      {
        hash: "MOCKSENSITIVITYSIG",
        registration_date: "2001-01-01",
        practitioner_name: null,
        speciality: "מקצוע מדומה",
        sensitivity_presentation: "תגובה מדומה",
        classification: "סיווג מדומה",
        sensitivity: "רגישות מדומה",
      },
    ]);
  });

  it("tell an empty list from a row nobody observed and from a malformed answer", async () => {
    expect(await read("sensitivities", {}, intolerance())).toEqual([]);
    await fails("sensitivities", {}, intolerance({ never_seen_field: 1 }), "NOT_OFFERED", "row-incomplete");
    await fails("sensitivities", {}, [answerWith(SENSITIVITY, { other: [] })], "UNEXPECTED_ANSWER", "key:intolerance");
    const nested = intolerance({ sensitivity: { nested: true }, registration_date: "2001" });
    await fails("sensitivities", {}, nested, "UNEXPECTED_ANSWER", "key:sensitivity");
    const bodyless: Route = { headers: { "content-type": "application/json" }, empty: true, match: SENSITIVITY };
    await fails("sensitivities", {}, [bodyless], "UNEXPECTED_ANSWER", "body-not-json-or-oversized");
  });

  describe("the report", () => {
    const envelope = (base64: string): Route[] => [answerWith(`${SENSITIVITY}/pdf`, { base64 })];

    it("is the PDF inside the JSON envelope", async () => {
      expect(await documentText("sensitivities-pdf")).toContain("sensitivities-report");
    });

    it.each<[string, string, string]>([
      ["text outside the base64 alphabet", "not*base64", "file:base64"],
      // Spare bits set in the last character: it decodes, but not back to the text that was sent.
      ["base64 that does not round-trip", "JVBERi0xLjd=", "file:base64"],
      ["base64 of something else", asBase64("no PDF header"), "file:not-a-pdf"],
    ])("is refused when the envelope holds %s", async (_what, content, detail) => {
      await fails("sensitivities-pdf", {}, envelope(content), "UNEXPECTED_ANSWER", detail);
    });
  });
});

describe("vaccinations", () => {
  const DOSES = "/vaccinations?";
  const GROUPS = "/vaccinations_grouped";
  const group = {
    timestamp: "stamp",
    last_date: "later",
    first_date: "earlier",
    vaccine_group_name: "group",
    vaccinations_amount: 3,
    vaccine_group_code: 2,
  };
  const timeline = (...groups: unknown[]): Route[] => [answerWith(GROUPS, { timeline: groups })];

  it("the doses of one of the member's groups are asked for with the birth date", async () => {
    const [first] = await read("vaccine-groups");
    expect(first).toMatchObject({ vaccinations_amount: 2, vaccine_group_code: 5 });
    expect(await read("vaccine-doses", { group: 5 })).toEqual([
      {
        source: "1",
        remark: null,
        age_on_vaccination: "1",
        vaccination_place: "מרפאה בדוי",
        vaccination_date: "2001-02-01",
      },
    ]);
    expect(queryOf(DOSES)).toEqual({ birth_date: "2000-01-01", vaccine_group_code: "5" });
  });

  it("a group the member's list does not hold is refused", async () => {
    await fails("vaccine-doses", { group: 77 }, [], "NOT_THE_MEMBERS", "id-unknown");
  });

  it("a dose with a remark that is not text is refused", async () => {
    const odd = answerWith(DOSES, [{ remark: { nested: true }, vaccination_date: "2001" }]);
    await fails("vaccine-doses", { group: 5 }, [odd], "UNEXPECTED_ANSWER", "key:remark");
  });

  it.each<[string, number]>([
    ["vaccine_group_code", -2],
    ["vaccinations_amount", 1.5],
    ["vaccine_group_code", Number.MAX_SAFE_INTEGER + 1],
  ])("a group whose %s is %d is refused", async (field, value) => {
    await fails("vaccine-groups", {}, timeline({ ...group, [field]: value }), "UNEXPECTED_ANSWER", `key:${field}`);
  });

  it("a group listed twice is refused", async () => {
    await fails("vaccine-groups", {}, timeline(group, group), "UNEXPECTED_ANSWER", "row-twice");
  });

  it("the certificate is returned only out of an envelope typed as a PDF", async () => {
    expect(await documentText("vaccine-certificate-pdf")).toContain("certificate-of-vaccination");
    const typedHtml = answerWith("/vaccination/certificates/report", { base64: asBase64("%PDF-1.7"), type: "html" });
    await fails("vaccine-certificate-pdf", {}, [typedHtml], "UNEXPECTED_ANSWER", "key:type");
  });
});

describe("certificates", () => {
  const APPROVALS = "/approvals";
  const LISTED = "/approvals?";
  /** The fake lists two certificates that look exactly alike, then a third that does not. */
  const DOCUMENTS = ["certificate-twin-1", "certificate-twin-2", "permit-unrelated"];
  const row = {
    hash: "sig",
    timestamp: "stamp",
    pdf_link: "dir%2Ffile",
    approval_type_code: "3",
    approval_date_to: "to",
    approval_date_from: "from",
    approval_date: "day",
    specialization_description: "specialty",
    practitioner_full_name: "doctor",
    title_name: "title",
  };
  const approvals = (...rows: unknown[]): Route[] => [answerWith(APPROVALS, { approval: rows })];
  const certificates = (routes: Route[] = []): Promise<any[]> => read("certificates", RANGE, routes);

  it("each get a reference of their own beside the temporary link and signature, look-alikes too", async () => {
    const rows = await certificates();
    rows.forEach((certificate, index) => {
      expect(certificate).toMatchObject({
        timestamp: expect.stringMatching(/^rotating-time-/),
        hash: expect.stringMatching(/^rotating%2Bhash/),
        pdf_link: expect.stringContaining(`%2Fmock%2F${DOCUMENTS[index]}%2Frotating-`),
        reference: expect.stringMatching(SHA256_HEX),
      });
    });
    expect(new Set(rows.map((certificate) => certificate.reference))).toHaveProperty("size", 3);
    // Take away what rotates and what identifies, and the two look-alikes are equal.
    const [first, second] = rows.map(({ timestamp, hash, pdf_link, reference, ...shown }) => shown);
    expect(second).toEqual(first);
  });

  it("each download their own document through links that have all rotated since the list", async () => {
    const rows = await certificates();
    for (const [index, { reference }] of rows.entries()) {
      const text = await documentText("certificate-pdf", { ...RANGE, reference });
      expect(text).toContain(`% mock ${DOCUMENTS[index]}\n`);
    }
  });

  it("are listed again under the range the download names, so a stale link is never used", async () => {
    const [{ reference }] = await certificates();
    expect(queryOf(LISTED)).toEqual({ from_date: RANGE.from, to_date: RANGE.to });
    const longAgo = { from: "2019-02-01", to: "2019-11-30" };
    await fails("certificate-pdf", { reference, ...longAgo }, approvals(), "NOT_THE_MEMBERS", "reference-unknown");
    expect(queryOf(LISTED)).toEqual({ from_date: longAgo.from, to_date: longAgo.to });
  });

  it.each<[string, unknown[], string, string]>([
    ["of another member", [{ ...row, member_id: SOMEONE_ELSE }], "NOT_THE_MEMBERS", "names-another-member"],
    ["listed twice", [row, row], "UNEXPECTED_ANSWER", "row-twice"],
    ["without a signature", [{ ...row, hash: undefined }], "UNEXPECTED_ANSWER", "key:hash"],
  ])("a row %s fails the list", async (_what, rows, code, detail) => {
    await fails("certificates", RANGE, approvals(...rows), code, detail);
  });

  it("a path that is not valid percent-encoding lists, and is refused at the download", async () => {
    const garbled = approvals({ ...row, pdf_link: "%xy" });
    const [{ reference }] = await certificates(garbled);
    await fails("certificate-pdf", { ...RANGE, reference }, garbled, "UNEXPECTED_ANSWER", "file-path-unencodable");
  });
});

describe("additional information", () => {
  const TUTORIALS = "/tutorials?";
  const leaflet = {
    type_id: 1,
    timestamp: "leaflet-stamp",
    hash: "c%2Bd%2F",
    url: "https%3A%2F%2Fmock.invalid%2Fleaflets%2Bprivate",
    display_text: "עלון מדומה",
    specialization: "מרפאה מדומה",
    practitioner_name: null,
    session_datetime: "2026-04-22",
  };
  const page = { ...leaflet, type_id: 2, display_text: "קישור מדומה", url: "https://example.invalid/page" };
  const entries = (...tutorials: unknown[]): Route[] => [answerWith(TUTORIALS, { tutorials })];
  const both = entries(leaflet, page);
  /** The arguments that download the leaflet, as a list of `both` references it. */
  const leafletArgs = async () => ({
    ...RANGE,
    reference: (await read("additional-information", RANGE, both))[0].reference,
  });

  it("is an empty list for an account that has none", async () => {
    expect(await read("additional-information", RANGE)).toHaveLength(0);
  });

  it("gives a reference to a document entry (type 1) and none to a link entry (type 2)", async () => {
    const [document, link] = await read("additional-information", RANGE, both);
    expect(queryOf(TUTORIALS)).toEqual({ from_date: RANGE.from, to_date: RANGE.to });
    // Either kind keeps the url and signature as sent.
    expect(document).toMatchObject({ ...leaflet, reference: expect.stringMatching(SHA256_HEX) });
    expect(link).toMatchObject({ hash: page.hash, url: page.url, type_id: 2 });
    expect("reference" in link).toBe(false);
  });

  it("downloads the document with the row's url and signature percent-decoded", async () => {
    expect(await documentText("additional-information-pdf", await leafletArgs(), both)).toContain("mock referral");
    expect(queryOf("/MedicalFileAPI/webapi/mac/v2/")).toEqual({
      hash: "c+d/",
      timestamp: "leaflet-stamp",
      url: "https://mock.invalid/leaflets+private",
    });
  });

  it("finds the document again after its signature rotated", async () => {
    const rotated = entries({ ...leaflet, timestamp: "a later stamp", hash: "another-sig" });
    expect(await documentText("additional-information-pdf", await leafletArgs(), rotated)).toContain("%PDF");
  });

  it("refuses a reference whose entry has since become a link", async () => {
    const becameLink = entries({ ...leaflet, type_id: 2 });
    await fails("additional-information-pdf", await leafletArgs(), becameLink, "NOT_THE_MEMBERS", "reference-unknown");
  });

  it("refuses a signature that cannot be percent-decoded, before any download", async () => {
    const garbled = entries({ ...leaflet, hash: "%not-hex" });
    await fails(
      "additional-information-pdf",
      await leafletArgs(),
      garbled,
      "UNEXPECTED_ANSWER",
      "signature-undecodable",
    );
  });

  it.each<[string, unknown[], string, string]>([
    ["of a type nobody observed", [{ ...leaflet, type_id: 42 }], "NOT_OFFERED", "row-shape-unknown"],
    ["listed twice", [leaflet, leaflet], "UNEXPECTED_ANSWER", "row-twice"],
    ["whose text is an object", [{ ...leaflet, display_text: {} }], "UNEXPECTED_ANSWER", "key:display_text"],
  ])("names what is wrong with an entry %s", async (_what, tutorials, code, detail) => {
    await fails("additional-information", RANGE, entries(...tutorials), code, detail);
  });
});

describe("account-wide documents", () => {
  const SUMMARY = "/report/english/";
  const summary = (answer: Partial<Route>): Route[] => [{ match: SUMMARY, ...answer }];

  it("the purchased-medication report comes back as sent", async () => {
    expect(await documentText("pharmacy-purchases-pdf")).toContain("purchased-report");
  });

  it("the English summary is signed with metadata fetched for it, and sent with cookies only", async () => {
    expect(await documentText("medical-summary-english-pdf")).toContain("summary-in-english");
    const { url, authorization } = last(SUMMARY);
    expect(authorization).toBe("");
    // The signature goes out exactly as received: encoded once, not twice.
    expect(url).toContain("hash=summary%2Fsig%3D%3D");
    expect(url.includes("%25")).toBe(false);
  });

  it.each<[string, Partial<Route>, string]>([
    ["an HTML page", { text: "<html>try later</html>" }, "file:content-type"],
    ["a JSON content type", { headers: { "content-type": "application/json" } }, "file:content-type"],
    ["an answer from another page", { url: ELSEWHERE }, "file:redirected"],
    ["a 503", { text: "", status: 503 }, "status=503"],
    ["a declared 3 MiB, over the 2 MiB cap", { headers: { "content-length": `${3 * MIB}` } }, "file:oversized"],
    ["bytes that are no PDF", { base64: asBase64("plain text") }, "file:not-a-pdf"],
  ])("the English summary is refused on %s", async (_what, answer, detail) => {
    const refusal = (await session.run("medical-summary-english-pdf", {}, summary(answer))).structuredContent.error;
    expect(refusal).toMatchObject({ detail });
  });

  it("the English summary's content type may be spelled in any case", async () => {
    const capitalised = summary({ headers: { "content-type": "APPLICATION/Pdf" } });
    expect(await documentText("medical-summary-english-pdf", {}, capitalised)).toContain("%PDF");
  });

  it("the logout page in place of the English summary means the session ended", async () => {
    await expired("medical-summary-english-pdf", {}, summary({ url: LOGOUT_PAGE }));
  });
});

describe("administrative requests", () => {
  const TIMELINE = "/requests_and_cases";
  const CASE = "/cases/case-7301";
  const SERVICE_REQUEST = "/service_requests/sr-5120";
  const DOCUMENT = "/service_requests_document";
  const theCase = { id: "case-7301" };
  const theServiceRequest = { id: "sr-5120" };
  const owner = String(MEMBER);
  const listed = { classification: "Case", interaction_id: "some-case", member_id: owner };
  const timeline = (...rows: unknown[]): Route => answerWith(TIMELINE, rows);
  /** The case, answered with these fields and nothing else. */
  const caseOf = (fields: Args): Route => answerWith(CASE, { ...fields, interaction_id: theCase.id, member_id: owner });
  const attachmentNames = (request: any): unknown[] => request.attachments.map((each: any) => each.file_name);
  const referenceOf = (request: any, name: string): string =>
    request.attachments.find((each: any) => each.file_name === name).reference;
  const attachment = (id: Args, reference: string, routes: Route[] = []) =>
    documentText("request-attachment-pdf", { ...id, reference }, routes);

  describe("the timeline", () => {
    it("is posted for the signed-in member only, and a row keeps all its fields", async () => {
      const [first] = await read("requests");
      expect(JSON.parse(last(TIMELINE).body)).toEqual({ members: [{ member_id: MEMBER, member_id_code: "0" }] });
      expect(first).toEqual({
        expand_data: {},
        obligation_provider_name: null,
        is_read: false,
        has_content: true,
        status_update_date: "2026-05-20",
        status: "בטיפול",
        type_name: "בקשת החזר",
        classification: "Case",
        interaction_id: theCase.id,
      });
    });

    it("may be empty, and leaves a numeric id a number", async () => {
      expect(await read("requests", {}, [timeline()])).toEqual([]);
      const [numbered] = await read("requests", {}, [timeline({ ...listed, interaction_id: 9001 })]);
      expect(numbered).toHaveProperty("interaction_id", 9001);
    });

    it.each<[string, Args, string]>([
      ["of another member", { ...listed, member_id: String(SOMEONE_ELSE) }, "NOT_THE_MEMBERS"],
      ["naming no member", { ...listed, member_id: undefined }, "NOT_THE_MEMBERS"],
      ["whose status is an object", { ...listed, status: {} }, "UNEXPECTED_ANSWER"],
      ["whose read flag is text", { ...listed, is_read: "false" }, "UNEXPECTED_ANSWER"],
      ["with an empty id", { ...listed, interaction_id: "" }, "NOT_OFFERED"],
      ["with nothing but a member", { member_id: MEMBER }, "NOT_OFFERED"],
    ])("fails as a whole over a row %s", async (_what, row, code) => {
      await fails("requests", {}, [timeline(row)], code);
    });
  });

  describe("a case", () => {
    it("shows the correspondence, the obligation details and the attachments the portal would show", async () => {
      const request = await read("request", theCase);
      expect(request).toMatchObject({
        obligation_details: {
          treatments: [{ treatment_name: "טיפול מדומה", health_ministry_code: "K4" }],
          doctor_referral: { name: "הפניה מדומה", code: 23 },
          treatment_date: "2026-04-14",
        },
        messages: [{ from_maccabi: true, body: "מענה מדומה", created_on: "2026-05-20" }],
        classification: "Case",
      });
      // The fake's feature list leaves IsCaseRejected off, which hides the case's own documents.
      expect(request.attachments).toEqual([{ reference: expect.stringMatching(SHA256_HEX), file_name: "מענה חתום" }]);
    });

    it("hands out an attachment through the signed query of the freshly read row", async () => {
      const [{ reference }] = (await read("request", theCase)).attachments;
      expect(await attachment(theCase, reference)).toContain("request-attachment");
      expect(last(DOCUMENT).url).toContain(
        `${DOCUMENT}?doc_uri=%2Fmock%2Fcase-reply.pdf&timestamp=case-reply-stamp&hash=case-reply-sig`,
      );
    });

    it("is refused for an id the timeline lacks or lists twice, and for an unknown attachment", async () => {
      await fails("request", { id: "no-such-case" }, [], "NOT_THE_MEMBERS", "id-unknown");
      const row = { ...listed, interaction_id: theCase.id };
      await fails("request", theCase, [timeline(row, row)], "NOT_THE_MEMBERS", "ambiguous-id-in-fresh-list");
      const stray = { ...theCase, reference: NO_SUCH_REFERENCE };
      await fails("request-attachment-pdf", stray, [], "NOT_THE_MEMBERS", "reference-unknown");
    });

    it("of a classification that has no detail read is not offered", async () => {
      const approval = timeline({ ...listed, interaction_id: theCase.id, classification: "Approval" });
      await fails("request", theCase, [approval], "NOT_OFFERED", "case-kind-unknown");
    });

    it.each<[string, Args]>([
      ["at the top", { member_id: String(SOMEONE_ELSE) }],
      ["as another case id", { interaction_id: "case-7302" }],
      ["in the provider document", { provider_document: { member_id: SOMEONE_ELSE } }],
      ["in the extended properties", { extended_properties: { member_id: SOMEONE_ELSE } }],
      ["in a refund", { extended_properties: { refund: { member_id: SOMEONE_ELSE } } }],
      ["in a department", { extended_properties: { obligation_details: { department: { member_id: SOMEONE_ELSE } } } }],
    ])("is refused when its detail names someone or something else %s", async (_where, change) => {
      await fails("request", theCase, [merge(CASE, change)], "NOT_THE_MEMBERS");
    });

    it.each<[string, Args]>([
      ["documents that are not a list", { documents: {} }],
      ["a message whose documents are not a list", { messages: [{ documents: {} }] }],
      ["treatments that are not a list", { extended_properties: { obligation_details: { treatment_array: {} } } }],
      ["a refund that is text", { extended_properties: { refund: "refund" } }],
      [
        "a message whose origin flag is text",
        { messages: [{ from_maccabi: "true", body: "text", created_on: "day" }] },
      ],
    ])("is refused when its detail has %s", async (_what, change) => {
      await fails("request", theCase, [merge(CASE, change)], "UNEXPECTED_ANSWER");
    });

    it("keeps half-filled treatments and leaves out a department without a description", async () => {
      const obligation_details = {
        service_provider: { service_provider_name: "ספק כלשהו" },
        department: { department_description: "" },
        treatment_array: [{}, { health_ministry_code: 8 }],
      };
      const sparse = caseOf({ extended_properties: { obligation_details }, treatment_date: "a day" });
      const request = await read("request", theCase, [sparse, switches()]);
      expect(request.obligation_details).toEqual({
        service_provider_name: "ספק כלשהו",
        treatments: [{}, { health_ministry_code: 8 }],
        treatment_date: "a day",
      });
    });

    it("refuses an attachment whose path would break out of the query, before any download", async () => {
      const documents = [{ hash: "sig", timestamp: "stamp", uri: "x&y", file_name: "file" }];
      const unsafe = [merge(CASE, { messages: [{ documents, from_maccabi: true, body: "text", created_on: "day" }] })];
      const [{ reference }] = (await read("request", theCase, unsafe)).attachments;
      await fails("request-attachment-pdf", { ...theCase, reference }, unsafe, "UNEXPECTED_ANSWER", "signature-unsafe");
    });
  });

  describe("a case's own documents", () => {
    const documents = [
      { hash: "sig", timestamp: "stamp", print_document_uri: "%2Fmock%2Fprintable.pdf", title: "מסמך להדפסה" },
      { hash: "sig", timestamp: "stamp", uri: "%2Fmock%2Fnameless.pdf" },
      { hash: "sig", timestamp: "stamp", title: "בלי נתיב" },
    ];
    /** Only a document with a path is listed, and one without a title is listed under null. */
    const LISTED = ["מסמך להדפסה", null];
    const shownWith = async (fields: Args, flag: string) =>
      attachmentNames(await read("request", theCase, [caseOf({ ...fields, documents }), switches([flag])]));

    it("follow the attachments of its messages when the case was rejected and Maccabi sent documents", async () => {
      const fromTheFake = await read("request", theCase, [switches(["IsCaseRejected"])]);
      expect(attachmentNames(fromTheFake)).toEqual(["מענה חתום", "כתב התחייבות"]);
      const rejected = { has_documents_from_maccabi: true, case_type_code: 75 };
      expect(await shownWith(rejected, "IsCaseRejected")).toEqual(LISTED);
    });

    it("are shown for a preauthorization", async () => {
      const preauthorized = { extended_properties: { preauthorization: { approval_number: "pre-1" } } };
      expect(await shownWith(preauthorized, "IshurMakdim")).toEqual(LISTED);
    });

    it("are shown for an obligation at the partly-approved status and at no other", async () => {
      const obligation = (unified_status_code: number) => ({ unified_status_code, case_type_code: 53 });
      expect(await shownWith(obligation(91), "EnablePartlyApprovedObligation")).toEqual(LISTED);
      expect(await shownWith(obligation(92), "EnablePartlyApprovedObligation")).toEqual([]);
    });

    it.each<[string, Route]>([
      ["listed twice", switches(["IsCaseRejected"], ["IsCaseRejected"])],
      ["with a value that is not a boolean", switches(["IsCaseRejected", "on"])],
    ])("stay unread when their switch is %s", async (_how, featureList) => {
      await fails("request", theCase, [caseOf({ documents }), featureList], "UNEXPECTED_ANSWER", "key:feature_enabled");
    });
  });

  describe("a decision", () => {
    const medication = {
      pharmacies: "any",
      participation: 15,
      valid_to_date: "until",
      valid_from_date: "since",
      largo_code: 1000,
      medication_name: "תרופה כלשהי",
    };
    const extended_properties = { medication_approval: { ...medication, approval_number: "ap-1" } };
    const reply = { from_maccabi: true, body: "text", created_on: "day" };
    const decisionOf = async (fields: Args) =>
      (await read("request", theCase, [caseOf({ extended_properties, ...fields }), switches()])).decision;

    it("on a medication shows the medication at the statuses the portal does, until Maccabi replies", async () => {
      const pending = await decisionOf({ messages: [], unified_status_code: 51 });
      expect(pending.medication).toEqual(medication);
    });

    it.each<[string, Args]>([
      ["once Maccabi replied", { messages: [reply], unified_status_code: 57 }],
      ["at any other status", { messages: [], unified_status_code: 44 }],
    ])("on a medication hides the medication %s", async (_when, fields) => {
      expect(await decisionOf(fields)).not.toHaveProperty("medication");
    });

    it("on a medication adds its signed print as one more attachment", async () => {
      const printable = {
        hash: "print-sig",
        timestamp: "print-stamp",
        print_document_uri: "%2Fmock%2Fdecision-print",
        print_document_title: "הדפסת החלטה",
        pharmacies: "any",
        participation: "some",
        valid_to_date: "until",
        valid_from_date: "since",
        largo_code: "1000",
        medication_name: "תרופה כלשהי",
        approval_number: "ap-2",
      };
      const decided = [merge(CASE, { extended_properties: { medication_approval: printable } })];
      const request = await read("request", theCase, decided);
      expect(request.decision).toMatchObject({ approval_number: "ap-2", kind: "medication_approval" });
      const print = referenceOf(request, "הדפסת החלטה");
      expect(await attachment(theCase, print, decided)).toContain("request-attachment");
    });

    it("on an obligation that is not printable reports its provider document as a section left out", async () => {
      const obligation = {
        print_decision_type: "Screen",
        print_decision_message: "הודעה כלשהי",
        service_provider: "ספק כלשהו",
        obligation_number: 12,
      };
      const provider_document = { file_base64string: "JVBERi0y", last_doc_name_reviced: "מסמך ספק" };
      const routes = [caseOf({ provider_document, extended_properties: { obligation } }), switches()];
      const request = await read("request", theCase, routes);
      expect(request.unsupported_sections).toEqual(["provider_document"]);
      expect(request.decision).toEqual({ ...obligation, kind: "obligation" });
    });

    it("with a field of the wrong type is a changed shape", async () => {
      const refund = { approval_number: { nested: true } };
      await fails(
        "request",
        theCase,
        [caseOf({ extended_properties: { refund } })],
        "UNEXPECTED_ANSWER",
        "shape-changed",
      );
    });
  });

  describe("a provider's printable decision", () => {
    const NAME = "החלטת הספק";
    const inlined = (content: string): Route[] => [
      merge(CASE, {
        provider_document: { file_base64string: asBase64(content), last_doc_name_reviced: NAME },
        extended_properties: { obligation: { print_decision_type: "Print" } },
      }),
    ];
    const args = async (routes: Route[]) => ({
      ...theCase,
      reference: referenceOf(await read("request", theCase, routes), NAME),
    });

    it("is decoded from the base64 the detail already carried, without a request for it", async () => {
      const routes = inlined("%PDF-1.7 from the provider");
      const reference = await args(routes);
      const before = box.fetches().length;
      expect(await documentText("request-attachment-pdf", reference, routes)).toContain("from the provider");
      const since = box.fetches().slice(before);
      expect(since.filter((request) => request.url.includes(DOCUMENT))).toEqual([]);
    });

    it.each<[string, string, string]>([
      ["something that is no PDF", "plain text", "file:not-a-pdf"],
      ["more than 2 MiB", `%PDF-${"7".repeat(2 * MIB)}`, "file:oversized"],
    ])("is refused when the inline bytes are %s", async (_what, content, detail) => {
      const routes = inlined(content);
      await fails("request-attachment-pdf", await args(routes), routes, "UNEXPECTED_ANSWER", detail);
    });
  });

  describe("a service request", () => {
    it("shows its body and hands out its documents", async () => {
      const request = await read("request", theServiceRequest);
      expect(request).toMatchObject({
        attachments: [{ file_name: "נספח" }],
        body: "פנייה מדומה",
        classification: "ServiceRequest",
      });
      const [{ reference }] = request.attachments;
      expect(await attachment(theServiceRequest, reference)).toContain("request-attachment");
    });

    it("lists the sections it leaves out", async () => {
      const extra = merge(SERVICE_REQUEST, { extended_properties: { some_branch: "value" } });
      const request = await read("request", theServiceRequest, [extra]);
      expect(request.unsupported_sections).toEqual(["extended_properties"]);
    });

    it("without a body says null", async () => {
      const bare = answerWith(SERVICE_REQUEST, { member_id: owner });
      expect(await read("request", theServiceRequest, [bare])).toHaveProperty("body", null);
    });

    it("keeps its messages as sent, though the portal does not display them", async () => {
      const messages = [{ from_maccabi: false, body: "הודעה מדומה", created_on: "2026-05-27" }];
      const request = await read("request", theServiceRequest, [merge(SERVICE_REQUEST, { messages })]);
      expect(request.messages).toEqual(messages);
    });

    it("with a document that has no path is a changed shape", async () => {
      const documents = [{ hash: "sig", timestamp: "stamp", uri: "", file_name: "file" }];
      const pathless = [merge(SERVICE_REQUEST, { documents })];
      await fails("request", theServiceRequest, pathless, "UNEXPECTED_ANSWER", "shape-changed");
    });
  });
});

describe("prescriptions", () => {
  const PRINT = "/getprescriptionpdf";
  const SUBSTITUTES = "/alternativeDrugs";
  const first = { id: "rx-40" };
  const prescription = {
    drug_largo_code: "3000",
    file_link: "dir/private+print",
    hash: "c%2Bd%2F",
    timestamp: "rx-stamp",
    is_prescription_renewal: false,
    is_permanent_drug: false,
    purchase_status: 1,
    is_digital_prescription: true,
    member_id_code: 0,
    member_id: String(MEMBER),
    to_date: "2026-07-31",
    from_date: "2026-05-01",
    drug_instructions: "הוראות מדומות",
    drug_name: "תרופה מדומה",
    doc_id: first.id,
  };
  const listing = (...results: unknown[]): Route[] => [answerWith("/prescriptions", { results }, { method: "POST" })];
  const one = (change: Args = {}) => listing({ ...prescription, ...change });

  describe("the list", () => {
    it("links each row to the medicine's information page", async () => {
      const [row] = await read("prescriptions", {}, one());
      expect(row.medicine_info_link).toBe("https://www.maccabi4u.co.il/healthguide/medicines/תרופות/3000");
    });

    it.each<[string, Args]>([
      ["another member", { member_id: String(SOMEONE_ELSE) }],
      ["another id code", { member_id_code: 4 }],
    ])("fails over a row under %s", async (_whose, change) => {
      await fails("prescriptions", {}, one(change), "NOT_THE_MEMBERS");
    });

    it("is filtered after the fetch by status and permanence, as the portal's own tabs are", async () => {
      // One row for each status the tabs know; the even ones are permanent, and 5 upward can be renewed.
      const everyStatus = listing(
        ...[1, 2, 3, 4, 5, 6, 7].map((status) => ({
          ...prescription,
          is_prescription_renewal: status >= 5,
          is_permanent_drug: status % 2 === 0,
          purchase_status: status,
          doc_id: `status-${status}`,
        })),
      );
      const statuses = async (filter: Args) =>
        (await read("prescriptions", filter, everyStatus)).map((row: any) => row.purchase_status);
      expect(await statuses({ status: "valid" })).toEqual([1, 2, 3, 7]);
      expect(await statuses({ status: "history" })).toEqual([4, 5, 6]);
      expect(await statuses({ status: "purchased" })).toEqual([4, 5]);
      expect(await statuses({ status: "expired" })).toEqual([6]);
      expect(await statuses({ status: "renewable" })).toEqual([5, 6]);
      expect(await statuses({ permanent: true })).toEqual([2, 4, 6]);
    });

    it.each<[Args, string, unknown]>([
      [{ permanent: true }, "is_permanent_drug", "false"],
      [{ status: "valid" }, "purchase_status", 8],
      [{ status: "renewable" }, "is_prescription_renewal", null],
      [{}, "drug_largo_code", "../3000"],
    ])("asked with %o, checks the field it depends on: %s", async (filter, field, value) => {
      await fails("prescriptions", filter, one({ [field]: value }), "UNEXPECTED_ANSWER", `key:${field}`);
    });
  });

  describe("the print", () => {
    it("is fetched with the signed query of the member's freshly listed row", async () => {
      expect(await documentText("prescription-pdf", first, one())).toContain("prescription-print");
      expect(queryOf(PRINT)).toEqual({
        path: "dir/private+print",
        data: first.id,
        hash: "c+d/",
        timestamp: "rx-stamp",
      });
    });

    it("exists for a digital prescription that is still current, and for no other", async () => {
      await file("prescription-pdf", first, one({ purchase_status: 3 }));
      for (const change of [{ purchase_status: "1" }, { purchase_status: 4 }, { is_digital_prescription: false }]) {
        await fails("prescription-pdf", first, one(change), "NOT_OFFERED", "not-a-live-digital-prescription");
      }
    });

    it("is refused for an id the list lacks or holds twice", async () => {
      await fails("prescription-pdf", { id: "rx-41" }, one(), "NOT_THE_MEMBERS", "id-unknown");
      const twice = listing(prescription, prescription);
      await fails("prescription-pdf", first, twice, "NOT_THE_MEMBERS", "ambiguous-id-in-fresh-list");
    });
  });

  describe("the alternatives", () => {
    const substitutes = (body: Args): Route[] => [...one(), answerWith(SUBSTITUTES, body)];

    it("are asked for by the drug code of a freshly listed prescription, and keep the two fields the portal shows", async () => {
      expect(await read("prescription-substitutes", first, one())).toEqual([
        { name: "תחליף מדומה", largo_code: "1000" },
        { name: "תחליף שני", largo_code: 2000 },
      ]);
      expect(queryOf(SUBSTITUTES)).toEqual({ largoCode: prescription.drug_largo_code });
    });

    it("need one listed prescription that can be bought now", async () => {
      const bought = one({ purchase_status: 5 });
      await fails("prescription-substitutes", first, bought, "NOT_OFFERED", "not-purchasable-now");
      const twice = listing(prescription, prescription);
      await fails("prescription-substitutes", first, twice, "NOT_THE_MEMBERS", "ambiguous-id-in-fresh-list");
      await fails("prescription-substitutes", { id: "rx-41" }, one(), "NOT_THE_MEMBERS", "id-unknown");
    });

    it.each<[string, unknown[], string]>([
      [
        "one code under two names",
        [
          { name: "first", largo_code: "77" },
          { name: "second", largo_code: "77" },
        ],
        "row-twice",
      ],
      ["a drug without a code", [{ name: "first", largo_code: null }], "key:largo_code"],
      ["a drug without a name", [{ name: "", largo_code: "77" }], "key:name"],
      [
        "more than a thousand drugs",
        Array.from({ length: 1001 }, (_, code) => ({ name: "many", largo_code: `${code}` })),
        "key:drugs",
      ],
    ])("are refused when the list holds %s", async (_what, drugs, detail) => {
      await fails("prescription-substitutes", first, substitutes({ drugs }), "UNEXPECTED_ANSWER", detail);
    });

    it("are refused when the list names another member", async () => {
      const foreign = substitutes({ drugs: [], member_id: SOMEONE_ELSE });
      await fails("prescription-substitutes", first, foreign, "NOT_THE_MEMBERS");
    });
  });
});

describe("referrals", () => {
  const LISTED = "/referrals?";
  const PRINT = `/MedicalFileAPI/webapi/mac/v1/members/0/${MEMBER}/pdf`;

  it("are listed for the range given, each with its link and signature as sent", async () => {
    const [referral] = await read("referrals", RANGE);
    expect(queryOf(LISTED)).toEqual({ from_date: RANGE.from, to_date: RANGE.to });
    expect(referral).toMatchObject({
      timestamp: "mock-time",
      hash: "mock%2Bhash",
      pdf_link: "%2Fmock%2Freferral.pdf",
      referral_id: "ref-1",
    });
  });

  it("print from the member's freshly listed row, with cookies only", async () => {
    const [{ referral_id }] = await read("referrals", RANGE);
    expect(await documentText("referral-pdf", { id: referral_id })).toContain("referral");
    expect(queryOf(PRINT)).toEqual({ timestamp: "mock-time", hash: "mock+hash", path: "/mock/referral.pdf" });
    expect(last(PRINT)).toMatchObject({ authorization: "" });
  });

  it("refuse an id the list lacks", async () => {
    await fails("referral-pdf", { id: "ref-2" }, [], "NOT_THE_MEMBERS", "id-unknown");
  });

  it("refuse a list whose id is not text", async () => {
    const numbered = answerWith(LISTED, { referrals: [{ referral_id: 12 }] });
    await fails("referrals", RANGE, [numbered], "UNEXPECTED_ANSWER", "key:referral_id");
  });
});

it("asked the fake for nothing it had to refuse", () => {
  expect(box.unexpected(), "refused requests and outbound sockets").toEqual([]);
});
