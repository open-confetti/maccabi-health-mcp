/**
 * The build. It writes three files into a directory:
 *
 *   maccabi-health.mjs          the whole tool, CLI and MCP server, in one file that needs only `node`
 *   maccabi-health.mjs.sha256   its hash, in the format `sha256sum -c` reads
 *   THIRD_PARTY_LICENSES.txt    the license notices, which also open the bundle as a comment
 *
 *   node scripts/build.mjs [dir]             into dir, or dist/ when none is named
 *   node scripts/build.mjs --release         into release/
 *   node scripts/build.mjs --check-release   builds elsewhere and fails if release/ differs
 *
 * Two builds of one tree and one lockfile are byte-identical: nothing in the output records a time
 * or a path on the machine that built it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = "maccabi-health.mjs";
const HASH = `${BUNDLE}.sha256`;
const LICENSES = "THIRD_PARTY_LICENSES.txt";
const RULE = `\n\n${"-".repeat(70)}\n\n`;

/**
 * Every package that may end up inside the bundle, each one reviewed. If a dependency, or a
 * dependency of one, brings in a package missing from this list, the build stops until someone
 * decides to add it.
 */
const BUNDLED_PACKAGES = new Set([
  "@modelcontextprotocol/core",
  "@modelcontextprotocol/server",
  "boolbase",
  "css-select",
  "css-what",
  "dom-serializer",
  "domelementtype",
  "domhandler",
  "domutils",
  "entities",
  "htmlparser2",
  "nth-check",
  "tldts",
  "tldts-core",
  "tough-cookie",
  "zod",
]);

/**
 * Some packages arrive already bundled inside another package's published files, where esbuild
 * cannot see them as modules. tldts carries tldts-core that way, unmarked. The MCP SDK carries ajv
 * and what ajv needs, and leaves a `#region …/node_modules/.pnpm/<name>@<version>/…` comment at each.
 * Their licenses are kept in licenses/embedded/; the build fails when one is not there.
 */
const INLINED_WITHOUT_MARKER = { tldts: ["tldts-core"] };
const INLINED_REGION = /#region [^\n]*?node_modules\/\.pnpm\/((?:@[^+/@]+\+)?[^/@]+)@(\d[^/_]*)/g;

/** The package folder a bundled file belongs to, or undefined for a file of this project. */
function packageFolder(file) {
  const segments = relative(root, resolve(root, file)).split(sep);
  const at = segments.lastIndexOf("node_modules");
  if (at < 0) return undefined;
  const scoped = segments[at + 1]?.startsWith("@");
  return join(root, ...segments.slice(0, at + (scoped ? 3 : 2)));
}

/** A package's name, version and license texts, read from its folder. */
function describe(folder) {
  const { name, version, license = "UNKNOWN" } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const texts = readdirSync(folder)
    .filter((entry) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry))
    .sort()
    .map((entry) => readFileSync(join(folder, entry), "utf8").trim());
  return { name, version, license, text: texts.join("\n\n") };
}

/** The packages a bundled file carries inside itself and announces with region comments. */
function* announcedInside(file, carrier) {
  for (const [, pnpmName, version] of readFileSync(resolve(root, file), "utf8").matchAll(INLINED_REGION)) {
    const name = pnpmName.replace("+", "/");
    const kept = join(root, "licenses", "embedded", `${name.replace("/", "__")}@${version}.LICENSE`);
    yield { name, version, kept, license: `embedded in ${carrier.name}@${carrier.version}` };
  }
}

/** One notice per package version that contributed a file, checked against the reviewed list. */
function gatherNotices(bundledFiles) {
  const byVersion = new Map();
  const keyOf = ({ name, version }) => `${name}@${version}`;
  const record = (notice) => byVersion.set(keyOf(notice), notice);
  for (const file of bundledFiles) {
    const folder = packageFolder(file);
    if (!folder) continue;
    const carrier = describe(folder);
    if (!BUNDLED_PACKAGES.has(carrier.name)) {
      throw new Error(
        `${carrier.name} is not in BUNDLED_PACKAGES (scripts/build.mjs); it has to be reviewed before it can ship`,
      );
    }
    record(carrier);
    for (const unmarked of INLINED_WITHOUT_MARKER[carrier.name] ?? []) {
      record(describe(join(root, "node_modules", unmarked)));
    }
    for (const { kept, ...inner } of announcedInside(file, carrier)) {
      if (byVersion.has(keyOf(inner))) continue;
      if (!existsSync(kept)) {
        throw new Error(`${keyOf(inner)} is inlined in ${carrier.name} but ${relative(root, kept)} is missing`);
      }
      record({ ...inner, text: readFileSync(kept, "utf8").trim() });
    }
  }
  return [...byVersion.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function noticesText(bundledFiles) {
  const ours = readFileSync(join(root, "LICENSE"), "utf8").trim();
  const theirs = gatherNotices(bundledFiles).map(
    ({ name, version, license, text }) => `${name}@${version} (${license})\n\n${text || `License: ${license}`}`,
  );
  return [
    "maccabi-health, built as a single file. Below are the license notices of this project and of each package bundled into it.",
    `maccabi-health\n\n${ours}`,
    ...theirs,
  ].join(RULE);
}

/** Bundles the tree and writes the three files into `outDir`; returns the bundle's hash. */
async function buildInto(outDir) {
  const { metafile, outputFiles } = await build({
    absWorkingDir: root,
    entryPoints: ["src/main.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    metafile: true,
    // Comments in dependencies contain example URLs. Left in, they would drown out a real host name
    // when the bundle is scanned for hosts.
    legalComments: "none",
    logLevel: "warning",
  });
  const notices = noticesText(Object.keys(metafile.inputs));
  // The notices become the opening comment, so nothing in them may close it early.
  const banner = `/*!\n${notices.replace(/\*\//g, "* /")}\n*/\n`;
  const code = `#!/usr/bin/env node\n${banner}${outputFiles[0].text.replace(/^#![^\n]*\n/, "")}`;
  const hash = createHash("sha256").update(code).digest("hex");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, BUNDLE), code, { mode: 0o755 });
  writeFileSync(join(outDir, HASH), `${hash}  ${BUNDLE}\n`);
  writeFileSync(join(outDir, LICENSES), `${notices}\n`);
  return hash;
}

/** Builds into a throwaway directory and compares each file with the committed one. */
async function checkRelease() {
  const fresh = mkdtempSync(join(tmpdir(), "maccabi-build-"));
  try {
    const hash = await buildInto(fresh);
    const sameAsCommitted = (file) => {
      const committed = join(root, "release", file);
      return existsSync(committed) && readFileSync(committed).equals(readFileSync(join(fresh, file)));
    };
    const stale = [BUNDLE, HASH, LICENSES].filter((file) => !sameAsCommitted(file));
    if (stale.length === 0) {
      process.stdout.write(`release/ matches a fresh build: ${hash}\n`);
      return;
    }
    process.stderr.write(`release/ is not a build of this tree (${stale.join(", ")}). Run: npm run release\n`);
    process.exitCode = 1;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

const [option] = process.argv.slice(2);
if (option === "--check-release") {
  await checkRelease();
} else {
  const outDir = option === "--release" ? join(root, "release") : resolve(root, option ?? "dist");
  const hash = await buildInto(outDir);
  process.stdout.write(`${hash}  ${relative(root, join(outDir, BUNDLE))}\n`);
}
