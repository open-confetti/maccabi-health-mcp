import * as z from "zod/v4";
import { isPortalDay, isPortalMonth, isVisitKind } from "../maccabi/member/parse/appointment-queries";
import { type Operation, read } from "./define";
import { provider as clinic, date, month, reference } from "./inputs";

const kind_ = "appointments" as const;

const SEARCH_ONLY =
  "A search only: nothing is booked, held or changed. The member books on the Maccabi website or app, or at *3555.";

const visitKind = z
  .string()
  .refine(isVisitKind, "Copy a `visit_types_eligible[].code` exactly.")
  .describe("A `visit_types_eligible[].code` of the same provider, from `visit-types` or `bookable-providers`.");

const optionalProvider = {
  object_type: clinic.object_type.optional(),
  object_id: clinic.object_id.optional(),
  employee_id: clinic.employee_id.optional(),
};

function wholeProvider(arg: { object_type?: string; object_id?: string; employee_id?: string }): string | undefined {
  const given = [arg.object_type, arg.object_id, arg.employee_id].filter((candidate) => candidate !== undefined).length;
  return given === 0 || given === 3
    ? undefined
    : "Give `object_type`, `object_id` and `employee_id` together, or none of them.";
}

export const appointments: Operation[] = [
  read({
    name: "appointments",
    category: kind_,
    summary: "List upcoming appointments.",
    description: "Rows carry a `reference` for `appointment`. Past visits are under `clinic-visits`.",
    rows: "data",
    run: (member) => member.appointments.allFutureAppointments(),
  }),
  read({
    name: "appointment",
    category: kind_,
    summary: "One upcoming appointment: provider contacts and visit instructions.",
    description: "Links to instructions are passed on as they are; this tool does not open them.",
    input: { reference: reference.describe("`reference` of an `appointments` row.") },
    run: (member, arg) => member.appointments.fetchFutureAppointment(arg.reference),
  }),
  read({
    name: "bookable-providers",
    category: kind_,
    summary: "Which recent providers can be booked online, with visit types and each type's first free slot.",
    description: `Without a provider this covers every recent provider (about four upstream queries each); one provider failing is reported in place. ${SEARCH_ONLY}`,
    input: optionalProvider,
    check: wholeProvider,
    run: (member, arg) =>
      member.appointments.bookingOptions(
        arg.object_type !== undefined && arg.object_id !== undefined && arg.employee_id !== undefined
          ? { object_type: arg.object_type, object_id: arg.object_id, employee_id: arg.employee_id }
          : undefined,
      ),
  }),
  read({
    name: "visit-types",
    category: kind_,
    summary: "The visit types one provider offers, with each type's first free slot.",
    description: SEARCH_ONLY,
    input: clinic,
    run: (member, arg) => member.appointments.visitKinds(arg),
  }),
  read({
    name: "open-slots",
    category: kind_,
    summary: "Free slots of one provider for one visit type.",
    description: `The first available month by default, or one \`month\` or one \`date\`. \`no_free_slots: true\` is a normal answer. ${SEARCH_ONLY}`,
    input: {
      ...clinic,
      visit_type: visitKind,
      // The upstream query builder accepts years from 2000 on; the schema must not be wider than it.
      month: month.refine(isPortalMonth, "Use a month from the year 2000 on.").optional().describe("A month, YYYY-MM."),
      date: date
        .refine(isPortalDay, "Use a date from the year 2000 on.")
        .optional()
        .describe("A single day, YYYY-MM-DD."),
    },
    check: (arg) =>
      arg.month !== undefined && arg.date !== undefined ? "Give `month` or `date`, not both." : undefined,
    run: (member, arg) => {
      const { visit_type, month: wantedMonth, date: wantedDate, ...entry } = arg;
      const lookup =
        wantedMonth !== undefined ? { month: wantedMonth } : wantedDate !== undefined ? { date: wantedDate } : {};
      return member.appointments.openSlots(entry, visit_type, lookup);
    },
  }),
  read({
    name: "visit-preparation",
    category: kind_,
    summary: "What to bring or do for one visit type of one provider.",
    description: "Links to instructions are passed on as they are; this tool does not open them.",
    input: { ...clinic, visit_type: visitKind },
    run: (member, arg) => {
      const { visit_type, ...entry } = arg;
      return member.appointments.visitNotes(entry, visit_type);
    },
  }),
  read({
    name: "booking-eligibility",
    category: kind_,
    summary: "Whether the member may book one provider online.",
    input: clinic,
    run: (member, arg) => member.appointments.askBookingEntitlement(arg),
  }),
];
