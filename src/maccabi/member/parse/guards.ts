/**
 * The checks every JSON parser in this directory repeats. A parser has one way of saying "this is not
 * the answer I was written for": an error class of its own that carries nothing from the answer.
 * `guardFor` ties the common checks to that error, which leaves each parser to spell out only what is
 * particular to its answer.
 */
export type Json = Record<string, unknown>;

export interface Guard {
  /** Raises the parser's mismatch error. */
  fail(): never;
  /** A JSON object: not an array, not null, not a scalar. */
  object(value: unknown): Json;
  /** An array of at most `most` entries. */
  list(value: unknown, most: number): unknown[];
  flag(value: unknown): boolean;
  integer(value: unknown): number;
  string(value: unknown): string;
  /** A string with at least one character in it. */
  filled(value: unknown): string;
  /** Text of at most `limit` characters; of the control characters only tab, line feed and carriage return pass. */
  text(value: unknown, limit: number): string;
  /** Hands `value` back once its JSON text is known to stay within `bytes`. */
  bounded<T>(value: T, bytes: number): T;
}

const LAYOUT_WHITESPACE = "\t\n\r";
const ASCII_DIGITS = "0123456789";
const HEX_DIGITS = `${ASCII_DIGITS}abcdefABCDEF`;

/** Whether `text` holds a C0 control character or DEL, the characters listed in `allowed` aside. */
export function hasControl(text: string, allowed = ""): boolean {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if ((code < 0x20 || code === 0x7f) && !allowed.includes(text.charAt(at))) return true;
  }
  return false;
}

/** Whether `text` is a run of ASCII digits, from `least` to `most` of them, and nothing besides. */
export function isDigits(text: string, least: number, most: number): boolean {
  if (typeof text !== "string" || text.length < least || text.length > most) return false;
  return text.split("").every((unit) => ASCII_DIGITS.includes(unit));
}

/** Whether some `%` in `text` is not the start of a two-digit hexadecimal escape. */
export function hasLonePercent(text: string): boolean {
  const afterEachPercent = text.split("%").slice(1);
  return afterEachPercent.some(
    (tail) => tail.length < 2 || !HEX_DIGITS.includes(tail.charAt(0)) || !HEX_DIGITS.includes(tail.charAt(1)),
  );
}

export const absent = (value: unknown): value is null | undefined => value === null || value === undefined;

/** `read` applied to a field that is there; null for one Maccabi left out or sent as null. */
export const optional = <T>(value: unknown, read: (present: unknown) => T): T | null =>
  absent(value) ? null : read(value);

/**
 * An absolute http(s) address without embedded credentials, short enough and free of control
 * characters. The parsers hand such links on as content; nothing here ever requests one.
 */
export function isWebLink(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 4096 || hasControl(value)) return false;
  if (!URL.canParse(value)) return false;
  const { protocol, username, password } = new URL(value);
  return (protocol === "https:" || protocol === "http:") && username === "" && password === "";
}

export function guardFor(mismatch: () => Error): Guard {
  const fail = (): never => {
    throw mismatch();
  };
  return {
    fail,
    object: (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : fail(),
    list: (value, most) => (Array.isArray(value) && value.length <= most ? value : fail()),
    flag: (value) => (typeof value === "boolean" ? value : fail()),
    integer: (value) => (Number.isSafeInteger(value) ? (value as number) : fail()),
    string: (value) => (typeof value === "string" ? value : fail()),
    filled: (value) => (typeof value === "string" && value !== "" ? value : fail()),
    text: (value, limit) =>
      typeof value === "string" && value.length <= limit && !hasControl(value, LAYOUT_WHITESPACE) ? value : fail(),
    bounded: (value, bytes) => (Buffer.byteLength(JSON.stringify(value)) > bytes ? fail() : value),
  };
}
