/**
 * Measures which lines of this project's own code, inside the built bundle, the integration tests
 * execute. The tests run the bundle in child processes, so ordinary test coverage sees nothing; this
 * asks Node to record coverage in each of those processes and adds the records up.
 *
 * Usage: node scripts/coverage.mjs            run the integration tests and print a summary
 *        node scripts/coverage.mjs --lines    also print every uncovered line
 *        node scripts/coverage.mjs --save F   write the covered lines to F
 *        node scripts/coverage.mjs --against F   fail if a line covered in F is no longer covered
 *        node scripts/coverage.mjs --reuse DIR   skip the test run and read records from DIR
 *        node scripts/coverage.mjs --min N    fail if less than N percent of the lines are covered
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? "");
};

const reuse = option("--reuse");
const records = reuse ?? mkdtempSync(join(tmpdir(), "maccabi-coverage-"));
if (!reuse) {
  const run = spawnSync("npx", ["vitest", "run", "--project", "integration"], {
    cwd: root,
    env: { ...process.env, MACCABI_COVERAGE_DIR: records },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (run.status !== 0) {
    process.stderr.write("The integration tests failed; coverage of a failing run means nothing.\n");
    process.exit(1);
  }
}

const bundle = readFileSync(join(root, "dist", "maccabi-health.mjs"), "utf8");

// One byte per character of the bundle: 0 never reached, 1 executed in some process.
const executed = new Uint8Array(bundle.length);
for (const name of readdirSync(records)) {
  if (!name.endsWith(".json")) continue;
  const { result } = JSON.parse(readFileSync(join(records, name), "utf8"));
  for (const script of result) {
    if (!script.url.endsWith("/maccabi-health.mjs")) continue;
    const counts = new Int32Array(bundle.length).fill(-1);
    for (const fn of script.functions) {
      // Ranges come outermost first, so a later, inner range overrides the count around it.
      for (const range of fn.ranges) counts.fill(range.count, range.startOffset, range.endOffset);
    }
    for (let index = 0; index < counts.length; index += 1) if (counts[index] > 0) executed[index] = 1;
  }
}
if (!reuse) rmSync(records, { recursive: true, force: true });

// esbuild marks where each module starts with a `// path` comment at column zero.
const lines = bundle.split("\n");
const report = new Map();
let module = null;
let offset = 0;
for (const [index, line] of lines.entries()) {
  const marker = /^\/\/ ((?:src|node_modules)\/\S+)$/.exec(line);
  if (marker) module = marker[1].startsWith("src/") ? marker[1] : null;
  else if (module && /[A-Za-z0-9]/.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) {
    const entry = report.get(module) ?? { total: 0, missed: [] };
    entry.total += 1;
    const first = offset + line.length - line.trimStart().length;
    let ran = false;
    for (let at = first; at < offset + line.length; at += 1) ran ||= executed[at] === 1;
    if (!ran) entry.missed.push(`${index + 1}: ${line.trim().slice(0, 150)}`);
    report.set(module, entry);
  }
  offset += line.length + 1;
}

let total = 0;
let missed = 0;
for (const [name, entry] of [...report].sort()) {
  total += entry.total;
  missed += entry.missed.length;
  const percent = (100 * (1 - entry.missed.length / entry.total)).toFixed(1).padStart(5);
  process.stdout.write(`${percent}%  ${String(entry.missed.length).padStart(4)} missed  ${name}\n`);
  if (process.argv.includes("--lines")) for (const line of entry.missed) process.stdout.write(`        ${line}\n`);
}
const percent = 100 * (1 - missed / total);
process.stdout.write(`${percent.toFixed(1)}%  ${missed} of ${total} lines missed\n`);

const missedLines = new Set(
  [...report.values()].flatMap((entry) => entry.missed.map((line) => Number.parseInt(line, 10))),
);
const save = option("--save");
if (save) writeFileSync(save, JSON.stringify([...missedLines]));
const against = option("--against");
if (against) {
  const before = new Set(JSON.parse(readFileSync(against, "utf8")));
  const lost = [...missedLines].filter((line) => !before.has(line)).sort((a, b) => a - b);
  if (lost.length > 0) {
    process.stderr.write(`${lost.length} lines were covered before and are not now:\n`);
    for (const line of lost) process.stderr.write(`  ${line}: ${lines[line - 1].trim().slice(0, 150)}\n`);
    process.exit(1);
  }
  process.stdout.write("No line lost coverage.\n");
}
const minimum = option("--min");
if (minimum !== undefined && percent < Number(minimum)) {
  process.stderr.write(`Coverage is below ${minimum}%. Cover the new code with an integration test.\n`);
  process.exit(1);
}
