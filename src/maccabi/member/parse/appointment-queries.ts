/**
 * Looking for an appointment without making one: which of the member's recent providers take online
 * bookings, what kinds of visit each offers, and when and where there is a free slot.
 *
 * The portal's "new appointment" pages (its appointmentOrder frontend) ask Maccabi all of this merely
 * to draw themselves, and this module asks the same questions and stops where the pages stop asking.
 * These are the requests, under the page that sends each (docs/security.md classifies every one of
 * them against the frontend bundle):
 *
 *   the recent-providers page
 *     GET  providers/appointment_service_providers      (AppointmentOrderAPI)
 *   the eligibility modal that comes before PickType
 *     POST appointments/eligibility                     (AppointmentOrderAPI)
 *   the PickType page as it loads
 *     POST providers, retrieval_type "1"                (MainAppAPI; the doctor's card)
 *     POST appointments/visit_types                     (AppointmentOrderAPI)
 *     POST appointments/member-eligibilities            (AppointmentOrderAPI; the Odoro page sends it too)
 *   a visit type, a month or a day being picked
 *     POST appointments/provider_appointments           (AppointmentOrderAPI)
 *   the Confirm page as it loads
 *     POST appointments/instructions_for_visit_type     (AppointmentOrderAPI)
 *
 * What the pages do after that is a different matter. Booking happens on the Confirm page's button
 * (summon_appointment), and nothing here leads to it, nor to update_appointment,
 * replace_for_different_provider, the cancelling DELETE, joinwaitinglist, the switchit endpoints or
 * an odoro session or dialog. Picking an hour in the portal changes the page and nothing at Maccabi.
 *
 * A request body is the portal's body, key for key. One rule of the portal's shapes most of them:
 * on the way from the provider list to the booking pages it keeps a row's `employee_id` for
 * object_type "S" and puts 0 for any other type, and from then on every query repeats the value in
 * the page's address, which is why it travels as a string.
 */
import type { RefusalCode } from "../../faults";
import type { ProviderKey, VisitedProvider } from "../scheduling";
import type { Fields, MemberKey, Reading } from "../shared";

/** Attached to every result of this module, so that a search cannot be read as a booking. */
export const SEARCH_ONLY = {
  booked: false,
  note: "This was a search and nothing more: no appointment was booked, reserved, moved or cancelled, and no scheduling session was started. Any free slot listed here may be gone a moment later, taken by another member.",
  how_to_book:
    "Booking is done by the member: in the Maccabi app or on the Maccabi website (זימון תורים, appointment scheduling), or by phone at the Maccabi service center, *3555.",
} as const;
export type SearchOnly = typeof SEARCH_ONLY;

/** How the portal's booking pages name a provider: in their own address, and in each query they send. */
export interface BookingKey {
  object_id: string;
  object_type: string;
  employee_id: string;
}

/** The portal asks for slots in three ways: the first available (nothing given), a month, or a single day. */
export type SlotWindow =
  | { date?: undefined; month?: undefined }
  | { date?: undefined; month: string }
  | { date: string; month?: undefined };

/** A refused read, described in place where the result would have been. */
export interface FailureNote {
  code: RefusalCode;
  guidance: string;
  detail?: string;
}

export interface ProviderCardResult {
  provider_record: Fields | null;
  provider_record_error?: FailureNote;
}

export interface BookableProvider extends ProviderCardResult {
  /** The row of the recent-providers list, untouched. */
  row: VisitedProvider;
  /** Whether the portal would put an order button on this row. Null for a row without a summons_type. */
  bookable_online: boolean | null;
  /** What the booking pages would send for this row; its employee_id is "0" for every object_type but "S". */
  booking_flow_reference: BookingKey;
}

export interface VisitKinds {
  provider: ProviderKey;
  /** The body that was sent, whole. It holds no credential. */
  query: BookingKey & { action_type: "1" };
  /** False for an HTTP 204, which is Maccabi saying this provider has nothing to choose from online. */
  answered: boolean;
  general_instruction: unknown[];
  visit_types_eligible: Fields[];
  visit_types_not_eligible: Fields[];
  other_visit_type_without_eligibility: Fields[];
  note?: string;
  booking: SearchOnly;
}

export interface OpenSlots extends ProviderCardResult {
  provider: ProviderKey;
  visit_type: Fields;
  query: {
    mode: "first-available" | "month" | "date";
    from_time: string | null;
    to_time: string | null;
    query_date: string | null;
    query_month: string | null;
  };
  /**
   * Maccabi's provider_appointments answer with nothing dropped, each slot extended by `day`, `time`
   * and `facility_matches_provider_record`, which are worked out here. Null for an HTTP 204, the
   * answer seen for a day without slots.
   */
  response: Fields | null;
  /** Present, and false, only for that HTTP 204. */
  answered?: boolean;
  /**
   * Worked out here: Maccabi said F4, or listed no slot, or sent no body. What Maccabi itself says
   * about it is still in the response, under result_message and messages.
   */
  no_free_slots: boolean;
  booking: SearchOnly;
}

export interface VisitNotes {
  provider: ProviderKey;
  visit_type: Fields;
  /** Maccabi's instructions_for_visit_type answer with nothing dropped. A link in it is text to pass on; none is opened. */
  instructions: Fields;
  booking: SearchOnly;
}

export interface Entitlement {
  provider: ProviderKey;
  /** False for an HTTP 204 (seen live). The portal then carries on as before and lists the visit types. */
  answered: boolean;
  response: Fields | null;
  booking: SearchOnly;
}

export interface BookingOption extends BookableProvider {
  /** Set when the row was left at that, with the reason. */
  skipped?: string;
  eligibility?: Fields | FailureNote;
  member_eligibility?: Omit<Entitlement, "provider" | "booking"> | FailureNote;
  visit_types?: Omit<VisitKinds, "provider" | "booking"> | FailureNote;
}
export interface BookingOptions {
  providers: BookingOption[];
  assigned_doctor: Fields | null;
  assigned_doctor_error?: FailureNote;
  booking: SearchOnly;
}

/** The account reader, as far as this module uses it. Every request goes out through here. */
export interface BookingScope {
  owner: MemberKey;
  /**
   * Sends `contentBody` as JSON with POST to `/sonline/<service>/webapi/mac/v1/members/<owner>/<suffix>`
   * and resolves to the parsed answer, or to null when Maccabi answers HTTP 204.
   */
  post(
    service: "AppointmentOrderAPI" | "MainAppAPI",
    suffix: string,
    contentBody: unknown,
    label: string,
  ): Promise<unknown>;
  fail(codeText: RefusalCode, label: string, reason: string): Error;
  /** Turns a refused read into its description. Any other error yields undefined and has to be thrown on. */
  describe(caught: unknown): FailureNote | undefined;
  assertOwner(line: Fields, label: string): void;
  allRecentProviders(): Promise<Reading<VisitedProvider[]>>;
  knownProvider(handle: ProviderKey, label: string): Promise<VisitedProvider>;
  askBookingEntitlement(handle: ProviderKey): Promise<Reading<Fields>>;
  fetchAscribedProvider(asOf: string): Promise<Reading<Fields>>;
  result<T>(payload: T, service: string, label: string): Reading<T>;
  now(): Date;
}

// ---- What a caller may pass in.

/** A visit-type code is handed back the way a visit_types answer gave it; it is never put together here. */
export function isVisitKind(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
}
/** A month that exists, written YYYY-MM, in this century or later. */
export function isPortalMonth(value: unknown): value is string {
  return typeof value === "string" && /^[2-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(value);
}
/** A day that exists on the calendar, written YYYY-MM-DD, in this century or later. */
export function isPortalDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^[2-9]\d{3}-\d\d-\d\d$/.test(value)) return false;
  const midnight = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(midnight.getTime()) && midnight.toISOString().startsWith(value);
}

// ---- Dates the way the portal writes them.

/** What a clock in Israel shows at `instant`, encoded as the UTC instant that reads the same. */
function jerusalemWallClock(instant: number): number {
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hourCycle: "h23",
    second: "2-digit",
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const shown = new Map(clock.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
  const field = (type: Intl.DateTimeFormatPartTypes): number => shown.get(type) ?? Number.NaN;
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
}
const SECONDS = "YYYY-MM-DDTHH:mm:ss".length;

/**
 * A month as the query carries it. The portal formats the month the member chose with moment's
 * "YYYYMM" (its saga handleGetAvailableAppointmentsForDateTime), so November 2026 goes out as
 * "202611", and so does this client.
 */
export function portalMonth(month: string): string {
  if (!isPortalMonth(month)) throw new TypeError("A month is written YYYY-MM");
  return month.slice(0, 4) + month.slice(5);
}
/**
 * A day as the query carries it. The portal's calendar (react-day-picker 7) gives the click handler a
 * Date set to noon, local time, and handleCalendarDayPick sends its `toISOString()` cut off at the
 * seconds. For a member in Israel, 15 November 2026 therefore goes out as "2026-11-15T10:00:00"
 * (winter, UTC+2), and a summer day ends in "T09:00:00" (UTC+3). Israel is where the portal's members
 * are, so that is the zone reproduced, and the only one.
 */
export function portalDay(day: string): string {
  if (!isPortalDay(day)) throw new TypeError("A date is written YYYY-MM-DD");
  const noonAsUtc = Date.parse(`${day}T12:00:00Z`);
  // Israel moves its clocks in the small hours, so the offset in force at noon is the offset of noon.
  const offset = jerusalemWallClock(noonAsUtc) - noonAsUtc;
  return new Date(noonAsUtc - offset).toISOString().slice(0, SECONDS);
}

/** The slot query of a search, in the portal's own terms. */
function slotQuery({ month, date }: SlotWindow): OpenSlots["query"] {
  if (month !== undefined && date !== undefined) throw new TypeError("A search takes a month or a date, never both");
  // The portal fills in the hours of a whole day whenever it names a month, and leaves them null
  // when it asks for the first available slot.
  const wholeDay = { from_time: "0000", to_time: "2359" };
  if (month !== undefined) return { mode: "month", query_month: portalMonth(month), query_date: null, ...wholeDay };
  if (date === undefined)
    return { mode: "first-available", query_month: null, query_date: null, from_time: null, to_time: null };
  return { mode: "date", query_month: portalMonth(date.slice(0, 7)), query_date: portalDay(date), ...wholeDay };
}

// ---- What the portal derives from an answer before showing it.

/** The portal's redirectNewAppointment drops a row's employee_id on the way to the booking pages, except for type "S". */
export function bookingKeyOf({ object_type, object_id, employee_id }: ProviderKey): BookingKey {
  return { object_type, object_id, employee_id: object_type === "S" ? employee_id : "0" };
}
const providerKeyOf = ({ object_type, object_id, employee_id }: ProviderKey): ProviderKey => ({
  object_type,
  object_id,
  employee_id,
});

/**
 * Whether a recent-providers row gets the order button or only a phone number. The frontend decides
 * it with `["2","3","8"].includes(e.summonsType)`.
 */
export function booksOnline(row: Fields): boolean | null {
  const kind = row.summons_type;
  if (typeof kind !== "string" && typeof kind !== "number") return null;
  return ["2", "3", "8"].includes(String(kind));
}

const NOT_SELECTABLE = "לא ניתן לבחור בסוג ביקור זה";
const AFTER_A_VISIT_THIS_YEAR = "זמין לאחר ביקור במרפאה בשנה האחרונה";
/**
 * What the portal writes under a visit type it greys out, by the code that greyed it. These are the
 * texts compiled into the frontend; the portal's resource service can replace them at run time, so
 * the live wording may differ.
 */
const GREYED_OUT_BY_CODE = new Map([
  ["P0", AFTER_A_VISIT_THIS_YEAR],
  ["R3", AFTER_A_VISIT_THIS_YEAR],
  ["R4", "אין זכאות לחיסון שפעת"],
  ["V2", "זמין לאחר רכישת ערכת הבדיקה"],
  ["V3", "זמין רק לאחר קבלת תוצאות הבדיקה"],
  ["V4", "זמין אחת לשנתיים"],
  ["T4", NOT_SELECTABLE],
  ["T6", NOT_SELECTABLE],
  ["T7", NOT_SELECTABLE],
  ["U4", "אין זכאות לחיסון קורונה"],
]);
/** The same for a type that needs a recent visit to the clinic, by how many months back counts as recent. */
const AFTER_A_VISIT_WITHIN = new Map<unknown, string>([
  [12, AFTER_A_VISIT_THIS_YEAR],
  [24, "זמין לאחר ביקור במרפאה בשנתיים האחרונות"],
  [36, "זמין לאחר ביקור במרפאה ב-3 השנים האחרונות"],
]);

/** The line under one greyed-out visit type, as the frontend picks it (the visitsTypes map in handleGetDataForPickTypePage). */
export function greyedOutText(type: Fields): string {
  const code = typeof type.error_code === "string" ? type.error_code.trim().toUpperCase() : "";
  if (code === "P0" || code === "R3") {
    const months = type.months_from_last_visit;
    const fixed = AFTER_A_VISIT_WITHIN.get(months);
    if (fixed !== undefined) return fixed;
    return typeof months === "number" && months > 0
      ? `זמין לאחר ביקור במרפאה ב-${months} החודשים האחרונים`
      : "נדרש ביקור פרונטלי לפני ביקור זה";
  }
  // A type with no error code of its own, or with the code "00", is explained by its booking type.
  const reason = code === "" || code === "00" ? type.booking_type : code;
  return (typeof reason === "string" ? GREYED_OUT_BY_CODE.get(reason) : undefined) ?? NOT_SELECTABLE;
}

// ---- One read against the account.

type Settled<T> = { value: T } | { refusal: FailureNote };

/** A read in progress: the account it runs on, and the name its refusals and its result carry. */
class Read {
  constructor(
    readonly scope: BookingScope,
    readonly label: string,
  ) {}

  refusal(code: RefusalCode, detail: string): Error {
    return this.scope.fail(code, this.label, detail);
  }
  /** For an answer in which `key` is not what the portal's pages count on finding. */
  unexpected(key: string): Error {
    return this.refusal("UNEXPECTED_ANSWER", `key:${key}`);
  }

  object(value: unknown, key: string): Fields {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw this.unexpected(key);
    return value as Fields;
  }
  /** A whole answer: an object, and one about the owner. */
  body(payload: unknown): Fields {
    const body = this.object(payload, "body");
    this.scope.assertOwner(body, this.label);
    return body;
  }
  /** A list in an answer, every entry an object about the owner. */
  rows(value: unknown, key: string): Fields[] {
    if (!Array.isArray(value) || value.length > 500) throw this.unexpected(key);
    return value.map((entry) => {
      const row = this.object(entry, key);
      this.scope.assertOwner(row, this.label);
      return row;
    });
  }
  /** The same for a list Maccabi leaves out when it is empty. */
  rowsIfAny(value: unknown, key: string): Fields[] {
    return value === undefined || value === null ? [] : this.rows(value, key);
  }

  post(service: "AppointmentOrderAPI" | "MainAppAPI", suffix: string, contentBody: unknown): Promise<unknown> {
    return this.scope.post(service, suffix, contentBody, this.label);
  }

  /** Runs one part of a read whose refusal belongs in the result. An error that is not a refusal is not caught. */
  async settle<T>(part: () => Promise<T>): Promise<Settled<T>> {
    try {
      return { value: await part() };
    } catch (caught) {
      const refusal = this.scope.describe(caught);
      if (refusal === undefined) throw caught;
      return { refusal };
    }
  }
  async valueOrRefusal<T>(part: () => Promise<T>): Promise<T | FailureNote> {
    const settled = await this.settle(part);
    return "refusal" in settled ? settled.refusal : settled.value;
  }

  done<T>(data: T, service: string): Reading<T> {
    return this.scope.result(data, service, this.label);
  }
}

// ---- The portal's queries.

/**
 * POST MainAppAPI `providers` with retrieval_type "1": the doctor card the PickType page loads. The
 * card is the first provider of the answer.
 */
async function providerCard(read: Read, key: BookingKey): Promise<ProviderCardResult> {
  const settled = await read.settle(async () => {
    const provider: Partial<BookingKey> = { object_type: key.object_type, object_id: key.object_id };
    if (key.employee_id && key.employee_id !== "0") provider.employee_id = key.employee_id;
    const payload = await read.post("MainAppAPI", "providers", { service_providers: [provider], retrieval_type: "1" });
    if (payload === null) return null;
    const { providers } = read.object(payload, "body");
    return read.rows(read.object(providers, "providers").provider, "providers.provider")[0] ?? null;
  });
  return "refusal" in settled
    ? { provider_record: null, provider_record_error: settled.refusal }
    : { provider_record: settled.value };
}

/**
 * POST AppointmentOrderAPI `appointments/visit_types`, also part of the PickType page's load. The
 * frontend adds retrieval_type_code, visit_type_classification_code, last_period_date and
 * number_of_embryos on its CPT, gynecology and pregnancy paths only, and this module takes none of
 * those paths.
 */
async function queryVisitTypes(read: Read, key: BookingKey): Promise<Omit<VisitKinds, "provider" | "booking">> {
  const query = { ...key, action_type: "1" as const };
  const payload = await read.post("AppointmentOrderAPI", "appointments/visit_types", query);
  if (payload === null)
    return {
      query,
      answered: false,
      visit_types_eligible: [],
      visit_types_not_eligible: [],
      other_visit_type_without_eligibility: [],
      general_instruction: [],
      note: "For this provider Maccabi sent HTTP 204, no content, which means it offers no visit type for online booking. That is an answer and not a failure (it was seen live for a clinic's row). The clinic itself, or *3555, can still be called.",
    };
  const body = read.body(payload);
  const eligible = read.rows(body.visit_types_eligible, "visit_types_eligible");
  if (!eligible.every((type) => isVisitKind(type.code))) throw read.unexpected("visit_types_eligible.code");
  const general_instruction = body.general_instruction ?? [];
  if (!Array.isArray(general_instruction)) throw read.unexpected("general_instruction");
  const greyedOut = (list: "visit_types_not_eligible" | "other_visit_type_without_eligibility") =>
    read.rowsIfAny(body[list], list).map((type) => ({ ...type, portal_disabled_text: greyedOutText(type) }));
  return {
    // The answer goes out whole (results keep every field Maccabi sent); the lists that
    // were checked above take the place of their originals in it.
    ...structuredClone(body),
    query,
    answered: true,
    visit_types_eligible: eligible,
    visit_types_not_eligible: greyedOut("visit_types_not_eligible"),
    other_visit_type_without_eligibility: greyedOut("other_visit_type_without_eligibility"),
    general_instruction,
  };
}

/**
 * The visit type a caller named, as the provider lists it at this moment. The portal lets a member
 * pick from the eligible list and from nowhere else, so a code outside that list goes no further.
 */
async function offeredVisitType(read: Read, key: BookingKey, code: string): Promise<Fields> {
  if (!isVisitKind(code))
    throw new TypeError("A visit type is the `code` of an entry of visit_types_eligible, unchanged");
  const offer = await queryVisitTypes(read, key);
  const [found, ...repeats] = offer.visit_types_eligible.filter((type) => type.code === code);
  if (repeats.length > 0) throw read.refusal("UNEXPECTED_ANSWER", "duplicate-visit-type");
  if (found !== undefined) return found;
  const listedGreyedOut = [offer.visit_types_not_eligible, offer.other_visit_type_without_eligibility].some((list) =>
    list.some((type) => type.code === code),
  );
  throw listedGreyedOut
    ? read.refusal("NOT_ENTITLED", "visit-kind-closed")
    : read.refusal("NOT_THE_MEMBERS", "visit-kind-unknown");
}

/**
 * POST AppointmentOrderAPI `appointments/member-eligibilities`, which the PickType and Odoro pages
 * send on load (the saga checkAppointmentMemberEligibilities). The frontend names the employee for
 * object types S and P only. It sets appointment_date and treatment_type on its supplemental-insurance
 * (shaban) path, which is not taken here.
 */
async function queryMemberEligibility(read: Read, key: BookingKey): Promise<Omit<Entitlement, "provider" | "booking">> {
  const contentBody: Fields = {
    object_type: key.object_type,
    object_id: key.object_id,
    appointment_date: null,
    is_supplemental_health_service: false,
  };
  if ((key.object_type === "S" || key.object_type === "P") && key.employee_id)
    contentBody.employee_id = key.employee_id;
  const payload = await read.post("AppointmentOrderAPI", "appointments/member-eligibilities", contentBody);
  if (payload === null) return { answered: false, response: null };
  const response = read.body(payload);
  if (typeof response.is_eligible !== "boolean") throw read.unexpected("is_eligible");
  return { answered: true, response };
}

const SLOT_START = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/;

/** What a provider_appointments answer comes to: the answer with its slots annotated, and whether any slot is free. */
function slotsIn(read: Read, payload: unknown, card: Fields | null): Pick<OpenSlots, "response" | "no_free_slots"> {
  const reply = read.body(payload);
  const code = reply.result_code;
  if (typeof code !== "string") throw read.unexpected("result_code");
  // "00" and "F4" are the codes the frontend treats as an answer. For any other it shows its general
  // error popup: Maccabi failed, which is not the same as Maccabi having no slots.
  if (code !== "00" && code !== "F4") throw read.refusal("PORTAL_REPORTED_ERROR", "result-code-not-00-or-F4");
  const days = reply.available_days ?? [];
  if (!Array.isArray(days) || days.some((day) => !Number.isInteger(day) || day < 1 || day > 31))
    throw read.unexpected("available_days");
  if (reply.appointments === undefined || reply.appointments === null) return { response: reply, no_free_slots: true };

  const holder = read.object(reply.appointments, "appointments");
  const facility = card?.facility_id;
  const appointment = read.rowsIfAny(holder.appointment, "appointments.appointment").map((slot) => {
    if (typeof slot.date !== "string") throw read.unexpected("appointments.appointment.date");
    const [, day = null, time = null] = SLOT_START.exec(slot.date) ?? [];
    const comparable =
      facility !== undefined && facility !== null && slot.facility_code !== undefined && slot.facility_code !== null;
    return {
      ...slot,
      day,
      time,
      facility_matches_provider_record: comparable ? String(slot.facility_code) === String(facility) : null,
    };
  });
  return {
    response: { ...reply, appointments: { ...holder, appointment } },
    no_free_slots: appointment.length === 0 || code === "F4",
  };
}

// ---- The reads.

/** The kinds of visit one recent provider offers; Maccabi lists each eligible kind with its first free date and time. */
export async function visitKinds(scope: BookingScope, handle: ProviderKey): Promise<Reading<VisitKinds>> {
  const read = new Read(scope, "visit-types");
  const provider = await scope.knownProvider(handle, read.label);
  const offer = await queryVisitTypes(read, bookingKeyOf(provider));
  return read.done({ provider: providerKeyOf(provider), ...offer, booking: SEARCH_ONLY }, "AppointmentOrderAPI");
}

/**
 * The free slots of one provider for one kind of visit, by POST AppointmentOrderAPI
 * `appointments/provider_appointments`: the request the portal sends when a member picks a visit
 * type, and again for each month or day picked after that. Without a month or a date the answer is
 * the first month that has anything free.
 */
export async function openSlots(
  scope: BookingScope,
  handle: ProviderKey,
  visitKind: string,
  when: SlotWindow = {},
): Promise<Reading<OpenSlots>> {
  const read = new Read(scope, "open-slots");
  const query = slotQuery(when);
  const provider = await scope.knownProvider(handle, read.label);
  const key = bookingKeyOf(provider);
  const visit_type = await offeredVisitType(read, key, visitKind);
  const card = await providerCard(read, key);
  const payload = await read.post("AppointmentOrderAPI", "appointments/provider_appointments", {
    ...key,
    action_type: "1",
    visit_type: visitKind,
    query_month: query.query_month,
    query_date: query.query_date,
    from_time: query.from_time,
    to_time: query.to_time,
    last_period_date: null,
  });
  // A day with nothing free was answered with HTTP 204 (seen live on 2026-10-26). To the portal a
  // missing body is simply "not F4", and it draws a time picker with no times in it. So this is a
  // search that found nothing, and it is reported as one.
  const found =
    payload === null
      ? { response: null, answered: false, no_free_slots: true }
      : slotsIn(read, payload, card.provider_record);
  return read.done(
    { provider: providerKeyOf(provider), visit_type, query, ...found, ...card, booking: SEARCH_ONLY },
    "AppointmentOrderAPI+MainAppAPI",
  );
}

/**
 * What the portal tells a member about one kind of visit with one provider, by POST AppointmentOrderAPI
 * `appointments/instructions_for_visit_type`: the request of the Confirm page's load.
 */
export async function visitNotes(
  scope: BookingScope,
  handle: ProviderKey,
  visitKind: string,
): Promise<Reading<VisitNotes>> {
  const read = new Read(scope, "visit-preparation");
  const provider = await scope.knownProvider(handle, read.label);
  const key = bookingKeyOf(provider);
  const visit_type = await offeredVisitType(read, key, visitKind);
  // The page adds instruction_type when its own address has one. That path is not taken here, so the
  // body goes without it, as the page's does.
  const payload = await read.post("AppointmentOrderAPI", "appointments/instructions_for_visit_type", {
    ...key,
    chosenVisitType: visitKind,
  });
  if (payload === null) throw read.refusal("UNEXPECTED_ANSWER", "no-content");
  const instructions = read.body(payload);
  // Without a visit_description the portal draws nothing and logs an error.
  if (typeof instructions.visit_description !== "string" || instructions.visit_description === "")
    throw read.unexpected("visit_description");
  read.rowsIfAny(instructions.specific_visits_instructions, "specific_visits_instructions");
  return read.done(
    { provider: providerKeyOf(provider), visit_type, instructions, booking: SEARCH_ONLY },
    "AppointmentOrderAPI",
  );
}

/** One row of the recent-providers list with everything the portal would ask about it before a slot is picked. */
async function bookingOption(read: Read, row: VisitedProvider): Promise<BookingOption> {
  const key = bookingKeyOf(row);
  const bookable_online = booksOnline(row);
  const option = { row, bookable_online, booking_flow_reference: key, ...(await providerCard(read, key)) };
  if (bookable_online === false)
    return {
      ...option,
      skipped:
        "Nothing more was asked about this row: its summons_type is none of 2, 3 and 8, so the portal has no online booking for it and prints the row's phone_number where the order button would be.",
    };
  const eligibility = await read.valueOrRefusal(
    async () => (await read.scope.askBookingEntitlement(providerKeyOf(row))).data,
  );
  const member_eligibility = await read.valueOrRefusal(() => queryMemberEligibility(read, key));
  const visit_types = await read.valueOrRefusal(() => queryVisitTypes(read, key));
  return { ...option, eligibility, member_eligibility, visit_types };
}

/** The member's ascribed doctor as of now; the read behind it takes the time in Israel, written without a zone. */
async function assignedDoctor(read: Read): Promise<Pick<BookingOptions, "assigned_doctor" | "assigned_doctor_error">> {
  const settled = await read.settle(async () => {
    const israelNow = new Date(jerusalemWallClock(read.scope.now().getTime())).toISOString().slice(0, SECONDS);
    return (await read.scope.fetchAscribedProvider(israelNow)).data;
  });
  return "refusal" in settled
    ? { assigned_doctor: null, assigned_doctor_error: settled.refusal }
    : { assigned_doctor: settled.value };
}

/**
 * All that the portal puts on screen before a member picks a slot, for one recent provider or for
 * each of them: the provider's card, the answer behind the eligibility modal, the member-eligibility
 * check, and the visit types (Maccabi gives each its first free date and time). A provider whose part
 * is refused is reported with the refusal, and the others are still read.
 */
export async function bookingOptions(scope: BookingScope, handle?: ProviderKey): Promise<Reading<BookingOptions>> {
  const read = new Read(scope, "bookable-providers");
  const rows = handle ? [await scope.knownProvider(handle, read.label)] : (await scope.allRecentProviders()).data;
  const providers: BookingOption[] = [];
  for (const row of rows) providers.push(await bookingOption(read, row));
  // The ascribed doctor belongs to the overview of all providers; a question about one provider leaves it out.
  const assigned = handle ? { assigned_doctor: null } : await assignedDoctor(read);
  return read.done({ providers, ...assigned, booking: SEARCH_ONLY }, "AppointmentOrderAPI+MainAppAPI");
}
