/**
 * What the upstream client throws. Nothing Maccabi sent and nothing a caller supplied is ever stored
 * on one of these: every message is a constant, and the two parts that vary are an HTTP status and
 * a `detail` token that is spelled out somewhere in this code base.
 */

export class ClientError extends Error {
  constructor(
    readonly code: string,
    notice: string,
    readonly status?: number,
  ) {
    super(notice);
    this.name = this.constructor.name;
  }
}

/** The session is over as far as Maccabi is concerned, and only signing in again restores it. */
export class SessionEnded extends ClientError {
  constructor(status?: number) {
    super("SESSION_ENDED", "The Maccabi session has ended; a new sign-in is needed.", status);
  }
}

/** Signing in stopped part-way; the code names the step. */
export class SignInFailure extends ClientError {
  constructor(code = "SIGN_IN_FAILED", status?: number) {
    super(code, "Maccabi sign-in did not complete.", status);
  }
}

/** The request never produced an answer to read: refused, unreachable, timed out, cancelled. */
export class HttpFailure extends ClientError {
  constructor(code = "PORTAL_FAILED", status?: number) {
    super(code, "The request to Maccabi did not go through.", status);
  }
}

export type RefusalCode =
  | "PORTAL_HTTP_ERROR"
  | "PORTAL_REPORTED_ERROR"
  | "NO_PORTAL_TOKEN"
  | "UNEXPECTED_ANSWER"
  | "NOT_THE_MEMBERS"
  | "OTHER_MEMBER_SELECTED"
  | "NOT_OFFERED"
  | "NOT_ENTITLED";

/**
 * Whose problem a failure is. An agent reads this to tell the member the right thing where it would
 * otherwise try again: `maccabi` (their side failed or refuses, and the website usually fails the
 * same way), `not-applicable` (a valid answer: this member or row has nothing of the kind), `caller`
 * (a wrong input or id), `session`, `member` (only the member can change it, in the Maccabi app),
 * `network`, `tool` (a defect here).
 */
export type Cause = "maccabi" | "not-applicable" | "caller" | "session" | "member" | "network" | "tool";

/** What a second attempt is good for. */
export type Retry =
  | "no"
  | "once"
  | "later"
  | "after-relisting"
  | "after-fixing-input"
  | "after-sign-in"
  | "after-member-action";

export interface Advice {
  cause: Cause;
  retry: Retry;
  /** One constant sentence about a failure that was met on the live service and is understood. */
  knownIssue?: string;
}

/** What a refusal means when nothing more specific is known about it than its code. */
const CODE_ADVICE: Record<RefusalCode, Advice> = {
  PORTAL_HTTP_ERROR: { cause: "maccabi", retry: "once" },
  PORTAL_REPORTED_ERROR: { cause: "maccabi", retry: "once" },
  NO_PORTAL_TOKEN: { cause: "maccabi", retry: "once" },
  UNEXPECTED_ANSWER: { cause: "tool", retry: "no" },
  NOT_THE_MEMBERS: { cause: "caller", retry: "after-relisting" },
  OTHER_MEMBER_SELECTED: { cause: "member", retry: "after-member-action" },
  NOT_OFFERED: { cause: "not-applicable", retry: "no" },
  NOT_ENTITLED: { cause: "not-applicable", retry: "no" },
};

/**
 * Failures met on the live service whose reason is understood. A key is `operation:reason`,
 * `operation:status=N` or a bare `operation`, and the first of those that is present applies.
 */
export const KNOWN_ISSUES: Record<string, Advice & { knownIssue: string }> = {
  "lab-values-pdf:report-absent": {
    cause: "maccabi",
    retry: "no",
    knownIssue:
      "Maccabi may not serve the printable report of an older laboratory result. When the Maccabi website's own Print button gets the same refusal, retrying will not help. The values are still available from `lab-values`.",
  },
  "lab-history-pdf:status=404": {
    cause: "maccabi",
    retry: "no",
    knownIssue:
      "Maccabi may refuse the history print of some tests. When the Maccabi website's own Print button gets the same refusal for them, retrying will not help. The values are still available from `lab-history`.",
  },
  "vaccination-groups-pdf:maccabi-error-page:document-cannot-be-opened": {
    cause: "maccabi",
    retry: "no",
    knownIssue:
      "Maccabi answers its own 'error opening document' page for this COVID vaccination print; the Maccabi website's print button gets the same page. The doses are in `vaccine-doses`, and `vaccine-certificate-pdf` is the vaccination certificate.",
  },
  "corona-certificate:status=500": {
    cause: "not-applicable",
    retry: "no",
    knownIssue:
      "Maccabi answers this with a server error when the member has no COVID certificate; the Maccabi website then shows its generic error message. Treat it as no certificate.",
  },
  "service-eligibilities:status=403": {
    cause: "maccabi",
    retry: "no",
    knownIssue:
      "Maccabi refuses this service-eligibility catalog for some accounts, including the request the Maccabi website itself sends; the website then shows a try-again-later message. It is not available for this account.",
  },
};

const TELL_MAINTAINERS = "tell this tool's maintainers which operation it was, without any clinical data.";

/**
 * The next step for each code, in the words shown to the caller. The right reaction differs sharply
 * from code to code (a second try helps after PORTAL_HTTP_ERROR and never after UNEXPECTED_ANSWER),
 * so no two share a text, and each names the read it is about.
 */
const GUIDANCE: Record<RefusalCode, (operation: string) => string> = {
  PORTAL_HTTP_ERROR: (operation) =>
    `The ${operation} request came back from Maccabi with an HTTP error, which says nothing against the arguments. Retry once. A second failure means the portal itself is having trouble.`,
  PORTAL_REPORTED_ERROR: (operation) =>
    `Maccabi's answer to ${operation} carried an error of its own. Retry once, arguments unchanged, and stop if it happens again.`,
  NO_PORTAL_TOKEN: (operation) =>
    `The portal did not hand over a token that ${operation} depends on. Retry once, arguments unchanged.`,
  UNEXPECTED_ANSWER: (operation) =>
    `The ${operation} answer is not laid out the way this tool expects, so neither a retry nor other arguments can help. Please ${TELL_MAINTAINERS}`,
  NOT_THE_MEMBERS: (operation) =>
    `The member's ${operation} data, read just now, does not contain that id or reference. It is out of date, or came from another row or another list. List again and take the value from the new result, and never mix ids of two rows.`,
  OTHER_MEMBER_SELECTED: (operation) =>
    `While reading ${operation}, the Maccabi portal turned out to be showing another family member. Nothing is wrong with the session, so do not sign in again: the member selects themselves in the portal, and then the read can be retried.`,
  NOT_OFFERED: (operation) =>
    `This record belongs to the member but has no ${operation}, or the account does not qualify for it. The same input will fail the same way; pick a different row or operation. Should the Maccabi website offer it after all, please ${TELL_MAINTAINERS}`,
  NOT_ENTITLED: (operation) =>
    `According to Maccabi, ${operation} is not available to the member, or not for this row. This is Maccabi's answer and not a fault, so do not retry.`,
};

const VISIT_KIND_CLOSED = "The provider lists this visit type, but the member may not use it.";
const VISIT_KIND_UNKNOWN =
  "That visit type is not among the ones the provider offers at present. Run `visit-types` again and copy a `visit_types_eligible[].code` as it is written.";

/** Exceptions to the table above, keyed `operation:reason`, where the general wording would mislead. */
const SPECIFIC_GUIDANCE: Record<string, string> = {
  "lab-values-pdf:report-absent":
    "Maccabi has no printable report for this result; this can happen for older results. Do not retry. `lab-values` still returns its values.",
  "lab-values-pdf:not-a-lab-row":
    "A laboratory report exists only for laboratory results, and this row is something else. `test-document-pdf` returns its file, when it has one.",
  "open-slots:visit-kind-closed": `${VISIT_KIND_CLOSED} No slots were looked up. Do not retry; choose a \`visit_types_eligible[].code\`.`,
  "visit-preparation:visit-kind-closed": `${VISIT_KIND_CLOSED} Choose a \`visit_types_eligible[].code\`.`,
  "open-slots:visit-kind-unknown": VISIT_KIND_UNKNOWN,
  "visit-preparation:visit-kind-unknown": VISIT_KIND_UNKNOWN,
};

/** For a reason that means one thing whichever read raises it: the wording, and whose problem it is. */
const REASON_GUIDANCE: Record<string, string> = {
  "provider-unknown":
    "That provider is not one of the member's recent providers. Pass `object_type`, `object_id` and `employee_id` exactly as a `recent-providers` row (or `bookable-providers` `providers[].row`) has them; team members and the assigned doctor cannot be used here.",
};
const REASON_ADVICE: Record<string, Advice> = {
  "provider-unknown": { cause: "caller", retry: "after-fixing-input" },
};

/** A `detail` is built from these characters only, which leaves no room for a URL, a sentence or a name from upstream. */
const SAFE_REASON = /^[A-Za-z0-9_.:=[\]-]{1,120}$/;

/** A read that got as far as Maccabi, or was about to, and has no result to give. */
export class ReadRefusal extends Error {
  /**
   * The check that failed, in a form fit to show: `status=503`, `reference-unknown`, `key:pdf_link`.
   * It is the HTTP status, a token from this code base, or both; a reason of any other form is discarded.
   */
  readonly detail?: string;
  readonly #reason?: string;

  constructor(
    readonly code: RefusalCode,
    readonly operation: string,
    readonly status?: number,
    why?: string,
  ) {
    super(`Maccabi ${operation}: ${code}`);
    this.name = "ReadRefusal";
    if (why !== undefined && SAFE_REASON.test(why)) this.#reason = why;
    const shown: string[] = [];
    if (Number.isSafeInteger(status)) shown.push(`status=${status}`);
    if (this.#reason !== undefined) shown.push(this.#reason);
    if (shown.length > 0) this.detail = shown.join(" ");
  }

  /** Whose problem this is and what a retry can do: a known issue first, then the reason, then the code. */
  get advice(): Advice {
    const why = this.#reason;
    const candidates = [
      why === undefined ? undefined : `${this.operation}:${why}`,
      Number.isSafeInteger(this.status) ? `${this.operation}:status=${this.status}` : undefined,
      this.operation,
    ];
    for (const prop of candidates)
      if (prop !== undefined && Object.hasOwn(KNOWN_ISSUES, prop)) return KNOWN_ISSUES[prop] as Advice;
    if (why !== undefined && Object.hasOwn(REASON_ADVICE, why)) return REASON_ADVICE[why] as Advice;
    return CODE_ADVICE[this.code];
  }

  /** The caller's next step, from the constant texts above. */
  get guidance(): string {
    return this.guidanceFor(this.operation);
  }

  /**
   * The same next step, worded around `command`. A read is often known inside this client by another
   * name than the command that reached it, and the caller only ever saw the command.
   */
  guidanceFor(command: string): string {
    const why = this.#reason;
    const exception =
      why === undefined
        ? undefined
        : (SPECIFIC_GUIDANCE[`${this.operation}:${why}`] ??
          (Object.hasOwn(REASON_GUIDANCE, why) ? REASON_GUIDANCE[why] : undefined));
    return exception ?? GUIDANCE[this.code](command);
  }
}

/** A refusal that has a reason and no HTTP status behind it. */
export function refuse(code: RefusalCode, operation: string, why: string): ReadRefusal {
  return new ReadRefusal(code, operation, undefined, why);
}
