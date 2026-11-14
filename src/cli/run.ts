import { type FileHandle, open, rm, stat } from "node:fs/promises";
import { type Argument, argumentsOf, describe, isCategory } from "../operations/catalog";
import { execute, noSuchRead, type Runtime } from "../operations/execute";
import { Failure, failureBody, toFailure } from "../operations/failure";
import { findOperation } from "../operations/index";
import { SessionStore } from "../session/files";
import { holdSession, startDetachedKeepAlive } from "../session/keep-alive";
import { ID_NUMBER, signInState, signOut, startSignIn, verifySignIn } from "../session/sign-in";
import { NAME, VERSION } from "../version";
import { AskAborted, ask, hasTerminal } from "./ask";
import { parseFlags } from "./flags";
import { indexJson, indexText, operationText, SESSION_COMMANDS, sessionCommandText } from "./help";

/** The process boundary, so tests can run the CLI without a real terminal or process. */
export interface CliIo {
  env: NodeJS.ProcessEnv;
  stdout(str: string): void;
  stderr(str: string): void;
  runtime?: Runtime;
}

const EXIT = { usage: 2, auth: 3, failed: 1 } as const;
const HELP_POINTER = `Run \`${NAME} help\`.`;
const SIGN_IN_HINT = `Run \`${NAME} login\` in a terminal, or \`${NAME} login --id DIGITS\` and then \`${NAME} login --code DIGITS\`.`;

const flag = (label_: string, sort: Argument["type"] = "string"): Argument => ({
  name: label_,
  type: sort,
  required: false,
});

function print(io: CliIo, candidate: unknown): void {
  io.stdout(`${JSON.stringify(candidate, null, 2)}\n`);
}

function usage(notice: string): Failure {
  return new Failure("BAD_INPUT", notice, "usage");
}

/** Creates the output file: new, private, never over an existing path. Each ordinary refusal gets its own answer. */
async function createNewFile(where: string): Promise<FileHandle> {
  try {
    return await open(where, "wx", 0o600);
  } catch (caught) {
    const codeText = (caught as NodeJS.ErrnoException).code ?? "";
    if (codeText === "ENOENT") throw new Failure("OUT_DIR_MISSING", "The directory for --out does not exist.");
    if (codeText !== "EEXIST") throw new Failure("OUT_NOT_WRITABLE", "--out cannot be written.");
    // Exclusive creation reports a directory as "exists"; tell the two apart for the caller.
    const isDirectory = await stat(where).then(
      (line) => line.isDirectory(),
      () => false,
    );
    throw isDirectory
      ? new Failure("OUT_IS_DIR", "--out names a directory; it takes the path of the file to create.")
      : new Failure("OUT_EXISTS", "--out names a file that already exists; nothing is ever overwritten.");
  }
}

async function help(io: CliIo, argv: readonly string[]): Promise<void> {
  let topic: string | undefined;
  let kind_: string | undefined;
  let getJson = false;
  for (let position = 0; position < argv.length; position += 1) {
    const secret = argv[position] as string;
    if (secret === "--json") getJson = true;
    else if (secret === "--category") kind_ = argv[++position];
    else if (!secret.startsWith("--") && topic === undefined) topic = secret;
    else throw usage("Unknown option. Run `maccabi-health help help`.");
  }
  if (argv.includes("--category") && !isCategory(kind_))
    throw usage("That is not a category. Run `maccabi-health help`.");
  const only = isCategory(kind_) ? kind_ : undefined;
  if (topic === undefined) {
    if (getJson) print(io, indexJson(only));
    else io.stdout(`${indexText(only)}\n`);
    return;
  }
  const label = findOperation(topic);
  if (label) {
    if (getJson) print(io, describe(label));
    else io.stdout(`${operationText(label)}\n`);
  } else if (Object.hasOwn(SESSION_COMMANDS, topic)) io.stdout(`${sessionCommandText(topic)}\n`);
  else throw noSuchRead("command", HELP_POINTER);
}

async function interactiveLogin(io: CliIo, runtime: Runtime): Promise<void> {
  const opts = { store: runtime.store, fetch: runtime.fetch };
  const ident = await ask("ID number: ", true);
  let started = await startSignIn(opts, ident);
  if (started.status === "phone-required") {
    for (const number of started.phones) io.stderr(`${number.option}. ${number.label}\n`);
    const offered = started.phones.map((number) => number.option);
    let choice = Number(await ask("Send the code to phone number: "));
    while (!offered.includes(choice)) choice = Number(await ask(`Enter one of ${offered.join(", ")}: `));
    started = await startSignIn(opts, ident, choice);
  }
  if (started.status === "sms-sent") io.stderr(`Code sent by SMS to ${started.phone}.\n`);
  await verifySignIn(opts, await ask("SMS code: ", true));
}

/** One short line from standard input. */
async function readStdin(): Promise<string> {
  let str = "";
  for await (const chunk of process.stdin) {
    str += chunk;
    if (str.length > 64) break;
  }
  return str.trim();
}

async function login(io: CliIo, runtime: Runtime, argv: readonly string[]): Promise<void> {
  const flags = parseFlags("login", argv, [
    flag("id"),
    flag("code"),
    flag("id_stdin", "boolean"),
    flag("code_stdin", "boolean"),
    flag("phone", "integer"),
    flag("keep_alive", "boolean"),
  ]);
  const opts = { store: runtime.store, fetch: runtime.fetch };
  // Standard input keeps a value out of the process list, the shell history and the environment.
  if (flags.id_stdin && flags.code_stdin) throw usage("Standard input carries one value: the ID or the code.");
  if (flags.id_stdin) flags.id = await readStdin();
  if (flags.code_stdin) flags.code = await readStdin();
  if (flags.id !== undefined && flags.code !== undefined) {
    throw usage("Starting and finishing a sign-in are two commands: the SMS has to arrive in between.");
  }
  // A flag names the step outright. With only the environment to go by, a code finishes a sign-in
  // and wins over an ID that may still be exported from the first step.
  const envCode = flags.id === undefined ? io.env.MACCABI_OTP || undefined : undefined;
  const codeText = (flags.code as string | undefined) ?? envCode;
  const ident =
    codeText === undefined ? ((flags.id as string | undefined) ?? (io.env.MACCABI_ID || undefined)) : undefined;
  if (flags.phone !== undefined && ident === undefined) throw usage("--phone goes with the ID that starts a sign-in.");
  if (ident !== undefined) {
    if (!ID_NUMBER.test(ident)) throw usage("The ID number is digits only, at most nine. No SMS was sent.");
    print(io, await startSignIn(opts, ident, flags.phone as number | undefined));
    return;
  }
  if (codeText === undefined) {
    if (!hasTerminal())
      throw new Failure("NO_TERMINAL", `There is no terminal to ask in. ${SIGN_IN_HINT} No SMS was sent.`, "auth");
    await interactiveLogin(io, runtime);
  } else {
    await verifySignIn(opts, codeText);
  }
  const keepAliveStarted = flags.keep_alive !== false && startDetachedKeepAlive(io.env);
  print(io, { status: "signed-in", keepAlive: keepAliveStarted });
}

async function state_(io: CliIo, runtime: Runtime, argv: readonly string[]): Promise<void> {
  const flags = parseFlags("status", argv, [flag("verify", "boolean")]);
  // Any account read proves the session; the profile comes from the request every read starts with.
  if (flags.verify) await execute(runtime, "profile", {});
  print(io, { ...(await signInState({ store: runtime.store })), verified: flags.verify === true });
}

async function runOperation(io: CliIo, runtime: Runtime, label_: string, argv: readonly string[]): Promise<void> {
  const label = findOperation(label_);
  if (!label) throw noSuchRead("command", HELP_POINTER);
  const known = [...argumentsOf(label), ...(label.returns === "file" ? [flag("out")] : [])];
  const { out, ...given } = parseFlags(label_, argv, known);
  if (label.returns === "file" && typeof out !== "string")
    throw usage(`\`${label_}\` returns a document: add --out FILE.`);
  if (label.returns === "json") {
    const outcome = await execute(runtime, label_, given);
    if (outcome.kind === "json") print(io, outcome.value);
    return;
  }
  // The file is claimed before anything is requested, so a bad path costs no download.
  const file = await createNewFile(out as string);
  try {
    const outcome = await execute(runtime, label_, given);
    if (outcome.kind !== "file") throw new Error("expected a file");
    await file.writeFile(outcome.bytes);
    await file.close();
    print(io, { status: "saved", ...outcome.details });
  } catch (caught) {
    await file.close().catch(() => {});
    await rm(out as string, { force: true }).catch(() => {});
    throw caught;
  }
}

/** Runs one command line and returns the process exit code. Never throws. */
export async function cliMain(argv: readonly string[], io: CliIo): Promise<number> {
  const runtime = io.runtime ?? { store: new SessionStore(), warn: (notice) => io.stderr(`Warning: ${notice}\n`) };
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === "--help" || command === "-h") await help(io, rest);
    else if (command === "--version" || command === "version") io.stdout(`${NAME} ${VERSION}\n`);
    else if (rest.includes("--help") || rest.includes("-h")) await help(io, [command]);
    else if (command === "help") await help(io, rest);
    else if (command === "login") await login(io, runtime, rest);
    else if (command === "status") await state_(io, runtime, rest);
    else if (command === "logout") {
      parseFlags("logout", rest, []);
      print(io, await signOut({ store: runtime.store }));
    } else if (command === "keep-alive") {
      parseFlags("keep-alive", rest, []);
      const interrupted = new AbortController();
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => interrupted.abort());
      print(io, await holdSession(runtime.store, interrupted.signal, { fetch: runtime.fetch }));
    } else await runOperation(io, runtime, command, rest);
    return 0;
  } catch (caught) {
    const refusal =
      caught instanceof AskAborted
        ? new Failure("CANCELLED", "Cancelled. Nothing was saved.", "auth")
        : toFailure(caught);
    io.stderr(`${JSON.stringify(failureBody(refusal, SIGN_IN_HINT))}\n`);
    return EXIT[refusal.kind];
  }
}
