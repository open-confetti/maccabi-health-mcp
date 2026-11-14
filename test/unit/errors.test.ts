/**
 * Two ways an error could take something private out of the process, neither of which an answer from
 * upstream can set off: an exception nobody planned for, and a read error whose reason is free text
 * and not one of the client's fixed tokens. In both the text is swapped for something fixed.
 */
import { describe, expect, test } from "vitest";
import { ReadRefusal } from "../../src/maccabi/faults";
import { toFailure } from "../../src/operations/failure";

const PRIVATE = "PRIVATE-TEXT-b61e";

describe("a failure nobody planned for", () => {
  test.each([
    ["an error of a kind the tool does not throw", new TypeError(`no property ${PRIVATE}`)],
    ["a thrown value that is no error at all", { code: PRIVATE, message: PRIVATE }],
  ])("%s becomes TOOL_DEFECT with a fixed sentence for a message", (_what, thrown) => {
    const { code, message, detail } = toFailure(thrown);

    expect(code).toBe("TOOL_DEFECT");
    expect(`${message} ${detail}`).not.toContain(PRIVATE);
  });
});

describe("the reason given for a read error", () => {
  const readError = (code: "UNEXPECTED_ANSWER" | "PORTAL_HTTP_ERROR", status: number | undefined, reason: string) =>
    new ReadRefusal(code, "mock-read", status, reason);

  test.each([
    ["a URL", `https://online.invalid/pdf?sig=${PRIVATE}`],
    ["a path", `/private/${PRIVATE}.pdf`],
    ["words with a space between them", `two words ${PRIVATE}`],
    ["two lines", `${PRIVATE}\nand-another-line`],
    ["text outside ASCII", `סוד-${PRIVATE}`],
    ["a token one character over the 120 allowed", PRIVATE.padEnd(121, "x")],
  ])("is left out when it is %s, since only a short token of safe characters may stay", (_what, reason) => {
    expect(readError("UNEXPECTED_ANSWER", undefined, reason).detail).toBeUndefined();
  });

  test("when left out, is in neither the message nor the guidance, and the status still makes it into the detail", () => {
    const notFound = readError("PORTAL_HTTP_ERROR", 404, `https://x.invalid/${PRIVATE}`);

    for (const text of [notFound.guidance, notFound.message]) expect(text).not.toContain(PRIVATE);
    expect(notFound.detail).toBe("status=404");
  });
});
