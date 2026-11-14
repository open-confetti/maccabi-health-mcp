import { type Advice, ClientError, KNOWN_ISSUES, ReadRefusal, SessionEnded } from "../maccabi/faults";
import { CatalogRefusal } from "../maccabi/member/parse/catalog";

/**
 * `usage`: the caller's input was refused before anything was requested.
 * `auth`: a sign-in is needed or did not complete.
 * `failed`: the request was made, or storage was touched, and it did not work.
 */
export type FailureKind = "usage" | "auth" | "failed";

/**
 * The only error either surface ever shows. Its text is written here or in `maccabi/faults.ts`;
 * nothing received from Maccabi and nothing the caller typed is ever copied into it.
 */
export class Failure extends Error {
  constructor(
    readonly code: string,
    notice: string,
    readonly kind: FailureKind = "failed",
    /** A fixed token naming the check that failed, such as `status=503` or `key:pdf_link`. */
    readonly detail?: string,
    /** Whose problem this is and what retrying can do; derived from the code when absent. */
    readonly advice?: Advice,
  ) {
    super(notice);
    this.name = "Failure";
  }
}

const NOTHING_SENT = "No SMS was sent.";
const RESTART = "Begin a new sign-in; it sends a new code.";

const MESSAGES: Record<string, { message: string; kind?: FailureKind }> = {
  TIMED_OUT: { message: "Maccabi did not answer in time. Nothing was retried; try again later." },
  LISTING_UNREACHABLE: {
    message:
      "The public directory host (serguide.maccabi4u.co.il) could not be reached. A firewall or network policy may block it. Nothing was retried.",
  },
  REQUEST_CANCELLED: { message: "The request was cancelled. Nothing was retried." },
  UNREACHABLE: { message: "Maccabi could not be reached. Check connectivity; nothing was retried." },
  STORAGE_UNAVAILABLE: {
    message: "The saved session could not be read or written. Check the permissions of the config directory.",
  },
  DAMAGED_SESSION: { message: "The saved session is damaged. Sign out, then sign in again.", kind: "auth" },
  BAD_ID: { message: `The ID number is digits only, at most nine. ${NOTHING_SENT}`, kind: "usage" },
  BAD_CODE: { message: "The SMS code is six digits. Nothing was verified.", kind: "usage" },
  BAD_PHONE_OPTION: { message: `That phone option is not offered for this ID. ${NOTHING_SENT}`, kind: "usage" },
  ID_LOOKUP_FAILED: {
    message: `Maccabi's sign-in service could not look this ID up right now. ${NOTHING_SENT} Try again later.`,
  },
  SIGN_IN_NOT_OFFERED: { message: `Maccabi does not offer online sign-in for this ID. ${NOTHING_SENT}` },
  NO_SMS_PHONE: { message: `No phone that can receive an SMS is registered for this ID. ${NOTHING_SENT}` },
  SIGN_IN_BLOCKED: {
    message: "Maccabi has blocked sign-in for this ID. The member has to contact Maccabi.",
    kind: "auth",
  },
  CODE_REJECTED: {
    message: `Maccabi rejected the code. A code gets one attempt, because retries lock the account. ${RESTART}`,
    kind: "auth",
  },
  CODE_EXPIRED: { message: `The code expired. ${RESTART}`, kind: "auth" },
  NO_CODE_SENT: { message: `No SMS has been sent for this sign-in yet. ${RESTART}`, kind: "auth" },
  SIGN_IN_EXPIRED: { message: `The sign-in was not finished within ten minutes. ${RESTART}`, kind: "auth" },
  NO_OPEN_SIGN_IN: { message: `No sign-in is waiting for a code. ${RESTART}`, kind: "auth" },
  SESSION_NOT_OPENED: {
    message: `Maccabi accepted the code but did not open a session. ${RESTART}`,
    kind: "auth",
  },
  SIGN_IN_PAGE_CHANGED: { message: "Maccabi's sign-in page changed and this tool needs an update." },
  SIGN_IN_ANSWER_CHANGED: { message: "Maccabi's sign-in service answered in a shape this tool does not know." },
  HANDOFF_CHANGED: { message: "Maccabi's sign-in hand-off changed and this tool needs an update." },
};

/** Advice for the failures that are not read refusals, looked up by code. */
const ADVICE: Record<string, Advice> = {
  SIGN_IN_NEEDED: { cause: "session", retry: "after-sign-in" },
  DAMAGED_SESSION: { cause: "session", retry: "after-sign-in" },
  TIMED_OUT: { cause: "network", retry: "later" },
  REQUEST_CANCELLED: { cause: "network", retry: "later" },
  UNREACHABLE: { cause: "network", retry: "later" },
  LISTING_UNREACHABLE: { cause: "network", retry: "later" },
  ID_LOOKUP_FAILED: { cause: "maccabi", retry: "later" },
  SIGN_IN_NOT_OFFERED: { cause: "member", retry: "no" },
  NO_SMS_PHONE: { cause: "member", retry: "no" },
  SIGN_IN_BLOCKED: { cause: "member", retry: "no" },
  LISTING_CHALLENGED: {
    cause: "maccabi",
    retry: "no",
    knownIssue:
      "Maccabi's public directory screens automated clients. Its specialty and city lists usually answer, but its searches answer automated clients with a robot check. This tool does not get around it. The member can search the directory on the Maccabi website.",
  },
  SIGN_IN_PAGE_CHANGED: { cause: "tool", retry: "no" },
  SIGN_IN_ANSWER_CHANGED: { cause: "tool", retry: "no" },
  HANDOFF_CHANGED: { cause: "tool", retry: "no" },
  TOOL_DEFECT: { cause: "tool", retry: "no" },
};

/** The advice a failure carries, or else what its code says, or else what its kind implies. */
export function adviceOf(refusal: Failure): Advice {
  if (refusal.advice) return refusal.advice;
  if (Object.hasOwn(ADVICE, refusal.code)) return ADVICE[refusal.code] as Advice;
  if (refusal.kind === "usage") return { cause: "caller", retry: "after-fixing-input" };
  if (refusal.kind === "auth") return { cause: "session", retry: "after-sign-in" };
  return { cause: "maccabi", retry: "once" };
}

/**
 * The error object both surfaces show. `hint` says how to sign in on that surface. `cause` and `retry`
 * are fixed values an agent can act on; `known_issue` explains a failure seen live before.
 */
export function failureBody(refusal: Failure, signInHint: string) {
  const notice = refusal.code === "SIGN_IN_NEEDED" ? `${refusal.message} ${signInHint}` : refusal.message;
  const advice = adviceOf(refusal);
  return {
    error: {
      code: refusal.code,
      message: notice,
      ...(refusal.detail ? { detail: refusal.detail } : {}),
      cause: advice.cause,
      retry: advice.retry,
      ...(advice.knownIssue ? { known_issue: advice.knownIssue } : {}),
    },
  };
}

/** Messages a lower layer wrote as one fixed sentence, safe to pass through as they are. */
const FIXED_MESSAGES: Record<string, FailureKind> = {
  LISTING_CHALLENGED: "failed",
  NOTHING_TO_VERIFY: "auth",
  CHOOSE_A_PHONE: "auth",
};

const NOT_DELIVERED = "The request to Maccabi did not go through, and it was not tried a second time.";

/**
 * `command` is the name the caller ran, which a message uses in place of the read's internal name.
 * `endpoint` is the catalog entry behind a transport-level error, so that entry's known issue applies.
 */
export function toFailure(caught: unknown, command?: string, endpoint?: string): Failure {
  if (caught instanceof Failure) return caught;
  if (caught instanceof SessionEnded) {
    return new Failure("SIGN_IN_NEEDED", "Maccabi ended the session. Sign in again.", "auth");
  }
  if (caught instanceof ReadRefusal) {
    const notice = caught.guidanceFor(command ?? caught.operation);
    return new Failure(caught.code, notice, "failed", caught.detail, caught.advice);
  }
  if (caught instanceof CatalogRefusal) return new Failure("BAD_INPUT", caught.message, "usage");
  if (caught instanceof ClientError) {
    const state_ = Number.isSafeInteger(caught.status) ? `status=${caught.status}` : undefined;
    const issueKey = endpoint && state_ ? `${endpoint}:${state_}` : undefined;
    if (issueKey !== undefined && Object.hasOwn(KNOWN_ISSUES, issueKey))
      return new Failure(caught.code, NOT_DELIVERED, "failed", state_, KNOWN_ISSUES[issueKey]);
    const known = MESSAGES[caught.code];
    if (known) return new Failure(caught.code, known.message, known.kind ?? "failed", state_);
    const fixed = FIXED_MESSAGES[caught.code];
    if (fixed) return new Failure(caught.code, caught.message, fixed, state_);
    return new Failure(caught.code, NOT_DELIVERED, "failed", state_);
  }
  // Anything else was never anticipated. Its message could hold anything, so it is not shown.
  return new Failure("TOOL_DEFECT", "This tool failed in a way it does not explain. That is a defect worth reporting.");
}
