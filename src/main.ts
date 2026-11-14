import { cliMain } from "./cli/run";

const argv = process.argv.slice(2);

if (argv[0] === "mcp") {
  const { mcpMain } = await import("./mcp/serve");
  process.exitCode = await mcpMain(argv.slice(1));
} else {
  process.exitCode = await cliMain(argv, {
    env: process.env,
    stdout: (str) => process.stdout.write(str),
    stderr: (str) => process.stderr.write(str),
  });
}
