import type { Argument } from "../operations/catalog";
import { Failure } from "../operations/failure";

/**
 * Turns `--request-id 12 --irregular-only --params key=value` into the argument object an operation
 * validates. Only the conversion from text happens here; whether a value is acceptable is the
 * schema's decision. Error messages never repeat what the caller typed.
 */

export function flagName(argument: string): string {
  return `--${argument.replaceAll("_", "-")}`;
}

function usage(notice: string, command: string): Failure {
  return new Failure("BAD_INPUT", `${notice} Run \`maccabi-health help ${command}\`.`, "usage");
}

function convert(argument: Argument, str: string, command: string): unknown {
  if (argument.type === "integer") {
    if (!/^-?\d{1,15}$/.test(str)) throw usage(`${flagName(argument.name)} takes a whole number.`, command);
    return Number(str);
  }
  return str;
}

export function parseFlags(
  command: string,
  argv: readonly string[],
  known: readonly Argument[],
): Record<string, unknown> {
  const byFlag = new Map(known.map((argument) => [flagName(argument.name), argument]));
  const inputs: Record<string, unknown> = {};
  for (let position = 0; position < argv.length; position += 1) {
    const secret = argv[position] as string;
    if (!secret.startsWith("--")) throw usage("Arguments are given as --name value.", command);
    const equals = secret.indexOf("=");
    const flag = equals === -1 ? secret : secret.slice(0, equals);
    const inline = equals === -1 ? undefined : secret.slice(equals + 1);

    const negated = flag.startsWith("--no-") ? byFlag.get(`--${flag.slice(5)}`) : undefined;
    const argument = byFlag.get(flag) ?? (negated?.type === "boolean" ? negated : undefined);
    if (!argument) {
      // The command's own options are listed, so the call can be corrected without opening the help.
      const accepted = [...byFlag.keys()];
      throw usage(
        accepted.length > 0
          ? `Unknown option. It takes: ${accepted.join(", ")}.`
          : "Unknown option. It takes no options.",
        command,
      );
    }
    if (argument.type !== "map" && Object.hasOwn(inputs, argument.name))
      throw usage("An option was given twice.", command);

    if (argument.type === "boolean") {
      if (inline !== undefined) throw usage(`${flagName(argument.name)} takes no value.`, command);
      inputs[argument.name] = byFlag.get(flag) === argument;
      continue;
    }
    const following = argv[position + 1];
    const str = inline ?? (following !== undefined && !following.startsWith("--") ? following : undefined);
    if (str === undefined) throw usage(`${flagName(argument.name)} needs a value.`, command);
    if (inline === undefined) position += 1;

    if (argument.type === "map") {
      const separator = str.indexOf("=");
      if (separator <= 0) throw usage(`${flagName(argument.name)} takes KEY=VALUE.`, command);
      const map = (inputs[argument.name] ?? {}) as Record<string, string>;
      inputs[argument.name] = map;
      const prop = str.slice(0, separator);
      if (prop === "__proto__") throw usage(`${flagName(argument.name)} takes KEY=VALUE.`, command);
      if (Object.hasOwn(map, prop)) throw usage(`A ${flagName(argument.name)} key was given twice.`, command);
      map[prop] = str.slice(separator + 1);
      continue;
    }
    inputs[argument.name] = convert(argument, str, command);
  }
  return inputs;
}
