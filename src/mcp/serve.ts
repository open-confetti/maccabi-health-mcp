import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Runtime } from "../operations/execute";
import { SessionStore } from "../session/files";
import { createRenewer, KEEP_ALIVE_EVERY_MS } from "../session/keep-alive";
import { createServer, type Queue, serialQueue } from "./server";

/** stdout is the protocol channel, so anything meant for a person goes to stderr. */
function note(notice: string): void {
  process.stderr.write(`maccabi-health mcp: ${notice}\n`);
}

/**
 * Keeps the saved session from idling out while the server is running. It shares the tool queue, so
 * a renewal never overlaps a read in this process, and it stays quiet: the next read reports what is
 * wrong.
 */
function beginKeepAlive(runtime: Runtime, queue: Queue): () => void {
  const renew = createRenewer(runtime.store, runtime.fetch);
  let failures = 0;
  const timer = setInterval(() => {
    queue(renew).then(
      () => {
        failures = 0;
      },
      () => {
        failures += 1;
        if (failures >= 3) clearInterval(timer);
      },
    );
  }, KEEP_ALIVE_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** The `mcp` command. It returns the exit code once the server has shut down. */
export async function mcpMain(argv: readonly string[]): Promise<number> {
  if (argv.length > 0) {
    note("this command takes no options. Sign in separately with `maccabi-health login`.");
    return 2;
  }
  const runtime: Runtime = { store: new SessionStore(), warn: note };
  const queue = serialQueue();
  const handle = serveStdio(() => createServer(runtime, queue), { onerror: () => note("transport error") });
  const endKeepAlive = beginKeepAlive(runtime, queue);

  // The server ends when the client goes away (stdin ends or closes) or the process is signalled.
  // Whichever comes first shuts it down; the later ones find the shutdown already under way.
  let shutdown: Promise<number> | undefined;
  const shutDown = (): Promise<number> => {
    endKeepAlive();
    // The transport is closed and the process left to end by itself, so a reply that is still
    // being written goes out whole.
    return handle.close().then(
      () => 0,
      () => 1,
    );
  };
  return new Promise<number>((resolve) => {
    const onEnd = (): void => {
      shutdown ??= shutDown();
      void shutdown.then(resolve);
    };
    for (const event of ["end", "close"] as const) process.stdin.once(event, onEnd);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, onEnd);
  });
}
