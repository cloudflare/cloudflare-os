// Live end-to-end test: deploys a full Cloudflare OS to the real account
// (default-on gatekeepers, no domain — served at the router's workers.dev
// URL), verifies the deployed system serves, and destroys it.
//
//   pnpm --dir packages/alchemy test:e2e
//
// Uses the same alchemy profile/state as `alchemy deploy`. Set NO_DESTROY=1
// to keep the deployment around between runs while iterating.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { expect } from "vitest";
import { OperatingSystem } from "../src/index.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const Stack = Alchemy.Stack(
  "CloudflareOsE2E",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // Everything defaulted: password auth, BYOK AI, the default-on
    // gatekeepers (context, scheduler, mcp), workers.dev origin.
    const os = yield* OperatingSystem("OS");
    return { url: os.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 900_000,
});

test(
  "serves the frontend at the public origin",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.getWhenReady(`${url}/`, { times: 25 });
    expect(response.status).toBe(200);
    const body = yield* response.text;
    // The workshop-frontend SPA shell, served by the router's ASSETS
    // binding with the vite build's output.
    expect(body).toContain('<div id="root">');
    expect(body).toContain("Cloudflare OS");
  }),
);

test(
  "routes /api to the workshop backend",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // `/api` is the backend's capnweb PublicApi endpoint. A plain GET is
    // not a valid RPC/WebSocket request, but any deliberate client
    // response proves the whole chain: router `run_worker_first` →
    // WORKSHOP_BACKEND service binding → backend booted with its KV, R2,
    // browser, loader, and Durable Object bindings resolved.
    const response = yield* Test.getWhenReady(`${url}/api`, { times: 25 });
    expect(response.status).toBeLessThan(500);
  }),
);

test(
  "routes /gatekeeper/* to gatekeeper workers",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // The mcp gatekeeper's HTTP surface answers under
    // /gatekeeper/mcp/* (forwarded whole by the router's GATEKEEPER_MCP
    // service binding). Any non-5xx response — including a structured
    // 4xx for an unknown path — proves the gatekeeper worker deployed
    // and the router reaches it. (Plain client: 404 here is a real
    // answer, not a cold-start signal, and the edge is already warm from
    // the previous tests.)
    const response = yield* client.get(`${url}/gatekeeper/mcp/connect`);
    expect(response.status).toBeLessThan(500);
  }),
);
