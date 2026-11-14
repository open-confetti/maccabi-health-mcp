import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ClientError } from "../maccabi/faults";
import type { MemberKey } from "../maccabi/member";
import type { PortalSession } from "../maccabi/portal-session";
import type { OpenSignIn } from "../maccabi/sms-sign-in";

/** A signed-in session and the member it belongs to. Anyone who can read it can read the member's records. */
export interface SavedSession {
  session: PortalSession;
  owner: MemberKey;
}

/** Local storage failed. Kept apart from upstream errors so a broken directory is never reported as a failed read. */
export class StorageFault extends ClientError {
  constructor() {
    super("STORAGE_UNAVAILABLE", "The saved session could not be read or written.");
  }
}

const DIRECTORY_NAME = "maccabi-health";
const SESSION_FILE = "signed-in.json";
const ATTEMPT_FILE = "sign-in-attempt.json";
/** Permission bits: the owner alone, for the directory and for each file in it. */
const OWNER_DIRECTORY = 0o700;
const OWNER_FILE = 0o600;

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MACCABI_CONFIG_DIR) return env.MACCABI_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, DIRECTORY_NAME);
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, DIRECTORY_NAME);
  return join(homedir(), ".config", DIRECTORY_NAME);
}

/** POSIX permission bits mean nothing on Windows, where Node reports the same mode for every file. */
const HAS_FILE_MODES = process.platform !== "win32";

async function readPrivate(where: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(where, "r");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StorageFault();
  }
  try {
    // A credential left readable by others is repaired, not merely reported.
    if (HAS_FILE_MODES && (await file.stat()).mode & 0o077) await file.chmod(OWNER_FILE);
    return await file.readFile("utf8");
  } catch {
    throw new StorageFault();
  } finally {
    await file.close();
  }
}

/**
 * Replaces a credential file whole or not at all. The new content goes to a draft beside it, private
 * from its first byte, and the draft then takes the file's name.
 */
async function writePrivate(directory: string, where: string, input: unknown): Promise<void> {
  // Unique per call: two concurrent writes must never share, or clean up, each other's temporary file.
  const draft = `${where}.${randomUUID()}.tmp`;
  const put = async (): Promise<void> => {
    const body = JSON.stringify(input);
    await mkdir(directory, { recursive: true, mode: OWNER_DIRECTORY });
    // mkdir sets the mode only on a directory it creates. An existing one is narrowed only when it
    // is this tool's own by name, so a MACCABI_CONFIG_DIR pointed at a shared folder is left alone.
    const ours = HAS_FILE_MODES && basename(directory) === DIRECTORY_NAME;
    if (ours && (await stat(directory)).mode & 0o077) await chmod(directory, OWNER_DIRECTORY);
    // Exclusive creation: the draft is born private and can never be a file or link that was already there.
    const handle = await open(draft, "wx", OWNER_FILE);
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
    await rename(draft, where);
  };
  const written = await put().then(
    () => true,
    () => false,
  );
  if (written) return;
  // Whatever went wrong, no draft stays behind; one that was never created is not an error.
  await unlink(draft).catch(() => undefined);
  throw new StorageFault();
}

async function removePrivate(where: string): Promise<void> {
  try {
    await rm(where, { force: true });
  } catch {
    throw new StorageFault();
  }
}

function isSavedSession(input: unknown): input is SavedSession {
  const saved = input as Partial<SavedSession> | null;
  return (
    saved?.session?.format === 1 &&
    Array.isArray(saved.session.jar?.cookies) &&
    typeof saved.session.signedInAt === "string" &&
    Number.isSafeInteger(saved.owner?.memberId) &&
    typeof saved.owner?.memberIdCode === "string"
  );
}

function isOpenSignIn(input: unknown): input is OpenSignIn {
  const open = input as Partial<OpenSignIn> | null;
  return (
    open?.format === 1 &&
    typeof open.attempt === "string" &&
    typeof open.sendToken === "string" &&
    Number.isSafeInteger(open.member) &&
    Array.isArray(open.phones) &&
    Number.isFinite(open.endsAt) &&
    Array.isArray(open.jar?.cookies)
  );
}

function parse<T>(str: string, isValid: (input: unknown) => input is T): T {
  let input: unknown;
  try {
    input = JSON.parse(str);
  } catch {
    throw new ClientError("DAMAGED_SESSION", "A saved file is damaged.");
  }
  if (!isValid(input)) throw new ClientError("DAMAGED_SESSION", "A saved file is damaged.");
  return input;
}

/**
 * The two credential files of this tool, both mode 0600 inside a 0700 directory:
 * `signed-in.json` (the signed-in session) and `sign-in-attempt.json` (a sign-in waiting for its SMS code).
 * Both name the member by ID number, to tie the session to the person who signed in. The SMS code is
 * never stored.
 */
export class SessionStore {
  readonly #directory: string;
  readonly #session: string;
  readonly #pending: string;
  readonly #clock: () => number;

  constructor(directory: string = configDirectory(), clock: () => number = Date.now) {
    this.#directory = directory;
    this.#session = join(directory, SESSION_FILE);
    this.#pending = join(directory, ATTEMPT_FILE);
    this.#clock = clock;
  }

  /** Proves the directory can be written, so a sign-in does not spend an SMS it cannot save the result of. */
  async assertWritable(): Promise<void> {
    const probe = join(this.#directory, "write-check.json");
    await writePrivate(this.#directory, probe, {});
    await removePrivate(probe);
  }

  async load(): Promise<SavedSession | null> {
    const str = await readPrivate(this.#session);
    return str === null ? null : parse(str, isSavedSession);
  }

  async save(saved: SavedSession): Promise<void> {
    await writePrivate(this.#directory, this.#session, saved);
  }

  /**
   * Saves refreshed cookies only while the stored session is still the same sign-in. Work that
   * overlaps a sign-out cannot bring the session back, and work that overlaps a newer sign-in cannot
   * overwrite it.
   */
  async refresh(saved: SavedSession): Promise<boolean> {
    const stored = await this.load();
    if (stored?.session.signedInAt !== saved.session.signedInAt) return false;
    await this.save(saved);
    return true;
  }

  /** Removes the session, and any temporary copy an interrupted write left behind. */
  async delete(): Promise<void> {
    await removePrivate(this.#session);
    const names = await readdir(this.#directory).catch(() => [] as string[]);
    const isDraft = (label_: string): boolean =>
      label_.endsWith(".tmp") &&
      [SESSION_FILE, ATTEMPT_FILE].some((file) => label_.startsWith(`${file}.`) && label_.length > file.length + 5);
    for (const label_ of names) if (isDraft(label_)) await removePrivate(join(this.#directory, label_));
  }

  /** Removes the session only while it is still the given sign-in, so a newer one is never lost. */
  async forget(saved: SavedSession): Promise<void> {
    const stored = await this.load().catch(() => null);
    if (stored === null || stored.session.signedInAt === saved.session.signedInAt) await this.delete();
  }

  /** A pending sign-in past its deadline is deleted and reported as absent. */
  async loadPending(): Promise<OpenSignIn | null> {
    const str = await readPrivate(this.#pending);
    if (str === null) return null;
    const pending = parse(str, isOpenSignIn);
    if (this.#clock() < pending.endsAt) return pending;
    await this.deletePending();
    return null;
  }

  async savePending(pending: OpenSignIn): Promise<void> {
    await writePrivate(this.#directory, this.#pending, pending);
  }

  async deletePending(): Promise<void> {
    await removePrivate(this.#pending);
  }
}
