import * as z from "zod/v4";

/** Input fields shared by several operations. Each one is validated before any session is opened. */

function isCalendarDate(candidate: string): boolean {
  const time = Date.parse(`${candidate}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === candidate;
}

export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date written YYYY-MM-DD.")
  .refine(isCalendarDate, "Use a real calendar date.");

export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month written YYYY-MM.");

/** The present moment as the portal writes it, `YYYY-MM-DDTHH:mm:ss`; the portal takes times to be Israel time. */
export function israelNow(clock = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(clock)
      .map((segment) => [segment.type, segment.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** A timezone-free portal timestamp. */
export const localDateTime = z
  .string()
  .regex(/^[0-9]{4}(?:-[0-9]{2}){2}T[0-9]{2}(?::[0-9]{2}){2}$/, "Use YYYY-MM-DDTHH:mm:ss, without a timezone.")
  .refine((candidate) => {
    const time = Date.parse(`${candidate}Z`);
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 19) === candidate;
  }, "Use a real date and time.");

/** An identifier copied from a list result. */
export const id = z.string().min(1).max(512);

/** A stable local reference this tool issued inside a list or detail result. */
export const reference = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Copy the 64-character reference exactly as a list or detail result returned it.");

/** A DICOM UID. It is placed in a viewer URL path, so nothing but digits and dots is accepted. */
export const uidText = z
  .string()
  .max(64)
  .regex(/^\d+(?:\.\d+)*$/, "Copy the UID exactly as the imaging result returned it.");

/** An upstream page of a legacy grid. */
export const gridPage = z.number().int().min(1).max(1000);

export const dateRange = {
  from: date.describe("First day, YYYY-MM-DD."),
  to: date.describe("Last day, YYYY-MM-DD."),
};

export const optionalDateRange = {
  from: date.optional().describe("First day, YYYY-MM-DD. Give `from` and `to` together."),
  to: date.optional().describe("Last day, YYYY-MM-DD."),
};

/** The three fields that identify one row of `recent-providers`. */
export const provider = {
  object_type: id.describe("`object_type` of a `recent-providers` row."),
  object_id: id.describe("`object_id` of the same row."),
  employee_id: id.describe("`employee_id` of the same row."),
};

export const labRow = {
  request_id: id.describe("`request_id` of a `test-results` row."),
  doc_id: id.describe("`doc_id` of the same row."),
};

/** Where one analyte is selected from: a single result, or the latest / followed views. */
export const labTest = {
  test_id: id.describe("`test_id` of one analyte, from `lab-values`, `labs-latest` or `labs-followed`."),
  source: z
    .enum(["result", "latest", "followed"])
    .optional()
    .describe(
      "The view `test_id` was copied from. Default: `result` when `request_id` and `doc_id` are given, otherwise `latest`.",
    ),
  request_id: id.optional().describe("With source `result`: `request_id` of the `test-results` row."),
  doc_id: id.optional().describe("With source `result`: `doc_id` of the same row."),
};

export function orderedRange(given: { from?: string; to?: string }): string | undefined {
  if ((given.from === undefined) !== (given.to === undefined)) return "Give `from` and `to` together.";
  if (given.from !== undefined && given.to !== undefined && given.from > given.to) {
    return "`from` must not be later than `to`.";
  }
  return undefined;
}

type LabTestInput = {
  test_id: string;
  source?: "result" | "latest" | "followed";
  request_id?: string;
  doc_id?: string;
};

/**
 * The view a call means when it names none. A row id points at one result. A bare `test_id` is taken
 * to come from `labs-latest`, the list agents nearly always copy it out of.
 */
function sourceOf(given: LabTestInput): "result" | "latest" | "followed" {
  if (given.source) return given.source;
  return given.request_id !== undefined || given.doc_id !== undefined ? "result" : "latest";
}

export function labTestRule(given: LabTestInput): string | undefined {
  const hasRow = given.request_id !== undefined && given.doc_id !== undefined;
  const hasPart = given.request_id !== undefined || given.doc_id !== undefined;
  if (sourceOf(given) === "result") {
    return hasRow
      ? undefined
      : "Source `result` needs both `request_id` and `doc_id` of the `test-results` row. For a `test_id` from `labs-latest` or `labs-followed`, pass that source instead.";
  }
  return hasPart ? "`request_id` and `doc_id` apply to source `result` only." : undefined;
}

export function labTestChoice(given: LabTestInput) {
  const origin = sourceOf(given);
  return origin === "result"
    ? {
        seenIn: "result" as const,
        analyte: given.test_id,
        askId: given.request_id as string,
        documentKey: given.doc_id as string,
      }
    : { seenIn: origin, analyte: given.test_id };
}

export function range(given: { from?: string; to?: string }): { from: string; to: string } | undefined {
  return given.from !== undefined && given.to !== undefined ? { from: given.from, to: given.to } : undefined;
}
