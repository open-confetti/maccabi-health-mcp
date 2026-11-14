/**
 * A provider's card from the public directory, reduced to the fields its page displays. Each field
 * is copied by name and checked for type and size, so an answer that grows a field, or changes one,
 * is refused instead of passed on.
 */
import { HttpFailure } from "./faults";

export interface ProviderRemark {
  Remark_Text: string;
  Line_Number: string;
  NewLine: boolean;
  Mlh: string;
}

/** The card's plain-text fields in alphabetical order, each spelt the way the directory spells it. */
const CARD_TEXT = [
  "Access",
  "Age_Range_From",
  "Age_Range_To",
  "City_Name",
  "First_Name",
  "Full_Adress",
  "House_Number",
  "Last_Name",
  "Neighborhood",
  "Posta",
  "Referring_Text",
  "Relevnt_Populat",
  "Service_Name",
  "Street_Name",
  "Titel",
  "Treat_Area_String",
] as const;

/** What the card shows. Links for booking and the site's own routing values are not part of it. */
export type ProviderCard = { reference: string } & Record<(typeof CARD_TEXT)[number], string> & {
    Languages: string[];
    Treat_Areas: { TreatCode: string; TreatArea: string }[];
    ContactDetails: { Type: number; Title: string; Value: string; Code: string; IsDirectContact: boolean }[];
    Schedules: { Schedule_Type: string; Schedule_Desc: string; Schedule_Details: Record<string, string | null>[] }[];
    ResumeLines: Record<string, string>[];
    Treatments: {
      Sg_Treat_Name: string;
      Cpt_Pubt_Name: string;
      Is_Personal: string;
      Cpt_Code: string;
      Remark_Text: ProviderRemark[];
    }[];
    remarks: Record<string, ProviderRemark[]>;
  };

const SHIFT_TEXT = [
  "Week_Day",
  "Week_Day_S",
  "Week_Day_L",
  "Shift_Start_H",
  "Shift_End_H",
  "Frequency_Desc",
  "Remark_Desc",
];
/** A line of the résumé: a topic, then seven numbered titles, each with its contents. */
const RESUME_TEXT = ["Resume_Topic", ...[1, 2, 3, 4, 5, 6, 7].flatMap((n) => [`Title${n}`, `Title${n}_Contents`])];
const REMARK_GROUPS = [
  "NameRemarks",
  "ContactRemarks",
  "DirectionRemarks",
  "GeneralRemarks",
  "NoticeRemarks",
  "ProfessionRemarks",
  "BoldComments",
];

const MAX_TEXT = 16_384;
const MAX_ITEMS = 200;
const MAX_CONTACTS = 50;
const MAX_SCHEDULES = 50;
const MAX_CARD_CHARS = 256 * 1024;

type Json = Record<string, unknown>;

const unexpected = (): HttpFailure => new HttpFailure("LISTING_UNEXPECTED_ANSWER");

function record(input: unknown): Json {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw unexpected();
  return input as Json;
}

function text(input: unknown): string {
  if (typeof input !== "string" || input.length > MAX_TEXT) throw unexpected();
  return input;
}

function flag(input: unknown): boolean {
  if (typeof input !== "boolean") throw unexpected();
  return input;
}

function each<T>(input: unknown, shape: (item: unknown) => T, limit = MAX_ITEMS): T[] {
  if (!Array.isArray(input) || input.length > limit) throw unexpected();
  return input.map((item) => shape(item));
}

/** The named fields of `from`, every one of them required to be text. */
function texts<K extends string>(from: Json, names: readonly K[]): Record<K, string> {
  const picked = {} as Record<K, string>;
  for (const name of names) picked[name] = text(from[name]);
  return picked;
}

function remark(item: unknown): ProviderRemark {
  const { Remark_Text, Line_Number, NewLine, Mlh } = record(item);
  return { Remark_Text: text(Remark_Text), Line_Number: text(Line_Number), NewLine: flag(NewLine), Mlh: text(Mlh) };
}

function treatArea(item: unknown): ProviderCard["Treat_Areas"][number] {
  return texts(record(item), ["TreatCode", "TreatArea"]);
}

function contact(item: unknown): ProviderCard["ContactDetails"][number] {
  const from = record(item);
  const { Type } = from;
  if (typeof Type !== "number" || !Number.isSafeInteger(Type)) throw unexpected();
  return { Type, ...texts(from, ["Title", "Value", "Code"]), IsDirectContact: flag(from.IsDirectContact) };
}

function shift(item: unknown): Record<string, string | null> {
  const from = record(item);
  const english = from.Week_Day_Eng;
  return { ...texts(from, SHIFT_TEXT), Week_Day_Eng: english === null ? null : text(english) };
}

function schedule(item: unknown): ProviderCard["Schedules"][number] {
  const from = record(item);
  return { ...texts(from, ["Schedule_Type", "Schedule_Desc"]), Schedule_Details: each(from.Schedule_Details, shift) };
}

function treatment(item: unknown): ProviderCard["Treatments"][number] {
  const from = record(item);
  return {
    ...texts(from, ["Sg_Treat_Name", "Cpt_Pubt_Name", "Is_Personal", "Cpt_Code"]),
    Remark_Text: each(from.Remark_Text, remark),
  };
}

export function shapeProviderCard(input: unknown, handle: string): ProviderCard {
  const from = record(input);
  const card: ProviderCard = {
    reference: handle,
    ...texts(from, CARD_TEXT),
    Languages: each(from.Languages, text),
    Treat_Areas: each(from.Treat_Areas, treatArea),
    ContactDetails: each(from.ContactDetails, contact, MAX_CONTACTS),
    Schedules: each(from.Schedules, schedule, MAX_SCHEDULES),
    ResumeLines: each(from.ResumeLines, (line) => texts(record(line), RESUME_TEXT)),
    Treatments: each(from.Treatments, treatment),
    remarks: Object.fromEntries(REMARK_GROUPS.map((group) => [group, each(from[group], remark)])),
  };
  if (JSON.stringify(card).length > MAX_CARD_CHARS) throw unexpected();
  return card;
}
