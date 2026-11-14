/**
 * Appointments ahead of the member and the providers they can be made with: the upcoming list and one
 * appointment's detail, the doctor the member is assigned to, the providers recently visited, whether
 * the member may book with one, and the search for visit types and free slots. All of it only asks.
 * No request in this file books, holds, changes or cancels anything.
 */
import { ReadRefusal, refuse } from "../faults";
import type { MemberScope } from "./context";
import * as finding from "./parse/appointment-queries";
import {
  shapeUpcomingVisitDetail,
  type UpcomingVisitDetail,
  UpcomingVisitDetailShapeError,
} from "./parse/upcoming-appointment";
import { shapeUpcomingVisits, type UpcomingVisit, UpcomingVisitShapeError } from "./parse/upcoming-list";
import {
  asObject,
  asString,
  digestOf,
  type Fields,
  getJson,
  isPortalMoment,
  isPresent,
  mustBelongToMember,
  mustBeReference,
  overSource,
  type Reading,
} from "./shared";

const APPOINTMENT_ORDER = "AppointmentOrderAPI";
const MAIN_APP = "MainAppAPI";
const ADULT_FROM_YEARS = 18;

const PROVIDER_KEY = ["object_type", "object_id", "employee_id"] as const;
const PRACTITIONER_TEXT = ["pactitioner_name_title", "practitioner_id"] as const;
const ASSIGNED_DOCTOR_TEXT = ["first_name", "last_name", "service_provider_id"];
const PROVIDER_CARD_TEXT = ["provider_id", "facility_id", "provider_role"];

/** The three values that name a provider to the appointment service. */
export type ProviderKey = Record<(typeof PROVIDER_KEY)[number], string>;
/**
 * A row of the recent-providers list. The practitioner fields are null when the row is a clinic and
 * not a named person (seen live).
 */
export type VisitedProvider = Fields &
  ProviderKey &
  Record<(typeof PRACTITIONER_TEXT)[number], string | null> & { clinic_address: Fields };

/** How the portal writes an id: text that is not empty, or a whole number. */
const isId = (value: unknown): boolean => (typeof value === "string" ? value !== "" : Number.isSafeInteger(value));
const keyOf = ({ object_type, object_id, employee_id }: ProviderKey): string =>
  JSON.stringify([object_type, object_id, employee_id]);

/**
 * The reference of an upcoming appointment, made of the fields that name it to the detail requests.
 * A row gets none when those fields are not usable ids, or when it is an appointment at a subsidiary:
 * the website opens those on a screen of their own, which this list does not lead to.
 */
function referenceOf(row: Fields): string | undefined {
  const { id = null, external_id = null, object_type, object_id, date, employee_id, provider_id = null, type } = row;
  if (row.subsidiary_name) return undefined;
  if (typeof object_type !== "string" || object_type === "") return undefined;
  if (![object_id, employee_id, type].every(isId)) return undefined;
  if (employee_id === 0 && !isId(provider_id)) return undefined;
  for (const optional of [id, external_id, provider_id])
    if (optional !== null && optional !== "" && !isId(optional)) return undefined;
  const identity = [id, external_id, object_type, object_id, date, employee_id, provider_id, type];
  return digestOf(identity);
}

/** A refusal as the appointment search reports it inside a result; anything else is not described. */
function describeRefusal(error: unknown): finding.FailureNote | undefined {
  if (!(error instanceof ReadRefusal)) return undefined;
  const { code, detail, guidance } = error;
  return detail ? { code, detail, guidance } : { code, guidance };
}

export class Appointments {
  /** The rows of the latest upcoming list that can be opened, by reference. */
  #upcoming = new Map<string, Fields>();
  /** The rows of the latest recent-providers list, by provider key. */
  #recentProviders = new Map<string, VisitedProvider>();

  constructor(private readonly scope: MemberScope) {}

  /** The member's upcoming appointments as this call returned them, each openable one with a reference. */
  async allFutureAppointments(): Promise<Reading<UpcomingVisit[]>> {
    const label = "appointments";
    const route = this.scope.path(APPOINTMENT_ORDER, "v2", "appointments/future");
    const self = { ...this.scope.member(), member_consent_for_subsidiary_information: 0 };
    const asked = this.scope.post({ members: [self], is_with_ascribed_doctor: true });
    const rows = this.scope.rows(await getJson(this.scope.http, route, label, asked), label);
    let shaped: UpcomingVisit[];
    try {
      shaped = shapeUpcomingVisits(rows);
    } catch (error) {
      throw error instanceof UpcomingVisitShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    const shown = overSource(rows, shaped);
    const openable = new Map<string, Fields>();
    rows.forEach((row, at) => {
      const reference = referenceOf(row);
      if (reference === undefined) return;
      if (openable.has(reference)) throw refuse("UNEXPECTED_ANSWER", label, "row-twice");
      openable.set(reference, row);
      shown[at]!.reference = reference;
    });
    this.#upcoming = openable;
    return this.scope.renderedResult(shown, APPOINTMENT_ORDER, label);
  }

  /**
   * One upcoming appointment as the website's ordinary detail screen shows it: the appointment, the
   * provider's card and the instructions for the visit type. The upcoming list is read again first.
   */
  async fetchFutureAppointment(reference: string): Promise<Reading<UpcomingVisitDetail>> {
    const label = "appointment";
    mustBeReference(reference, label);
    await this.allFutureAppointments();
    const visit = this.#upcoming.get(reference);
    if (!visit) throw refuse("NOT_THE_MEMBERS", label, "reference-unknown");
    const { object_type, object_id, employee_id, provider_id } = visit;
    // An appointment without an employee is looked up by its provider id, sent as null when it is zero.
    const staff = employee_id === 0 ? { provider_id: provider_id === 0 ? null : provider_id } : { employee_id };
    const card = this.#onlyCard(await this.#askForCard({ object_type, object_id, ...staff }, label), label);
    if (isPresent(card.sap_key)) {
      const sap = asObject(card.sap_key, label, "sap_key");
      const isSameProvider =
        String(sap.object_type) === String(object_type) &&
        String(sap.object_Id) === String(object_id) &&
        (employee_id === 0 || String(sap.employee_id) === String(employee_id));
      if (!isSameProvider) throw refuse("UNEXPECTED_ANSWER", label, "key:sap_key");
    }
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", "appointments/instructions_for_visit_type");
    const asked = this.scope.post({
      object_type,
      object_id,
      employee_id: object_type === "O" ? 0 : employee_id,
      chosenVisitType: visit.type,
    });
    const instructions = asObject(await getJson(this.scope.http, route, label, asked), label);
    mustBelongToMember(instructions, this.scope.owner, label);
    let shaped: UpcomingVisitDetail;
    try {
      shaped = shapeUpcomingVisitDetail(visit, card, instructions);
    } catch (error) {
      const isShapeError = error instanceof UpcomingVisitDetailShapeError || error instanceof UpcomingVisitShapeError;
      throw isShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    // Each rendered part is laid back over the answer it was taken from, so no field of the three
    // answers is lost; the instructions answer is also returned whole.
    const detail = {
      ...shaped,
      appointment: overSource(visit, shaped.appointment),
      provider: overSource(card, shaped.provider),
      instructions: overSource(instructions.specific_visits_instructions, shaped.instructions),
      visit_instructions: structuredClone(instructions),
    };
    return this.scope.renderedResult(detail, `${APPOINTMENT_ORDER}+${MAIN_APP}`, label);
  }

  /**
   * The doctor the member is assigned to at `at`, a moment in the portal's own zone-less notation
   * (YYYY-MM-DDTHH:mm:ss). It is sent on as written; no time zone is assumed or converted.
   */
  async fetchAscribedProvider(at: string): Promise<Reading<Fields>> {
    if (!isPortalMoment(at)) throw new TypeError("the moment is not written as YYYY-MM-DDTHH:mm:ss");
    const label = "assigned-doctor";
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", "providers/ascribed");
    const query = new URLSearchParams({ requested_association_date: at });
    const sent = asObject(await getJson(this.scope.http, `${route}?${query}`, label), label);
    for (const key of ASSIGNED_DOCTOR_TEXT) asString(sent[key], label, key);
    return this.scope.result(sent, APPOINTMENT_ORDER, label);
  }

  /**
   * The providers the member saw recently, which is where the website starts a booking from. Read for
   * adults only, with is_minor=false; this is not a search of Maccabi's provider directory.
   */
  async allRecentProviders(): Promise<Reading<VisitedProvider[]>> {
    const label = "recent-providers";
    const { years } = asObject(this.scope.bootstrap.age, label, "age");
    if (typeof years !== "number" || years < ADULT_FROM_YEARS) throw refuse("NOT_OFFERED", label, "account-of-a-minor");
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", "providers/appointment_service_providers");
    const rows = this.scope.rows(await getJson(this.scope.http, `${route}?is_minor=false`, label), label);
    for (const row of rows) {
      for (const key of PROVIDER_KEY) asString(row[key], label, key);
      // Null is accepted for these two fields and no others: a clinic's row has both null (seen live).
      // Neither is part of the provider key, so a null cannot change which provider a later reference
      // resolves to.
      for (const key of PRACTITIONER_TEXT) if (row[key] !== null) asString(row[key], label, key);
      asObject(row.clinic_address, label, "clinic_address");
    }
    const providers = rows as VisitedProvider[];
    this.#recentProviders = new Map(providers.map((row) => [keyOf(row), structuredClone(row)]));
    return this.scope.result(providers, APPOINTMENT_ORDER, label);
  }

  /** Whether the member may book with one of their recent providers. An answer, not a booking step. */
  async askBookingEntitlement(provider: ProviderKey): Promise<Reading<Fields>> {
    const label = "booking-eligibility";
    const { object_type, object_id, employee_id } = await this.#listedProvider(provider, label);
    const route = this.scope.path(APPOINTMENT_ORDER, "v1", "appointments/eligibility");
    const asked = this.scope.post({ object_type, object_id, employee_id, action_type: 1 });
    const sent = asObject(await getJson(this.scope.http, route, label, asked), label);
    if (typeof sent.is_eligible !== "boolean") throw refuse("UNEXPECTED_ANSWER", label, "key:is_eligible");
    this.scope.rows(sent.future_appointments, label, "future_appointments");
    return this.scope.result(sent, APPOINTMENT_ORDER, label);
  }

  /** The portal's card for one of the member's recent providers. */
  async fetchAppointmentProvider(provider: ProviderKey): Promise<Reading<Fields>> {
    const label = "provider";
    const { object_type, object_id, employee_id } = await this.#listedProvider(provider, label);
    // The website leaves the employee out of the lookup when the provider has none ("0").
    const staff = employee_id && employee_id !== "0" ? { employee_id } : {};
    const answer = await this.#askForCard({ object_type, object_id, ...staff }, label, true);
    // Seen live on 2026-10-26: for a recent provider that has no booking type the portal answers 204
    // and there is no card to show.
    if (answer === null) {
      const sap_key = { object_type, object_Id: object_id, employee_id };
      return this.scope.result({ answered: false, provider_card: null, sap_key }, MAIN_APP, label);
    }
    const card = this.#onlyCard(answer, label);
    for (const key of PROVIDER_CARD_TEXT) asString(card[key], label, key);
    const sap = asObject(card.sap_key, label, "sap_key");
    if (sap.object_type !== object_type || sap.object_Id !== object_id || sap.employee_id !== employee_id)
      throw refuse("UNEXPECTED_ANSWER", label, "key:sap_key");
    return this.scope.result(card, MAIN_APP, label);
  }

  // The four searches below are implemented in ./parse/appointment-queries.ts. They query what could
  // be booked and stop there: none opens a booking session or reserves a slot.

  /** The visit types of one recent provider; each type open to the member comes with its first free slot. */
  async visitKinds(provider: ProviderKey) {
    return finding.visitKinds(this.#finder(), provider);
  }

  /**
   * The free slots of one recent provider for one of its visit types. `when` narrows the search to a
   * month (YYYY-MM) or a day (YYYY-MM-DD); left empty, the first month with a free slot is returned.
   */
  async openSlots(provider: ProviderKey, visitKind: string, when: finding.SlotWindow = {}) {
    return finding.openSlots(this.#finder(), provider, visitKind, when);
  }

  /** What the portal tells the member to do for a visit type. Links in it are passed on, not followed. */
  async visitNotes(provider: ProviderKey, visitKind: string) {
    return finding.visitNotes(this.#finder(), provider, visitKind);
  }

  /** The overview a booking starts from, for one recent provider or all: eligibility, visit types, first free slots. */
  async bookingOptions(provider?: ProviderKey) {
    return finding.bookingOptions(this.#finder(), provider);
  }

  /** Everything the search module may use of this reader, so it never touches the transport itself. */
  #finder(): finding.BookingScope {
    const { scope } = this;
    return {
      owner: scope.memberKey,
      now: () => new Date(),
      post: (api, tail, body, label) => getJson(scope.http, scope.path(api, "v1", tail), label, scope.post(body), true),
      result: (data, api, label) => scope.result(data, api, label),
      fail: refuse,
      describe: describeRefusal,
      assertOwner: (row, label) => mustBelongToMember(row, scope.owner, label),
      allRecentProviders: () => this.allRecentProviders(),
      knownProvider: (provider, label) => this.#listedProvider(provider, label),
      askBookingEntitlement: (provider) => this.askBookingEntitlement(provider),
      fetchAscribedProvider: (at) => this.fetchAscribedProvider(at),
    };
  }

  /** The member's own row for a provider key. A key that no recent-providers list holds is refused. */
  async #listedProvider(provider: ProviderKey, label: string): Promise<VisitedProvider> {
    for (const key of PROVIDER_KEY) asString(provider[key], label, key);
    const key = keyOf(provider);
    if (!this.#recentProviders.has(key)) await this.allRecentProviders();
    const row = this.#recentProviders.get(key);
    if (!row) throw refuse("NOT_THE_MEMBERS", label, "provider-unknown");
    return row;
  }

  /** Asks for the card of one provider. With `mayBeEmpty`, a 204 comes back as null. */
  #askForCard(provider: Fields, label: string, mayBeEmpty = false): Promise<unknown> {
    const route = this.scope.path(MAIN_APP, "v1", "providers");
    const asked = this.scope.post({ service_providers: [provider], retrieval_type: "1" });
    return getJson(this.scope.http, route, label, asked, mayBeEmpty);
  }

  /** The one card a provider lookup has to hold. */
  #onlyCard(answer: unknown, label: string): Fields {
    const { providers } = asObject(answer, label);
    const cards = this.scope.rows(asObject(providers, label, "providers").provider, label);
    if (cards.length !== 1) throw refuse("UNEXPECTED_ANSWER", label, "row-count-off");
    return cards[0]!;
  }
}
