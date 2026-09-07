import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Use Wrangler's installed tooling without adding dependencies or changing the
// package's Node-based Vitest config (whose cloudflare:workers alias is a mock).
const require = createRequire(import.meta.url);
const tooling = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare } = tooling("miniflare");
const { build } = tooling("esbuild");

const url = "http://localhost:4097/pi/command?transport=rpc";
const body = JSON.stringify({ type: "prompt", message: "transport fixture: \u03c0\n" });

// This is bundled independently of Vitest, so both cloudflare:workers and the
// SDK resolve for real inside workerd. The DO substitutes only the container
// execution boundary: request construction is the installed Sandbox parser,
// not a reimplementation that might accidentally accept an invalid overload.
// No Sandbox constructor, image, container binding, or external fetch is used.
const worker = `
import { DurableObject } from "cloudflare:workers";
import { getSandbox, Sandbox } from "@cloudflare/sandbox";

export class TransportReceiver extends DurableObject {
  defaultPort = 3000;
  calls = 0;
  configuration;

  configure(configuration) { this.configuration = configuration; }
  snapshot() { return { calls: this.calls, configuration: this.configuration }; }

  async containerFetch(...args) {
    this.calls++;
    const { request, port } = Sandbox.prototype.parseContainerFetchArgs.call(this, ...args);
    return Response.json({
      runtime: navigator.userAgent,
      argumentTypes: args.map(arg => typeof arg),
      requestConstructed: request instanceof Request,
      method: request.method,
      body: await request.text(),
      redirect: request.redirect,
      url: request.url,
      contentType: request.headers.get("content-type"),
      port,
    });
  }
}

export default {
  async fetch(request, env) {
    const shape = new URL(request.url).pathname.slice(1);
    const sandbox = getSandbox(env.RECEIVER, shape);
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ${JSON.stringify(body)},
      redirect: "manual",
    };
    let result;
    try {
      const response = shape === "old-request"
        ? await sandbox.containerFetch(new Request(${JSON.stringify(url)}, {
            ...init, signal: AbortSignal.timeout(30_000),
          }), 4097)
        : await sandbox.containerFetch(${JSON.stringify(url)}, init, 4097);
      result = { ok: true, received: await response.json() };
    } catch (error) {
      result = { ok: false, error: { name: error.name, message: error.message } };
    }
    // Also proves getSandbox's configure call completed over the real stub.
    return Response.json({ ...result, receiver: await sandbox.snapshot() });
  }
};
`;

describe("Pi transport through installed Sandbox SDK and workerd RPC", () => {
  let mf: InstanceType<typeof Miniflare> | undefined;

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: worker,
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        sourcefile: "pi-transport-worker.js",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["cloudflare:*", "node:*"],
    });
    mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-02-02",
      // Deliberately do not enable AbortSignal RPC serialization: this is the
      // compatibility behavior under which the production call shape failed.
      compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
      durableObjects: { RECEIVER: "TransportReceiver" },
    });
    await mf.ready;
  }, 30_000);

  afterAll(async () => { await mf?.dispose(); });

  it("rejects Request + timeout signal before reaching the receiver", async () => {
    const response = await mf!.dispatchFetch("http://transport.test/old-request");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      ok: false,
      error: { message: "AbortSignal serialization is not enabled." },
      receiver: { calls: 0, configuration: { sandboxName: { name: "old-request" } } },
    });
  });

  it("carries string + plain init + explicit 4097 over RPC and reconstructs the request", async () => {
    const response = await mf!.dispatchFetch("http://transport.test/plain-init");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      ok: true,
      receiver: { calls: 1, configuration: { sandboxName: { name: "plain-init" } } },
      received: {
        runtime: "Cloudflare-Workers",
        argumentTypes: ["string", "object", "number"],
        requestConstructed: true,
        method: "POST",
        body,
        redirect: "manual",
        url,
        contentType: "application/json",
        port: 4097,
      },
    });
  });
});
