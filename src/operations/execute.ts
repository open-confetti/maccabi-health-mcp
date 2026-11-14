import type * as z from "zod/v4";
import { SessionEnded } from "../maccabi/faults";
import type { Fetch } from "../maccabi/http";
import type { Member } from "../maccabi/member";
import { ProviderDirectory } from "../maccabi/provider-directory";
import { redact } from "../maccabi/redact";
import type { SavedSession, SessionStore } from "../session/files";
import { openMember } from "../session/sign-in";
import type { FileOutput, FileType, Operation, Sources } from "./define";
import { Failure, toFailure } from "./failure";
import { findOperation } from "./index";

/** The answer to a name that is not a read. `where` is the surface's own pointer to its index of names. */
export function noSuchRead(noun: "command" | "operation", where: string): Failure {
  return new Failure("BAD_INPUT", `There is no such ${noun}. ${where}`, "usage");
}

/** What an operation needs from the process it runs in. */
export interface Runtime {
  store: SessionStore;
  /** Replaces the global fetch. Only tests set it. */
  fetch?: Fetch;
  /** A note for the person at the keyboard that is not part of the result. */
  warn(notice: string): void;
}

export type Outcome =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "file"; bytes: Uint8Array; mimeType: FileType; details: Record<string, unknown> };

export interface ExecuteOptions {
  /** Rows returned from a pageable list when the caller gave no `limit`. Unlimited when absent. */
  defaultLimit?: number;
  /** Fires when the caller has stopped waiting. Work that finishes afterwards no longer touches the session. */
  signal?: AbortSignal;
}

function describeIssue(issue: z.core.$ZodIssue, label: Operation): string {
  // Only the argument's own name: deeper path segments can be keys the caller typed.
  const where =
    typeof issue.path[0] === "string" && Object.hasOwn(label.input.shape, issue.path[0]) ? issue.path[0] : "";
  // The accepted names are listed instead of the rejected one: an error never repeats caller input.
  if (issue.code === "unrecognized_keys") {
    const accepted = Object.keys(label.input.shape);
    return accepted.length > 0
      ? `Unknown argument. It takes: ${accepted.join(", ")}.`
      : "Unknown argument. It takes no arguments.";
  }
  const notice = /[.!?]$/.test(issue.message) ? issue.message : `${issue.message}.`;
  return where ? `${where}: ${notice}` : notice;
}

/** Validates caller input against the operation's schema. Nothing has been loaded or requested yet. */
export function parseInput(label: Operation, asSent: unknown): Record<string, unknown> {
  const tree = label.input.safeParse(asSent ?? {});
  if (tree.success) return tree.data;
  const problems = tree.error.issues.map((issue) => describeIssue(issue, label)).join(" ");
  throw new Failure("BAD_INPUT", `${problems} See the help of \`${label.name}\`.`, "usage");
}

interface Page {
  offset: number;
  returned: number;
  /** Rows in the response Maccabi sent for this call. Not a total of the member's history. */
  available: number;
  nextOffset: number | null;
}

/** Slices the row array of a fetched list in place of the full one, and says what was left out. */
function paginate(outcome: unknown, where: string, offset: number, limit: number): Record<string, unknown> {
  const names = where.split(".");
  const clone = structuredClone(outcome) as Record<string, unknown>;
  let holder: Record<string, unknown> = clone;
  for (const prop of names.slice(0, -1)) holder = holder[prop] as Record<string, unknown>;
  const last = names[names.length - 1] as string;
  const entries = holder[last];
  if (!Array.isArray(entries)) return clone;
  const chosen = entries.slice(offset, offset + limit);
  holder[last] = chosen;
  const end = offset + chosen.length;
  const pageNo: Page = {
    offset,
    returned: chosen.length,
    available: entries.length,
    nextOffset: end < entries.length ? end : null,
  };
  return { ...clone, page: pageNo };
}

/**
 * Runs one operation end to end, the same way for every surface: validate the input, open the saved
 * session if the operation needs the account, run it, store the cookies the portal refreshed, and
 * strip identity and credential fields from the result. Every failure leaves as a `Failure`.
 */
export async function execute(
  runtime: Runtime,
  label_: string,
  rawInput: unknown,
  opts: ExecuteOptions = {},
): Promise<Outcome> {
  const label = findOperation(label_);
  if (!label) throw noSuchRead("operation", "`maccabi_help` lists them all.");
  const given = parseInput(label, rawInput);

  let saved: SavedSession | null = null;
  let opened: Awaited<ReturnType<typeof openMember>> | undefined;
  const sources: Sources = {
    async member(): Promise<Member> {
      if (!opened) {
        saved = await runtime.store.load();
        if (!saved) throw new Failure("SIGN_IN_NEEDED", "No one is signed in. Sign in, then retry.", "auth");
        opened = await openMember(saved, runtime.fetch);
      }
      return opened.member;
    },
    directory: () => new ProviderDirectory(runtime.fetch ? { fetch: runtime.fetch } : {}),
  };

  const stillWanted = (): boolean => opts.signal?.aborted !== true;
  /** Stores the cookies the portal rotated during this call, whether or not the call succeeded. */
  const keepCookies = async (): Promise<void> => {
    if (!opened || !stillWanted()) return;
    try {
      await runtime.store.refresh({ session: await opened.snapshot(), owner: opened.member.owner });
    } catch {
      runtime.warn("The refreshed session could not be saved; the next call may need a new sign-in.");
    }
  };

  let outcome: unknown;
  try {
    if (label.access === "member") await sources.member();
    outcome = await label.run(sources, given as never);
  } catch (caught) {
    if (caught instanceof SessionEnded && label.access === "member") {
      // The session is dead upstream and the transport has already dropped its cookies; keeping the
      // file would only make every later call rediscover that. A newer sign-in is left alone.
      if (saved && stillWanted()) await runtime.store.forget(saved).catch(() => {});
      throw new Failure(
        "SIGN_IN_NEEDED",
        "Maccabi ended the session, so it was removed. Sign in again, then retry.",
        "auth",
      );
    }
    await keepCookies();
    // The failure is worded for what the caller asked for. Behind `portal` and `portal-document` that
    // is a catalog entry, whose name also selects the known issue of a transport-level error.
    const throughCatalog = label.name === "portal" || label.name === "portal-document";
    throw toFailure(
      caught,
      throughCatalog ? undefined : label.name,
      throughCatalog ? String(given.endpoint) : undefined,
    );
  }
  await keepCookies();

  if (label.returns === "file") {
    const file = outcome as FileOutput;
    return {
      kind: "file",
      bytes: file.bytes,
      mimeType: file.mimeType,
      details: redact({ ...file.details, mimeType: file.mimeType, bytes: file.bytes.byteLength }) as Record<
        string,
        unknown
      >,
    };
  }

  const limit = (given.limit as number | undefined) ?? (label.rows ? opts.defaultLimit : undefined);
  const offset = (given.offset as number | undefined) ?? 0;
  const wantsPage = limit !== undefined || given.offset !== undefined;
  const paged =
    label.rows && wantsPage ? paginate(outcome, label.rows, offset, limit ?? Number.POSITIVE_INFINITY) : outcome;
  return { kind: "json", value: redact(paged) as Record<string, unknown> };
}
