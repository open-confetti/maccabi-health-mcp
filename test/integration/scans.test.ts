/**
 * Imaging reads, driven through the built bundle (its MCP server, and its CLI where a file or a saved
 * session matters) with the fake MedDream viewer of test/fake/records.mjs behind it.
 *
 * Reaching the viewer takes eight requests: the portal mints a token for one study, the sign-in host
 * turns it into a SAML form, the viewer host's own F5 takes that form and asks for a second leg, a
 * redirect then carries the HIS token, the viewer's shell page hands out a CSRF token, and `/his`
 * finally authenticates. After that come the study tree, the DICOM metadata of an image, its JPEG
 * thumbnail, and its raw pixels with the numbers needed to read them.
 *
 * What may come out: the scan, and the accession number. What may not: the patient's name, id and
 * birth date, the labels the viewer draws, the patient group of DICOM tags, a clinician's
 * identification code, the member's checksum, or anything the handoff used as a credential. The UIDs
 * sit under a made-up 2.25 root, and the patient is made up as well.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error a plain ES module, without type declarations
import { IMAGING } from "../fake/records.mjs";
import { answerWith, bootstrap, MEMBER, memberSession, merge, type Route } from "../rig";

const { cookies } = IMAGING;
/** Everything the fake viewer knows that no output may repeat. */
const WITHHELD: string[] = [
  ...[IMAGING.patientName, IMAGING.patientId, IMAGING.birthDate, IMAGING.clinicianId],
  ...[IMAGING.checksum, IMAGING.handoff, IMAGING.assertion, IMAGING.his, IMAGING.csrf],
  ...Object.values<string>(cookies),
  "MEDDREAMSESSID",
];
const session = memberSession("imaging", WITHHELD, "imaging");
const { box, ok, fails, file, run, expired, count: countOf } = session;

const PORTAL = "https://online.maccabi4u.co.il";
const SIGN_IN = "https://mac.maccabi4u.co.il";
const VIEWER = "https://meddreamy.maccabi4u.co.il";
const UID_ROOT = "2.25.7391";
const MIB = 1024 * 1024;
const ACS = "/saml/sp/profile/post/acs";
const MINT = "/meddream/token/";
const AUTHENTICATE = "/his?";
const STRUCTURE = "/structure";
const METADATA = `/images/${IMAGING.sop}/metadata`;
const THUMBNAIL = `/images/${IMAGING.sop}/thumbnail`;
const PIXELS = `/images/${IMAGING.sop}/pixels`;

const theStudy = { study_uid: IMAGING.study };
const theImage = { image_uid: IMAGING.sop, series_uid: IMAGING.series, ...theStudy };
const imageFlags = ["--image-uid", IMAGING.sop, "--series-uid", IMAGING.series, "--study-uid", IMAGING.study];
/** The frame the fake serves: 5 rows of 7 one-byte samples. */
const FRAME_BYTES = 35;

/** A second, CLI-side sign-in, for what only a separate process or a saved file can show. */
const CLI = { scenario: "imaging", config: "imaging-by-cli" };
function cli(...args: string[]) {
  const done = box.cli(args, CLI);
  const printed = done.out + done.err;
  expect(WITHHELD.filter((secret) => printed.includes(secret))).toEqual([]);
  return done;
}
const binary = { "content-type": "application/octet-stream" };
const pixelsOf = (bytes: number): Route => ({
  headers: binary,
  base64: Buffer.alloc(bytes).toString("base64"),
  match: PIXELS,
});
const viewerRequests = () => box.log().filter((entry) => entry.kind === "viewer").length;
const read = async (operation: string, args: Record<string, unknown>, routes: Route[] = []) =>
  (await ok(operation, args, routes)).data;

beforeAll(async () => {
  await session.start();
  box.signIn(CLI);
});

describe("the way into the viewer", () => {
  it("takes the eight hops in order, with each host's cookies kept to that host", async () => {
    const earlier = box.fetches().length;
    const answer = await ok("scan", theStudy);
    expect(answer.source).toMatchObject({ service: "MedDream" });
    const requests = box.fetches().slice(earlier);

    const visited = requests.map(({ url }) => url.split("?")[0]).filter((url) => !url.endsWith("/token/full"));
    const testResults = `${PORTAL}/sonline/TestResultsAPI/webapi/mac`;
    expect(visited).toEqual([
      `${testResults}/v1/members/0/${MEMBER}/tests`,
      `${testResults}/pdf/members/0/${MEMBER}${MINT}${IMAGING.study}`,
      `${SIGN_IN}/imaging/login`,
      VIEWER + ACS,
      `${VIEWER}/my.policy`,
      VIEWER + ACS,
      `${VIEWER}/`,
      `${VIEWER}/`,
      `${VIEWER}/his`,
      `${VIEWER}/studies/${IMAGING.study}${STRUCTURE}`,
    ]);

    // The mint is a cookie-only request whose redirect is read, not followed.
    const mint = requests.find(({ url }) => url.includes(MINT));
    expect(mint).toMatchObject({ redirect: "manual", authorization: "" });
    expect(new URL(mint?.url).searchParams.get("checksum")).toBe(IMAGING.checksum);

    // The SAML form is posted on as it came; the second leg echoes the nonce of the policy page.
    const [saml, secondLeg] = requests.filter(({ url }) => url.endsWith(ACS));
    expect(Object.fromEntries(new URLSearchParams(saml?.body))).toMatchObject({ SAMLResponse: IMAGING.assertion });
    expect(secondLeg?.body).toBe(`dummy=${IMAGING.nonce}`);

    const tree = requests.at(-1);
    expect(new URL(tree?.url).searchParams.get("storageId")).toBe(IMAGING.storage);
    for (const cookie of [`MRHSession=${cookies.f5}`, `MEDDREAMSESSID=${cookies.app}`])
      expect(tree?.cookie).toContain(cookie);

    // Both hosts name their F5 cookie MRHSession; neither host may be sent the other's value.
    const viewerF5 = [cookies.f5Pending, cookies.f5];
    for (const { origin, cookie } of requests) {
      if (origin === VIEWER) expect(cookie).not.toContain("MOCKSESSIONCOOKIE");
      else expect(viewerF5.filter((value) => cookie.includes(value))).toEqual([]);
    }
  });

  it("returns the study tree", async () => {
    const tree = await read("scan", theStudy);
    expect(tree.series[0].instances).toHaveLength(2);
    expect(tree).toMatchObject({
      patientSex: "O",
      mainModality: "US",
      studyDate: "2001-01-01",
      studyDescription: "MOCK STUDY",
      studyInstanceUID: IMAGING.study,
    });
  });

  it("does not disturb the portal session", async () => {
    await ok("scan", theStudy);
    await ok("test-results");
  });

  it("is walked once for all the viewer reads of one call", async () => {
    const minted = countOf(MINT);
    const authenticated = countOf(AUTHENTICATE);
    await ok("scan-image", theImage);
    expect([countOf(MINT) - minted, countOf(AUTHENTICATE) - authenticated]).toEqual([1, 1]);
  });

  it("decodes the entities of a hidden form value before posting it on", async () => {
    const escaped = `<html><body><form method="POST"><input name="dummy" value="x&lt;y&amp;z&quot;w&#39;v"></form></body></html>`;
    await ok("scan", theStudy, [{ text: escaped, match: "/my.policy" }]);
    const secondLeg = box
      .fetches()
      .filter(({ url }) => url.endsWith(ACS))
      .at(-1);
    expect(Object.fromEntries(new URLSearchParams(secondLeg?.body))).toEqual({ dummy: `x<y&z"w'v` });
  });

  it("is not begun for a member who has no checksum", async () => {
    const minted = countOf(MINT);
    const withoutChecksum = bootstrap({ current_customer_info: { checksum_id: null } });
    await fails("scan", theStudy, [withoutChecksum], "NO_PORTAL_TOKEN");
    expect(countOf(MINT)).toBe(minted);
  });

  it.each<[string, Route]>([
    ["the sign-in page has no form", { text: "<html><body>nothing to submit</body></html>", match: "/imaging/login" }],
    [
      "the policy page has no nonce",
      { text: `<html><body><form method="POST"></form></body></html>`, match: "/my.policy" },
    ],
    [
      "the redirect to the shell carries no token",
      { headers: { location: "/?unrelated=1" }, status: 302, match: "=/" },
    ],
    ["the mint answers 200", { text: "", status: 200, match: MINT }],
    [
      "the mint redirects to the viewer itself",
      { headers: { location: `${VIEWER}/imaging/login` }, status: 302, match: MINT },
    ],
  ])("ends without a viewer session when %s", async (_when, hop) => {
    await fails("scan", theStudy, [hop], "NO_PORTAL_TOKEN");
  });

  it.each<[string, Route]>([
    ["the mint", { text: "", status: 500, match: MINT }],
    ["the sign-in page", { text: "", status: 502, match: "/imaging/login" }],
  ])("reports a server error from %s as an upstream failure", async (_hop, failing) => {
    await fails("scan", theStudy, [failing], "PORTAL_HTTP_ERROR");
  });

  describe("is refused when the viewer contradicts the request", () => {
    const another = `${UID_ROOT}.404`;
    const grants = (studyIds: unknown): Route => answerWith(AUTHENTICATE, { studyIds });

    it.each<[string, Route]>([
      ["authenticating for another study", grants([{ modality: "MR", storageId: IMAGING.storage, studyUid: another }])],
      ["authenticating for no list of studies", grants({})],
      [
        "naming a storage id with a space in it",
        grants([{ modality: "US", storageId: "not an id", studyUid: IMAGING.study }]),
      ],
      ["answering the authentication with a page", { text: "<html></html>", match: AUTHENTICATE }],
      ["returning the tree of another study", merge(STRUCTURE, { studyInstanceUID: another })],
      [
        "listing an image whose UID is a path",
        merge(STRUCTURE, { series: [{ instances: [{ sopInstanceUID: "a/../b" }], seriesInstanceUID: "2.25" }] }),
      ],
    ])("by %s", async (_how, contradiction) => {
      await fails("scan", theStudy, [contradiction], "UNEXPECTED_ANSWER");
    });
  });

  it.each([`${PORTAL}/my.policy`, `${SIGN_IN}/login?SAMLRequest=mock-request`])(
    "live: a mint redirected to the login page %s means the session ended",
    async (location) => {
      await expired("scan", theStudy, [{ headers: { location }, status: 302, match: MINT }]);
    },
  );

  it("live: leaves behind any viewer cookie it finds in a saved session", () => {
    // Saved viewer cookies would alter the gateway's answer to the assertion, so the handoff goes out without them.
    const saved = join(box.configDir(CLI.config), "signed-in.json");
    const state = JSON.parse(readFileSync(saved, "utf8"));
    const leftover = (key: string, path: string) => ({
      key,
      path,
      value: `leftover-${key}`,
      lastAccessed: "2026-08-30T00:00:00.000Z",
      creation: "2026-08-30T00:00:00.000Z",
      hostOnly: true,
      httpOnly: true,
      secure: true,
      domain: new URL(VIEWER).hostname,
    });
    state.session.jar.cookies.push(leftover("MEDDREAMSESSID", "/"), leftover("LastMRH_Session", "/saml"));
    writeFileSync(saved, JSON.stringify(state), { mode: 0o600 });

    const earlier = box.fetches().length;
    expect(cli("scan", "--study-uid", IMAGING.study).code).toBe(0);
    const toViewer = box
      .fetches()
      .slice(earlier)
      .filter(({ origin }) => origin === VIEWER);
    expect(toViewer).not.toHaveLength(0);
    expect(toViewer.filter(({ cookie }) => cookie.includes("leftover-"))).toEqual([]);
  });
});

describe("whose scan it is", () => {
  it("the studies are the imaging-study rows of the member's own list of tests", async () => {
    const answer = await ok("scans");
    expect(answer.source).toMatchObject({ completeness: "local-filtered-subset" });
    expect(answer.data).toEqual([expect.objectContaining({ request_id: IMAGING.study, type: "imaging_study" })]);
  });

  it("a study that list does not hold is refused before the viewer hears of it", async () => {
    const heard = viewerRequests();
    await fails("scan", { study_uid: `${UID_ROOT}.31337` }, [], "NOT_THE_MEMBERS", "id-unknown");
    expect(viewerRequests()).toBe(heard);
  });

  it("a study the list holds twice is refused", async () => {
    const [listed] = await read("scans", {});
    // Rows as the portal would send them: with the member's id, and without the field this tool adds.
    const copy = (doc_id: string) => ({
      ...listed,
      doc_id,
      has_document: undefined,
      member_id_code: 0,
      member_id: String(MEMBER),
    });
    const twice = answerWith(`/${MEMBER}/tests`, { tests: [copy("copy-1"), copy("copy-2")], categories: [] });
    await fails("scan", theStudy, [twice], "UNEXPECTED_ANSWER", "row-twice");
  });

  it.each<[string, Record<string, string>]>([
    ["series", { ...theImage, series_uid: `${UID_ROOT}.51` }],
    ["image", { ...theImage, image_uid: `${UID_ROOT}.52` }],
  ])("a %s that is not in the study's own tree is refused before anything is asked about it", async (_which, stray) => {
    const asked = countOf("/metadata");
    await fails("scan-image", stray, [], "NOT_THE_MEMBERS", "id-unknown");
    expect(countOf("/metadata")).toBe(asked);
  });

  it("an image the tree holds twice is refused", async () => {
    const same = { sopInstanceUID: IMAGING.sop };
    const twice = merge(STRUCTURE, {
      series: [{ instances: [same, same], modality: "US", seriesInstanceUID: IMAGING.series }],
    });
    await fails("scan-image", theImage, [twice], "UNEXPECTED_ANSWER", "row-twice");
  });
});

describe("what comes out", () => {
  it("of the study tree: the scan and the patient's sex, without the patient", async () => {
    const tree = await read("scan", theStudy);
    expect(Object.keys(tree).filter((key) => /^patient(?!Sex)/.test(key))).toEqual([]);
    expect(tree.patientSex).toBe("O");
    expect(tree.series).toEqual([expect.objectContaining({ seriesInstanceUID: IMAGING.series })]);
  });

  it("of an image's metadata: the accession number and the scan's tags, without the patient group or an identification code", async () => {
    const metadata = await read("scan-image", theImage);
    expect(metadata).toMatchObject({
      photometricInterpretation: "MONOCHROME2",
      rows: 5,
      accessionNumber: IMAGING.accession,
    });
    expect(Object.keys(metadata).filter((key) => ["viewPortLabels", "patientID"].includes(key))).toEqual([]);
    expect(metadata.attributes).toEqual({
      note: "הערה מדומה לסריקה",
      "00280002": "1",
      "00200010": IMAGING.accession,
      "00181000": "MOCK-SERIAL-0000",
      "00081090": "MOCK-MODEL",
      "00081010": "SUITE-B",
      "00080090": "REFERRER^SPECIMEN",
      "00080080": "SPECIMEN IMAGING CENTRE",
      "00080070": "SPECIMEN IMAGING LTD",
    });
    expect(cli("scan-image", ...imageFlags).json().data.attributes).toEqual(metadata.attributes);
  });

  it("of an image's metadata: nor a patient tag written with punctuation, nor a credential nested in a tag that stays", async () => {
    const sopClass = "1.2.840.10008.5.1.4.1.1.3.1";
    const attributes = {
      "00081140": [{ "00081150": sopClass, token: IMAGING.clinicianId }],
      "(0010,0020)": IMAGING.patientId,
    };
    const kept = (await read("scan-image", theImage, [merge(METADATA, { attributes })])).attributes;
    expect(kept["00081140"]).toEqual([{ "00081150": sopClass }]);
    expect("(0010,0020)" in kept).toBe(false);
  });

  it.each<[string, Route]>([
    ["describes another series", merge(METADATA, { seriesInstanceUID: `${UID_ROOT}.51` })],
    ["is typed as plain text", { headers: { "content-type": "text/plain" }, text: "{}", match: METADATA }],
    ["is not JSON", { headers: { "content-type": "application/json" }, text: "{broken", match: METADATA }],
  ])("metadata that %s is refused", async (_how, answer) => {
    await fails("scan-image", theImage, [answer], "UNEXPECTED_ANSWER");
  });

  it("a viewer that fails on the metadata is an upstream failure", async () => {
    await fails("scan-image", theImage, [{ text: "", status: 500, match: METADATA }], "PORTAL_HTTP_ERROR");
  });
});

describe("an image's preview", () => {
  const jpeg = { "content-type": "image/jpeg" };

  it("comes back as image content: the JPEG the viewer served", async () => {
    const { content } = await run("scan-preview", theImage);
    const image = content?.find(({ type }) => type === "image");
    expect(image).toMatchObject({ mimeType: "image/jpeg" });
    expect(
      Buffer.from(image?.data as string, "base64")
        .subarray(0, 3)
        .toString("hex"),
    ).toBe("ffd8ff");
  });

  it.each<[string, Route]>([
    ["an error page", { text: "<html>no thumbnail</html>", match: THUMBNAIL }],
    [
      "a PNG typed as a JPEG",
      { headers: jpeg, base64: Buffer.from("89504e47", "hex").toString("base64"), match: THUMBNAIL },
    ],
    ["a JPEG cut off after its header", { headers: jpeg, base64: "/9j/", match: THUMBNAIL }],
  ])("is refused, and not passed on, when the viewer serves %s", async (_what, answer) => {
    await fails("scan-preview", theImage, [answer], "UNEXPECTED_ANSWER");
  });

  it("that the viewer does not have is an upstream failure", async () => {
    await fails("scan-preview", theImage, [{ text: "", status: 404, match: THUMBNAIL }], "PORTAL_HTTP_ERROR");
  });
});

describe("the raw pixels", () => {
  it("come with the geometry that makes them readable", async () => {
    const { geometry } = (await run("scan-pixels", theImage)).structuredContent;
    expect(geometry).toMatchObject({
      windowCenter: [120],
      transferSyntaxUID: "1.2.840.10008.1.2",
      expectedBytes: FRAME_BYTES,
      bytesPerFrame: FRAME_BYTES,
      numberOfFrames: 1,
      bitsAllocated: 8,
      samplesPerPixel: 1,
      columns: 7,
      rows: 5,
    });
    expect((await file("scan-pixels", theImage)).byteLength).toBe(FRAME_BYTES);
  });

  it("are written to a file by the CLI, which prints the geometry", () => {
    const report = cli("scan-pixels", ...imageFlags, "--out", "frame.raw").json();
    expect(report).toMatchObject({
      geometry: { expectedBytes: FRAME_BYTES, columns: 7, rows: 5 },
      bytes: FRAME_BYTES,
      status: "saved",
    });
  });

  it("take their geometry from the metadata, 16-bit and multi-frame included, not from the modality", async () => {
    // 6 rows x 4 columns x 1 sample x 2 bytes is 48 bytes a frame; there are 2 frames.
    const deep = merge(METADATA, { numberOfFrames: 2, bitsStored: 10, bitsAllocated: 16, columns: 4, rows: 6 });
    const { geometry } = (await run("scan-pixels", theImage, [deep, pixelsOf(96)])).structuredContent;
    expect(geometry).toMatchObject({ bitsStored: 10, expectedBytes: 96, bytesPerFrame: 48 });
  });

  it.each<[string, Route, string]>([
    ["one byte short of what the metadata implies", pixelsOf(FRAME_BYTES - 1), "UNEXPECTED_ANSWER"],
    ["typed as text", { ...pixelsOf(FRAME_BYTES), headers: { "content-type": "text/plain" } }, "UNEXPECTED_ANSWER"],
    ["a server error", { text: "", status: 500, match: PIXELS }, "PORTAL_HTTP_ERROR"],
  ])("are refused when the answer is %s", async (_what, answer, code) => {
    await fails("scan-pixels", theImage, [answer], code);
  });

  it("are not asked for when the metadata cannot describe a readable buffer", async () => {
    const asked = countOf(PIXELS);
    for (const unreadable of [{ bitsAllocated: 12 }, { bitsAllocated: 16, columns: 50_000, rows: 50_000 }]) {
      await fails("scan-pixels", theImage, [merge(METADATA, unreadable)], "NOT_OFFERED");
    }
    // The tree can report 0 frames for an image; that number here would make every size zero.
    await fails("scan-pixels", theImage, [merge(METADATA, { numberOfFrames: 0 })], "UNEXPECTED_ANSWER");
    expect(countOf(PIXELS)).toBe(asked);
  });

  describe("have a cap of their own, 16 MiB", () => {
    const frameOf = (rows: number, columns: number): Route[] => [
      merge(METADATA, { columns, rows }),
      { headers: binary, pad: rows * columns, base64: "", match: PIXELS },
    ];

    it("so a frame of real size, past the 2 MiB allowed to a PDF, comes back whole", async () => {
      const { content, structuredContent } = await run("scan-pixels", theImage, frameOf(1024, 3072));
      expect(structuredContent).toMatchObject({
        geometry: { expectedBytes: 3 * MIB, columns: 3072, rows: 1024 },
        mimeType: "application/octet-stream",
        bytes: 3 * MIB,
      });
      const resource = content?.find(({ type }) => type === "resource")?.resource;
      expect(Buffer.from(resource?.blob as string, "base64").byteLength).toBe(3 * MIB);
    });

    it("and one of 16.5 MiB is refused over MCP with the CLI command that can save it", async () => {
      const { message } = await fails("scan-pixels", theImage, frameOf(4224, 4096), "TOO_LARGE_TO_RETURN");
      for (const hint of ["--out FILE", "maccabi-health scan-pixels"]) expect(message).toContain(hint);
    });
  });
});

it("asked the fake for nothing it had to refuse", () => {
  expect(box.unexpected(), "refused requests and outbound sockets").toEqual([]);
});
