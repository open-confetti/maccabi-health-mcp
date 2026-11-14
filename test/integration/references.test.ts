/**
 * How a document of a visit, an inquiry or a certificate is named between two reads, through the
 * built bundle with the fake Maccabi behind it.
 *
 * Maccabi hands out a new link, timestamp and signature for the same document every time it answers,
 * and listing a row and downloading its PDF are separate commands that each fetch the member's list
 * anew. A reference derived from the link therefore never matched again: live, every such download
 * was refused as not the member's. The fake in test/fake/maccabi.mjs rotates its links the same way,
 * and these tests hold the reference to what does not rotate.
 *
 * They also hold the rule for what such a row returns: all of it, the temporary link and signature
 * included and a clinician's id included, less the member's own id. Every value here is made up.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { call, memberSession } from "../rig";

const session = memberSession("references");
const { box, ok } = session;

const YEAR = { from: "2026-01-01", to: "2026-12-31" };
const theVisit = { id: "encounter-42" };
const theInquiry = { id: "inq-1" };
const aReference = expect.stringMatching(/^[0-9a-f]{64}$/);
const aRotatingSignature = {
  timestamp: expect.stringMatching(/^rotating-time-/),
  hash: expect.stringMatching(/^rotating%2Bhash/),
};
/** The private link the fake hands out for a document on this particular answer. */
const linkTo = (document: string) => expect.stringContaining(`%2Fmock%2F${document}%2Frotating-`);
/** Any key under which Maccabi sends the member's own id. */
const ownerKeysIn = (result: unknown) =>
  JSON.stringify(result).match(/"(?:patient_id|user_code|user_id|member_id_code|member_id)"/g) ?? [];
const read = async (operation: string, args: Record<string, unknown>) => (await ok(operation, args)).data;

beforeAll(session.start);

describe("a row that has documents", () => {
  /** Where each document of the fake's visit sits, the field holding its link, and its name in the fake. */
  const OF_THE_VISIT: [list: string, at: number, linkField: string, document: string][] = [
    ["approvals", 0, "approval_pdf_link", "approval-sheet"],
    ["drugs", 0, "prescription_pdf_link", "dispensing-slip"],
    ["tutorials", 0, "item_url", "leaflet-page"],
    // Only a referral has an id of its own; the other kinds are told apart by what they show.
    ["referrals", 0, "referral_pdf_link", "referral-first"],
    ["referrals", 1, "referral_pdf_link", "referral-second"],
  ];

  it("of a visit comes back with the clinician's id and the rotating summary link, without the member's id", async () => {
    const visit = await read("clinic-visit", theVisit);
    expect(ownerKeysIn(visit)).toEqual([]);
    expect(visit).toMatchObject({
      ...aRotatingSignature,
      visit_summary_pdf_link: linkTo("visit-summary"),
      has_summary_pdf: true,
      service_provider_id: 4455001,
    });
  });

  it.each(OF_THE_VISIT)(
    "of a visit: %s[%i] keeps its reference while its link rotates",
    async (list, at, linkField, document) => {
      const [once, again] = [await read("clinic-visit", theVisit), await read("clinic-visit", theVisit)].map(
        (visit) => visit[list][at],
      );
      expect(once).toMatchObject({
        hash: aRotatingSignature.hash,
        pdf_reference: aReference,
        [linkField]: linkTo(document),
      });
      expect(again.pdf_reference).toBe(once.pdf_reference);
      expect(again[linkField]).not.toBe(once[linkField]);
    },
  );

  it("of an inquiry comes back with the doctor's id and each form's rotating link, without the member's id", async () => {
    const inquiry = await read("doctor-inquiry", theInquiry);
    expect(ownerKeysIn(inquiry)).toEqual([]);
    expect(inquiry).toMatchObject({
      medical_forms_details: [
        {
          hash: aRotatingSignature.hash,
          pdf_reference: aReference,
          link_pdf: linkTo("question-form-501"),
          document_id: 501,
        },
        { document_id: 502 },
      ],
      doctor_name: 'ד"ר בדוי',
      doctor_id: 2233001,
      request_id: theInquiry.id,
    });

    const forms = inquiry.medical_forms_details;
    const formsAgain = (await read("doctor-inquiry", theInquiry)).medical_forms_details;
    const references = (rows: any[]) => rows.map((form) => form.pdf_reference);
    expect(references(formsAgain)).toEqual(references(forms));
    expect(formsAgain[0].link_pdf).not.toBe(forms[0].link_pdf);
  });
});

describe("a reference picks out its own document", () => {
  /** Which of the fake's documents an operation returns once the fake lists its rows back to front. */
  async function withRowsReversed(operation: string, args: Record<string, unknown>): Promise<string | undefined> {
    box.override({ scenario: "rows-reversed" });
    const { isError, content, structuredContent } = await call(session.client(), "maccabi_read", {
      arguments: args,
      operation,
    });
    expect(isError, JSON.stringify(structuredContent)).not.toBe(true);
    const pdf = content?.find(({ type }) => type === "resource")?.resource?.blob as string;
    return Buffer.from(pdf, "base64")
      .toString("utf8")
      .match(/% mock (\S+)/)?.[1];
  }

  it("after the source reversed its rows: the certificate listed after two look-alikes", async () => {
    const [, , { reference }] = await read("certificates", YEAR);
    expect(await withRowsReversed("certificate-pdf", { ...YEAR, reference })).toBe("permit-unrelated");
  });

  it("after the source reversed its rows: the first referral of a visit", async () => {
    const [{ pdf_reference: reference }] = (await read("clinic-visit", theVisit)).referrals;
    expect(await withRowsReversed("clinic-visit-document-pdf", { reference, ...theVisit })).toBe("referral-first");
  });

  it("after the source reversed its rows: the second form of an inquiry", async () => {
    const [, { pdf_reference: reference }] = (await read("doctor-inquiry", theInquiry)).medical_forms_details;
    expect(await withRowsReversed("doctor-inquiry-pdf", { reference, ...theInquiry })).toBe("question-form-502");
  });

  it("in a CLI process started after the one that printed it, by which time each link is a new one", () => {
    const signedIn = { config: "references" };
    const range = ["--from", YEAR.from, "--to", YEAR.to];
    // The second of two certificates that show the same fields: the reference is all that separates them.
    const [, { reference }] = box.cli(["certificates", ...range], signedIn).json().data;
    const target = join(box.dir(), "second-look-alike.pdf");
    const saving = box.cli(["certificate-pdf", ...range, "--out", target, "--reference", reference], signedIn);
    expect(saving.code, saving.err).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("% mock certificate-twin-2\n");
  });
});

it("asked the fake for nothing it had to refuse", () => {
  expect(box.unexpected(), "refused requests and outbound sockets").toEqual([]);
});
