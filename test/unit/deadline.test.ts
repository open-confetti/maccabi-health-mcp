/**
 * A single rule of the transport is out of the fake Maccabi's reach. The fake ends a request when it is
 * aborted, exactly as `fetch` does, so it cannot play a `fetch` that does not: one that stays pending
 * even after the abort. The deadline has to end that request too. The transport's other rules are in
 * test/integration/http.test.ts, where they run in the bundle.
 */
import { expect, test } from "vitest";
import { PORTAL_SITE, PortalHttp } from "../../src/maccabi/http";

test("the deadline ends a request whose fetch never settles, abort or no abort, and nothing is tried again", async () => {
  const asked: string[] = [];
  const pendingForGood = new Promise<Response>(() => {});
  const deaf = (url: unknown) => {
    asked.push(String(url));
    return pendingForGood;
  };
  const transport = new PortalHttp({ fetch: deaf, timeoutMs: 50 });

  const request = transport.request(`${PORTAL_SITE}/sonline/never-answered`);

  await expect(request).rejects.toHaveProperty("code", "TIMED_OUT");

  expect(asked).toHaveLength(1);
});
