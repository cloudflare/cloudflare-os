import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { getServerConfig } from "../src/deployment-config.js";

// The pool binds no BLUEPRINTS namespace, where getServerConfig reads the admin config.
function config(vars: object) {
  return getServerConfig({ ...env, BLUEPRINTS: { get: async () => null }, ...vars } as Cloudflare.Env);
}

describe("ServerConfig.authMode", () => {
  it("says Cloudflare Access where the deployment verifies Access tokens", async () => {
    const access = { CF_ACCESS_AUD: "workshop-audience", CF_ACCESS_ISS: "https://team.cloudflareaccess.com" };
    expect((await config(access)).authMode).toBe("cfAccess");
  });

  it("says token where it does not", async () => {
    expect((await config({ CF_ACCESS_AUD: undefined, CF_ACCESS_ISS: undefined })).authMode).toBe("token");
    expect((await config({ CF_ACCESS_AUD: "" })).authMode).toBe("token");
  });
});
