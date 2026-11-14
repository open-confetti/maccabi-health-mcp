/**
 * The MCP server from a client's side of the wire: the bundle's `mcp` command on stdio, spoken to by the
 * official client, with the fake Maccabi behind it. What it offers and how it describes itself, help that
 * works signed out, calls it refuses without running them, pages and the cap on a result's size, a
 * document as an embedded resource, what an error is allowed to say, calls kept apart from each other,
 * and a channel that carries nothing but the protocol. session.test.ts has the sign-in tools.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, test } from "vitest";
import { OPERATION_GROUPS, OPERATIONS } from "../../src/operations/index";
import { answerWith, call, carriesNone, ROOT, type Route, sandbox, type ToolResult } from "../rig";

const box = sandbox("mcp");
/** The two config directories of this file: one that a sign-in fills once, one that stays empty. */
const WITH_SESSION = "has-session";
const NO_SESSION = "no-session";
beforeAll(() => box.signIn({ config: WITH_SESSION }));

type Args = Record<string, unknown>;
const read = (client: Client, operation: string, args?: Args) =>
  call(client, "maccabi_read", args ? { operation, arguments: args } : { operation });
/** The error of a result that has to be one. */
function errorOf(result: ToolResult) {
  expect(result.isError).toBe(true);
  return result.structuredContent.error;
}
const requestsSoFar = () => box.fetches().length;
const namesOf = (items: readonly { name: string }[]) => items.map(({ name }) => name);

/** A text no error may give back: the tests put it into arguments and into upstream answers. */
const PRIVATE = "mock-private-text";

describe("what a client is offered", () => {
  const TOOLS = ["help", "login_start", "login_verify", "logout", "read", "status"].map((tool) => `maccabi_${tool}`);
  let client: Client;
  let tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
  beforeAll(async () => {
    client = await box.mcp({ config: NO_SESSION });
    ({ tools } = await client.listTools());
  });

  test("six tools, of which the three that only read say so and logout alone calls itself destructive", () => {
    const hints = (
      readOnlyHint: boolean,
      idempotentHint: boolean,
      openWorldHint: boolean,
      destructiveHint = false,
    ) => ({
      readOnlyHint,
      idempotentHint,
      openWorldHint,
      destructiveHint,
    });
    expect(Object.fromEntries(tools.map(({ name, annotations }) => [name, annotations]))).toEqual({
      maccabi_help: hints(true, true, false),
      maccabi_status: hints(true, true, false),
      maccabi_read: hints(true, true, true),
      maccabi_login_start: hints(false, false, true),
      maccabi_login_verify: hints(false, false, true),
      maccabi_logout: hints(false, true, false, true),
    });
  });

  test("no tool accepts an argument it does not declare, and no tool declares one for a member", () => {
    for (const { name, inputSchema } of tools) {
      expect(JSON.stringify(inputSchema), name).not.toContain("member_id");
      expect(inputSchema.additionalProperties, name).toBe(false);
    }
  });

  test("maccabi_read describes itself with a line for each operation that carries the operation's summary", () => {
    const description = tools.find(({ name }) => name === "maccabi_read")?.description ?? "";
    for (const { name, summary } of OPERATIONS) {
      expect(description, name).toContain(summary);
      expect(description, name).toMatch(new RegExp(`^- ${name}[ :]`, "m"));
    }
  });

  test("the instructions and the descriptions refer to no tool that does not exist", () => {
    const prose = [client.getInstructions(), ...tools.map(({ description }) => description)].join("\n");
    const referredTo = [...new Set(prose.match(/maccabi_[a-z_]+/g))];
    expect(referredTo).toContain("maccabi_login_start");
    expect(referredTo.filter((tool) => !TOOLS.includes(tool))).toEqual([]);
  });

  test("the instructions call the server read-only and tell the client not to retry on SIGN_IN_NEEDED", () => {
    const instructions = client.getInstructions();
    for (const said of ["Read-only", "On SIGN_IN_NEEDED, do not retry"]) expect(instructions).toContain(said);
  });
});

describe("maccabi_help, which works signed out and asks Maccabi nothing", () => {
  let client: Client;
  let requestsBefore = 0;
  const help = async (args?: Args) => (await call(client, "maccabi_help", args)).structuredContent;
  beforeAll(async () => {
    client = await box.mcp({ config: NO_SESSION });
    requestsBefore = requestsSoFar();
  });

  test("given nothing, covers all the operations under their categories", async () => {
    const { categories } = await help();
    expect(categories.map(({ category }: any) => category)).toEqual(Object.keys(OPERATION_GROUPS));
    const covered = categories.flatMap(({ operations }: any) => namesOf(operations));
    expect(covered.sort()).toEqual(namesOf(OPERATIONS).sort());
  });

  test("given a category, covers the operations of that category and no other", async () => {
    const { categories } = await help({ category: "billing" });
    expect(categories).toHaveLength(1);
    expect(categories[0].category).toBe("billing");
    const billing = OPERATIONS.filter(({ category }) => category === "billing");
    expect(namesOf(categories[0].operations)).toEqual(namesOf(billing));
  });

  test("given an operation, says what kind it is, what it returns and which arguments it takes", async () => {
    const labResult = await help({ operation: "lab-values" });
    expect(labResult).toMatchObject({ returns: "json", access: "member", category: "medical", name: "lab-values" });
    const required = labResult.arguments.filter((argument: any) => argument.required);
    expect(namesOf(required)).toEqual(["request_id", "doc_id"]);
    expect(labResult.arguments).toHaveLength(2);
  });

  test("left no request behind, and no config directory", () => {
    expect(fs.existsSync(box.configDir(NO_SESSION))).toBe(false);
    expect(requestsSoFar()).toBe(requestsBefore);
  });
});

describe("a call that cannot be run comes back as an error result, with the protocol intact and Maccabi not asked", () => {
  let client: Client;
  let requestsBefore = 0;
  beforeAll(async () => {
    client = await box.mcp({ config: WITH_SESSION });
    requestsBefore = requestsSoFar();
  });

  test("an operation that does not exist is BAD_INPUT", async () => {
    expect(errorOf(await read(client, "not-an-operation")).code).toBe("BAD_INPUT");
  });

  test("an argument the operation does not have is BAD_INPUT; the answer lists the ones it has and omits the one sent", async () => {
    const error = errorOf(await read(client, "test-results", { nonsense: PRIVATE }));
    expect(error).toEqual({
      message: expect.stringContaining("Unknown argument. It takes: year, limit, offset."),
      code: "BAD_INPUT",
      cause: "caller",
      retry: "after-fixing-input",
    });
  });

  test.each<[string, string, Args]>([
    ["a text where a number belongs", "test-results", { year: PRIVATE }],
    ["a text where a date belongs", "certificates", { to: "2026-01-01", from: PRIVATE }],
    ["a limit beyond the largest allowed", "clinic-visits", { limit: 1001 }],
  ])("%s is BAD_INPUT, and the answer points to the help without quoting the value", async (_what, operation, args) => {
    const refused = await read(client, operation, args);
    const { code, message } = errorOf(refused);
    expect(message).toContain(`See the help of \`${operation}\`.`);
    expect(code).toBe("BAD_INPUT");
    carriesNone(refused, [PRIVATE]);
  });

  test("an operation's argument put next to `operation`, outside `arguments`, is refused", async () => {
    const refused = await call(client, "maccabi_read", { year: 2026, operation: "test-results" });
    expect(refused.isError).toBe(true);
  });

  test("Maccabi heard of none of these", () => {
    expect(requestsSoFar()).toBe(requestsBefore);
  });
});

describe("reading the account with no session", () => {
  test("is SIGN_IN_NEEDED with both ways of signing in named, and sends nothing", async () => {
    const client = await box.mcp({ config: NO_SESSION });
    const requestsBefore = requestsSoFar();
    const { code, message } = errorOf(await read(client, "test-results"));
    expect(code).toBe("SIGN_IN_NEEDED");
    for (const way of ["`maccabi-health login`", "maccabi_login_start and maccabi_login_verify"]) {
      expect(message).toContain(way);
    }
    expect(requestsSoFar()).toBe(requestsBefore);
  });
});

describe("reading the account through a server that is signed in", () => {
  let client: Client;
  beforeAll(async () => {
    client = await box.mcp({ config: WITH_SESSION });
  });
  /** One operation, run after telling the fake how Maccabi answers this time. */
  function readGiven(routes: Route[], operation: string, args?: Args) {
    box.override({ routes });
    return read(client, operation, args);
  }
  /** The same for a read that has to succeed. Returns its structured content. */
  async function dataGiven(routes: Route[], operation: string, args?: Args) {
    const result = await readGiven(routes, operation, args);
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  }
  /** Maccabi's list of past visits with `rows` rows, each of which carries `filler`. */
  function visitList(rows: number, filler = "mock"): Route {
    const visit = (number: number) => ({
      appointment_id: `visit-${number}`,
      appointment_date: "2026-02-03T09:15:00",
      has_summery_file: false,
      service_name: filler,
      service_provider_name: "mock",
    });
    return answerWith("/visits/history", { results: Array.from({ length: rows }, (_, index) => visit(index)) });
  }
  const idsOf = (rows: any[]) => rows.map((row) => row.appointment_id);

  test("the result comes twice, as structured content and as the same object in text", async () => {
    const result = await readGiven([], "clinic-visits");
    expect(result.isError).not.toBe(true);
    expect(idsOf(result.structuredContent.data)).toEqual(["encounter-41", "encounter-42"]);
    const [text] = result.content ?? [];
    expect(JSON.parse(text?.text as string)).toEqual(result.structuredContent);
  });

  describe("a list of 25 rows", () => {
    const twentyFive = [visitList(25)];

    test("is returned 20 rows at a time unless a limit is given, with the offset of the next page", async () => {
      const { data, page } = await dataGiven(twentyFive, "clinic-visits");
      expect(page).toEqual({ available: 25, returned: 20, offset: 0, nextOffset: 20 });
      expect(data).toHaveLength(20);
    });

    test("ends on the page at that offset, which holds the other five rows", async () => {
      const { data, page } = await dataGiven(twentyFive, "clinic-visits", { offset: 20 });
      expect(page).toEqual({ available: 25, returned: 5, offset: 20, nextOffset: null });
      expect(idsOf(data)).toEqual([20, 21, 22, 23, 24].map((number) => `visit-${number}`));
    });
  });

  describe("a result of more than 128 KiB", () => {
    const twoHeavyRows = [visitList(2, "x".repeat(70_000))];

    test("is TOO_LARGE_TO_RETURN and is not cut down to fit", async () => {
      const refused = await readGiven(twoHeavyRows, "clinic-visits");
      const { code, message } = errorOf(refused);
      expect(code).toBe("TOO_LARGE_TO_RETURN");
      expect(message).toContain("`limit`");
      expect(JSON.stringify(refused).length).toBeLessThan(1_000);
    });

    test("comes back piece by piece once the limit is lowered as the error suggests", async () => {
      const { page } = await dataGiven(twoHeavyRows, "clinic-visits", { limit: 1 });
      expect(page).toEqual({ available: 2, returned: 1, offset: 0, nextOffset: 1 });
    });
  });

  test("a PDF is an embedded resource, as many bytes long as the result says", async () => {
    const result = await readGiven([], "referral-pdf", { id: "ref-1" });
    expect(result.isError).not.toBe(true);
    const embedded = result.content?.find(({ type }) => type === "resource")?.resource;
    expect(embedded?.mimeType).toBe("application/pdf");
    const pdf = Buffer.from(embedded?.blob as string, "base64");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const { retrievedAt, source, ...rest } = result.structuredContent;
    expect(rest).toEqual({ bytes: pdf.byteLength, mimeType: "application/pdf" });
    expect(source).toMatchObject({ operation: "referral-pdf" });
    expect(retrievedAt).toEqual(expect.any(String));
  });

  /** What Maccabi sends where the prescriptions list should be. */
  const notTheList: Route = { match: "/prescriptions", text: PRIVATE };
  const unknownIds = { doc_id: PRIVATE, request_id: PRIVATE };
  test.each<[string, Route[], string, Args, string]>([
    ["Maccabi answers with an HTTP error", [{ ...notTheList, status: 500 }], "prescriptions", {}, "PORTAL_HTTP_ERROR"],
    ["Maccabi answers with something that is not JSON", [notTheList], "prescriptions", {}, "UNEXPECTED_ANSWER"],
    ["the connection fails", [{ match: "/prescriptions", throw: "TypeError" }], "prescriptions", {}, "UNREACHABLE"],
    ["the ids are not ones of the member", [], "lab-values", unknownIds, "NOT_THE_MEMBERS"],
  ])(
    "when %s, the error is a code and a message, free of upstream text, URLs and argument values",
    async (_what, routes, operation, args, code) => {
      const failed = await readGiven(routes, operation, args);
      const { code: reported, message, detail, cause, retry, known_issue, ...unexpected } = errorOf(failed);
      expect(reported).toBe(code);
      expect(unexpected).toEqual({});
      carriesNone(failed, [PRIVATE, /https?:|maccabi4u/]);
    },
  );

  test("three calls sent at once are served in turn, so that no read's requests land among another's", async () => {
    box.override();
    const requestsBefore = requestsSoFar();
    const operations = ["prescriptions", "referrals", "clinic-visits"];
    for (const result of await Promise.all(operations.map((operation) => read(client, operation)))) {
      expect(result.isError).not.toBe(true);
    }
    const lastSegments = box
      .fetches()
      .slice(requestsBefore)
      .map(({ url }) => path.basename(new URL(url).pathname));
    // A read is the bootstrap and then its own request, so three reads kept apart are three such pairs.
    expect(lastSegments).toEqual(["full", "prescriptions", "full", "referrals", "full", "history"]);
  });
});

describe("the mcp command itself", () => {
  /**
   * Speaks to a server without the client library: sends the messages, waits until the one numbered
   * `finalId` is answered, closes the server's standard input and collects what it printed.
   */
  async function speak(config: string, messages: Record<string, unknown>[], finalId: number) {
    const preload = path.join(ROOT, "test", "fake", "maccabi.mjs");
    const server = spawn(process.execPath, ["--import", preload, box.bundle(), "mcp"], {
      stdio: "pipe",
      env: box.env({ config }),
      cwd: box.dir(),
    });
    try {
      const exit = new Promise<number | null>((resolve) => server.on("close", resolve));
      let printed = "";
      const allAnswered = new Promise<void>((resolve) => {
        server.stdout.on("data", (chunk) => {
          printed += chunk;
          if (printed.endsWith("\n") && printed.includes(`"id":${finalId}`)) resolve();
        });
      });
      for (const message of messages) server.stdin.write(`${JSON.stringify({ ...message, jsonrpc: "2.0" })}\n`);
      await allAnswered;
      server.stdin.end();
      return {
        exitCode: await exit,
        answers: printed
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      };
    } finally {
      server.kill();
    }
  }
  const toolCall = (id: number, name: string, args: Args = {}) => ({
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

  test("prints protocol messages on stdout and nothing else, and exits 0 once its stdin is closed", async () => {
    const hello = { clientInfo: { version: "1", name: "no-library" }, capabilities: {}, protocolVersion: "2025-06-18" };
    const conversation = [
      { id: 1, method: "initialize", params: hello },
      { method: "notifications/initialized" },
      toolCall(2, "maccabi_read", { operation: "clinic-visits" }),
      toolCall(3, "maccabi_status"),
    ];
    const { exitCode, answers } = await speak(WITH_SESSION, conversation, 3);
    expect(answers.map(({ id, jsonrpc }) => [id, jsonrpc])).toEqual([1, 2, 3].map((id) => [id, "2.0"]));
    const [, visits, status] = answers;
    expect(visits.result.structuredContent.data).toHaveLength(2);
    expect(status.result.structuredContent).toEqual({ status: "signed-in" });
    expect(exitCode).toBe(0);
  });

  test("has no options, so one that would have it listen is exit 2 and leaves stdout empty", () => {
    const { code, out, err } = box.cli(["mcp", "--port", "9000"], { config: NO_SESSION });
    expect(err).toContain("takes no options");
    expect(out).toBe("");
    expect(code).toBe(2);
  });
});

test("nothing in this file asked for a request the fake does not know, or for a socket", () => {
  expect(box.unexpected()).toEqual([]);
});
