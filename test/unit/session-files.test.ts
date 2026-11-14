/**
 * What happens to the session file in situations no subprocess can be steered into: several writers at
 * the same moment, a write that goes wrong, and work that comes to an end when the session it began
 * with has been signed out of or signed in over. The file's modes, damaged files and the choice of
 * directory run through the bundle, in test/integration/session.test.ts.
 */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type SavedSession, SessionStore, StorageFault } from "../../src/session/files";

const FILE = "signed-in.json";
const emptyJar = {
  cookies: [],
  rejectPublicSuffixes: true,
  storeType: "MemoryCookieStore",
  version: "tough-cookie@6.0.2",
};
/** The session of a sign-in at `minute` past an arbitrary hour, owned by `memberId`. */
function sessionFrom(minute: number, memberId = 40718293): SavedSession {
  const signedInAt = new Date(Date.UTC(2001, 0, 1, 12, minute)).toISOString();
  return {
    owner: { memberIdCode: "0", memberId },
    session: { bearer: "Bearer mock.session.jwt", jar: emptyJar, signedInAt, format: 1 },
  };
}
const earlier = sessionFrom(0);
const later = sessionFrom(30);

const parents: string[] = [];
afterEach(async () => {
  await Promise.all(parents.splice(0).map((parent) => fs.rm(parent, { force: true, recursive: true })));
});

/** A store over a directory that does not exist yet and that no other test knows of. */
async function emptyStore() {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "maccabi-store-"));
  parents.push(parent);
  const directory = path.join(parent, "maccabi-health");
  return { directory, store: new SessionStore(directory), files: () => fs.readdir(directory) };
}
/** A store that already holds `session`. */
async function storeHolding(session: SavedSession) {
  const holding = await emptyStore();
  await holding.store.save(session);
  return holding;
}

describe("writing the session file", () => {
  test("five saves at the same moment all go through, and what is left is one whole session and no other file", async () => {
    const { directory, store, files } = await emptyStore();
    const owners = Array.from({ length: 5 }, (_, writer) => 20_000_001 + writer);

    await Promise.all(owners.map((owner) => store.save(sessionFrom(0, owner))));

    expect(await files()).toEqual([FILE]);
    const { owner, session }: SavedSession = JSON.parse(await fs.readFile(path.join(directory, FILE), "utf8"));
    expect(session).toEqual(earlier.session);
    expect(owners).toContain(owner.memberId);
  });

  test("a save that cannot be completed keeps the session that was there and leaves no temporary file behind", async () => {
    const { store, files } = await storeHolding(earlier);
    // JSON has no way to write a BigInt, so serialising this fails.
    const unwritable = { ...earlier, owner: { ...earlier.owner, memberId: 1n } } as unknown as SavedSession;

    const failure = await store.save(unwritable).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StorageFault);
    const [stored, left] = await Promise.all([store.load(), files()]);
    expect(stored).toEqual(earlier);
    expect(left).toEqual([FILE]);
  });
});

describe("work that finishes when its session is no longer the stored one", () => {
  test("a refresh after the session was deleted does not put it back", async () => {
    const { store, files } = await storeHolding(earlier);
    await store.delete();

    const refreshed = await store.refresh(earlier);

    expect(refreshed).toBe(false);
    expect(await files()).toEqual([]);
  });

  test("a refresh after a later sign-in does not write over it", async () => {
    const { store } = await storeHolding(later);

    const refreshed = await store.refresh(earlier);

    const stored = await store.load();
    expect({ refreshed, stored }).toEqual({ refreshed: false, stored: later });
  });

  test("forgetting the earlier session does not remove a later sign-in", async () => {
    const { store } = await storeHolding(later);

    await store.forget(earlier);

    const stored = await store.load();
    expect(stored).toEqual(later);
  });
});
