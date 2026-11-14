import { type Argument, argumentsOf, byCategory, describe } from "../operations/catalog";
import type { Category, Operation } from "../operations/define";
import { NAME, VERSION } from "../version";
import { flagName } from "./flags";

/** Commands that manage the local session or the tool itself. They are not reads. */
export const SESSION_COMMANDS: Record<string, { usage: string; summary: string; detail: string }> = {
  login: {
    usage: "login [--id DIGITS | --id-stdin] [--phone N] [--code DIGITS | --code-stdin] [--no-keep-alive]",
    summary: "Sign in with the member's ID number and an SMS code.",
    detail: [
      "In a terminal, `login` alone asks for the ID and the code with hidden input.",
      "Without a terminal it is two commands: `login --id DIGITS` sends one SMS, `login --code DIGITS` finishes.",
      "`--id-stdin` and `--code-stdin` read the value from standard input, which keeps it out of the process list, the shell history and the environment. MACCABI_ID and MACCABI_OTP are accepted too.",
      "If several phones are registered, `--id` lists them and sends nothing; repeat it with `--phone N`.",
      "A code gets one attempt and a sign-in stays open for ten minutes. A wrong code means starting again.",
      "A finished sign-in starts `keep-alive` in the background unless `--no-keep-alive` is given.",
    ].join("\n"),
  },
  status: {
    usage: "status [--verify]",
    summary: "Show whether a session is saved; --verify checks it with Maccabi.",
    detail:
      "Without --verify nothing is requested: the answer is `signed-in`, `pending-login` or `signed-out`, with the session's deadline when known. Maccabi ends every session an hour after sign-in.",
  },
  logout: {
    usage: "logout",
    summary: "Delete the saved session from this machine.",
    detail: "Removes the session and any unfinished sign-in. Nothing is revoked at Maccabi.",
  },
  "keep-alive": {
    usage: "keep-alive",
    summary: "Renew the session every four minutes until it ends.",
    detail:
      "Holds off Maccabi's idle timeout. It cannot extend the one-hour limit, and stops by itself when the session is signed out, replaced or expired.",
  },
  mcp: {
    usage: "mcp",
    summary: "Run the MCP server on stdin/stdout.",
    detail: "Offers the same operations to an MCP client. It takes no options and reads the same saved session.",
  },
  help: {
    usage: "help [COMMAND] [--category NAME] [--json]",
    summary: "Show this index, one command, or one category.",
    detail: "`--json` prints the same information for a program.",
  },
};

function placeholder(argument: Argument): string {
  if (argument.type === "boolean") return "";
  if (argument.type === "map") return " KEY=VALUE";
  if (argument.choices) return ` ${argument.choices.join("|")}`;
  return argument.type === "integer" ? " N" : " VALUE";
}

function usageLine(label: Operation): string {
  const segments = argumentsOf(label).map((argument) => {
    const str = `${flagName(argument.name)}${placeholder(argument)}`;
    return argument.required ? str : `[${str}]`;
  });
  if (label.returns === "file") segments.push("--out FILE");
  return [NAME, label.name, ...segments].join(" ");
}

function column(entries: readonly (readonly [string, string])[]): string {
  const width = Math.max(...entries.map(([left]) => left.length));
  return entries.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`).join("\n");
}

/** The first thing a caller sees: every command on one line, grouped so clinical data is easy to tell apart. */
export function indexText(only?: Category): string {
  const sections = byCategory(only)
    .filter((cluster) => cluster.operations.length > 0)
    .map(
      (cluster) =>
        `${cluster.category}: ${cluster.about}\n${column(cluster.operations.map((op) => [op.name, op.summary]))}`,
    );
  const saved = `session\n${column(Object.entries(SESSION_COMMANDS).map(([label_, command]) => [label_, command.summary]))}`;
  return [
    `${NAME} ${VERSION}: read-only access to a member's own Maccabi Healthcare records.`,
    `Usage: ${NAME} COMMAND [--argument VALUE ...]`,
    ...(only ? [] : [saved]),
    ...sections,
    `\`${NAME} help COMMAND\` shows a command's arguments. Results are JSON on stdout; errors are JSON on stderr.\nCommands that return a document write it to --out FILE and never overwrite.`,
  ].join("\n\n");
}

const ACCESS_NOTE = {
  member: "Needs a signed-in session.",
  public: "Needs no account.",
  offline: "Makes no request.",
} as const;

export function operationText(label: Operation): string {
  const entries = argumentsOf(label).map((argument): [string, string] => [
    `${flagName(argument.name)}${placeholder(argument)}`,
    [
      argument.required ? "Required." : undefined,
      argument.description,
      argument.default === undefined ? undefined : `Default: ${String(argument.default)}.`,
    ]
      .filter(Boolean)
      .join(" "),
  ]);
  if (label.returns === "file")
    entries.push(["--out FILE", "Required. A new file, created private (mode 0600); an existing path is refused."]);
  return [
    usageLine(label),
    [label.summary, label.description].filter(Boolean).join("\n"),
    ...(entries.length > 0 ? [`Arguments\n${column(entries)}`] : []),
    `Category: ${label.category}. ${ACCESS_NOTE[label.access]}`,
  ].join("\n\n");
}

export function sessionCommandText(label_: string): string {
  const command = SESSION_COMMANDS[label_] as (typeof SESSION_COMMANDS)[string];
  return `${NAME} ${command.usage}\n\n${command.summary}\n${command.detail}`;
}

/** The same catalog for a program. */
export function indexJson(only?: Category) {
  return {
    name: NAME,
    version: VERSION,
    session: Object.entries(SESSION_COMMANDS).map(([label_, command]) => ({
      name: label_,
      usage: command.usage,
      summary: command.summary,
    })),
    categories: byCategory(only).map((cluster) => ({
      category: cluster.category,
      about: cluster.about,
      operations: cluster.operations.map(describe),
    })),
    exitCodes: { 0: "success", 1: "the request failed", 2: "invalid usage", 3: "sign-in needed" },
  };
}
