/**
 * The appointment reads, from the built bundle's MCP server against the fake Maccabi. What is already
 * booked: the list, and one appointment with its provider's card and its instructions. Whom the member
 * sees: the recent providers, one card, the assigned doctor. What could be booked: visit types, free
 * slots, instructions, eligibility, and `bookable-providers`, which gathers them. Wherever the website
 * posts a body, the body the bundle sent is held against the website's. All of it only looks, so the
 * closing tests search the fake's log for a request that books, holds, moves or cancels an appointment
 * or starts a scheduling conversation, and must find none.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { answerWith, bootstrap, ID, MEMBER, memberSession, merge, type Route, SOMEONE_ELSE } from "../rig";

const session = memberSession("scheduling");
const { box, ok, fails } = session;

/** The first two recent providers of test/fake/maccabi.mjs: a doctor booked online, and a clinic. */
const DOCTOR = { object_type: "S", object_id: "5001", employee_id: "7001" };
const CLINIC = { object_type: "O", object_id: "6001", employee_id: "0" };
/** What that fake's provider card and visit instructions say. */
const DOCTOR_NAME = 'ד"ר בדוי';
const ADDRESS = "רחוב בדוי 1, עיר בדוי";
const BRING = { description: "יש להביא כרטיס מגנטי", link: "https://example.invalid/what-to-bring" };

/** Fragments of the URLs these reads request. */
const UPCOMING = "/appointments/future";
const CARD = `/MainAppAPI/webapi/mac/v1/members/0/${ID}/providers`;
const RECENT = "/appointment_service_providers";
const ASCRIBED = "/providers/ascribed";
const VISIT_TYPES = "/appointments/visit_types";
const SLOTS = "/provider_appointments";
const INSTRUCTIONS = "/instructions_for_visit_type";
const MEMBER_ELIGIBILITY = "/member-eligibilities";

const OPAQUE = /^[0-9a-f]{64}$/;
/** An appointment with the doctor, the way the website's list would send it. */
const booked = {
  phone_for_contact: "03-0000004",
  permissions: "4",
  type: "100",
  ...DOCTOR,
  id: "booking-61",
  provider_role: "מ",
  waiting_list_status: "1",
  ascribed_doctor_gender: 2,
  ascribed_doctor: false,
  category_visit_type: 3,
  description: "בדיקה תקופתית",
  provider_service_type: "מקצוע מדומה",
  provider_name: 'ד"ר פלונית',
  date: "2027-02-16T11:40:00",
};
const upcoming = (...rows: unknown[]): Route => answerWith(UPCOMING, rows);
/** The JSON the bundle last posted to a URL containing `fragment`. */
const posted = (fragment: string) => JSON.parse(session.last(fragment).body);

beforeAll(session.start);

describe("the upcoming list", () => {
  it("is asked for on behalf of the signed-in member alone, assigned doctor included", async () => {
    const { data } = await ok("appointments");
    expect(data).toEqual([]);
    expect(posted(UPCOMING)).toEqual({
      is_with_ascribed_doctor: true,
      members: [{ member_consent_for_subsidiary_information: 0, member_id: MEMBER, member_id_code: "0" }],
    });
  });

  it("returns a row with all it was sent, the timeline's fields filled in, and a reference", async () => {
    const { data, source } = await ok("appointments", {}, [upcoming(booked)]);
    expect(source.schemaEvidence).toBe("frontend-field-projection");
    const added = { follow_up_appointments_count: null, facility_category: null, subsidiary_name: null };
    expect(data).toEqual([{ reference: expect.stringMatching(OPAQUE), ...added, ...booked }]);
  });

  it("gives a reference only to a row whose detail it could read", async () => {
    const atSubsidiary = {
      external_id: "partner-9",
      category_visit_type: 1,
      follow_up_appointments_count: 3,
      facility_category: "מכון שותף",
      subsidiary_name: "חברה בת בדויה",
      provider_service_type: "דימות",
      date: "2027-03-02",
    };
    const atClinic = { ...booked, ...CLINIC, provider_id: 8001, employee_id: 0, id: "booking-62" };
    const oddType = { ...booked, type: { nested: true }, id: "booking-63" };
    const { data } = await ok("appointments", {}, [upcoming(atSubsidiary, atClinic, oddType)]);
    expect(data.map((row: object) => "reference" in row)).toEqual([false, true, false]);
    expect(data[1].reference).toMatch(OPAQUE);
    expect(data[0]).toMatchObject({
      follow_up_appointments_count: 3,
      subsidiary_name: "חברה בת בדויה",
      provider_name: null,
    });
  });

  const tooMany = Array.from({ length: 1001 }, (_, number) => ({ ...booked, id: `booking-${number}` }));
  it.each<[string, Route, string, string?]>([
    [
      "a row that names neither a provider nor a subsidiary",
      upcoming({ provider_service_type: "s", date: "d" }),
      "UNEXPECTED_ANSWER",
      "shape-changed",
    ],
    [
      "a row whose visit category is text",
      upcoming({ category_visit_type: "3", provider_service_type: "s", provider_name: "n", date: "d" }),
      "UNEXPECTED_ANSWER",
      "shape-changed",
    ],
    ["an answer that is no list", answerWith(UPCOMING, {}), "UNEXPECTED_ANSWER"],
    ["one row sent twice", upcoming(booked, booked), "UNEXPECTED_ANSWER", "row-twice"],
    ["a thousand and one rows", upcoming(...tooMany), "UNEXPECTED_ANSWER", "shape-changed"],
    ["a row that names another member", upcoming({ member_id: SOMEONE_ELSE, ...booked }), "NOT_THE_MEMBERS"],
  ])("refuses %s", async (_what, route, code, detail) => {
    await fails("appointments", {}, [route], code, detail);
  });
});

describe("one upcoming appointment", () => {
  let reference = "";
  beforeAll(async () => {
    const { data } = await ok("appointments", {}, [upcoming(booked)]);
    reference = data[0].reference;
  });
  /** The detail of `booked` while the fake answers with `routes` too. */
  const detail = async (...routes: Route[]) =>
    (await ok("appointment", { reference }, [upcoming(booked), ...routes])).data;
  const cardOf = (provider: Record<string, unknown>): Route =>
    answerWith(CARD, { providers: { provider: [provider] } });
  const instructionsOf = (answer: Record<string, unknown>): Route => answerWith(INSTRUCTIONS, answer);
  const linked = (link: unknown): Route =>
    instructionsOf({ specific_visits_instructions: [{ link, description: "bring" }], visit_description: "visit" });

  it("reads the provider's card and the visit's instructions, and shows what the website's detail shows", async () => {
    const { provider, instructions, visit_instructions, appointment } = await detail();
    expect(provider).toMatchObject({
      contacts: expect.any(Array),
      provider_details: expect.objectContaining({ full: ADDRESS }),
      fax: null,
      phone: "03-0000001",
      order_appointment_phone: "03-0000002",
      address: ADDRESS,
    });
    expect(instructions).toEqual([BRING]);
    expect(typeof visit_instructions.visit_description).toBe("string");
    expect(appointment).toMatchObject({ provider_name: booked.provider_name, object_id: "5001", id: booked.id });
    expect(posted(CARD)).toEqual({ retrieval_type: "1", service_providers: [DOCTOR] });
    expect(posted(INSTRUCTIONS)).toEqual({ chosenVisitType: "100", ...DOCTOR });
  });

  it("looks a row without an employee up by its provider id, and has no address outside visit category 3", async () => {
    const listed = upcoming({ ...booked, category_visit_type: 2, provider_id: 8001, employee_id: 0, id: "booking-62" });
    const fasting = instructionsOf({
      specific_visits_instructions: [{ link: null, description: "להגיע בצום" }],
      visit_description: "בדיקת דם",
    });
    const [row] = (await ok("appointments", {}, [listed])).data;
    const { data } = await ok("appointment", { reference: row.reference }, [listed, fasting]);
    expect(data.provider.address).toBeNull();
    expect(posted(CARD)).toEqual({
      retrieval_type: "1",
      service_providers: [{ provider_id: 8001, object_id: "5001", object_type: "S" }],
    });
  });

  it("refuses a reference the fresh list does not hold", async () => {
    const stale = { reference: "c".repeat(64) };
    await fails("appointment", stale, [upcoming(booked)], "NOT_THE_MEMBERS", "reference-unknown");
  });

  it("returns a contact whose code the website does not show, and fills none of the three fields from it", async () => {
    const contacts = [
      { contact_details: "פקס המרפאה", code: "03" },
      { contact_details: "MOCKOTHERCONTACT", code: "77" },
    ];
    const { provider } = await detail(cardOf({ contacts, provider_details: { full: "סמטת הדוגמה 4" } }));
    expect(provider).toMatchObject({
      fax: "פקס המרפאה",
      phone: null,
      order_appointment_phone: null,
      address: "סמטת הדוגמה 4",
    });
    expect(provider.contacts).toContainEqual(expect.objectContaining({ code: "77" }));
  });

  const bare = { contacts: [], provider_details: { full: "anywhere" } };
  const sameCode = ["first", "second"].map((contact_details) => ({ contact_details, code: "02" }));
  it.each<[string, Route, string]>([
    [
      "the card is another provider's",
      cardOf({ ...bare, sap_key: { ...DOCTOR, object_Id: "5999" } }),
      "UNEXPECTED_ANSWER",
    ],
    ["there is no card", answerWith(CARD, { providers: { provider: [] } }), "UNEXPECTED_ANSWER"],
    ["a contact code comes twice", cardOf({ ...bare, contacts: sameCode }), "UNEXPECTED_ANSWER"],
    ["the instructions lack a description", instructionsOf({ specific_visits_instructions: [] }), "UNEXPECTED_ANSWER"],
    ["an instruction's link is a number", linked(404), "UNEXPECTED_ANSWER"],
    ["an instruction's link is no URL", linked("see the nurse"), "UNEXPECTED_ANSWER"],
    ["an instruction's link would run a script", linked("javascript:void(0)"), "UNEXPECTED_ANSWER"],
    [
      "an instruction's link carries credentials",
      linked("https://nurse:secret@example.invalid/prepare"),
      "UNEXPECTED_ANSWER",
    ],
    [
      "the instructions name another member",
      instructionsOf({ member_id: SOMEONE_ELSE, specific_visits_instructions: [], visit_description: "visit" }),
      "NOT_THE_MEMBERS",
    ],
  ])("refuses the detail when %s", async (_why, route, code) => {
    await fails("appointment", { reference }, [upcoming(booked), route], code);
  });
});

describe("recent providers", () => {
  // Live, a clinic's row has null where a doctor's row has a title and an id.
  it("accepts a row whose practitioner fields are null", async () => {
    const [, clinic] = (await ok("recent-providers")).data;
    expect(clinic).toMatchObject({ practitioner_id: null, pactitioner_name_title: null, object_type: "O" });
  });

  const complete = {
    clinic_address: {},
    practitioner_id: "pr",
    pactitioner_name_title: "אחות",
    employee_id: "em",
    object_id: "ob",
    object_type: "S",
  };
  it.each([
    ["clinic_address", null],
    ["pactitioner_name_title", 12],
    ["object_id", null],
  ])("refuses a row whose %s is %j", async (field, value) => {
    const rows = [complete, { ...complete, [field]: value }];
    await fails("recent-providers", {}, [answerWith(RECENT, rows)], "UNEXPECTED_ANSWER", `key:${field}`);
  });

  it("are not offered on a minor's account", async () => {
    const fourteen = bootstrap({ logged_customer_info: { age: { years: 14 } } });
    await fails("recent-providers", {}, [fourteen], "NOT_OFFERED", "account-of-a-minor");
  });
});

describe("one recent provider's card", () => {
  const cards = (...provider: unknown[]): Route => answerWith(CARD, { providers: { provider } });

  // A team member taken from a provider's card is not a recent provider, and no amount of listing again
  // makes it one. The refusal says which rows the three fields are copied from.
  it("is refused for a provider the fresh list does not hold, as a mistake in the input", async () => {
    const stranger = { ...DOCTOR, object_id: "nobody" };
    const refusal = await fails("provider", stranger, [], "NOT_THE_MEMBERS", "provider-unknown");
    expect(refusal).toMatchObject({ retry: "after-fixing-input", cause: "caller" });
    expect(refusal.message).toContain("`recent-providers` row");
  });

  it("is refused when it is another provider's", async () => {
    const theirs = {
      sap_key: { ...DOCTOR, object_Id: "5999" },
      provider_role: "מ",
      facility_id: "410",
      provider_id: "8040",
    };
    await fails("provider", DOCTOR, [cards(theirs)], "UNEXPECTED_ANSWER", "key:sap_key");
  });

  it("is refused when two come back for one provider", async () => {
    await fails("provider", DOCTOR, [cards({}, {})], "UNEXPECTED_ANSWER", "row-count-off");
  });

  // Live, the card endpoint answers HTTP 204 for a provider that has no booking type.
  it("is absent, not malformed, when the endpoint answers HTTP 204", async () => {
    const { data } = await ok("provider", DOCTOR, [{ match: CARD, text: "", status: 204 }]);
    expect(data).toMatchObject({ provider_card: null, answered: false });
  });
});

describe("the assigned doctor and booking eligibility", () => {
  const at = "2024-06-07T08:09:10";

  it("asks for the assigned doctor at the wall-clock time it was given, adding no zone", async () => {
    const { data } = await ok("assigned-doctor", { at });
    expect(data).toMatchObject({ service_provider_id: "9001" });
    expect(session.query(ASCRIBED)).toMatchObject({ requested_association_date: at });
  });

  it("reads a bare date as noon of that day, and no time at all as the present moment in Israel", async () => {
    await ok("assigned-doctor", { at: "2024-06-07" });
    expect(session.query(ASCRIBED)).toMatchObject({ requested_association_date: "2024-06-07T12:00:00" });
    await ok("assigned-doctor");
    expect(session.query(ASCRIBED).requested_association_date).toMatch(/^\d{4}(?:-\d\d){2}T\d\d(?::\d\d){2}$/);
  });

  it("refuses an assigned doctor who has no id", async () => {
    const anonymous = answerWith(ASCRIBED, { last_name: "ln", first_name: "fn" });
    await fails("assigned-doctor", { at }, [anonymous], "UNEXPECTED_ANSWER", "key:service_provider_id");
  });

  it("refuses an eligibility that is neither true nor false", async () => {
    const maybe = answerWith("/appointments/eligibility", { future_appointments: [], is_eligible: "true" });
    await fails("booking-eligibility", DOCTOR, [maybe], "UNEXPECTED_ANSWER", "key:is_eligible");
  });
});

describe("visit types", () => {
  const regular = { ...DOCTOR, visit_type: "100" };
  const inClinic = {
    appointment_time: "09:15",
    appointment_date: "2027-01-11",
    description: "ביקור במרפאה",
    code: "100",
  };
  /** The doctor's visit types: `closed` greyed out, `open` bookable. */
  const typesWith = (closed: unknown[], open: unknown = [inClinic]): Route =>
    answerWith(VISIT_TYPES, {
      other_visit_type_without_eligibility: [],
      general_instruction: [],
      visit_types_not_eligible: closed,
      visit_types_eligible: open,
    });
  /** Each reason the website greys a visit type out for, with the words it shows. The last has none of its own. */
  const GREYED: [Record<string, unknown>, unknown][] = [
    [{ error_code: "ZZ", code: "410" }, "לא ניתן לבחור בסוג ביקור זה"],
    [{ booking_type: "V4", error_code: "00", code: "411" }, "זמין אחת לשנתיים"],
    [{ error_code: "U4", code: "412" }, "אין זכאות לחיסון קורונה"],
    [{ error_code: "P0", code: "413" }, "נדרש ביקור פרונטלי לפני ביקור זה"],
    [{ months_from_last_visit: 6, error_code: " r3 ", code: "414" }, "זמין לאחר ביקור במרפאה ב-6 החודשים האחרונים"],
    [{ months_from_last_visit: 24, error_code: "P0", code: "415" }, "זמין לאחר ביקור במרפאה בשנתיים האחרונות"],
    [{ months_from_last_visit: 12, error_code: "R3", code: "416" }, expect.any(String)],
  ];
  const greyedOut = typesWith(GREYED.map(([type]) => type));

  it("puts the website's own explanation on every greyed-out visit type", async () => {
    const { providers } = (await ok("bookable-providers", DOCTOR, [greyedOut])).data;
    const shown = providers[0].visit_types.visit_types_not_eligible.map((type: any) => type.portal_disabled_text);
    expect(shown).toEqual(GREYED.map(([, words]) => words));
  });

  it("refuses free slots of a greyed-out visit type as not entitled, without one slot query", async () => {
    const queries = session.count(SLOTS);
    const closed = { ...DOCTOR, visit_type: "410" };
    const error = await fails("open-slots", closed, [greyedOut], "NOT_ENTITLED", "visit-kind-closed");
    expect(error.message).toMatch(/visit_types_eligible/);
    expect(session.count(SLOTS)).toBe(queries);
  });

  it("refuses a visit type that is not on the provider's list", async () => {
    const unlisted = { ...DOCTOR, visit_type: "977" };
    await fails("visit-preparation", unlisted, [greyedOut], "NOT_THE_MEMBERS", "visit-kind-unknown");
  });

  it("refuses a list that holds one visit type twice", async () => {
    const twice = typesWith([], [{ code: "100" }, { code: "100" }]);
    await fails("open-slots", regular, [twice], "UNEXPECTED_ANSWER", "duplicate-visit-type");
  });

  it("refuses visit types that are no list, and an answer that is no object", async () => {
    await fails("open-slots", regular, [typesWith([], {})], "UNEXPECTED_ANSWER");
    await fails("open-slots", regular, [answerWith(VISIT_TYPES, [])], "UNEXPECTED_ANSWER", "key:body");
  });

  it("say that nothing was answered for a clinic that answers HTTP 204", async () => {
    expect((await ok("visit-types", CLINIC)).data).toMatchObject({ answered: false });
  });
});

describe("free slots", () => {
  const regular = { ...DOCTOR, visit_type: "100" };
  const video = { ...DOCTOR, visit_type: "200" };
  const WHOLE_DAY = ["0000", "2359"];
  const slotsWith = (patch: Record<string, unknown>): Route => merge(SLOTS, patch);
  /** The month, the day and the hours the last slot query asked for. */
  const lastQuery = () => {
    const sent = posted(SLOTS);
    return { month: sent.query_month, day: sent.query_date, hours: [sent.from_time, sent.to_time] };
  };

  it("are those of the first month that has any when no month or day is given, with the provider's card", async () => {
    const { data } = await ok("open-slots", regular);
    expect(data).toMatchObject({
      booking: { booked: false },
      provider_record: { provider_details: { name: DOCTOR_NAME } },
      no_free_slots: false,
    });
    expect(data.response.appointments.appointment).toMatchObject([
      { time: "08:30", day: "2026-11-23" },
      { time: "12:00", day: "2026-11-24" },
      { time: "16:40", day: "2026-11-24", replacement_provider: { first_name: "מחליף" } },
    ]);
    expect(lastQuery()).toEqual({ month: null, day: null, hours: [null, null] });
  });

  it("are asked for by month as YYYYMM, and the website's F4 is an ordinary 'nothing free'", async () => {
    const { data } = await ok("open-slots", { ...regular, month: "2027-03" });
    expect(data).toMatchObject({
      response: { result_message: "לא נמצאו תורים פנויים עבור הפרטים שהוזנו.", result_code: "F4" },
      no_free_slots: true,
    });
    expect(lastQuery()).toEqual({ month: "202703", day: null, hours: WHOLE_DAY });
  });

  it("are asked for by day at the website's noon, each marked as at the provider's own clinic or not", async () => {
    const { query, response } = (await ok("open-slots", { ...video, date: "2026-11-24" })).data;
    const atOwnClinic = response.appointments.appointment.map((slot: any) => slot.facility_matches_provider_record);
    expect(atOwnClinic).toEqual([true, false]);
    expect(query).toMatchObject({ query_date: "2026-11-24T10:00:00", mode: "date" });
    expect(lastQuery()).toEqual({ month: "202611", day: "2026-11-24T10:00:00", hours: WHOLE_DAY });
  });

  // The website's day picker sends noon in Israel as UTC, which is 09:00 while summer time lasts.
  it("are asked for at 09:00 UTC on a summer day", async () => {
    await ok("open-slots", { ...regular, date: "2026-08-12" });
    expect(lastQuery()).toEqual({ month: "202608", day: "2026-08-12T09:00:00", hours: WHOLE_DAY });
  });

  // Live, a day that has no slot answers HTTP 204.
  it("are none, without a failure, on a day that answers HTTP 204", async () => {
    const { data } = await ok("open-slots", { ...video, date: "2026-11-25" });
    expect(data).toMatchObject({ booking: { booked: false }, response: null, no_free_slots: true, answered: false });
  });

  it("are none when the answer has neither appointments nor days", async () => {
    const { data } = await ok("open-slots", regular, [slotsWith({ available_days: null, appointments: null })]);
    expect(data.no_free_slots).toBe(true);
  });

  it("still come back when the provider's card fails, with the failure where the card would be", async () => {
    const { data } = await ok("open-slots", regular, [{ match: CARD, text: "", status: 502 }]);
    expect(data).toMatchObject({
      response: { result_code: "00" },
      provider_record_error: { detail: "status=502", code: "PORTAL_HTTP_ERROR" },
      provider_record: null,
    });
  });

  it("are not queried for a provider who is not one of the member's recent ones", async () => {
    const queries = session.count(SLOTS);
    await fails("open-slots", { ...regular, employee_id: "3", object_id: "4321" }, [], "NOT_THE_MEMBERS");
    expect(session.count(SLOTS)).toBe(queries);
  });

  it("request nothing for a month or day before 2000, a month together with a day, or a two-line visit type", async () => {
    const requests = box.fetches().length;
    const inputs = [
      { ...regular, visit_type: "1\n2" },
      { ...regular, date: "2026-11-24", month: "2026-11" },
      { ...regular, date: "1999-12-31" },
      { ...regular, month: "1999-12" },
    ];
    for (const input of inputs) await fails("open-slots", input, [], "BAD_INPUT");
    expect(box.fetches()).toHaveLength(requests);
  });

  it.each<[string, Record<string, unknown>, string, string?]>([
    [
      "a result code that is neither 00 nor F4",
      { result_code: "W2" },
      "PORTAL_REPORTED_ERROR",
      "result-code-not-00-or-F4",
    ],
    ["a result code that is a number", { result_code: 7 }, "UNEXPECTED_ANSWER", "key:result_code"],
    ["a day of the month above 31", { available_days: [32] }, "UNEXPECTED_ANSWER", "key:available_days"],
    [
      "a slot whose date is a number",
      { appointments: { appointment: [{ date: 20261123 }] } },
      "UNEXPECTED_ANSWER",
      "key:appointments.appointment.date",
    ],
    ["the name of another member", { member_id: SOMEONE_ELSE }, "NOT_THE_MEMBERS"],
  ])("are refused when the answer carries %s", async (_what, patch, code, detail) => {
    await fails("open-slots", regular, [slotsWith(patch)], code, detail);
  });
});

describe("visit instructions", () => {
  const regular = { ...DOCTOR, visit_type: "100" };

  it("tell what to bring, and are asked for with the website's body", async () => {
    const { instructions } = (await ok("visit-preparation", regular)).data;
    expect(instructions).toMatchObject({
      specific_visits_instructions: [{ description: BRING.description }],
      visit_description: "ביקור רגיל",
    });
    expect(posted(INSTRUCTIONS)).toEqual({ chosenVisitType: "100", ...DOCTOR });
  });

  it("are refused as no content on an HTTP 204", async () => {
    const nothing = { match: INSTRUCTIONS, text: "", status: 204 };
    await fails("visit-preparation", regular, [nothing], "UNEXPECTED_ANSWER", "no-content");
  });

  it("are refused when the visit description is empty", async () => {
    const wordless = answerWith(INSTRUCTIONS, { visit_description: "" });
    await fails("visit-preparation", regular, [wordless], "UNEXPECTED_ANSWER", "key:visit_description");
  });
});

describe("appointment options", () => {
  const optionsFor = async (provider: Record<string, unknown>, ...routes: Route[]) =>
    (await ok("bookable-providers", provider, routes)).data;

  describe("for every recent provider", () => {
    let options: any;
    let firstRequest = 0;
    beforeAll(async () => {
      firstRequest = box.fetches().length;
      options = await optionsFor({});
    });

    it("give a doctor booked online the card, the eligibility and each visit type's first free slot", () => {
      const [doctor] = options.providers;
      expect(doctor).toMatchObject({
        visit_types: {
          visit_types_eligible: [
            { appointment_time: "08:30", appointment_date: "2026-11-23", code: "100" },
            { appointment_time: "12:00", appointment_date: "2026-11-24", code: "200" },
          ],
        },
        member_eligibility: { answered: false },
        eligibility: { is_eligible: true },
        provider_record: { provider_details: { full: ADDRESS } },
        row: { clinic_address: { city: "עיר בדוי" }, pactitioner_name_title: DOCTOR_NAME },
        bookable_online: true,
      });
    });

    it("explain a clinic whose visit types answer HTTP 204, where they could have failed", () => {
      const [, clinic] = options.providers;
      expect(clinic).toMatchObject({
        visit_types: { note: expect.stringContaining("204"), answered: false },
        booking_flow_reference: { employee_id: "0" },
        bookable_online: null,
      });
    });

    it("skip a provider the website shows only a phone number for, and say why", () => {
      expect(options.providers[2].skipped).toMatch(/phone_number/);
    });

    it("carry the assigned doctor and the way to book", () => {
      expect(options).toMatchObject({
        booking: { how_to_book: expect.stringContaining("*3555"), booked: false },
        assigned_doctor: { service_provider_id: "9001" },
      });
    });

    it("ask for visit types as the website does: action type 1, and employee 0 for a clinic", () => {
      const asked = box
        .fetches()
        .slice(firstRequest)
        .filter((request) => new URL(request.url).pathname.endsWith(VISIT_TYPES))
        .map((request) => JSON.parse(request.body));
      expect(asked).toEqual([
        { action_type: "1", ...DOCTOR },
        { action_type: "1", ...CLINIC },
      ]);
    });
  });

  it("request nothing when given half of a provider's identity", async () => {
    const requests = box.fetches().length;
    await fails("bookable-providers", { object_id: "5001", object_type: "S" }, [], "BAD_INPUT");
    expect(box.fetches()).toHaveLength(requests);
  });

  it("cover one provider alone when one is given", async () => {
    const { providers } = await optionsFor(DOCTOR);
    expect(providers).toMatchObject([{ row: DOCTOR }]);
  });

  it("ask a clinic's member eligibility with the website's body, and return the answer as answered", async () => {
    const response = { note: "as sent", is_eligible: false };
    const { providers } = await optionsFor(CLINIC, answerWith(MEMBER_ELIGIBILITY, response));
    expect(providers[0]).toMatchObject({ member_eligibility: { response, answered: true } });
    expect(posted(MEMBER_ELIGIBILITY)).toEqual({
      is_supplemental_health_service: false,
      appointment_date: null,
      object_id: CLINIC.object_id,
      object_type: CLINIC.object_type,
    });
  });

  it("report a malformed member eligibility where the eligibility would be", async () => {
    const { providers } = await optionsFor(DOCTOR, answerWith(MEMBER_ELIGIBILITY, { is_eligible: "false" }));
    expect(providers[0].member_eligibility).toMatchObject({ detail: "key:is_eligible", code: "UNEXPECTED_ANSWER" });
  });

  it("report failing visit types on the provider they failed for, and still answer for the others", async () => {
    const { providers } = await optionsFor({}, { match: VISIT_TYPES, text: "", status: 500 });
    expect(providers[0].visit_types).toMatchObject({ code: "PORTAL_HTTP_ERROR" });
    expect(providers[2].skipped).toMatch(/phone_number/);
  });

  it("report a failing assigned-doctor read where the doctor would be, and still answer for the providers", async () => {
    const options = await optionsFor({}, { match: ASCRIBED, text: "", status: 500 });
    expect(options).toMatchObject({
      assigned_doctor_error: { detail: "status=500", code: "PORTAL_HTTP_ERROR" },
      assigned_doctor: null,
    });
    expect(options.providers).toHaveLength(3);
  });

  it("take a summons type sent as a number for a provider booked online", async () => {
    const row = {
      clinic_address: {},
      summons_type: 8,
      practitioner_id: "9001",
      pactitioner_name_title: "פרופ'",
      ...DOCTOR,
    };
    const { providers } = await optionsFor({}, answerWith(RECENT, [row]));
    expect(providers[0].bookable_online).toBe(true);
  });
});

describe("only reads were made", () => {
  /** What the website's appointmentOrder bundle calls to book, hold, move, hand over, cancel or wait-list. */
  const WRITES =
    /joinwaitinglist|switchit|cancel|replace_for_different_provider|update_appointment|summon_appointment/i;

  it("made every request a GET or a POST, and none to a path that changes an appointment", () => {
    const requests = box.fetches();
    // Enough of them concerned appointments for the sweep to mean something.
    expect(requests.filter(({ url }) => /providers|appointments\//.test(url)).length).toBeGreaterThan(20);
    for (const { url, method } of requests) {
      expect(url).not.toMatch(WRITES);
      expect(method).toMatch(/^(?:GET|POST)$/);
    }
  });

  it("never started a scheduling conversation", () => {
    expect(box.fetches().filter(({ url }) => /\/odoro\//i.test(url))).toEqual([]);
    expect(box.log().filter(({ kind }) => /^scheduling-/.test(kind))).toEqual([]);
  });

  it("asked the fake for nothing it does not serve, and opened no socket", () => {
    expect(box.unexpected()).toEqual([]);
  });
});
