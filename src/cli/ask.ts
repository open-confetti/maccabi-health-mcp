/** Ctrl-C at a prompt. Raw mode delivers it as a byte, so cancelling is an ordinary outcome, not a crash. */
export class AskAborted extends Error {}

const ENTER = new Set(["\r", "\n"]);
/** Ctrl-C and Ctrl-D. */
const CANCEL = new Set(["\u0003", "\u0004"]);
/** Delete and backspace; terminals send one or the other for the same key. */
const RUB_OUT = new Set(["\u007f", "\u0008"]);
/** Step back, blank the cell, step back again. */
const BLANK_LAST_CELL = "\u0008 \u0008";
const LONGEST_ANSWER = 128;

/**
 * Asks one question on the terminal. With `hidden`, typed characters are shown as asterisks, so an ID
 * number or a code never lands in argv, shell history or scrollback.
 */
export function ask(label: string, hidden = false): Promise<string> {
  const given = process.stdin;
  const output = process.stderr;
  const echoOf = hidden ? () => "*" : (typed: string) => typed;
  return new Promise((resolve, reject) => {
    let candidate = "";
    let done = false;
    const wasRaw = given.isRaw;
    const finish = (cancelled: boolean): void => {
      if (done) return;
      done = true;
      given.off("data", onData);
      given.off("error", onError);
      given.setRawMode(wasRaw);
      given.pause();
      output.write("\n");
      if (cancelled) reject(new AskAborted());
      else resolve(candidate);
    };
    const onError = (): void => finish(true);
    const onData = (chunk: Buffer): void => {
      for (const key of chunk.toString("utf8")) {
        if (done) return;
        if (ENTER.has(key)) finish(false);
        else if (CANCEL.has(key)) finish(true);
        else if (RUB_OUT.has(key)) {
          if (candidate === "") continue;
          candidate = candidate.slice(0, -1);
          output.write(BLANK_LAST_CELL);
        } else if (key >= " " && key !== "\u001b" && candidate.length < LONGEST_ANSWER) {
          candidate += key;
          output.write(echoOf(key));
        }
      }
    };
    // Raw mode first: a key pressed while the question is being written must reach this handler,
    // not the terminal's own line editing.
    given.setRawMode(true);
    output.write(label);
    given.on("data", onData);
    given.on("error", onError);
    given.resume();
  });
}

export function hasTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}
