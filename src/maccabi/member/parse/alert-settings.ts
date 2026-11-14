import { type Guard, guardFor, type Json } from "./guards";

/**
 * The notification settings as the server holds them now. What the settings page tracks while the
 * member edits, and what it would send to save, have no counterpart here.
 */
export interface ChannelState {
  code: number;
  order: number;
  name: string;
  description: string | null;
  registered: boolean;
  canRegister: boolean;
  restrictionCode: number | null;
  restrictionDescription: string;
}
export interface ChannelService extends ChannelState {
  typeCode: string | null;
  isMaccabitonType: boolean;
  defaultChannelCode: number;
  selectedChannelCode: number;
  channels: ChannelState[];
}
export interface ChannelGroup extends ChannelState {
  services: ChannelService[];
}
export interface ChannelSettings {
  statusCode: number;
  preferredLanguageCode: number;
  contact: { cellPhone: string; email: string };
  groups: ChannelGroup[];
}

export class ChannelShapeError extends Error {
  constructor() {
    super("Maccabi's notification settings are not laid out the way they were when this reader was written");
    this.name = "ChannelShapeError";
  }
}

const check: Guard = guardFor(() => new ChannelShapeError());
const label = (value: unknown): string => (typeof value === "string" && value.length <= 16_384 ? value : check.fail());
const nullOr = <T>(value: unknown, read: (given: unknown) => T): T | null => (value === null ? null : read(value));

/** The entries of one level of the tree: objects, each with a whole-number `Code` no sibling repeats. */
function coded(value: unknown): Json[] {
  const items = check.list(value, 100).map(check.object);
  const codes = new Set(items.map((item) => check.integer(item.Code)));
  return codes.size === items.length ? items : check.fail();
}

/** Groups, services and channels all carry these same eight fields. */
function state(item: Json): ChannelState {
  return {
    code: check.integer(item.Code),
    name: label(item.Name),
    description: nullOr(item.Description, label),
    registered: check.flag(item.IsRegistered),
    canRegister: check.flag(item.CanRegister),
    restrictionDescription: label(item.RestrictionDesc),
    restrictionCode: nullOr(item.RestrictionCode, check.integer),
    order: check.integer(item.Order),
  };
}

function service(item: Json): ChannelService {
  return {
    ...state(item),
    typeCode: nullOr(item.TypeCode, label),
    defaultChannelCode: check.integer(item.DefaultChannelCode),
    // The misspelling is the portal's.
    selectedChannelCode: check.integer(item.ServiceChanneIdSelected),
    isMaccabitonType: check.flag(item.IsMaccabitonType),
    channels: coded(item.Channels).map(state),
  };
}

/** The tree the portal's PersonalReminders controller walks: groups, their services, each service's channels. */
export function shapeChannelGroups(answer: unknown): ChannelGroup[] {
  const groups = coded(answer).map((item) => ({ ...state(item), services: coded(item.Services).map(service) }));
  return check.bounded(groups, 128 * 1024);
}

export function shapeChannelSettings(answer: unknown): ChannelSettings {
  const body = check.object(answer);
  if (check.object(body.ResultMessage).Code !== 0) check.fail();
  const contact = check.object(body.ContactDetails);
  return check.bounded(
    {
      statusCode: check.integer(body.StatusCode),
      preferredLanguageCode: check.integer(body.PreferredLangCode),
      contact: { cellPhone: label(contact.CellPhone), email: label(contact.Email) },
      groups: shapeChannelGroups(body.ServiceGroups),
    },
    128 * 1024,
  );
}
