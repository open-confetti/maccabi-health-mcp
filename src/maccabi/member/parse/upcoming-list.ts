import { type Guard, guardFor, optional } from "./guards";

export interface UpcomingVisit {
  reference?: string;
  date: string;
  description: string | null;
  provider_name: string | null;
  provider_role: string | null;
  provider_service_type: string;
  subsidiary_name: string | null;
  facility_category: string | null;
  category_visit_type: number | null;
  ascribed_doctor: boolean | null;
  ascribed_doctor_gender: number | null;
  waiting_list_status: string | null;
  follow_up_appointments_count: number | null;
}

export class UpcomingVisitShapeError extends Error {
  constructor() {
    super("A Maccabi upcoming appointment is not laid out the way the portal's timeline reads it");
    this.name = "UpcomingVisitShapeError";
  }
}

const check: Guard = guardFor(() => new UpcomingVisitShapeError());

function count(value: unknown): number {
  const whole = check.integer(value);
  return whole < 0 ? check.fail() : whole;
}

function upcomingVisit(entry: unknown): UpcomingVisit {
  const row = check.object(entry);
  const provider_name = optional(row.provider_name, check.string);
  const subsidiary_name = optional(row.subsidiary_name, check.string);
  // A row has to say who the visit is with: a subsidiary, or else a provider by name.
  if (subsidiary_name === null && !provider_name) check.fail();
  return {
    date: check.filled(row.date),
    provider_name,
    provider_service_type: check.filled(row.provider_service_type),
    description: optional(row.description, check.string),
    category_visit_type: optional(row.category_visit_type, check.integer),
    ascribed_doctor: optional(row.ascribed_doctor, check.flag),
    ascribed_doctor_gender: optional(row.ascribed_doctor_gender, check.integer),
    subsidiary_name,
    facility_category: optional(row.facility_category, check.string),
    follow_up_appointments_count: optional(row.follow_up_appointments_count, count),
    waiting_list_status: optional(row.waiting_list_status, check.string),
    provider_role: optional(row.provider_role, check.string),
  };
}

/**
 * The fields the portal's upcoming-appointments timeline displays, and only those: what the portal
 * uses to route, edit or cancel an appointment, and its subsidiary-consent state, are not copied.
 */
export function shapeUpcomingVisits(answer: unknown): UpcomingVisit[] {
  return check.bounded(check.list(answer, 1000).map(upcomingVisit), 128 * 1024);
}
