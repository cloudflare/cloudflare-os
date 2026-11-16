import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { API_SESSION_HEADER, openApiSessionObject, type ApiSessionDurableObject } from "../src/server.js";
// Load the whole backend (the pool's `main`) up front. Otherwise the pool loads it on the first
// call into the Durable Object, and that slow load counts against the first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_API_SESSION: DurableObjectNamespace<ApiSessionDurableObject>;
  }
}

const upgradeRequest = (headers: Record<string, string> = {}) =>
  new Request("https://workshop.example/api", { headers: { Upgrade: "websocket", ...headers } });

describe("ApiSessionDurableObject", () => {
  it("refuses a request that did not come through the fetch handler", async () => {
    const stub = env.TEST_API_SESSION.get(env.TEST_API_SESSION.newUniqueId());
    const response = await stub.fetch(upgradeRequest());
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });

  it("refuses anything but a WebSocket upgrade", async () => {
    const stub = env.TEST_API_SESSION.get(env.TEST_API_SESSION.newUniqueId());
    const response = await stub.fetch(new Request("https://workshop.example/api",
        { method: "POST", headers: { [API_SESSION_HEADER]: "null" } }));
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

describe("openApiSessionObject", () => {
  // Captures what the fetch handler sends, without creating an object.
  const capture = () => {
    const sent: Request[] = [];
    const sessions = {
      newUniqueId: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async (req: Request) => { sent.push(req); return new Response(null, { status: 204 }); },
      }),
    } as unknown as DurableObjectNamespace<ApiSessionDurableObject>;
    return { sent, sessions };
  };

  it("replaces a session header the client sent with the verified one", async () => {
    const { sent, sessions } = capture();
    const forged = JSON.stringify({ payload: {}, jwt: "forged", email: "admin@example.com" });
    const verified = { payload: { sub: "u1" }, jwt: "real-jwt", email: "ada@example.com" };
    await openApiSessionObject(upgradeRequest({ [API_SESSION_HEADER]: forged }), sessions, verified);
    expect(JSON.parse(sent[0]!.headers.get(API_SESSION_HEADER)!)).toEqual(verified);
  });

  it("sends null when Access is off, even if the client sent a session", async () => {
    const { sent, sessions } = capture();
    await openApiSessionObject(
        upgradeRequest({ [API_SESSION_HEADER]: '{"email":"admin@example.com"}' }), sessions, undefined);
    expect(sent[0]!.headers.get(API_SESSION_HEADER)).toBe("null");
    expect(sent[0]!.headers.get("Upgrade")).toBe("websocket");
  });
});
