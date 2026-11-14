/**
 * The install step an agent runs: the `sh install` block of skills/maccabi-health/SKILL.md, taken out of
 * the file as it stands and run by a shell. The shell gets a HOME of its own and a PATH with nothing on it
 * but four core utilities, node, and stand-ins for `gh` and `curl`. Nothing here touches the network. A
 * stand-in serves a mock release and writes down its arguments, its standard input and any GH_TOKEN,
 * which is how a test learns what the real tool would have been given. Only the two pins are swapped, for
 * values the tests control.
 */
import { exec, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ROOT } from "../rig";

const SKILL = fs.readFileSync(path.join(ROOT, "skills", "maccabi-health", "SKILL.md"), "utf8");
const [, BLOCK = ""] = /^```sh install\n(.*?)\n```$/ms.exec(SKILL) ?? [];
/** The line `NAME="value"` of a script, as a pattern that captures the value. */
const assignment = (name: string) => new RegExp(`^${name}="([^"]*)"$`, "m");
const assigned = (name: string) => assignment(name).exec(BLOCK)?.[1];
/** Where the block downloads from, which it says itself. */
const REPO = assigned("REPO") ?? "<the block has no REPO= line>";
const BUNDLE_NAME = "maccabi-health.mjs";

/** What an unpinned SKILL.md carries in place of a commit and a hash. */
const UNPINNED = { ref: "__RELEASE_COMMIT__", sha: "__RELEASE_SHA256__" };
const REF = "5eed".repeat(10);
const RELEASE = "#!/usr/bin/env node\nconsole.log('the mock release');\n";
const ALTERED = RELEASE.replace("mock", "altered");
const OLD_RELEASE = "an earlier mock release\n";
const sha256 = (content: string) => crypto.createHash("sha256").update(content).digest("hex");

const ACCEPT = "Accept: application/vnd.github.raw";
const apiPath = (ref: string) => `repos/${REPO}/contents/release/${BUNDLE_NAME}?ref=${ref}`;
const apiUrl = (ref: string) => `https://api.github.com/${apiPath(ref)}`;
/** What the stand-ins answer in place of the file. The block must never pass it on. */
const REFUSAL = "the stand-in says no";

type Tool = "gh" | "curl";
/** One invocation of a stand-in, as it recorded it. */
interface Call {
  tool: Tool;
  argv: string[];
  ghToken: string | null;
  stdin: string | null;
}

/** What the machine has installed, beside the core utilities. */
interface Tools {
  /** A `gh` that has a login of its own, or one that has none and is refused. */
  gh?: "signed-in" | "signed-out";
  /** A `curl` that answers 200, or the given status, or fails as it does when the network is down. */
  curl?: true | number | "network-error";
  /** node is there unless this says it is missing or too old to pass the block's version check. */
  node?: "absent" | "old";
  /** The bytes GitHub has for the release. */
  served?: string;
}

/**
 * The source of a stand-in: a node script that records its invocation as one line of JSON and then does
 * what `behaviour` says. Its shebang is absolute, so it runs however little the PATH offers.
 */
function standIn(tool: Tool, record: string, behaviour: string): string {
  const lines = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    "const argv = process.argv.slice(2);",
    `const stdin = ${tool === "curl" ? 'fs.readFileSync(0, "utf8")' : "null"};`,
    "const ghToken = process.env.GH_TOKEN ?? null;",
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ tool: "${tool}", argv, stdin, ghToken }) + "\\n");`,
    behaviour,
  ];
  return `${lines.join("\n")}\n`;
}

/** As `gh api` does: the file on standard output when it has a login, else half an answer and exit 1. */
const ghBehaviour = (login: Tools["gh"], release: string) => `
const authorised = ${login === "signed-in"};
const expected = ${JSON.stringify(["api", "-H", ACCEPT, apiPath(REF)])};
if (authorised && JSON.stringify(argv) === JSON.stringify(expected)) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(release)}));
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify({ message: REFUSAL }))});
  process.stderr.write("gh: ${REFUSAL} (HTTP 401)\\n");
  process.exitCode = 1;
}`;

/**
 * As `curl -o FILE -w '%{http_code}'` does: GitHub's answer goes into FILE and its status is printed.
 * The repository is public, so the release path at the pinned ref is served to anyone; any other is 404.
 */
const curlBehaviour = (answer: Tools["curl"], release: string) => `
if (${answer === "network-error"}) {
  process.stderr.write("curl: (6) a network error of the stand-in's making\\n");
  process.exit(6);
}
const target = argv[argv.indexOf("-o") + 1];
const asked = argv.find((arg) => arg.startsWith("https://"));
const status = asked !== ${JSON.stringify(apiUrl(REF))} ? 404 : ${typeof answer === "number" ? answer : 200};
fs.writeFileSync(target, status === 200 ? fs.readFileSync(${JSON.stringify(release)}) : ${JSON.stringify(JSON.stringify({ message: REFUSAL }))});
process.stdout.write(String(status));`;

const machines: string[] = [];
afterEach(() => {
  while (machines.length > 0) fs.rmSync(machines.pop() as string, { force: true, recursive: true });
});

/** A machine to install on: a HOME, a PATH of one directory, and a record of the stand-ins' calls. */
function machine(tools: Tools = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "skill-install-"));
  machines.push(root);
  const inRoot = (...parts: string[]) => path.join(root, ...parts);
  const [bin, home, record, release] = [inRoot("bin"), inRoot("home"), inRoot("calls.jsonl"), inRoot("release")];
  for (const directory of [bin, home]) fs.mkdirSync(directory);
  fs.writeFileSync(release, tools.served ?? RELEASE);

  const executable = (name: string, source: string) => fs.writeFileSync(path.join(bin, name), source, { mode: 0o755 });
  // The block gets these four and node. A real gh, curl, npm or npx is out of its reach.
  for (const utility of ["rm", "mv", "chmod", "mkdir"]) fs.symlinkSync(`/bin/${utility}`, path.join(bin, utility));
  if (tools.node === "old") executable("node", "#!/bin/sh\nexit 1\n");
  if (tools.node === undefined) fs.symlinkSync(process.execPath, path.join(bin, "node"));
  if (tools.gh) executable("gh", standIn("gh", record, ghBehaviour(tools.gh, release)));
  if (tools.curl !== undefined) executable("curl", standIn("curl", record, curlBehaviour(tools.curl, release)));

  const dir = path.join(home, ".local", "share", "maccabi-health");
  const file = path.join(dir, BUNDLE_NAME);
  return {
    home,
    dir,
    file,
    download: `${file}.download`,
    env: { HOME: home, PATH: bin },
    /** Every call the stand-ins recorded, in order. */
    calls(): Call[] {
      if (!fs.existsSync(record)) return [];
      const lines = fs.readFileSync(record, "utf8").trim().split("\n");
      return lines.map((line) => JSON.parse(line));
    },
    /** A file at the install path that anyone can read, as it would be had an agent saved it by hand. */
    place(content: string): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
      fs.writeFileSync(file, content, { mode: 0o644 });
    },
  };
}
type Machine = ReturnType<typeof machine>;

interface Run {
  shell?: string;
  ref?: string;
  sha?: string;
}
/** Runs the block on the machine, pinned to the tests' commit and hash unless the run names others. */
function install(on: Machine, { shell = "/bin/sh", ref = REF, sha = sha256(RELEASE) }: Run = {}) {
  const script = BLOCK.replace(assignment("REF"), `REF="${ref}"`).replace(assignment("SHA256"), `SHA256="${sha}"`);
  const env: NodeJS.ProcessEnv = on.env;
  const { status, stdout, stderr } = spawnSync(shell, ["-c", script], { timeout: 30_000, encoding: "utf8", env });
  return { code: status, stdout, stderr, output: stdout + stderr };
}
type Outcome = ReturnType<typeof install>;

const permissions = (target: string) => fs.statSync(target).mode & 0o777;
const urlsIn = (argv: string[]) => argv.filter((arg) => /^https?:/.test(arg));

/** The run succeeded and left the verified release, closed to others, with no download beside it. */
function expectInstalled(on: Machine, outcome: Outcome): void {
  expect(outcome.stdout).toContain("installed and verified");
  expect(outcome.code).toBe(0);
  expect(fs.readFileSync(on.file, "utf8")).toBe(RELEASE);
  expect([on.dir, on.file].map(permissions)).toEqual([0o700, 0o700]);
  expect(fs.existsSync(on.download)).toBe(false);
}
/** Neither an installed file nor a download is left on the machine. */
function expectNothingKept(on: Machine): void {
  for (const leftover of [on.download, on.file]) expect(fs.existsSync(leftover), leftover).toBe(false);
}
/** The run ended with this exit code and said each of these on standard error. */
function expectExit(outcome: Outcome, code: number, ...said: string[]): void {
  expect(outcome.code).toBe(code);
  for (const part of said) expect(outcome.stderr).toContain(part);
}

describe("the block as SKILL.md has it", () => {
  const pin = { ref: assigned("REF"), sha: assigned("SHA256") };

  test("is the only install block, and assigns REPO, REF and SHA256", () => {
    expect(SKILL.split("\n").filter((line) => line === "```sh install")).toHaveLength(1);
    expect(REPO).toMatch(/^[-A-Za-z0-9]+\/[-.\w]+$/);
    expect(pin.ref).toBeDefined();
    expect(pin.sha).toBeDefined();
  });

  test("is pinned to a whole commit and to the hash recorded for the committed release, or to neither", () => {
    if (pin.ref === UNPINNED.ref && pin.sha === UNPINNED.sha) {
      // A copy without pins has no commit and no hash in it at all, and is not good enough where
      // REQUIRE_SKILL_PIN=1 asks for a pinned one.
      expect(SKILL.match(/\b[0-9a-f]{40,}\b/g)).toBeNull();
      expect(process.env.REQUIRE_SKILL_PIN).not.toBe("1");
      return;
    }
    const hashFile = path.join(ROOT, "release", `${BUNDLE_NAME}.sha256`);
    const [recorded] = fs.readFileSync(hashFile, "utf8").trim().split(/\s+/);
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.sha).toBe(recorded);
    expect(pin.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  test("is no place for npm or npx, which the file mentions only to forbid them", () => {
    const packageManager = /\bnpm\b|\bnpx\b/;
    expect(BLOCK).not.toMatch(packageManager);
    const allowing = SKILL.split("\n").filter((line) => packageManager.test(line) && !/\bNever use\b/.test(line));
    expect(allowing).toEqual([]);
  });

  test("turns on neither the shell's command tracing nor curl's verbose output", () => {
    for (const loud of [/set -[a-z]*x/, /curl[^\n]*\s-[a-zA-Z]*v/, /--verbose|--trace/]) {
      expect(BLOCK).not.toMatch(loud);
    }
  });

  test("sends no credential: the repository is public", () => {
    expect(BLOCK).not.toMatch(/TOKEN|Authorization|Bearer/);
  });

  test("contains a single URL, made of the fixed path of the release and the pinned ref", () => {
    expect(BLOCK.match(/https?:\/\/[^\s"']+/g)).toEqual(["https://api.github.com/$API"]);
    expect(BLOCK).toContain(`API="repos/$REPO/contents/release/${BUNDLE_NAME}?ref=$REF"`);
    expect(BLOCK.match(/^\s*(?:REPO|REF|SHA256|API)=/gm)).toHaveLength(4);
  });
});

describe("what stops the block before it changes anything", () => {
  test("pins that are still placeholders: exit 4, with no download and no directory made", () => {
    const on = machine({ curl: true, gh: "signed-in" });
    expectExit(install(on, UNPINNED), 4, "pins no release");
    expect(on.calls()).toEqual([]);
    expect(fs.existsSync(path.join(on.home, ".local"))).toBe(false);
  });

  test("the same pins with a file already installed: the file stays as it is, mode included", () => {
    const on = machine({ curl: true });
    on.place(OLD_RELEASE);
    expectExit(install(on, UNPINNED), 4);
    expect(permissions(on.file)).toBe(0o644);
    expect(fs.readFileSync(on.file, "utf8")).toBe(OLD_RELEASE);
  });

  test.each(["old", "absent"] as const)("a node that is %s: exit 5, with no download and no directory made", (node) => {
    const on = machine({ curl: true, gh: "signed-in", node });
    expectExit(install(on), 5, "Node.js 22 or later is required");
    expect(on.calls()).toEqual([]);
    expect(fs.existsSync(path.join(on.home, ".local"))).toBe(false);
  });
});

describe("something already at the install path", () => {
  test("the pinned release itself is kept without a download, and it and its directory get mode 700", () => {
    const on = machine({ curl: true, gh: "signed-in" });
    on.place(RELEASE);
    expectInstalled(on, install(on));
    expect(on.calls()).toEqual([]);
  });

  test("any other file is removed ahead of the download and then replaced by the verified release", () => {
    const on = machine({ curl: true });
    on.place(OLD_RELEASE);
    const outcome = install(on);
    expect(outcome.stderr).toContain("does not match the pin");
    expectInstalled(on, outcome);
  });

  test("any other file, with no means of downloading, is removed and reported as that and not as tampering", () => {
    const on = machine();
    on.place(OLD_RELEASE);
    const outcome = install(on);
    expectExit(outcome, 6, `Removed what was at ${on.file}: it does not match the pin`);
    expect(outcome.stderr).not.toContain("SHA-256 mismatch");
    expectNothingKept(on);
  });

  // The danger in a directory there: taken for "no file yet", it would have the download moved into it
  // and the block would exit 0. `node <that path>` would then run the directory's unverified index.js.
  test("a directory is never reported as an installation: exit 0 means the pinned file is in place", () => {
    const on = machine({ gh: "signed-in" });
    fs.mkdirSync(on.file, { recursive: true });
    fs.writeFileSync(path.join(on.file, "index.js"), ALTERED);
    const succeeded = install(on).code === 0;
    const there = fs.statSync(on.file, { throwIfNoEntry: false });
    const pinnedFileInPlace = there?.isFile() === true && fs.readFileSync(on.file, "utf8") === RELEASE;
    expect(succeeded).toBe(pinnedFileInPlace);
  });

  test("a download that an interrupted run left behind is not what gets installed", () => {
    const on = machine();
    fs.mkdirSync(on.dir, { recursive: true });
    fs.writeFileSync(on.download, RELEASE);
    expectExit(install(on), 6);
    expectNothingKept(on);
  });
});

describe("downloading with curl", () => {
  test("one quiet request with no credential fetches the raw file at the pinned ref, and curl is used before gh", () => {
    const on = machine({ curl: true, gh: "signed-in" });
    expectInstalled(on, install(on));
    const [call, ...more] = on.calls() as [Call, ...Call[]];
    expect(more).toEqual([]);
    expect(call).toMatchObject({ ghToken: null, stdin: "", tool: "curl" });
    const { argv } = call;
    expect(argv.join(" ")).not.toMatch(/Authorization|Bearer/);
    expect(urlsIn(argv)).toEqual([apiUrl(REF)]);
    for (const expected of ["-L", ACCEPT]) expect(argv).toContain(expected);
    expect(argv.filter((arg) => /^-[a-zA-Z]*v|^--verbose$|^--trace/.test(arg))).toEqual([]);
  });

  test("when GitHub refuses with HTTP 404: exit 2 after the one request, nothing kept or echoed", () => {
    const on = machine({ curl: 404 });
    const outcome = install(on);
    expectExit(outcome, 2, "HTTP 404", "Do not try another source");
    expect(outcome.output).not.toContain(REFUSAL);
    expect(on.calls()).toHaveLength(1);
    expectNothingKept(on);
  });

  test("when the network fails: exit 2, nothing kept", () => {
    const on = machine({ curl: "network-error" });
    expectExit(install(on), 2, "network error");
    expectNothingKept(on);
  });

  test("when the download is not the pinned release: exit 3, the download deleted and nothing installed", () => {
    const on = machine({ curl: true, served: ALTERED });
    const outcome = install(on);
    expectExit(outcome, 3, "SHA-256 mismatch");
    expect(outcome.stdout).not.toContain("installed and verified");
    expectNothingKept(on);
  });
});

describe("downloading with gh, where there is no curl", () => {
  test("a gh with a login of its own installs the verified release, and is given no token", () => {
    const on = machine({ gh: "signed-in" });
    expectInstalled(on, install(on));
    const call: Call = { ghToken: null, stdin: null, argv: ["api", "-H", ACCEPT, apiPath(REF)], tool: "gh" };
    expect(on.calls()).toEqual([call]);
  });

  test("a gh that is refused: exit 2, nothing kept or echoed", () => {
    const on = machine({ gh: "signed-out" });
    const outcome = install(on);
    expectExit(outcome, 2, "gh api failed", "Do not try another source");
    expect(outcome.output).not.toContain(REFUSAL);
    expectNothingKept(on);
  });
});

describe("neither curl nor gh", () => {
  test("exit 6 with no request made spells out the API path, the ref, the media type and where to save the file, and makes that directory private", () => {
    const on = machine();
    expectExit(
      install(on),
      6,
      "neither curl nor gh is installed",
      `GET /${apiPath(REF)}`,
      `at ref ${REF} from ${REPO}`,
      ACCEPT,
      on.file,
      "run this block again",
    );
    expect(on.calls()).toEqual([]);
    expectNothingKept(on);
    expect(permissions(on.dir)).toBe(0o700);
  });
});

describe("a pinned ref has no say in where the download comes from", () => {
  test("one that climbs out of its path still asks curl for the pinned repository's release path, and is refused", () => {
    const ref = "../../../../someone-else/their-repo/contents/another.mjs";
    const on = machine({ curl: true });
    const outcome = install(on, { ref });
    const [asked, ...others] = on.calls().flatMap(({ argv }) => urlsIn(argv));
    expect(others).toEqual([]);
    expect(asked).toBe(apiUrl(ref));
    expect(new URL(asked as string).pathname).toBe(`/repos/${REPO}/contents/release/${BUNDLE_NAME}`);
    expectExit(outcome, 2);
    expectNothingKept(on);
  });

  test("one with a space in it reaches gh as a single argument, on the release path of the pinned repository", () => {
    const ref = "two words";
    const on = machine({ gh: "signed-in" });
    const outcome = install(on, { ref });
    expect(on.calls().map(({ argv }) => argv)).toEqual([["api", "-H", ACCEPT, apiPath(ref)]]);
    expectExit(outcome, 2);
    expectNothingKept(on);
  });
});

describe("under the POSIX shells", () => {
  const find = (name: string) => [`/bin/${name}`, `/usr/bin/${name}`].find((candidate) => fs.existsSync(candidate));
  const [dash, bash] = [find("dash"), find("bash")];

  /** A first run that downloads, then one that has only to verify. */
  function installsThenVerifies(shell: string | undefined): void {
    const on = machine({ curl: true });
    expectInstalled(on, install(on, { shell }));
    expectInstalled(on, install(on, { shell }));
    expect(on.calls()).toHaveLength(1);
  }

  test.skipIf(!dash)("dash downloads once and verifies on the second run", () => installsThenVerifies(dash));
  test.skipIf(!bash)("bash downloads once and verifies on the second run", () => installsThenVerifies(bash));

  test.skipIf(!dash)("dash exits with the same codes for the same failures", () => {
    const shell = dash;
    expect(install(machine({ curl: 401 }), { shell }).code).toBe(2);
    expect(install(machine({ curl: true, served: ALTERED }), { shell }).code).toBe(3);
    expect(install(machine(), { shell, ref: UNPINNED.ref }).code).toBe(4);
    expect(install(machine(), { shell }).code).toBe(6);
  });
});

describe("the real curl, invoked the way the block invokes it", () => {
  const curlInstalled = spawnSync("curl", ["--version"]).status === 0;
  const curlCommand = (accept: string, out: string, format: string, url: string) =>
    `curl -sS -L -H "${accept}" -o ${out} -w '${format}' ${url} < /dev/null`;

  test("the command in the block is the one the next test runs", () => {
    const inBlock = BLOCK.split("\n").find((line) => line.includes("curl -sS"));
    expect(inBlock).toContain(curlCommand("$ACCEPT", '"$TMP"', "%{http_code}", '"$URL"'));
  });

  /** A server on this machine under the given host name, answering every request with `respond`. */
  async function serve(host: string, respond: http.RequestListener) {
    const server = http.createServer(respond);
    await new Promise<void>((listening) => server.listen(0, host, listening));
    return { server, origin: `http://${host}:${(server.address() as AddressInfo).port}` };
  }

  test.skipIf(!curlInstalled)(
    "follows GitHub's redirect to the file and sends no credential to either host",
    async () => {
      const received: [host: string, authorization: string | undefined][] = [];
      const storage = await serve("127.0.0.1", (request, response) => {
        received.push(["storage", request.headers.authorization]);
        response.end(RELEASE);
      });
      const api = await serve("localhost", (request, response) => {
        received.push(["api", request.headers.authorization]);
        response.writeHead(302, { location: `${storage.origin}/the-file` }).end();
      });
      try {
        const command = curlCommand(ACCEPT, "-", " %{http_code}", `"${api.origin}/${apiPath(REF)}"`);
        const options = { encoding: "utf8", env: { PATH: process.env.PATH } } as const;
        const printed = await new Promise<string>((resolve, reject) => {
          exec(command, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
        });
        expect(printed).toBe(`${RELEASE} 200`);
        expect(received).toEqual([
          ["api", undefined],
          ["storage", undefined],
        ]);
      } finally {
        for (const { server } of [storage, api]) server.close();
      }
    },
  );
});
