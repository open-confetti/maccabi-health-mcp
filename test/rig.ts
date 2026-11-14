/**
 * What every integration test stands on. A test never imports the tool. It takes the built bundle
 * (`dist/maccabi-health.mjs`), puts a copy by itself into a fresh directory and runs it there with the
 * fake Maccabi of `test/fake/` loaded first through `--import`, which leaves the bundle's real transport,
 * cookie jar and origin allowlist in play. Whatever a command prints or an MCP call returns is searched
 * for the fake's credentials and the member's ID before the test gets to see it. No value is a real one.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, expect } from "vitest";
// @ts-expect-error the fake is plain JavaScript and has no type declarations
import { MARKERS } from "./fake/tags.mjs";

const BUNDLE_NAME = "maccabi-health.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake", "maccabi.mjs");
export const ROOT = path.resolve(HERE, "..");
export const BUNDLE = path.join(ROOT, "dist", BUNDLE_NAME);

/** The member the fake knows, as the number and as the ID a person types, and the SMS code it accepts. */
export const MEMBER = 40718293;
export const ID = String(MEMBER);
export const OTP = "904512";
/** A second member of the fake. A row that names this one belongs to somebody else. */
export const SOMEONE_ELSE = 60482715;
/** The page F5 answers with once a session has run out. */
export const LOGOUT_PAGE = "https://online.maccabi4u.co.il/my.logout.php3";
export const NEVER_PRINTED: string[] = [ID, ...(Object.values(MARKERS) as string[])];

type Fields = Record<string, unknown>;

/** A rule that replaces or alters one upstream answer. test/fake/maccabi.mjs documents each field. */
export interface Route {
  /** Which requests: part of the path and query, or the whole of it after a leading "=". */
  match: string;
  method?: string;
  after?: number;
  times?: number;
  /** What the answer looks like from outside. */
  status?: number;
  url?: string;
  headers?: Record<string, string>;
  /** Its body, when the fake's own is not wanted. */
  json?: unknown;
  merge?: Fields;
  text?: string;
  empty?: boolean;
  base64?: string;
  pad?: number;
  /** A failure in place of an answer. */
  throw?: string;
  streamError?: string;
  /** Any text. It keeps two otherwise equal rules apart, so that each counts its own `after` and `times`. */
  case?: string;
}
export interface Overrides {
  routes?: Route[];
  scenario?: string;
}
export interface RunOptions {
  /** The name of the config directory inside the sandbox. */
  config?: string;
  /** The fake's scenario for this run, passed as FAKE_MACCABI_SCENARIO. */
  scenario?: string;
  overrides?: Overrides;
  /** Whether the fake is loaded, which it is unless this says no. A bundle without it reaches nothing. */
  fake?: boolean;
  /** What the command reads from its standard input. */
  input?: string;
  env?: Record<string, string>;
}
export interface CliResult {
  out: string;
  err: string;
  code: number | null;
  error(): { code: string; message: string; detail?: string };
  json(): any;
}
type ContentPart = {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  resource?: { mimeType?: string; blob?: string };
};
export interface ToolResult {
  content?: ContentPart[];
  structuredContent?: any;
  isError?: boolean;
}

/** A rule that answers the matching request with `body` as JSON. */
export function answerWith(match: string, body: unknown, more: Partial<Route> = {}): Route {
  return { match, json: body, ...more };
}
/** A rule that lays `patch` over the JSON the fake would have answered. */
export function merge(match: string, patch: Fields): Route {
  return { match, merge: patch };
}
/** The same for the account bootstrap, which every member read begins with. */
export function bootstrap(patch: Fields): Route {
  return merge("/token/full", patch);
}

function expectNoSecret(output: string, source: string, alsoSecret: readonly string[] = []): void {
  for (const secret of NEVER_PRINTED.concat(alsoSecret)) {
    expect(output, `${source} exposed a secret`).not.toContain(secret);
  }
}

/**
 * Fails when `value`, written out as JSON, shows any of `markers`: a text that must not occur in it,
 * or a pattern that must not match it. `about` names the case in the failure message.
 */
export function carriesNone(value: unknown, markers: readonly (string | RegExp)[], about?: string): void {
  const written = JSON.stringify(value);
  for (const marker of markers) {
    if (typeof marker === "string") expect(written, about).not.toContain(marker);
    else expect(written, about).not.toMatch(marker);
  }
}

/**
 * A directory of its own for one test file, holding a copy of the bundle. Call it at module scope, because
 * it registers the hooks that make the directory before the file's tests and remove it after them.
 */
export function sandbox(prefix: string) {
  let dir = "";
  const within = (...parts: string[]) => path.join(dir, ...parts);
  const bundle = () => within(BUNDLE_NAME);
  const journalFile = () => within("fake.jsonl");
  const planFile = () => within("overrides.json");
  const configDir = (name = "config") => within(name);
  const servers: Client[] = [];

  beforeAll(() => {
    if (!fs.existsSync(BUNDLE)) throw new Error(`no dist/${BUNDLE_NAME} to test: run \`npm run build\` first`);
    dir = fs.mkdtempSync(path.join(tmpdir(), `maccabi-${prefix}-`));
    fs.copyFileSync(BUNDLE, bundle());
  });
  afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => {})));
    if (dir !== "") fs.rmSync(dir, { force: true, recursive: true });
  });

  function environment(options: RunOptions): Record<string, string> {
    const env: Record<string, string> = {
      HOME: dir,
      PATH: process.env.PATH ?? "",
      MACCABI_CONFIG_DIR: configDir(options.config),
      FAKE_MACCABI_SCENARIO: options.scenario ?? "normal",
      FAKE_MACCABI_LOG: journalFile(),
    };
    if (options.overrides) env.FAKE_MACCABI_OVERRIDES = JSON.stringify(options.overrides);
    // Under `npm run coverage` each bundle process reports which of its lines ran.
    const coverage = process.env.MACCABI_COVERAGE_DIR;
    if (coverage) env.NODE_V8_COVERAGE = coverage;
    return { ...env, ...options.env };
  }

  /** Runs one command to its end. */
  function cli(args: string[], options: RunOptions = {}): CliResult {
    const node = options.fake === false ? [bundle()] : ["--import", FAKE, bundle()];
    const { status, stdout, stderr } = spawnSync(process.execPath, node.concat(args), {
      encoding: "utf8",
      cwd: dir,
      env: environment(options),
      input: options.input,
      timeout: 60_000,
    });
    expectNoSecret(stdout + stderr, `maccabi-health ${args[0] ?? ""}`);
    return {
      out: stdout,
      err: stderr,
      code: status,
      json: () => JSON.parse(stdout),
      /** The failure the command reported, which is the last line it wrote to standard error. */
      error() {
        const lines = stderr.trim().split("\n");
        return JSON.parse(lines[lines.length - 1] as string).error;
      },
    };
  }

  /** Signs in with two commands. Like an agent would, it hands the ID and the code over in the environment. */
  function signIn(options: RunOptions = {}): void {
    const steps: [args: string[], value: Record<string, string>][] = [
      [["login"], { MACCABI_ID: ID }],
      [["login", "--no-keep-alive"], { MACCABI_OTP: OTP }],
    ];
    for (const [args, value] of steps) {
      const step = cli(args, { ...options, env: { ...options.env, ...value } });
      expect(step.code, `${args.join(" ")}: ${step.err}`).toBe(0);
    }
  }

  /** Starts the bundle as an MCP server on stdio. Its fake reads the plan file anew for every request. */
  async function mcp(options: RunOptions = {}): Promise<Client> {
    const transport = new StdioClientTransport({
      cwd: dir,
      command: process.execPath,
      args: ["--import", FAKE, bundle(), "mcp"],
      env: { ...environment(options), FAKE_MACCABI_OVERRIDES_FILE: planFile() },
      stderr: "pipe",
    });
    const client = new Client({ version: "1", name: `${prefix}-test` });
    await client.connect(transport);
    servers.push(client);
    return client;
  }

  /** Changes what the fake answers to every MCP server of this sandbox, starting with its next request. */
  function override(plan: Overrides = {}): void {
    fs.writeFileSync(planFile(), JSON.stringify(plan));
  }
  /** Everything the fake has recorded so far. */
  function log(): Record<string, any>[] {
    if (!fs.existsSync(journalFile())) return [];
    const lines = fs.readFileSync(journalFile(), "utf8").split("\n");
    return lines.filter((line) => line !== "").map((line) => JSON.parse(line));
  }
  const ofKind = (...kinds: string[]) => log().filter((event) => kinds.includes(event.kind));

  return {
    dir: () => dir,
    bundle,
    configDir,
    /** For a test that starts a bundle process by itself: the environment `cli` and `mcp` give theirs. */
    env: environment,
    cli,
    signIn,
    mcp,
    override,
    log,
    /** The requests the bundle sent. */
    fetches: () => ofKind("fetch"),
    /** What must never happen: a request the fake had to refuse, a socket, a look at a GitHub token. */
    unexpected: () => ofKind("unexpected-fetch", "socket", "env-read"),
  };
}

/** Calls an MCP tool. The result is searched for secrets, whatever it says. */
export async function call(client: Client, tool: string, args: Fields = {}): Promise<ToolResult> {
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  expectNoSecret(JSON.stringify(result), tool);
  return result;
}

/**
 * A single MCP server that signs in once and is then led through one upstream variation after another.
 * Every helper below puts its rules into the fake's plan file first and then runs one operation through
 * `maccabi_read`.
 */
export function memberSession(prefix: string, never: string[] = [], scenario?: string) {
  const box = sandbox(prefix);
  let client: Client;

  async function signIn(): Promise<void> {
    box.override();
    const steps = [
      { tool: "maccabi_login_start", args: { id: ID }, leadsTo: "sms-sent" },
      { tool: "maccabi_login_verify", args: { code: OTP }, leadsTo: "signed-in" },
    ];
    for (const { tool, args, leadsTo } of steps) {
      const { structuredContent } = await call(client, tool, args);
      expect(structuredContent.status, tool).toBe(leadsTo);
    }
  }
  async function start(): Promise<void> {
    client = await box.mcp(scenario ? { config: prefix, scenario } : { config: prefix });
    await signIn();
  }

  async function run(operation: string, args: Fields = {}, routes: Route[] = []): Promise<ToolResult> {
    box.override({ routes });
    const result = await call(client, "maccabi_read", { operation, arguments: args });
    expectNoSecret(JSON.stringify(result), operation, never);
    return result;
  }
  async function succeeded(operation: string, args: Fields, routes: Route[]): Promise<ToolResult> {
    const result = await run(operation, args, routes);
    if (result.isError === true) expect.fail(`${operation} failed: ${JSON.stringify(result.structuredContent)}`);
    return result;
  }
  /** What the operation returned as JSON. An error result fails the test. */
  async function ok(operation: string, args: Fields = {}, routes: Route[] = []): Promise<any> {
    return (await succeeded(operation, args, routes)).structuredContent;
  }
  /** The file the operation returned: a PDF or a raw buffer comes as a resource, a JPEG as image content. */
  async function file(operation: string, args: Fields = {}, routes: Route[] = []): Promise<Buffer> {
    const { content = [] } = await succeeded(operation, args, routes);
    const attached = content.find(({ type }) => type === "image" || type === "resource");
    return Buffer.from((attached?.resource?.blob ?? attached?.data) as string, "base64");
  }
  /** The error the operation ended in. It has to carry `code`, and `detail` too when one is given. */
  async function fails(operation: string, args: Fields, routes: Route[], code: string, detail?: string): Promise<any> {
    const { structuredContent } = await run(operation, args, routes);
    const expected = detail === undefined ? { code } : { code, detail };
    const context = `${operation} ${JSON.stringify(args).slice(0, 200)}`;
    expect(structuredContent?.error, context).toMatchObject(expected);
    return structuredContent?.error;
  }
  /**
   * For an answer that turns out to be the logout page: the session has run out, the tool drops it, and
   * the helper signs in again for the tests that follow.
   */
  async function expired(operation: string, args: Fields, routes: Route[]): Promise<void> {
    await fails(operation, args, routes, "SIGN_IN_NEEDED");
    await signIn();
  }

  /** The recorded requests whose URL contains `fragment`, oldest first. */
  const requestsTo = (fragment: string) => box.fetches().filter((request) => request.url.includes(fragment));
  const last = (fragment: string) => requestsTo(fragment).pop() as Record<string, any>;
  const query = (fragment: string) => Object.fromEntries(new URLSearchParams(new URL(last(fragment).url).search));
  const count = (fragment: string) => requestsTo(fragment).length;

  return { box, start, signIn, run, ok, fails, file, expired, last, query, count, client: () => client };
}
