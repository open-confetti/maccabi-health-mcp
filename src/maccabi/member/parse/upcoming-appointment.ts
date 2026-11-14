import { type Guard, guardFor, isWebLink, optional } from "./guards";
import { shapeUpcomingVisits, type UpcomingVisit } from "./upcoming-list";

export interface UpcomingVisitNote {
  description: string;
  link: string | null;
}

export interface UpcomingVisitDetail {
  appointment: UpcomingVisit;
  provider: {
    address: string | null;
    phone: string | null;
    order_appointment_phone: string | null;
    fax: string | null;
  };
  instructions: UpcomingVisitNote[];
}

export class UpcomingVisitDetailShapeError extends Error {
  constructor() {
    super("The detail of a Maccabi upcoming appointment is not laid out the way the portal's page reads it");
    this.name = "UpcomingVisitDetailShapeError";
  }
}

const check: Guard = guardFor(() => new UpcomingVisitDetailShapeError());
const webLink = (value: unknown): string => (isWebLink(value) ? value : check.fail());

/** The contact kinds the detail page prints, by the code Maccabi gives each. A provider's other contacts are skipped. */
const PHONE = "01";
const BOOKING_PHONE = "02";
const FAX = "03";

function printedContacts(listed: unknown): Map<string, string> {
  const byCode = new Map<string, string>();
  for (const entry of check.list(listed, 100)) {
    const { code, contact_details } = check.object(entry);
    if (typeof code !== "string") check.fail();
    if (code !== PHONE && code !== BOOKING_PHONE && code !== FAX) continue;
    // One value per printed kind: with two, which of them the page would show is not known.
    if (byCode.has(code)) check.fail();
    byCode.set(code, check.string(contact_details));
  }
  return byCode;
}

/**
 * What the portal's detail page shows for one upcoming appointment with an ordinary Maccabi provider,
 * out of the three answers the page loads. The provider's routing keys and whatever feeds the page's
 * edit, cancel and upload controls are left behind. An instruction's link is passed on as text, the
 * way the page offers it to the member to open; it is not requested from here.
 */
export function shapeUpcomingVisitDetail(
  appointmentAnswer: unknown,
  providerAnswer: unknown,
  instructionsAnswer: unknown,
): UpcomingVisitDetail {
  const appointment = shapeUpcomingVisits([appointmentAnswer])[0]!;

  const provider = check.object(providerAnswer);
  const place = check.object(provider.provider_details);
  const contacts = printedContacts(provider.contacts);

  const guidance = check.object(instructionsAnswer);
  check.filled(guidance.visit_description);
  const instructions = check.list(guidance.specific_visits_instructions, 100).map((entry): UpcomingVisitNote => {
    const step = check.object(entry);
    return { description: check.filled(step.description), link: optional(step.link, webLink) };
  });

  return check.bounded(
    {
      appointment,
      provider: {
        // The page prints an address for this one category of visit only.
        address: appointment.category_visit_type === 3 ? optional(place.full, check.string) : null,
        order_appointment_phone: contacts.get(BOOKING_PHONE) ?? null,
        phone: contacts.get(PHONE) ?? null,
        fax: contacts.get(FAX) ?? null,
      },
      instructions,
    },
    128 * 1024,
  );
}
