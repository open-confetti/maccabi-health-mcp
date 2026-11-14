/**
 * Each MCP tool call waits its turn in a queue whose deadline is four minutes, which is longer than a
 * test through the bundle can sit out. So this one piece of the server is taken on its own here, with
 * deadlines of a few dozen milliseconds.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, test } from "vitest";
import { createServer, serialQueue } from "../../src/mcp/server";
import type { SessionStore } from "../../src/session/files";

/** A task that is never done. */
const hang = () => new Promise<never>(() => {});
const done = async () => "done";

describe("serialQueue", () => {
  test("runs its tasks in the order they came, each one only after the one before has ended", async () => {
    const run = serialQueue(1_000);
    const log: string[] = [];
    const task = (name: string, takes: number) => async () => {
      log.push(`${name} begins`);
      await sleep(takes);
      log.push(`${name} is over`);
      return name;
    };
    // The slowest task is queued first, so tasks running side by side would end in another order.
    const queued = [run(task("a", 30)), run(task("b", 1)), run(task("c", 10))];

    expect(await Promise.all(queued)).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a", "b", "c"].flatMap((name) => [`${name} begins`, `${name} is over`]));
  });

  test("gives up at the deadline on a task that never ends, and then runs the next one", async () => {
    const run = serialQueue(40);
    const hanging = run(hang);
    const next = run(done);

    await expect(hanging).rejects.toBeInstanceOf(Error);
    await expect(next).resolves.toBe("done");
  });

  test("starts a task's deadline when the task starts, and not while it is still waiting its turn", async () => {
    const run = serialQueue(60);
    const hanging = [run(hang), run(hang)].map((task) => task.catch(() => "given up on"));
    const behindThem = run(done);

    await expect(behindThem).resolves.toBe("done");
    expect(await Promise.all(hanging)).toEqual(["given up on", "given up on"]);
  });

  test("aborts the signal of a task it gave up on, and leaves alone the signal of one that ended in time", async () => {
    const run = serialQueue(40);
    const seen: Record<string, AbortSignal> = {};
    const prompt = run(async (signal) => {
      seen.prompt = signal;
    });
    const hanging = run((signal) => {
      seen.hanging = signal;
      return hang();
    });

    await prompt;
    await expect(hanging).rejects.toBeInstanceOf(Error);
    // Wait beyond the deadline the prompt task would have had, which its timely end has cancelled.
    await sleep(60);
    expect(seen.hanging?.aborted).toBe(true);
    expect(seen.prompt?.aborted).toBe(false);
  });
});

describe("a server on a queue with a short deadline", () => {
  test("answers TIMED_OUT to a tool call that hangs, and serves the call after it", async () => {
    // The first look at the session never returns. Every later one finds nothing stored.
    let looks = 0;
    const store = {
      loadPending: async () => null,
      load() {
        looks += 1;
        return looks === 1 ? hang() : Promise.resolve(null);
      },
    } as unknown as SessionStore;
    const server = createServer({ warn: () => {}, store }, serialQueue(40));
    const client = new Client({ version: "1", name: "serial-queue-test" });
    const [toServer, toClient] = InMemoryTransport.createLinkedPair();
    await server.connect(toClient);
    await client.connect(toServer);
    const status = () => client.callTool({ name: "maccabi_status", arguments: {} });
    try {
      const hanging = await status();
      expect(hanging.structuredContent).toEqual({
        error: { message: expect.any(String), code: "TIMED_OUT", cause: "network", retry: "later" },
      });
      expect(hanging.isError).toBe(true);

      expect((await status()).structuredContent).toEqual({ status: "signed-out" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
