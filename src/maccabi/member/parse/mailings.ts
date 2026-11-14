import { type Guard, guardFor, isWebLink, type Json } from "./guards";

export interface MailingTutorial {
  display_text: string;
  link?: string;
  tutorial_type: "pdf" | "webpage" | "video";
}

type MailingDates = { item_date: string; original_item_date: string };
/** A letter, which at one of its statuses has a document to download. */
export type MailingLetter = MailingDates & { letter_type: 2; status: 0 | 1 | 2 | 3; has_document: boolean };
/** A set of tutorials tied to a practitioner and a kind of service. */
export type MailingGuidance = MailingDates & {
  letter_type: 3;
  practitioner_name: string;
  service_type_text: string;
  tutorials: MailingTutorial[];
};
export type Mailing = MailingLetter | MailingGuidance;

export class MailingShapeError extends Error {
  constructor() {
    super("A Maccabi mailing is not laid out the way the portal's mailbox reads it");
    this.name = "MailingShapeError";
  }
}

const check: Guard = guardFor(() => new MailingShapeError());
const LETTER_STATUSES: readonly unknown[] = [0, 1, 2, 3];
/** The one status at which the mailbox offers the letter's document. */
const DOCUMENT_READY = 1;

function letter(row: Json, dates: MailingDates): MailingLetter {
  if (!LETTER_STATUSES.includes(row.status)) check.fail();
  const status = row.status as MailingLetter["status"];
  if (status === DOCUMENT_READY) {
    // The download needs the document's address and signature, so they have to be there; neither is passed on.
    check.filled(row.link);
    check.filled(row.timestamp);
    if (row.hash !== undefined && row.hash !== null) check.filled(row.hash);
  }
  return { letter_type: 2, status, ...dates, has_document: status === DOCUMENT_READY };
}

function tutorial(entry: unknown): MailingTutorial {
  const item = check.object(entry);
  const display_text = check.filled(item.display_text);
  switch (item.tutorial_type) {
    case "pdf":
      // A PDF is fetched through Maccabi with its signature, so its address stays out of the result.
      for (const signed of [item.url, item.timestamp, item.hash]) check.filled(signed);
      return { tutorial_type: "pdf", display_text };
    case "webpage":
    case "video":
      return {
        tutorial_type: item.tutorial_type,
        display_text,
        link: isWebLink(item.url) ? item.url : check.fail(),
      };
    default:
      return check.fail();
  }
}

function guidance(row: Json, dates: MailingDates): MailingGuidance {
  return {
    letter_type: 3,
    service_type_text: check.filled(row.service_type_text),
    practitioner_name: check.filled(row.practitioner_name),
    ...dates,
    tutorials: check.list(row.tutorials, 100).map(tutorial),
  };
}

/**
 * What the portal's mailbox displays of each mailing, plus whether a letter has a document. The
 * member's identifiers and the routes and signatures of PDFs are not copied. A web page or a video is
 * something the mailbox simply links to, so its address is passed on as text; it is not requested here.
 */
export function shapeMailings(answer: unknown): Mailing[] {
  const mailings = check.list(answer, 1000).map((entry): Mailing => {
    const row = check.object(entry);
    const dates = {
      item_date: check.filled(row.item_date),
      original_item_date: check.filled(row.original_item_date),
    };
    if (row.letter_type === 2) return letter(row, dates);
    if (row.letter_type === 3) return guidance(row, dates);
    return check.fail();
  });
  return check.bounded(mailings, 128 * 1024);
}
