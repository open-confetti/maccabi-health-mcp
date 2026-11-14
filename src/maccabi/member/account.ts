/**
 * The member's own account: who they are, how Maccabi reaches them, who may act on the account, which
 * reminders are switched on and how payments are collected. The keep-alive request lives here too.
 * Nothing in this file writes: no setting is saved and no access is granted or withdrawn.
 */
import { ReadRefusal, refuse, SessionEnded } from "../faults";
import { textUpTo } from "../http";
import { type MemberScope, servicePath } from "./context";
import { type ChannelSettings, ChannelShapeError, shapeChannelSettings } from "./parse/alert-settings";
import { type AccessList, AccessListShapeError, shapeAccessList } from "./parse/authorized-users";
import {
  asObject,
  asString,
  classicBody,
  type Fields,
  getJson,
  isCount,
  isGatewayLogonPage,
  type MemberProfile,
  mustBelongToMember,
  overSource,
  type Reading,
  turnAway,
} from "./shared";

const DIRECTORSHIP = "DirectorshipAPI";
const MAIN_APP = "MainAppAPI";
/** The service the sign-in bootstrap came from; profile and contact details are read out of it. */
const BOOTSTRAP = "TokenServerAPI";
const REMINDERS_ROUTE = "/online/webapi/PersonalRemindersESB/GetReminders/";

const PHONE_TEXT = ["phone_type", "phone_prefix", "fax_special_prefix"];
/** The fields of an address that have to be text, alphabetically; the PO box is the one number. */
const ADDRESS_TEXT =
  "address_for_mail address_status address_type apartment_num city_name city_name_for_not_maccabi_member entrance house_num postal_code street_name street_name_for_not_maccabi_member zip_code".split(
    " ",
  );
/** The payment fields the website renders, with the type each must arrive as. */
const PAYMENT_FIELD_TYPES: Record<string, "boolean" | "number" | "string"> = {
  is_active_auth_exists: "boolean",
  is_credit_auth_only: "boolean",
  is_shaban_auth_only: "boolean",
  payment_method: "number",
  bank_code: "number",
  branch_code: "number",
  payer_type: "number",
  bank_name: "string",
  branch_name: "string",
  credit_card_type: "string",
  last_four_digits_credit_card: "string",
};
/** A full bank account number is the one payment field that is withheld. */
const ACCOUNT_NUMBER_KEY = /account_?num(?:ber)?$/i;

/** Phone numbers and PO boxes arrive as whole, non-negative numbers. */
function wholeNumber(row: Fields, key: string, label: string): void {
  if (!isCount(row[key])) throw refuse("UNEXPECTED_ANSWER", label, `key:${key}`);
}

export class Account {
  constructor(private readonly scope: MemberScope) {}

  /**
   * Who the member is, as the bootstrap described them. The validated name, birth date and sex sit on top
   * of the remaining bootstrap fields; the passport number and identity checksums were already removed.
   */
  fetchOwnerProfile(): Reading<MemberProfile> {
    const { sourceProfile } = this.scope.bootstrap;
    return this.#fromBootstrap(overSource(sourceProfile, { ...this.scope.profile }), "profile");
  }

  /** The people who currently hold access to this account. A listing only. */
  async allAccountAccess(): Promise<Reading<AccessList>> {
    const label = "authorized-users";
    const route = this.scope.path(DIRECTORSHIP, "v1", "accounts");
    const sent = asObject(await getJson(this.scope.http, route, label), label);
    mustBelongToMember(sent, this.scope.owner, label);
    let shaped: AccessList;
    try {
      shaped = shapeAccessList(sent);
    } catch (error) {
      throw error instanceof AccessListShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    return this.scope.renderedResult(overSource(sent, shaped), DIRECTORSHIP, label);
  }

  /**
   * Sends the portal's own keep-alive once. Maccabi decides how long a session lasts; this neither
   * guarantees more time nor survives an expiry the portal forces.
   */
  async renew(): Promise<Reading<{ renewed: true }>> {
    const label = "session-renewal";
    const reply = await this.scope.http.request(this.scope.path(MAIN_APP, "v1", "alive"));
    if (reply.status !== 200) await turnAway(reply, new ReadRefusal("PORTAL_HTTP_ERROR", label, reply.status));
    // A live session answers with nothing at all. The gateway's logon page in that place means the
    // session is over, exactly as it would on a read.
    const body = await textUpTo(reply, refuse("UNEXPECTED_ANSWER", label, "body-unreadable"));
    if (isGatewayLogonPage(body)) throw new SessionEnded(reply.status);
    if (body.length > 0) throw refuse("UNEXPECTED_ANSWER", label, "body-not-empty");
    return this.scope.result({ renewed: true }, MAIN_APP, label);
  }

  /** E-mail, phones and addresses as the bootstrap carried them; no further request is made. */
  fetchOwnerContactProfile(): Reading<Fields> {
    const label = "contact-details";
    const contact = asObject(this.scope.bootstrap.contact, label, "contact");
    const { phones } = this.scope.bootstrap;
    for (const phone of this.scope.rows(phones, label, "phones")) {
      wholeNumber(phone, "phone_no", label);
      for (const key of PHONE_TEXT) asString(phone[key], label, key);
    }
    for (const address of this.scope.rows(contact.addresses, label, "addresses")) {
      for (const key of ADDRESS_TEXT) asString(address[key], label, key);
      wholeNumber(address, "po_box", label);
    }
    for (const key of ["email", "phones_update_date"]) asString(contact[key], label, key);
    // Every row passed its checks as sent, so the answer is the bootstrap's contact block itself.
    return this.#fromBootstrap(structuredClone({ ...contact, phones }), label);
  }

  /** The reminder channels as currently saved for the member alone; family members' settings are not read. */
  async fetchNotificationPreferences(): Promise<Reading<ChannelSettings>> {
    const label = "notification-settings";
    // The reminders service answers only inside a classic-page session, and that page proves whose it is.
    await this.scope.classicPage("directorship/personalreminders/", label);
    const reply = await this.scope.classicJson(REMINDERS_ROUTE, label);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await classicBody(reply, label));
    } catch (error) {
      throw error instanceof SyntaxError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    const sent = asObject(parsed, label);
    mustBelongToMember(sent, this.scope.owner, label);
    const { Code: outcome } = asObject(sent.ResultMessage, label, "ResultMessage");
    if (!Number.isSafeInteger(outcome)) throw refuse("UNEXPECTED_ANSWER", label, "key:Code");
    if (outcome !== 0) throw new ReadRefusal("PORTAL_REPORTED_ERROR", label);
    let shaped: ChannelSettings;
    try {
      shaped = shapeChannelSettings(sent);
    } catch (error) {
      throw error instanceof ChannelShapeError ? refuse("UNEXPECTED_ANSWER", label, "shape-changed") : error;
    }
    return this.scope.renderedResult(overSource(sent, shaped), "LegacyPersonalReminders", label);
  }

  /** How the member pays: standing-order and card details, never the bank account number itself. */
  async fetchPaymentMethods(): Promise<Reading<Fields>> {
    const label = "payment-methods";
    // Addressed by payer: the member's two segments follow `payers` here, not `members`.
    const route = servicePath(DIRECTORSHIP, `v1/payers/${this.scope.ownerSegments}/debit_authorization`);
    const sent = asObject(await getJson(this.scope.http, route, label), label);
    for (const [key, type] of Object.entries(PAYMENT_FIELD_TYPES)) {
      const value = sent[key];
      const fits = type === "number" ? Number.isFinite(value) : typeof value === type;
      if (!fits) throw refuse("UNEXPECTED_ANSWER", label, `key:${key}`);
    }
    if (sent.auth_start_date !== null) asString(sent.auth_start_date, label, "auth_start_date");
    const kept: Fields = structuredClone(sent);
    for (const key of Object.keys(kept)) if (ACCOUNT_NUMBER_KEY.test(key)) delete kept[key];
    return this.scope.result(kept, DIRECTORSHIP, label);
  }

  /** Bootstrap data is as old as the sign-in read, so it is stamped with that read's time. */
  #fromBootstrap<T>(data: T, label: string): Reading<T> {
    return { ...this.scope.result(data, BOOTSTRAP, label), retrievedAt: this.scope.bootstrapAt };
  }
}
