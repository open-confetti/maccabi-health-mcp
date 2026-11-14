/**
 * One registry is behind both the command line and the MCP server, so the two have to agree. Each
 * operation is run here on both, in the built bundle, with one input, and must give one answer: equal
 * data, or an error with the same code. Adding an operation without an input for it below fails the file.
 */
import * as path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, test } from "vitest";
import { OPERATIONS } from "../../src/operations";
import { call, ID, OTP, sandbox } from "../rig";

const box = sandbox("parity");

type Input = Record<string, unknown>;
const reference = "c".repeat(64);
const dates = { from: "2026-02-09", to: "2026-08-31" };
const asOf = { as_of: "2026-09-01" };
const doctor = { object_id: "5001", object_type: "S", employee_id: "7001" };
const labRow = { doc_id: "assay-doc-3", request_id: "assay-req-3" };
const analyte = { ...labRow, test_id: "no-such-test" };
const image = { study_uid: "1.2.840", series_uid: "1.2.840.1", image_uid: "1.2.840.1.1" };
const doctors = { category: "doctors" };
const familyDoctors = { ...doctors, field: "family" };
const visit = { id: "encounter-41" };
/** An id of the right form that the fake has no record under. */
const unknown = (kind: string) => ({ id: `no-such-${kind}` });
const prescription = unknown("prescription");
const inquiry = unknown("inquiry");
const request = unknown("request");

/**
 * A valid input for each operation, by the area of the account it reads. It does not matter whether the
 * fake holds the record an input names, because the test is that the two surfaces say the same about it.
 */
const SAMPLES: Record<string, Input> = {
  // Laboratory and imaging
  "test-results": { year: 2026 },
  "labs-latest": {},
  "labs-latest-pdf": {},
  "labs-followed": {},
  "labs-followed-pdf": {},
  "lab-values": labRow,
  "test-document-pdf": labRow,
  "lab-covid-report-pdf": labRow,
  "lab-values-pdf": { irregular_only: true, ...labRow },
  "lab-analyte-pdf": analyte,
  "lab-history": analyte,
  "lab-history-pdf": { view: "graph", ...analyte },
  scans: {},
  scan: { study_uid: image.study_uid },
  "scan-preview": image,
  "scan-pixels": image,
  "scan-image": image,

  // Visits, hospital stays and what doctors issued
  "clinic-visits": { limit: 1 },
  "clinic-visit": visit,
  "clinic-visit-summary-pdf": visit,
  "clinic-visit-document-pdf": { reference, ...visit },
  "hospital-visits": asOf,
  "hospital-visit-pdf": { reference, ...asOf },
  prescriptions: { permanent: false, status: "valid" },
  "prescription-pdf": prescription,
  "prescription-substitutes": prescription,
  "pharmacy-purchases": { page: 2 },
  "pharmacy-purchases-pdf": {},
  referrals: dates,
  "referral-pdf": unknown("referral"),
  certificates: dates,
  "certificate-pdf": { ...dates, reference },
  "additional-information": dates,
  "additional-information-pdf": { ...dates, reference },

  // The medical file
  "vaccine-groups": {},
  "vaccine-doses": { group: 5 },
  "vaccine-certificate-pdf": {},
  sensitivities: {},
  "sensitivities-pdf": {},
  "health-recommendations": {},
  "medical-summary": {},
  "medical-summary-english-pdf": {},
  "saved-documents": { page: 1, ...dates },
  "doctor-inquiries": {},
  "doctor-inquiry": inquiry,
  "doctor-inquiry-pdf": { reference, ...inquiry },

  // Appointments and providers
  appointments: {},
  appointment: { reference },
  "bookable-providers": doctor,
  "visit-types": doctor,
  "visit-preparation": { visit_type: "100", ...doctor },
  "open-slots": { month: "2026-12", visit_type: "100", ...doctor },
  "booking-eligibility": doctor,
  "assigned-doctor": { at: "2026-09-01T08:00:00" },
  "recent-providers": {},
  provider: doctor,
  "directory-cities": doctors,
  "directory-specialties": doctors,
  "directory-search": familyDoctors,
  "directory-provider": { reference: `provider-${"d".repeat(32)}`, ...familyDoctors },

  // The account, its money and its paperwork
  profile: {},
  "contact-details": {},
  "authorized-users": {},
  "notification-settings": {},
  "payment-methods": {},
  "billing-totals": {},
  "quarterly-statements": { period: "1" },
  "quarterly-statement-pdf": { period: "1", reference },
  "nursing-statements": {},
  "nursing-statement-pdf": { reference },
  requests: {},
  request,
  "request-attachment-pdf": { reference, ...request },
  "requests-and-approvals": { page: 1 },
  mailings: dates,
  "mailing-pdf": { ...dates, reference },

  // The portal catalog
  "portal-endpoints": { category: "medical" },
  portal: { endpoint: "entitlement" },
  "portal-document": { reference, endpoint: "entitlement" },
};

/** An input as the flags of a command: `--name value`, and `--name` or `--no-name` for a switch. */
function asFlags(input: Input): string[] {
  const flags: string[] = [];
  for (const [argument, value] of Object.entries(input)) {
    const name = argument.replaceAll("_", "-");
    if (typeof value === "boolean") flags.push(value ? `--${name}` : `--no-${name}`);
    else flags.push(`--${name}`, String(value));
  }
  return flags;
}

/**
 * Two calls never get the same download link out of Maccabi, nor the same signature for it, and each
 * result is stamped with its own time. These are the fields that hold such values.
 */
const NEVER_EQUAL = /^(retrievedAt|hash|timestamp|time_stamp|.*(link|url|file)$)/i;
/** `result` with those fields taken out at every depth. */
function comparable(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(comparable);
  if (result === null || typeof result !== "object") return result;
  const kept = Object.entries(result).filter(([field, value]) => value !== undefined && !NEVER_EQUAL.test(field));
  return Object.fromEntries(kept.map(([field, value]) => [field, comparable(value)]));
}

describe("the command line and MCP give one answer for every operation", () => {
  test("there is an input above for each operation in the registry, and for nothing else", () => {
    const registered = OPERATIONS.map(({ name }) => name);
    expect(Object.keys(SAMPLES).sort()).toEqual([...registered].sort());
  });

  // A single server for the file, so that the session it saves is the one the commands read with.
  let client: Client;
  test("signing in once, over MCP, signs the command line in too", async () => {
    client = await box.mcp();
    const sent = await call(client, "maccabi_login_start", { id: ID });
    expect(sent.structuredContent.status).toBe("sms-sent");
    const verified = await call(client, "maccabi_login_verify", { code: OTP });
    expect(verified.structuredContent.status).toBe("signed-in");
    expect(box.cli(["status"]).json().status).toBe("signed-in");
  });

  test.each(OPERATIONS.map((operation) => [operation.name, operation] as const))("%s", async (name, operation) => {
    const input = SAMPLES[name] ?? {};
    const isFile = operation.returns === "file";
    const overMcp = await call(client, "maccabi_read", { operation: name, arguments: input });
    const target = isFile ? ["--out", path.join(box.dir(), `${name}.bin`)] : [];
    const onCli = box.cli([name, ...asFlags(input), ...target]);

    if (overMcp.isError) {
      expect(onCli.code, onCli.out.slice(0, 300)).not.toBe(0);
      expect(onCli.error().code).toBe(overMcp.structuredContent.error.code);
      return;
    }
    expect(onCli.code, onCli.err).toBe(0);
    const { page, ...fromMcp } = overMcp.structuredContent;
    // A list over MCP is paged even when no limit is given. The command line pages only on request.
    const expected = operation.rows && input.limit === undefined ? fromMcp : { ...fromMcp, page };
    const { status, ...fromCli } = onCli.json();
    // The command line adds to a document's description that it saved the document.
    if (isFile) expect(status).toBe("saved");
    expect(comparable(isFile ? fromCli : { ...fromCli, status })).toEqual(comparable(expected));
  });
});
