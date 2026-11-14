import * as z from "zod/v4";
import { document, type Operation, read } from "./define";
import { dateRange, gridPage, id, orderedRange, reference } from "./inputs";

/** A period selector of the quarterly page: one to four digits. */
const PERIOD_VALUE = /^[0-9]{1,4}$/;

export const account: Operation[] = [
  read({
    name: "profile",
    category: "account",
    summary: "The member's profile: names, birth date, sex.",
    run: (member) => member.account.fetchOwnerProfile(),
  }),
  read({
    name: "contact-details",
    category: "account",
    summary: "The member's email, phones and postal addresses.",
    run: (member) => member.account.fetchOwnerContactProfile(),
  }),
  read({
    name: "authorized-users",
    category: "account",
    summary: "Who else may access this account.",
    description: "Access is never granted, extended, revoked or switched.",
    run: (member) => member.account.allAccountAccess(),
  }),
  read({
    name: "notification-settings",
    category: "account",
    summary: "Saved notification channels and registrations.",
    run: (member) => member.account.fetchNotificationPreferences(),
  }),
  read({
    name: "payment-methods",
    category: "account",
    summary: "The payer's payment-authorization summary.",
    description: "Full account numbers are never returned.",
    run: (member) => member.account.fetchPaymentMethods(),
  }),
];

export const billing: Operation[] = [
  read({
    name: "quarterly-statements",
    category: "billing",
    summary: "Quarterly billing reports and the periods available.",
    description:
      "`reports[].reference` with `selectedPeriod.value` selects a report for `quarterly-statement-pdf`. A row's displayed period label is not the selector.",
    input: {
      period: z
        .string()
        .regex(PERIOD_VALUE, "Copy a `value` from `availablePeriods`.")
        .optional()
        .describe("A `value` from `availablePeriods`. The portal's default period when omitted."),
    },
    run: (member, given) => member.billing.allQuarterlyBillingReports(given.period),
  }),
  document({
    name: "quarterly-statement-pdf",
    category: "billing",
    summary: "One quarterly billing report.",
    input: {
      reference: reference.describe("`reports[].reference` from `quarterly-statements`."),
      period: z
        .string()
        .regex(PERIOD_VALUE, "Copy `selectedPeriod.value` from the same `quarterly-statements` result.")
        .describe("`selectedPeriod.value` of the same `quarterly-statements` result."),
    },
    run: (member, given) => member.billing.fetchQuarterlyBillingReportPdf(given.reference, given.period),
  }),
  read({
    name: "nursing-statements",
    category: "billing",
    summary: "Annual nursing-insurance reports.",
    run: (member) => member.billing.allNursingInsuranceReports(),
  }),
  document({
    name: "nursing-statement-pdf",
    category: "billing",
    summary: "One annual nursing-insurance report.",
    input: { reference: reference.describe("`reports[].reference` from `nursing-statements`.") },
    run: (member, given) => member.billing.fetchNursingInsuranceReportPdf(given.reference),
  }),
  read({
    name: "billing-totals",
    category: "billing",
    summary: "Aggregate billing totals of the payer account.",
    description: "Totals of the whole payer account (`source.scope`), not the member's personal debt.",
    run: (member) => member.billing.fetchOutstandingDebt(),
  }),
];

export const requests: Operation[] = [
  read({
    name: "requests",
    category: "requests",
    summary: "List administrative requests: approvals, refunds, commitments.",
    description:
      "A row's `interaction_id`, as a string, is the `id` of `request`. Doctor correspondence is under `doctor-inquiries`.",
    rows: "data",
    run: (member) => member.requests.allAdministrativeRequests(),
  }),
  read({
    name: "request",
    category: "requests",
    summary: "One administrative request: correspondence, decisions, attachments.",
    description: "`unsupported_sections` names what this read does not cover. Attachments carry a `reference`.",
    input: { id: id.describe("`interaction_id` of a `requests` row, as a string.") },
    run: (member, given) => member.requests.fetchAdministrativeRequest(given.id),
  }),
  document({
    name: "request-attachment-pdf",
    category: "requests",
    summary: "One attachment of an administrative request.",
    input: {
      id: id.describe("`interaction_id` of a `requests` row, as a string."),
      reference: reference.describe("`attachments[].reference` from `request`."),
    },
    run: (member, given) => member.requests.fetchAdministrativeRequestPdf(given.id, given.reference),
  }),
  read({
    name: "requests-and-approvals",
    category: "requests",
    summary: "The website's older requests-and-approvals grid, one upstream page at a time.",
    input: { page: gridPage.optional().describe("Upstream page, 1 by default.") },
    run: (member, given) => member.records.allLegacyRequestsAndApprovals(given.page),
  }),
];

export const notifications: Operation[] = [
  read({
    name: "mailings",
    category: "notifications",
    summary: "Letters, status notices and tutorials Maccabi sent in a date range.",
    description:
      "Downloadable rows carry a `reference`; tutorials carry `tutorials[].pdf_reference`. Nothing is marked as read.",
    input: dateRange,
    check: orderedRange,
    rows: "data",
    run: (member, given) => member.mailings.allNotifications({ from: given.from, to: given.to }),
  }),
  document({
    name: "mailing-pdf",
    category: "notifications",
    summary: "One letter or tutorial document.",
    description: "Pass the same range the row was listed with.",
    input: { reference: reference.describe("A `reference` or `pdf_reference` from `mailings`."), ...dateRange },
    check: orderedRange,
    run: (member, given) => member.mailings.fetchNotificationPdf(given.reference, { from: given.from, to: given.to }),
  }),
];
