/** What a read can be about. Each operation, and each call in the portal catalog, belongs to one of these. */
export const DATA_KINDS = {
  medical:
    "The medical file: laboratory and imaging results, doctor visits, hospital stays, prescriptions, referrals, vaccinations, sensitivities, certificates and inquiries to doctors.",
  appointments: "Appointments already made, and looking for open slots. This tool never books, holds or cancels one.",
  providers:
    "The member's own doctor, providers seen lately, and the public provider directory, which works without signing in.",
  account:
    "The member's account itself: profile, contact details, entitlements, authorized users and notification settings.",
  billing: "Billing reports and totals, means of payment, and nursing-insurance reports.",
  requests: "Administrative requests and approvals, including their correspondence and attachments.",
  notifications: "Letters and mailings from Maccabi to the member.",
  reference:
    "General reference data that concerns no particular member: portal content, lists of cities and banks, explanations of tests.",
} as const;

export type DataKind = keyof typeof DATA_KINDS;
