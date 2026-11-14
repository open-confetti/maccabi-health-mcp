import { type Guard, guardFor, type Json } from "./guards";

export interface PrescriptionAsk {
  drug_name: string;
}

export interface ApprovalAsk {
  approval_additional_text: string;
  approval_description?: string;
  approval_required_from: string | null;
  approval_required_to: string | null;
}

export interface ClinicalAsks {
  approval_request_details: ApprovalAsk[];
  prescription_largo_code_list: PrescriptionAsk[];
  /** Named when the answer carries it: the portal keeps that list for its edit form and the timeline never shows it. */
  unsupported_sections: "prescription_user_drugs_indication"[];
}

export class ClinicalAskShapeError extends Error {
  constructor() {
    super("The clinical part of a Maccabi inquiry is not laid out the way the portal's timeline reads it");
    this.name = "ClinicalAskShapeError";
  }
}

const check: Guard = guardFor(() => new ClinicalAskShapeError());
const records = (value: unknown): Json[] => check.list(value, 100).map(check.object);
const dateOrNull = (value: unknown): string | null => (value === null ? null : check.text(value, 512));

function approvalAsk(row: Json): ApprovalAsk {
  const ask: ApprovalAsk = {
    approval_required_from: dateOrNull(row.approval_required_from),
    approval_required_to: dateOrNull(row.approval_required_to),
    approval_additional_text: check.text(row.approval_additional_text, 16_384),
  };
  if (row.approval_description === undefined) return ask;
  return { ...ask, approval_description: check.text(row.approval_description, 4096) };
}

/** What the portal's timeline shows of an inquiry that asks for a prescription or for an approval. */
export function shapeClinicalAsks(answer: unknown): ClinicalAsks {
  const body = check.object(answer);
  const asks: ClinicalAsks = {
    prescription_largo_code_list: records(body.prescription_largo_code_list).map((row) => ({
      drug_name: check.text(row.drug_name, 4096),
    })),
    approval_request_details: records(body.approval_request_details).map(approvalAsk),
    unsupported_sections:
      check.list(body.prescription_user_drugs_indication, 100).length > 0 ? ["prescription_user_drugs_indication"] : [],
  };
  return check.bounded(asks, 256 * 1024);
}
