/**
 * Past visits and inquiries to a doctor, driven through the MCP server of the built bundle with the
 * fake Maccabi behind it. For a visit: its detail, the summary PDF, and each document attached to it
 * (a prescription, a referral, an approval, an information sheet). For an inquiry: the list with its
 * automatic sick permits, the detail with the forms the doctor answered, the visit an inquiry may
 * point at, and the documents of all three.
 *
 * Two live observations are reproduced. The portal does not open a visit that has no summary file,
 * so neither does this tool. And an inquiry whose linked visit answers 204 is still readable; it
 * simply has no visit. Every id and reference is looked up again in the member's newly fetched list.
 * Every value here is made up.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { answerWith, LOGOUT_PAGE, MEMBER, memberSession, merge, type Route, SOMEONE_ELSE } from "../rig";

const session = memberSession("visits");
const { box, ok, fails, file, expired, last, count: countOf } = session;

type Fields = Record<string, unknown>;
const TWO_MIB = 2 * 1024 * 1024;
/** The longest list of approval requests the tool takes in one inquiry. */
const MOST_APPROVALS = 100;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const owner = String(MEMBER);
/** Visit documents and inquiry documents are all served by this one route. */
const DOCUMENT = `/AppointmentOrderAPI/webapi/mac/v1/members/0/${MEMBER}/pdf`;
/** A signature with the characters that tell "interpolated as sent" from "encoded again". */
const signed = { hash: "sig%2F+nature", timestamp: "stamp+ed" };
const SENT_SIGNATURE = "&timestamp=stamp+ed&hash=sig%2F+nature";
/** A lone surrogate: JSON carries it, a URI cannot. */
const UNENCODABLE = "\udfff";
const asBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const read = async (operation: string, args: Fields = {}, routes: Route[] = []) =>
  (await ok(operation, args, routes)).data;
const documentText = async (operation: string, args: Fields, routes: Route[] = []) =>
  (await file(operation, args, routes)).toString("utf8");
/** The methods of the last two requests whose URL matches. */
const lastTwoMethods = (url: RegExp) =>
  box
    .fetches()
    .filter((request) => url.test(request.url))
    .slice(-2)
    .map((request) => request.method);

beforeAll(session.start);

describe("a visit", () => {
  const HISTORY = "/visits/history";
  const DETAIL = "/visits/encounter-42";
  const theVisit = { id: "encounter-42" };
  const withoutSummary = { id: "encounter-41" };
  const ATTACHED = ["approvals", "drugs", "tutorials", "referrals"] as const;

  const listed = {
    has_summery_file: true,
    service_name: "מרפאה מדומה",
    service_provider_name: "רופאה מדומה",
    appointment_date: "2026-08-01T10:00:00",
    appointment_id: theVisit.id,
    member_id_code: "0",
    member_id: MEMBER,
  };
  const history = (...results: unknown[]): Route => answerWith(HISTORY, { results }, { method: "POST" });
  /** A detail with one live document of each kind, a cancelled prescription and two web links. */
  const detail = (change: Fields = {}) => ({
    member_id_code: "0",
    member_id: owner,
    service_provider_name: "רופאה מדומה",
    visit_summary_date: "2026-08-01",
    visit_summary_pdf_link: "summary+dir%2Ffile",
    ...signed,
    diagnosis: [{ diagnosis_description: "אבחנה מדומה" }],
    approvals: [{ approval_pdf_link: "approval%2Fdir+file", title_name: "אישור מדומה", ...signed }],
    referrals: [
      { referral_pdf_link: "referral%2Fdir+file", referral_description: "הפניה מדומה", referral_id: "r-1", ...signed },
    ],
    drugs: [
      {
        prescription_pdf_link: "drug%2Fdir+file",
        rescription_cancellation_status: 0,
        prescription_is_digital: 1,
        drug_name: "תרופה מדומה",
        ...signed,
      },
      { prescription_pdf_link: "withdrawn", rescription_cancellation_status: 1, prescription_is_digital: 1, ...signed },
    ],
    tutorials: [
      { item_url: "sheet%2Fdir+file", item_display_text: "עלון מדומה", type_id: 1, ...signed },
      { item_url: "https%3A%2F%2Fexample.invalid%2Fclip", type_id: 2, ...signed },
      { item_url: "https%3A%2F%2Fexample.invalid%2Farticle", type_id: 3, ...signed },
    ],
    ...change,
  });
  const answering = (change: Fields = {}): Route[] => [answerWith(DETAIL, detail(change))];
  const visit = (change: Fields = {}) => read("clinic-visit", theVisit, answering(change));

  describe("in detail", () => {
    it("live: is not opened when it has no summary file, as the portal does not open it either", async () => {
      for (const operation of ["clinic-visit", "clinic-visit-summary-pdf"]) {
        await fails(operation, withoutSummary, [], "NOT_OFFERED", "summary-absent");
      }
    });

    it("is refused when the member's list does not hold it", async () => {
      await fails("clinic-visit", { id: "visit-404" }, [], "NOT_THE_MEMBERS", "id-unknown");
    });

    it("is fetched after the member's list, and keeps what the doctor wrote", async () => {
      const { diagnosis, has_summary_pdf } = await visit();
      expect(has_summary_pdf).toBe(true);
      expect(diagnosis).toEqual([{ diagnosis_description: "אבחנה מדומה" }]);
      expect(lastTwoMethods(/visits\/(?:history|encounter-42)/)).toEqual(["POST", "GET"]);
    });

    it("has a reference for each PDF, none for a cancelled prescription, and a plain link for a web page", async () => {
      const opened = await visit();
      for (const kind of ATTACHED) expect(opened[kind][0].pdf_reference).toMatch(SHA256_HEX);
      const [, cancelled] = opened.drugs;
      expect("pdf_reference" in cancelled).toBe(false);
      const [, clip, article] = opened.tutorials;
      expect(clip).toMatchObject({ link: "https://example.invalid/clip" });
      expect(article).toMatchObject({ link: "https://example.invalid/article" });
      for (const page of [clip, article]) expect("pdf_reference" in page).toBe(false);
    });

    it("gives two rows that look alike two different references", async () => {
      const alike = (approval_pdf_link: string) => ({ approval_pdf_link, title_name: "אותו אישור", ...signed });
      const { approvals } = await visit({ approvals: [alike("first"), alike("second")] });
      expect(approvals[0].pdf_reference).not.toBe(approvals[1].pdf_reference);
    });

    it.each<[string, string]>([
      ["a script", "javascript%3Avoid(0)"],
      ["a URL with credentials", "https%3A%2F%2Fme%3Asecret%40example.invalid%2Fv"],
      ["invalid percent-encoding", "%xy"],
      ["no URL at all", "see%20the%20clinic"],
      ["a URL with a line break", "https%3A%2F%2Fexample.invalid%2Fa%0Ab"],
      ["empty", ""],
    ])("is refused over a web link that is %s", async (_what, item_url) => {
      await fails(
        "clinic-visit",
        theVisit,
        answering({ tutorials: [{ item_url, type_id: 2, ...signed }] }),
        "UNEXPECTED_ANSWER",
      );
    });

    it("is refused when the detail belongs to another member", async () => {
      await fails("clinic-visit", theVisit, [merge(DETAIL, { member_id: String(SOMEONE_ELSE) })], "NOT_THE_MEMBERS");
    });

    it("is refused when the summary link is not text", async () => {
      const numbered = [merge(DETAIL, { visit_summary_pdf_link: 12 })];
      await fails("clinic-visit", theVisit, numbered, "UNEXPECTED_ANSWER", "key:visit_summary_pdf_link");
    });
  });

  it("the list is refused over a row whose summary flag is not a boolean", async () => {
    const flaggedInText = history({ ...listed, has_summery_file: "true" });
    await fails("clinic-visits", {}, [flaggedInText], "UNEXPECTED_ANSWER", "key:has_summery_file");
  });

  describe("as a summary PDF", () => {
    const served = (answer: Partial<Route> = {}): Route => ({
      base64: asBase64("%PDF-1.7 summary"),
      match: DOCUMENT,
      ...answer,
    });

    it("is asked for the way the portal does: the path URI-encoded, the signature as it came", async () => {
      expect(await documentText("clinic-visit-summary-pdf", theVisit, answering())).toContain("%PDF");
      const { url, authorization } = last(DOCUMENT);
      expect(authorization).toBe("");
      expect(url).toContain(`${DOCUMENT}?path=summary%2Bdir%252Ffile${SENT_SIGNATURE}`);
    });

    it("needs the visit to be listed once", async () => {
      await fails("clinic-visit-summary-pdf", theVisit, [history(listed, listed)], "UNEXPECTED_ANSWER", "row-twice");
    });

    it("is not offered when the detail has no summary link", async () => {
      const linkless = answering({ visit_summary_pdf_link: "" });
      await fails("clinic-visit-summary-pdf", theVisit, linkless, "NOT_OFFERED", "summary-pdf-absent");
    });

    it.each<[string, string]>([
      ["is cut off mid-escape", "truncated%2"],
      ["could add a parameter", "sig&extra=1"],
    ])("is not asked for with a signature that %s", async (_how, hash) => {
      const asked = countOf(DOCUMENT);
      await fails("clinic-visit-summary-pdf", theVisit, answering({ hash }), "UNEXPECTED_ANSWER", "signature-unsafe");
      expect(countOf(DOCUMENT)).toBe(asked);
    });

    it.each<[string, Partial<Route>, string]>([
      ["comes from another URL", { url: `${new URL(DOCUMENT, LOGOUT_PAGE).href}?path=another` }, "file:redirected"],
      ["is no PDF", { base64: asBase64("plain text") }, "file:not-a-pdf"],
      ["is typed as HTML", { headers: { "content-type": "text/html" } }, "file:content-type"],
      ["declares one byte over 2 MiB", { headers: { "content-length": `${TWO_MIB + 1}` } }, "file:oversized"],
      // No declared length: the cap then applies to the bytes as they arrive.
      ["grows past 2 MiB undeclared", { pad: TWO_MIB }, "file:oversized"],
    ])("is refused when the answer %s", async (_how, answer, detail) => {
      await fails("clinic-visit-summary-pdf", theVisit, [...answering(), served(answer)], "UNEXPECTED_ANSWER", detail);
    });

    it("of exactly 2 MiB is returned whole, so it is the cap that refuses a larger one", async () => {
      const header = "%PDF-";
      const full = served({ pad: TWO_MIB - header.length, base64: asBase64(header) });
      expect((await file("clinic-visit-summary-pdf", theVisit, [full])).byteLength).toBe(TWO_MIB);
    });

    it("answered by the logout page means the session ended", async () => {
      await expired("clinic-visit-summary-pdf", theVisit, [served({ url: LOGOUT_PAGE })]);
    });
  });

  describe("through an attached document", () => {
    const referralArgs = async () => ({ ...theVisit, reference: (await visit()).referrals[0].pdf_reference });

    it.each(ATTACHED)(
      "%s: is found again in a fresh detail and fetched the way the portal fetches that kind",
      async (kind) => {
        const { pdf_reference } = (await visit())[kind][0];
        // Since the reference was handed out, the signature of the document has rotated.
        const later = detail();
        Object.assign(later[kind][0] as Fields, { hash: "later%2F+sig" });
        const text = await documentText("clinic-visit-document-pdf", { ...theVisit, reference: pdf_reference }, [
          answerWith(DETAIL, later),
        ]);
        expect(text).toContain("%PDF");

        // An information sheet is read from the medical file by `url`; the rest from here by `path`.
        const sheet = kind === "tutorials";
        const { url } = last(sheet ? "/MedicalFileAPI/webapi/mac/v2/" : DOCUMENT);
        expect(url).toContain(sheet ? "?url=" : "?path=");
        expect(url).toContain("%252Fdir%2Bfile&timestamp=stamp+ed&hash=later%2F+sig");
      },
    );

    it("is not fetched once the fresh list or the fresh detail stopped backing the reference", async () => {
      const args = await referralArgs();
      const asked = countOf("/pdf?");
      const another = {
        referral_pdf_link: "elsewhere",
        referral_description: "another",
        referral_id: "r-2",
        ...signed,
      };
      await fails(
        "clinic-visit-document-pdf",
        args,
        answering({ referrals: [another] }),
        "NOT_THE_MEMBERS",
        "reference-unknown",
      );
      await fails("clinic-visit-document-pdf", args, [history(listed, listed)], "UNEXPECTED_ANSWER", "row-twice");
      const summaryGone = history({ ...listed, has_summery_file: false });
      await fails("clinic-visit-document-pdf", args, [summaryGone], "NOT_OFFERED", "summary-absent");
      await fails("clinic-visit-document-pdf", { ...args, id: "visit-404" }, [], "NOT_THE_MEMBERS", "id-unknown");
      expect(countOf("/pdf?")).toBe(asked);
    });

    it.each<[string, string, string]>([
      ["one character over 16 KiB long", "p".repeat(16 * 1024 + 1), "file-path-unsafe"],
      ["impossible to URI-encode", UNENCODABLE, "link-unencodable"],
    ])("is refused when its path is %s", async (_what, referral_pdf_link, detail) => {
      const routes = answering({ referrals: [{ referral_pdf_link, referral_id: "r-1", ...signed }] });
      await fails("clinic-visit-document-pdf", await referralArgs(), routes, "UNEXPECTED_ANSWER", detail);
    });
  });
});

describe("an inquiry to a doctor", () => {
  const LIST = "/inquiries";
  const DETAIL = "/inquiries/2718/details";
  const theInquiry = { id: "2718" };
  const listed = {
    status_update_date: "day",
    request_status_code: "1",
    request_status: "נענתה במלואה",
    service_provider_name: "רופאה מדומה",
    type: "medical_form_request",
    request_id: theInquiry.id,
    member_id_code: 0,
    member_id: owner,
  };
  const sickPermit = { ...listed, medical_forms_documents: [], type: "automatic_sick_permit" };
  const form = (change: Fields = {}) => ({
    hash: "form+sig%2Bend",
    timestamp: "form%2Bstamp",
    link_pdf: "form+dir%2Ffile",
    document_description: "טופס מדומה",
    form_type: 1,
    document_id: 61,
    ...change,
  });
  const detail = (change: Fields = {}) => ({
    patient_full_name: "MOCKPATIENTFULLNAME",
    medical_forms_details: [form()],
    prescription_user_drugs_indication: [],
    approval_request_details: [],
    prescription_largo_code_list: [],
    request_status_desc: "נענתה במלואה",
    doctor_name: "רופאה מדומה",
    update_date: "day",
    creation_date: "day",
    doctor_remark: "תשובה מדומה",
    patient_remark: "שאלה מדומה",
    user_code: 0,
    user_id: MEMBER,
    request_id: Number(theInquiry.id),
    ...change,
  });
  const listing = (...inquiries: unknown[]): Route => answerWith(LIST, { inquiries });
  /** The inquiry answered with a changed detail, on a list that holds these rows. */
  const answering = (change: Fields = {}, rows: unknown[] = [listed]): Route[] => [
    answerWith(DETAIL, detail(change)),
    listing(...rows),
  ];
  const inquiry = (routes: Route[] = answering()) => read("doctor-inquiry", theInquiry, routes);
  const document = (reference: string, routes: Route[]) =>
    documentText("doctor-inquiry-pdf", { ...theInquiry, reference }, routes);

  describe("in detail", () => {
    it("live: reads without a visit when the visit it links to answers 204", async () => {
      const { visit_summary } = await read("doctor-inquiry", { id: "inq-2" });
      expect(visit_summary).toBeNull();
      expect(last("/visits/omr-1/").url).toContain("/?isOpenMedicalRecordNumber=true");
    });

    it("takes two GETs, keeps what was written, and has a reference for each answered form", async () => {
      const { patient_remark, medical_forms_details } = await inquiry();
      expect(lastTwoMethods(/./)).toEqual(["GET", "GET"]);
      expect(patient_remark).toBe("שאלה מדומה");
      expect(medical_forms_details).toEqual([
        expect.objectContaining({
          pdf_reference: expect.stringMatching(SHA256_HEX),
          form_type: 1,
          document_description: "טופס מדומה",
          document_id: 61,
        }),
      ]);
    });

    it.each<[string, Route[], string, string]>([
      ["names another member", answering({ user_id: SOMEONE_ELSE }), "NOT_THE_MEMBERS", "names-another-member"],
      ["names another inquiry", answering({ request_id: 2719 }), "NOT_THE_MEMBERS", "names-another-member"],
      ["is listed twice", answering({}, [listed, listed]), "UNEXPECTED_ANSWER", "row-twice"],
    ])("is refused when it %s", async (_how, routes, code, detail) => {
      await fails("doctor-inquiry", theInquiry, routes, code, detail);
    });

    it("is refused for an id the list lacks", async () => {
      await fails("doctor-inquiry", { id: "2720" }, answering(), "NOT_THE_MEMBERS", "id-unknown");
    });

    it("does not exist for an automatic sick permit", async () => {
      await fails(
        "doctor-inquiry",
        theInquiry,
        answering({}, [sickPermit]),
        "NOT_OFFERED",
        "sick-permit-has-no-detail",
      );
    });

    it("is refused when the doctor's remark is not text", async () => {
      await fails(
        "doctor-inquiry",
        theInquiry,
        answering({ doctor_remark: 12 }),
        "UNEXPECTED_ANSWER",
        "key:doctor_remark",
      );
    });

    it("is refused when it holds the same form twice", async () => {
      const twice = answering({ medical_forms_details: [form(), form()] });
      await fails("doctor-inquiry", theInquiry, twice, "UNEXPECTED_ANSWER", "row-twice");
    });

    it("keeps the prescription and approval requests field for field", async () => {
      const prescription_largo_code_list = [{ unlisted_code: "kept", drug_name: "תרופה מדומה" }];
      const approval_request_details = [
        {
          unlisted_type: "kept",
          approval_description: "תיאור מדומה",
          approval_additional_text: "פירוט מדומה",
          approval_required_to: null,
          approval_required_from: "2031-03-04T00:00:00",
        },
      ];
      const asked = await inquiry(answering({ approval_request_details, prescription_largo_code_list }));
      expect(asked.approval_request_details).toEqual(approval_request_details);
      expect(asked.prescription_largo_code_list).toEqual(prescription_largo_code_list);
    });

    it("reports a section it does not read, where silence would look like an empty one", async () => {
      const asked = await inquiry(answering({ prescription_user_drugs_indication: [{ origin: "somewhere" }] }));
      expect(asked.unsupported_sections).toEqual(["prescription_user_drugs_indication"]);
    });

    it.each<[string, Fields]>([
      ["a drug name with a control character", { prescription_largo_code_list: [{ drug_name: "\u0000" }] }],
      [
        "an approval whose start is a number",
        {
          approval_request_details: [
            { approval_additional_text: "text", approval_required_to: null, approval_required_from: 20310304 },
          ],
        },
      ],
      ["one approval more than the list may hold", { approval_request_details: Array(MOST_APPROVALS + 1).fill({}) }],
    ])("is refused as a changed shape over %s", async (_what, change) => {
      await fails("doctor-inquiry", theInquiry, answering(change), "UNEXPECTED_ANSWER", "shape-changed");
    });
  });

  describe("through an answered form", () => {
    const referenceIn = async (routes: Route[] = answering()) =>
      (await inquiry(routes)).medical_forms_details[0].pdf_reference;

    it("is found in a fresh detail by the form, whatever became of its link and signature", async () => {
      const reference = await referenceIn();
      const later = answering({ medical_forms_details: [form({ link_pdf: "later+dir%2Ffile", hash: "later%2Bsig" })] });
      expect(await document(reference, later)).toContain("%PDF");
      expect(last(DOCUMENT).url.endsWith("&hash=later%2Bsig")).toBe(true);
    });

    it("downloads at the highest form type listed, on an inquiry of status 8", async () => {
      const closed = answering({ medical_forms_details: [form({ form_type: 5 })] }, [
        { ...listed, request_status_code: "8" },
      ]);
      expect(await document(await referenceIn(closed), closed)).toContain("%PDF");
    });

    it("is not fetched once the fresh list or the fresh detail stopped backing the reference", async () => {
      const reference = await referenceIn();
      const asked = countOf("/pdf?");
      const unbacked: [Route[], string][] = [
        [answering(), "9d".repeat(32)],
        [answering({}, [{ ...listed, request_status_code: "0" }]), reference],
        [answering({ open_medical_record_number: "" }), reference],
        [answering({ medical_forms_details: [form({ form_type: 6 })] }), reference],
      ];
      for (const [routes, wanted] of unbacked) {
        await fails("doctor-inquiry-pdf", { ...theInquiry, reference: wanted }, routes, "NOT_THE_MEMBERS");
      }
      await fails("doctor-inquiry-pdf", { reference, id: "2720" }, answering(), "NOT_THE_MEMBERS", "id-unknown");
      expect(countOf("/pdf?")).toBe(asked);
    });
  });

  describe("that points at a visit", () => {
    const VISIT = "/visits/record-88/";
    const plainlySigned = { hash: "sig", timestamp: "stamp" };
    const pointedAt = {
      tutorials: [{ item_url: "https%3A%2F%2Fexample.invalid%2Farticle", type_id: 3, ...plainlySigned }],
      referrals: [
        {
          referral_pdf_link: "referral-of-88",
          referral_displaying_name: "הפניה מדומה",
          referral_id: "r-88",
          ...plainlySigned,
        },
      ],
      ...plainlySigned,
      visit_summary_pdf_link: "summary-of-88",
      diagnosis: [{ diagnosis_description: null }],
      visit_summary_date: "2026-06-30",
      member_id_code: "0",
      member_id: owner,
    };
    const pointing = answering({ medical_forms_details: [], open_medical_record_number: "record-88" });
    const routes = [...pointing, answerWith(VISIT, pointedAt)];
    const summaryOf = async () => (await inquiry(routes)).visit_summary.data;

    it("shows the visit's notes and has a reference for each of its documents", async () => {
      const summary = await summaryOf();
      expect(last(VISIT).url).toContain(`${VISIT}?isOpenMedicalRecordNumber=true`);
      expect(summary).toMatchObject({
        tutorials: [{ link: "https://example.invalid/article", type_id: 3 }],
        referrals: [
          {
            pdf_reference: expect.stringMatching(SHA256_HEX),
            referral_displaying_name: "הפניה מדומה",
            referral_id: "r-88",
          },
        ],
        summary_pdf_reference: expect.stringMatching(SHA256_HEX),
        has_summary_pdf: true,
        diagnosis: [{ diagnosis_description: null }],
        visit_summary_date: "2026-06-30",
      });
    });

    it("downloads the visit's summary and its referral, each with the visit's own signature", async () => {
      const { summary_pdf_reference, referrals } = await summaryOf();
      expect(await document(summary_pdf_reference, routes)).toContain("%PDF");
      expect(last(DOCUMENT).url).toContain("?path=summary-of-88&timestamp=stamp&hash=sig");
      expect(await document(referrals[0].pdf_reference, routes)).toContain("%PDF");
      expect(last(DOCUMENT).url).toContain("?path=referral-of-88&");
    });

    it("is refused when that visit belongs to someone else", async () => {
      const foreign = [...pointing, answerWith(VISIT, { ...pointedAt, member_id: "somebody-else" })];
      await fails("doctor-inquiry", theInquiry, foreign, "NOT_THE_MEMBERS");
    });

    it("is refused when the visit number is not text", async () => {
      const numbered = answering({ open_medical_record_number: 88 });
      await fails("doctor-inquiry", theInquiry, numbered, "UNEXPECTED_ANSWER", "key:open_medical_record_number");
    });
  });

  describe("in the list", () => {
    const permitFile = { hash: "permitsig", timestamp: "permitstamp", result_file: "permit+dir%2Ffile" };
    const permit = (medical_forms_documents: unknown[], change: Fields = {}): Route[] => [
      listing({ ...sickPermit, medical_forms_documents, document_id: "permit-9", ...change }),
    ];
    const inquiries = (routes: Route[]): Promise<any[]> => read("doctor-inquiries", {}, routes);

    it("keeps its subjects exactly as received", async () => {
      const request_subjects = [{ unlisted: "kept", name: "נושא מדומה", id: 3 }];
      const [row] = await inquiries([listing({ ...listed, request_subjects })]);
      expect(row.request_subjects).toEqual(request_subjects);
    });

    it.each<[string, unknown]>([
      ["of another member", String(SOMEONE_ELSE)],
      ["that names no member", undefined],
    ])("fails the list when it is a row %s", async (_whose, member_id) => {
      await fails(
        "doctor-inquiries",
        {},
        [listing({ ...listed, member_id })],
        "NOT_THE_MEMBERS",
        "names-another-member",
      );
    });

    it("as an automatic sick permit, hands out its one document signed by the list row, with no detail read", async () => {
      const [{ pdf_reference }] = await inquiries(permit([permitFile]));
      expect(pdf_reference).toMatch(SHA256_HEX);
      const detailsRead = countOf(DETAIL);
      expect(await document(pdf_reference, permit([permitFile]))).toContain("%PDF");
      expect(countOf(DETAIL)).toBe(detailsRead);
      expect(last(DOCUMENT).url).toContain("?path=permit%2Bdir%252Ffile&timestamp=permitstamp&hash=permitsig");
    });

    it("as an automatic sick permit, refuses a reference the fresh list does not back", async () => {
      const stray = { ...theInquiry, reference: "5a".repeat(32) };
      await fails("doctor-inquiry-pdf", stray, permit([permitFile]), "NOT_THE_MEMBERS", "reference-unknown");
    });

    it("as an automatic sick permit without a document, has no reference", async () => {
      const [row] = await inquiries(permit([]));
      expect("pdf_reference" in row).toBe(false);
    });

    it.each<[string, Route[], string]>([
      ["two documents", permit([permitFile, permitFile]), "key:medical_forms_documents"],
      ["no document id", permit([permitFile], { document_id: "" }), "oversized"],
      ["a timestamp that could add a parameter", permit([{ ...permitFile, timestamp: "x&y" }]), "signature-unsafe"],
      ["a path that cannot be URI-encoded", permit([{ ...permitFile, result_file: UNENCODABLE }]), "link-unencodable"],
      ["a path over 16 KiB", permit([{ ...permitFile, result_file: "p".repeat(16 * 1024 + 1) }]), "key:result_file"],
    ])("fails the list over a sick permit with %s", async (_what, routes, detail) => {
      await fails("doctor-inquiries", {}, routes, "UNEXPECTED_ANSWER", detail);
    });
  });
});

it("asked the fake for nothing it had to refuse", () => {
  expect(box.unexpected(), "refused requests and outbound sockets").toEqual([]);
});
