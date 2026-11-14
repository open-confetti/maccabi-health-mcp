import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SessionEnded } from "../maccabi/faults";
import type { Fetch } from "../maccabi/http";
import type { SessionStore } from "./files";
import { openMember } from "./sign-in";

/**
 * Maccabi ends an idle session after a few minutes and every session an hour after sign-in. Renewal
 * holds off the first; nothing extends the second.
 */
export const KEEP_ALIVE_EVERY_MS = 240_000;
const ABSOLUTE_LIFETIME_MS = 60 * 60_000;
/** A dropped connection should not end renewal; three failures in a row will not fix themselves. */
const FAILURE_LIMIT = 3;

export type Renewal = "renewed" | "signed-out" | "expired";

/**
 * One renewal of the stored session. The refreshed cookies are saved only while a session is still
 * stored, so a renewal that overlaps a sign-out cannot bring the session back.
 */
export async function renewOnce(store: SessionStore, fetch?: Fetch, signedInAt?: string): Promise<Renewal> {
  const saved = await store.load();
  // A different sign-in time means a newer sign-in replaced the session this renewal was started for.
  if (!saved || (signedInAt !== undefined && saved.session.signedInAt !== signedInAt)) return "signed-out";
  try {
    const opened = await openMember(saved, fetch);
    await opened.member.account.renew();
    const retained = await store.refresh({ session: await opened.snapshot(), owner: saved.owner });
    return retained ? "renewed" : "signed-out";
  } catch (caught) {
    // Nothing is deleted here. The next read finds the session ended, says so and removes it.
    if (caught instanceof SessionEnded) return "expired";
    throw caught;
  }
}

/**
 * A renewal to call on a timer for as long as a process lives. A session Maccabi has ended is not
 * renewed again, so an idle server does not keep sending dead cookies; a later sign-in is renewed.
 */
export function createRenewer(store: SessionStore, fetch?: Fetch): () => Promise<void> {
  let ended: string | undefined;
  return async () => {
    const signedInAt = (await store.load())?.session.signedInAt;
    if (signedInAt === undefined || signedInAt === ended) return;
    if ((await renewOnce(store, fetch, signedInAt)) === "expired") ended = signedInAt;
  };
}

export interface KeepAliveSummary {
  status: "signed-out" | "expired" | "lifetime-reached" | "failed" | "interrupted";
  renewals: number;
}

/** Renews until the session is gone or replaced, the hour is up, or the signal fires. */
export async function holdSession(
  store: SessionStore,
  abort: AbortSignal,
  opts: { fetch?: Fetch; intervalMs?: number; lifetimeMs?: number } = {},
): Promise<KeepAliveSummary> {
  const deadline = Date.now() + (opts.lifetimeMs ?? ABSOLUTE_LIFETIME_MS);
  const signedInAt = (await store.load())?.session.signedInAt;
  let renewals = 0;
  let failures = 0;
  while (!abort.aborted) {
    if (Date.now() >= deadline) return { status: "lifetime-reached", renewals };
    try {
      const outcome = await renewOnce(store, opts.fetch, signedInAt);
      if (outcome !== "renewed") return { status: outcome, renewals };
      renewals += 1;
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= FAILURE_LIMIT) return { status: "failed", renewals };
    }
    try {
      await sleep(opts.intervalMs ?? KEEP_ALIVE_EVERY_MS, undefined, { signal: abort });
    } catch {
      break;
    }
  }
  return { status: "interrupted", renewals };
}

const SECRET_NAME = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION|^MACCABI_(ID|OTP)$/i;

/**
 * The environment for the detached renewal process: everything except what looks like a secret. It
 * lives for an hour, and a secret it never received cannot be read from its process entry.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const retained: NodeJS.ProcessEnv = {};
  for (const label_ of Object.keys(env)) {
    if (!SECRET_NAME.test(label_)) retained[label_] = env[label_];
  }
  return retained;
}

/**
 * Starts `keep-alive` as a detached process, so renewal continues after a CLI command returns. The
 * child is always this Node binary running this same file, and it stops by itself once the session
 * is signed out or expired.
 */
export function startDetachedKeepAlive(env: NodeJS.ProcessEnv = process.env): boolean {
  const script = process.argv[1];
  if (!script) return false;
  const child = spawn(process.execPath, [resolve(script), "keep-alive"], {
    detached: true,
    stdio: "ignore",
    env: withoutSecrets(env),
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  return child.pid !== undefined;
}
