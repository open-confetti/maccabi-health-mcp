import { ClientError } from "../maccabi/faults";
import type { Fetch } from "../maccabi/http";
import { PortalHttp } from "../maccabi/http";
import { Member } from "../maccabi/member";
import type { PortalSession } from "../maccabi/portal-session";
import { SmsSignIn } from "../maccabi/sms-sign-in";
import type { SavedSession, SessionStore } from "./files";

export { ID_NUMBER } from "../maccabi/sms-sign-in";

/**
 * Signing in with the ID number and an SMS code, in two steps that may run in two processes:
 * `start` sends one SMS and stores the open challenge, `verify` finishes it with the code.
 *
 * One SMS per start and one attempt per code. A rejected code ends the challenge, because repeated
 * attempts against one challenge are what lock a Maccabi account.
 */

export interface SignInOptions {
  store: SessionStore;
  fetch?: Fetch;
  now?: () => number;
  /** Fires when the caller has stopped waiting; a sign-in that finishes afterwards is not saved. */
  signal?: AbortSignal;
}

export type SignInStarted =
  | { status: "sms-sent"; phone: string; expiresInSeconds: number }
  | { status: "phone-required"; phones: { option: number; label: string }[]; expiresInSeconds: number };

export type SignInState =
  | { status: "signed-in"; expiresAt?: string }
  | { status: "expired"; expiresAt: string }
  | { status: "pending-login"; smsSent: boolean; expiresInSeconds: number }
  | { status: "signed-out" };

class SignInError extends ClientError {}

function secondsUntil(time: number, clock: number): number {
  return Math.max(0, Math.round((time - clock) / 1000));
}

/** Opens the member behind a session; the transport keeps the cookies the portal refreshes along the way. */
export async function openMember(saved: { session: PortalSession; owner?: SavedSession["owner"] }, fetch?: Fetch) {
  const http = new PortalHttp({ session: saved.session, ...(fetch ? { fetch } : {}) });
  const member = await Member.open(http, saved.owner);
  return { member, snapshot: () => http.snapshot() };
}

function newAuth(opts: SignInOptions): SmsSignIn {
  return new SmsSignIn(new PortalHttp(opts.fetch ? { fetch: opts.fetch } : {}), {
    ...(opts.now ? { now: opts.now } : {}),
  });
}

/**
 * Sends one SMS. When the ID has several phones and none was chosen, nothing is sent and the options
 * are returned instead: picking for the member could text a phone they are not holding.
 */
export async function startSignIn(opts: SignInOptions, ident: string, chosenOption?: number): Promise<SignInStarted> {
  const clock = opts.now ?? Date.now;
  // A storage problem should surface here, before an SMS is spent. A damaged session file is not
  // one: the sign-in that follows replaces it.
  await opts.store.load().catch((caught: unknown) => {
    if (!(caught instanceof ClientError) || caught.code !== "DAMAGED_SESSION") throw caught;
  });
  await opts.store.assertWritable();
  const auth = newAuth(opts);
  let stored = false;
  try {
    const attempt = await auth.begin(ident);
    const phones = attempt.phones.filter((number) => number.canText);
    // An option number is a list position counted from one. Phones that cannot take an SMS keep
    // theirs, which is why the numbers offered can skip.
    const offered = phones.map((number) => number.position + 1);
    if (chosenOption === undefined && phones.length > 1) {
      const open = await auth.snapshotOpen();
      await opts.store.savePending(open);
      stored = true;
      return {
        status: "phone-required",
        phones: phones.map((number) => ({ option: number.position + 1, label: number.label })),
        expiresInSeconds: secondsUntil(open.endsAt, clock()),
      };
    }
    if (chosenOption !== undefined && !offered.includes(chosenOption)) {
      throw new ClientError("BAD_PHONE_OPTION", "That phone option is not offered for this ID.");
    }
    const chosen = chosenOption === undefined ? phones[0]?.position : chosenOption - 1;
    await auth.sendCode(attempt.attemptId, chosen);
    const open = await auth.snapshotOpen();
    await opts.store.savePending(open);
    stored = true;
    const number = phones.find((candidate) => candidate.position === chosen);
    return {
      status: "sms-sent",
      phone: number?.shown ?? "",
      expiresInSeconds: secondsUntil(open.endsAt, clock()),
    };
  } catch (caught) {
    await auth.abandon().catch(() => {});
    // Only a challenge this call stored: an earlier one may still be waiting for its code.
    if (stored) await opts.store.deletePending().catch(() => {});
    throw caught;
  }
}

/** Finishes the open sign-in. The challenge is removed whether or not the code is accepted. */
export async function verifySignIn(opts: SignInOptions, codeText: string): Promise<{ status: "signed-in" }> {
  // Checked before the challenge is touched, so a mistyped code does not cost the member an SMS.
  if (!/^\d{6}$/.test(codeText)) throw new ClientError("BAD_CODE", "The SMS code is six digits.");
  const open = await opts.store.loadPending();
  if (!open) {
    throw new SignInError(
      "NOTHING_TO_VERIFY",
      "No sign-in is waiting for a code. Start one; it stays open for ten minutes.",
    );
  }
  if (open.checkToken === undefined) {
    throw new SignInError(
      "CHOOSE_A_PHONE",
      "No SMS was sent yet: start the sign-in again with one of the phone options.",
    );
  }
  const auth = newAuth(opts);
  try {
    auth.resume(open);
    const session = await auth.finish(open.attempt, codeText);
    // The member that signed in must be the ID the challenge was opened for.
    const opened = await openMember({ session, owner: { memberId: open.member, memberIdCode: "0" } }, opts.fetch);
    if (opts.signal?.aborted) throw new ClientError("REQUEST_CANCELLED", "The sign-in was abandoned.");
    await opts.store.save({ session: await opened.snapshot(), owner: opened.member.owner });
    return { status: "signed-in" };
  } finally {
    await opts.store.deletePending().catch(() => {});
    await auth.abandon().catch(() => {});
  }
}

/**
 * When the session ends for good, read locally from the `F5_ST` cookie: five `z`-separated numbers,
 * the last two being the start and the lifetime in seconds. Only the resulting time is returned.
 */
function absoluteDeadline(session: PortalSession): string | undefined {
  const input = session.jar.cookies.find((crumb) => crumb.key === "F5_ST")?.value;
  const attrs = typeof input === "string" ? input.split("z") : [];
  if (attrs.length !== 5 || attrs.some((column) => !/^\d+$/.test(column))) return undefined;
  const deadline = new Date((Number(attrs[3]) + Number(attrs[4])) * 1000);
  return Number.isNaN(deadline.getTime()) ? undefined : deadline.toISOString();
}

/** Local state only: no request is made. */
export async function signInState(opts: SignInOptions): Promise<SignInState> {
  const clock = opts.now ?? Date.now;
  const saved = await opts.store.load();
  if (saved) {
    const expiresAt = absoluteDeadline(saved.session);
    if (expiresAt !== undefined && Date.parse(expiresAt) <= clock()) return { status: "expired", expiresAt };
    return { status: "signed-in", ...(expiresAt ? { expiresAt } : {}) };
  }
  const open = await opts.store.loadPending();
  if (!open) return { status: "signed-out" };
  return {
    status: "pending-login",
    smsSent: open.checkToken !== undefined,
    expiresInSeconds: secondsUntil(open.endsAt, clock()),
  };
}

/** Deletes the local credentials. Nothing is revoked at Maccabi. */
export async function signOut(opts: SignInOptions): Promise<{ status: "signed-out" }> {
  await opts.store.delete();
  await opts.store.deletePending();
  return { status: "signed-out" };
}
