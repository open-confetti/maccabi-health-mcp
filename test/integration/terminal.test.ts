/**
 * `login` with a person at the keyboard. The ID and the SMS code are typed at prompts that do not show
 * them, which takes a terminal, and Node has no way of opening a pseudo-terminal by itself. A short
 * Python script opens one, runs the bundle on it and types the answers.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { ID, OTP, ROOT, sandbox } from "../rig";

const box = sandbox("terminal");
const pythonHasPty = spawnSync("python3", ["-c", "import pty"]).status === 0;

/**
 * Starts argv[0] on a pseudo-terminal and reads what it prints. Whenever the text printed since the last
 * answer contains the next prompt, the answer to that prompt is typed. Prints the exit code and the screen.
 */
const TYPIST = `
import json, os, pty, select, sys
argv, answers = json.loads(sys.argv[1]), json.loads(sys.argv[2])
child, terminal = pty.fork()
if child == 0:
    os.execvpe(argv[0], argv, os.environ)
screen, since_answer = b"", b""
while select.select([terminal], [], [], 20)[0]:
    try:
        printed = os.read(terminal, 4096)
    except OSError:
        break
    if not printed:
        break
    screen += printed
    since_answer += printed
    if answers and answers[0][0].encode() in since_answer:
        os.write(terminal, answers.pop(0)[1].encode())
        since_answer = b""
exit_code = os.waitstatus_to_exitcode(os.waitpid(child, 0)[1])
json.dump({"code": exit_code, "screen": screen.decode("utf-8", "replace")}, sys.stdout)
`;

type Answer = [prompt: string, typed: string];
const ENTER = "\r";
const idPrompt = (typed = ID + ENTER): Answer => ["ID number: ", typed];
const codePrompt: Answer = ["SMS code: ", OTP + ENTER];

/** Runs a command of the bundle on a terminal, typing `answers` as their prompts come up. */
function atTerminal(config: string, args: string[], answers: Answer[], scenario = "normal") {
  const command = [process.execPath, "--import", path.join(ROOT, "test", "fake", "maccabi.mjs"), box.bundle(), ...args];
  const typist = spawnSync("python3", ["-c", TYPIST, JSON.stringify(command), JSON.stringify(answers)], {
    timeout: 60_000,
    encoding: "utf8",
    env: box.env({ config, scenario }),
    cwd: box.dir(),
  });
  return JSON.parse(typist.stdout) as { code: number; screen: string };
}
const login = (config: string, answers: Answer[], scenario?: string) =>
  atTerminal(config, ["login", "--no-keep-alive"], answers, scenario);
const SIGNED_IN = '"status": "signed-in"';

describe.skipIf(!pythonHasPty)("login at a terminal", () => {
  test("prompts for the ID and for the code, echoes neither of them, and signs in", () => {
    const { code, screen } = login("typed-in", [idPrompt(), codePrompt]);
    expect(code).toBe(0);
    for (const shown of [SIGNED_IN, "Code sent by SMS to", "*".repeat(ID.length)]) expect(screen).toContain(shown);
    for (const hidden of [ID, OTP]) expect(screen).not.toContain(hidden);
    expect(box.cli(["status"], { config: "typed-in" }).json().status).toBe("signed-in");
  });

  test("lets a wrong character be deleted before Enter sends the line", () => {
    const BACKSPACE = "\x7f";
    const { code, screen } = login("corrected", [idPrompt(`${ID}7${BACKSPACE}${ENTER}`), codePrompt]);
    expect(screen).toContain(SIGNED_IN);
    expect(code).toBe(0);
  });

  test("shows the phones of an ID that has several, asks again when the choice is not one of them, and texts the chosen one", () => {
    const choices: Answer[] = [
      ["Send the code to phone number: ", `2${ENTER}`],
      ["Enter one of 1, 3: ", `3${ENTER}`],
    ];
    const { code, screen } = login("choosing", [idPrompt(), ...choices, codePrompt], "phones");
    expect(code).toBe(0);
    for (const shown of ["1. Phone ending 0001", "3. Phone ending 0002", "Code sent by SMS to ending 0002"]) {
      expect(screen).toContain(shown);
    }
    // The third option is Maccabi's phone number 2, and that is the one the SMS was requested for.
    const smsRequests = box.fetches().filter(({ url }) => url.includes("/otp/generateV2"));
    expect(smsRequests.map(({ url }) => new URL(url).searchParams.get("phone"))).toContain("2");
  });

  test("is called off by Ctrl-C at a prompt, with exit 3, no SMS and nothing stored", () => {
    const CTRL_C = "\x03";
    const requestsBefore = box.fetches().length;
    const { code, screen } = atTerminal("called-off", ["login"], [idPrompt(CTRL_C)]);
    expect(screen).toContain("CANCELLED");
    expect(code).toBe(3);
    expect(box.fetches()).toHaveLength(requestsBefore);
    expect(box.cli(["status"], { config: "called-off" }).json().status).toBe("signed-out");
  });
});
