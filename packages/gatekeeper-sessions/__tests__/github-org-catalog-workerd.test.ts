import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Bundle separately from Vitest's mocked cloudflare:workers and validation aliases.
const require = createRequire(import.meta.url);
const rpcValidation = require("capnweb-validate/esbuild");
const tooling = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare } = tooling("miniflare");
const { build } = tooling("esbuild");

const worker = `
import { DurableObject, RpcTarget } from "cloudflare:workers";
export {
  GitHubOrganizationAccount, GitHubOrganizationGatekeeper,
} from "./src/github-org.ts";

class Authorizer extends RpcTarget {
  authorizeObservation() {
    throw new Error("An absent catalog must not read or disclose repository metadata");
  }
}

// Negative control for the pre-fix receiver shape; a property lookup on its stub still looks callable.
export class LegacyGatekeeper extends DurableObject {
  async describe() { return { title: "Legacy singleton" }; }
}

export class TestHost extends DurableObject {
  async inspect(legacy) {
    const account = this.ctx.exports.GitHubOrganizationAccount({ props: { accountId: "test" } });
    const accountDescription = await account.describe();
    const facetClass = legacy
      ? this.ctx.exports.LegacyGatekeeper({ props: {} })
      : await account.getSingletonGatekeeperClass();
    const facet = this.ctx.facets.get(legacy ? "legacy" : "current", () => ({ class: facetClass }));
    const resource = await facet.describe();
    const methodType = typeof facet.getAgentCatalog;
    try {
      const catalog = await facet.getAgentCatalog(new Authorizer());
      return { runtime: navigator.userAgent, accountDescription, resource, methodType, catalog };
    } catch (error) {
      return { methodType, error: error.message };
    }
  }
}

export default {
  async fetch(request, env) {
    return Response.json(await env.HOST.getByName("catalog").inspect(
      new URL(request.url).pathname === "/legacy"));
  },
};
`;

describe("GitHub organization singleton catalog over workerd facets", () => {
  let mf: InstanceType<typeof Miniflare> | undefined;

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: worker,
        resolveDir: fileURLToPath(new URL("..", import.meta.url)),
        sourcefile: "github-org-catalog-worker.ts",
        loader: "ts",
      },
      bundle: true,
      preserveSymlinks: true,
      write: false,
      format: "esm",
      target: "es2022",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["cloudflare:*", "node:*"],
      loader: { ".txt": "text" },
      plugins: [rpcValidation()],
    });
    mf = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-02-02",
      compatibilityFlags: ["nodejs_compat", "allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
      durableObjects: { HOST: { className: "TestHost", useSQLite: true } },
      outboundService: () => { throw new Error("Catalog must not fetch GitHub or mint a token"); },
    });
  }, 60_000);

  afterAll(async () => { await mf?.dispose(); });

  it("accepts the authorizer argument on the advertised singleton facet and returns no catalog", async () => {
    const response = await mf!.dispatchFetch("http://localhost/current");
    expect(await response.json()).toMatchObject({
      runtime: "Cloudflare-Workers",
      accountDescription: { singleton: { tsType: "GitHubOrganizationSession" } },
      resource: { title: "Totango GitHub", tsType: "GitHubOrganizationSession", suggestedBindingName: "GITHUB_ORG" },
      methodType: "function",
      catalog: null,
    });
  });

  it("demonstrates why typeof cannot detect a missing RPC method on a historical receiver", async () => {
    const response = await mf!.dispatchFetch("http://localhost/legacy");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      methodType: "function",
      error: expect.stringMatching(/does not implement.*getAgentCatalog/),
    });
  });
});
