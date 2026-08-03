import { describe, expect, it } from "vitest";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { defaultModelSeeds } from "../src/default-models.js";

const DEPLOY_URL = "https://deploy.example.com/instances/abc123";

describe("defaultModelSeeds", () => {
  it("returns no seeds when DEPLOY_URL is not set", () => {
    expect(defaultModelSeeds({} as Cloudflare.Env)).toEqual([]);
  });

  it("seeds every suggested Workers AI model on a deploy-flow instance", () => {
    const seeds = defaultModelSeeds({ DEPLOY_URL } as Cloudflare.Env);

    const expected = Object.entries(SUGGESTED_MODELS.cloudflare);
    expect(expected.length).toBeGreaterThan(0);
    expect(seeds).toHaveLength(expected.length);

    for (const [i, [id, name]] of expected.entries()) {
      expect(seeds[i].profile).toEqual({ type: "agent", id, name });
      expect(seeds[i].config).toEqual({ provider: "cloudflare", model: id, apiToken: "" });
      expect(seeds[i].config.apiUrl).toBeUndefined();
    }
  });

  it("returns no seeds in AI Gateway mode (gateway virtuals cover these models)", () => {
    const env = { DEPLOY_URL, CF_AI_GATEWAY: "gadgets" } as Cloudflare.Env;
    expect(defaultModelSeeds(env)).toEqual([]);
  });
});
