/**
 * Everything one signed-in member can read, a reader per domain. The readers share a single
 * MemberScope; whatever a reader remembers between calls it keeps to itself.
 */

import { Account } from "./account";
import { MemberScope } from "./context";
import { Imaging } from "./imaging";
import { Labs } from "./labs";
import { Mailings } from "./mailings";
import { Billing } from "./payments";
import { Portal } from "./portal";
import { Prescriptions } from "./prescriptions";
import { Records } from "./records";
import { Requests } from "./requests";
import { Appointments } from "./scheduling";
import type { MemberHttp, MemberKey } from "./shared";
import { Visits } from "./visits";

export type { MemberKey } from "./shared";

export class Member {
  readonly account: Account;
  readonly mailings: Mailings;
  readonly billing: Billing;
  readonly records: Records;
  readonly requests: Requests;
  readonly prescriptions: Prescriptions;
  readonly visits: Visits;
  readonly appointments: Appointments;
  readonly labs: Labs;
  readonly imaging: Imaging;
  readonly portal: Portal;

  private constructor(private readonly scope: MemberScope) {
    this.account = new Account(scope);
    this.mailings = new Mailings(scope);
    this.billing = new Billing(scope);
    this.records = new Records(scope);
    // Two readers lean on another one: requests on the visit list, imaging on the test list.
    this.visits = new Visits(scope);
    this.requests = new Requests(scope, this.visits);
    this.prescriptions = new Prescriptions(scope);
    this.appointments = new Appointments(scope);
    this.labs = new Labs(scope);
    this.imaging = new Imaging(scope, this.labs);
    this.portal = new Portal(scope);
  }

  /** Opens the scope for whoever is signed in; see MemberScope.open for what is refused. */
  static async open(http: MemberHttp, rightfulOwner?: MemberKey): Promise<Member> {
    return new Member(await MemberScope.open(http, rightfulOwner));
  }

  get owner(): MemberKey {
    return this.scope.memberKey;
  }
}
