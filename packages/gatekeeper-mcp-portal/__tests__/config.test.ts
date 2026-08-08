import { describe, expect, it } from "vitest";
import {
  portalResource,
  portalAuthRequiresReconnect,
  portalServer,
  portalTokenFor,
  portalTrust,
  readPortalConfig,
  requirePortalServerScope,
} from "../src/config.js";

function env(overrides: Record<string, string> = {}): Env {
  return overrides as unknown as Env;
}

describe("readPortalConfig", () => {
  it("returns null when unconfigured, so the connector hides itself", () => {
    // Advertising no resources is how the Workshop drops a vendor. A connector that appears in the
    // list and then errors when clicked would be the worse failure.
    expect(readPortalConfig(env())).toBeNull();
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "   " }))).toBeNull();
  });

  it("returns null for an unparseable or non-HTTP URL", () => {
    // An administrator-set URL is trusted, but a typo that produced a non-HTTP scheme should not
    // reach `fetch`.
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "not a url" }))).toBeNull();
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "file:///etc/passwd" }))).toBeNull();
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "javascript:alert(1)" }))).toBeNull();
  });

  it("rejects URL credentials rather than persisting or displaying them", () => {
    // This endpoint is copied into account state, resource URLs, and configurator inputs. Userinfo
    // would both become ambient fetch credentials and expose the configured secret to users.
    expect(readPortalConfig(env({
      MCP_PORTAL_URL: "https://admin:secret@gw.example.com/mcp",
    }))).toBeNull();
    expect(readPortalConfig(env({
      MCP_PORTAL_URL: "https://admin@gw.example.com/mcp",
    }))).toBeNull();
  });

  it("reads the endpoint and strips any fragment, defaulting the name and auth kind", () => {
    const defaulted = readPortalConfig(env({ MCP_PORTAL_URL: "https://gw.example.com/mcp#x" }));
    expect(defaulted?.endpoint).toBe("https://gw.example.com/mcp");
    expect(defaulted?.name).toBe("MCP Server Portal (gw.example.com)");
    expect(defaulted?.auth).toBe("oauth");

    const configured = readPortalConfig(env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp",
      MCP_PORTAL_NAME: "Cloudflare MCP Portal",
      MCP_PORTAL_AUTH: "TOKEN",
    }));
    expect(configured?.name).toBe("Cloudflare MCP Portal");
    expect(configured?.auth).toBe("token");
  });

  it("falls back to oauth for an unrecognized auth kind", () => {
    // Failing closed here would hide the connector over a typo; oauth is the safe default because it
    // cannot succeed without the user completing a real authorization.
    expect(readPortalConfig(env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp",
      MCP_PORTAL_AUTH: "basic",
    }))?.auth).toBe("oauth");
  });

  it("permits http only where guardedFetch would, which is local development", () => {
    // The URL is not user input, so there is no untrusted party to keep away from private hosts --
    // but `guardedFetch` still refuses plain http without the insecure flag. Accepting it here would
    // produce a connector that appears in the list, takes a connect click, and then fails on its
    // first request over a URL the user never saw. Hiding it says the same thing at the right time.
    expect(readPortalConfig(env({ MCP_PORTAL_URL: "http://localhost:9000/mcp" }))).toBeNull();
    expect(readPortalConfig(env({
      MCP_PORTAL_URL: "http://localhost:9000/mcp",
      MCP_ALLOW_INSECURE: "true",
    }))?.endpoint).toBe("http://localhost:9000/mcp");
  });
});

describe("portalResource", () => {
  const config = readPortalConfig(env({
    MCP_PORTAL_URL: "https://gw.example.com/mcp",
    MCP_PORTAL_NAME: "Acme Portal",
  }))!;

  it("scopes the resource to the portal's origin", () => {
    // Origin-scoped, so a resource URL for any other host matches nothing this connector offers.
    expect(portalResource(config).urlPattern).toBe("https://gw.example.com/*");
    expect(portalResource(config).title).toBe("Acme Portal");
  });
});

describe("portalTrust", () => {
  it("does not trust upstream annotations just because an administrator chose the portal", () => {
    // A portal aggregates servers the administrator did not write. Auto-approval keys off annotations
    // those upstreams supply, so choosing the portal must not silently vouch for all of them.
    expect(portalTrust(env({ MCP_PORTAL_URL: "https://gw.example.com/mcp" }))).toBe("byo");
  });

  it("requires the exact opt-in, so a stray value is not an assertion", () => {
    expect(portalTrust(env({ MCP_PORTAL_TRUST_ANNOTATIONS: "true" }))).toBe("vetted");
    expect(portalTrust(env({ MCP_PORTAL_TRUST_ANNOTATIONS: "TRUE" }))).toBe("vetted");
    for (const value of ["1", "yes", "on", "vetted", ""]) {
      expect(portalTrust(env({ MCP_PORTAL_TRUST_ANNOTATIONS: value }))).toBe("byo");
    }
  });

  it("takes effect immediately when withdrawn", () => {
    // The tier is read at each point of use rather than stored on the account or a binding's props.
    // It used to be frozen at connect time, so turning the assertion off left every existing account
    // vetted until it happened to reconnect -- the wrong direction for a security setting to stick.
    const vetted = env({ MCP_PORTAL_TRUST_ANNOTATIONS: "true" });
    expect(portalTrust(vetted)).toBe("vetted");
    expect(portalTrust(env())).toBe("byo");
  });
});

describe("portalServer", () => {
  it("records provenance, which is permanent, and not the trust tier, which is not", () => {
    // Provenance answers "who chose this endpoint" and is settled forever once the account connects.
    // The trust tier answers "what may its annotations do today" and is configuration. The bug this
    // pins: with `trust` doing double duty, a portal left at the default `byo` counted as
    // user-supplied, so the upstream could rename itself over MCP_PORTAL_NAME in every prompt.
    const config = readPortalConfig(env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp",
      MCP_PORTAL_NAME: "Acme Portal",
    }))!;
    expect(portalServer(config).provenance).toBe("deployment");
    expect(portalServer(config)).not.toHaveProperty("trust");
    expect(portalServer(config).serverName).toBe("Acme Portal");
  });
});

describe("portalAuthRequiresReconnect", () => {
  it("requires reconnecting when token authority changes", () => {
    expect(portalAuthRequiresReconnect("none", "token")).toBe(true);
    expect(portalAuthRequiresReconnect("oauth", "token")).toBe(true);
    expect(portalAuthRequiresReconnect("token", "none")).toBe(true);
    expect(portalAuthRequiresReconnect("token", "oauth")).toBe(true);
  });

  it("allows none and oauth to differ after probing the endpoint", () => {
    expect(portalAuthRequiresReconnect("none", "oauth")).toBe(false);
    expect(portalAuthRequiresReconnect("oauth", "none")).toBe(false);
  });
});

describe("requirePortalServerScope", () => {
  it("refuses a grant that names no upstream server", () => {
    // The hole this closes. An empty scope is the whole portal: `scopeAllows` permits every tool
    // that is not portal-native, across every system connected to it, including ones added later.
    // The configurator will not build such a URL, but the configurator is not what mints the facet
    // -- an agent passes its own `resourceUrl` to `requestConnection`, and any URL under the
    // portal's origin gets here.
    expect(() => requirePortalServerScope({})).toThrow(/name one of the servers/);
  });

  it("refuses a tool pin with no server, which is not a shape this connector offers", () => {
    // Narrow, but unanchored. Every documented grant here is `#server=<id>` with an optional tool
    // pin refining it, and the boundary should accept exactly the shapes the form can produce.
    expect(() => requirePortalServerScope({ tools: ["gh_a"] })).toThrow(/name one of the servers/);
  });

  it("accepts a server scope, with or without a tool pin", () => {
    expect(() => requirePortalServerScope({ serverId: "github" })).not.toThrow();
    expect(() => requirePortalServerScope({ serverId: "github", tools: ["github_a"] }))
      .not.toThrow();
    // Pinned-and-empty denies everything, which is fail-closed and fine to mint.
    expect(() => requirePortalServerScope({ serverId: "github", tools: [] })).not.toThrow();
  });
});

describe("portalTokenFor", () => {
  const OLD = "https://old.example.com/mcp";
  const NEW = "https://new.example.com/mcp";

  it("serves the token for the endpoint the deployment currently names", () => {
    const configured = env({
      MCP_PORTAL_URL: OLD, MCP_PORTAL_AUTH: "token", MCP_PORTAL_TOKEN: "old-secret",
    });
    expect(portalTokenFor(configured, OLD)).toBe("old-secret");
    expect(portalTokenFor(env({ MCP_PORTAL_URL: OLD }), OLD)).toBeNull();
    expect(portalTokenFor(env({ MCP_PORTAL_URL: OLD, MCP_PORTAL_TOKEN: "" }), OLD)).toBeNull();
  });

  it("withholds the token when the deployment no longer uses token auth", () => {
    for (const auth of ["oauth", "none"]) {
      expect(portalTokenFor(env({
        MCP_PORTAL_URL: OLD, MCP_PORTAL_AUTH: auth, MCP_PORTAL_TOKEN: "old-secret",
      }), OLD)).toBeNull();
    }
  });

  it("withholds a repointed deployment's token from an account still on the old endpoint", () => {
    // The hole this closes. A repoint edits the URL and its token together and touches no account,
    // so until someone reconnects the account still records the old endpoint and its own endpoint
    // check passes. Reading the token live at that moment would hand the *new* portal's secret to a
    // facet that is about to contact the *old* host. An already-minted durable facet never passes
    // through `getGatekeeperClassFor` again, so that check cannot catch it either.
    const repointed = env({
      MCP_PORTAL_URL: NEW, MCP_PORTAL_AUTH: "token", MCP_PORTAL_TOKEN: "new-secret",
    });
    expect(portalTokenFor(repointed, OLD)).toBeNull();
    expect(portalTokenFor(repointed, NEW)).toBe("new-secret");
  });

  it("withholds the token when the portal is unconfigured or unusable", () => {
    // No configuration means no endpoint this token belongs to, so there is nothing safe to serve.
    expect(portalTokenFor(env({ MCP_PORTAL_TOKEN: "orphan-secret" }), OLD)).toBeNull();
    // An unusable URL hides the connector; it must not still release the secret.
    expect(portalTokenFor(env({
      MCP_PORTAL_URL: "http://old.example.com/mcp", MCP_PORTAL_TOKEN: "orphan-secret",
    }), "http://old.example.com/mcp")).toBeNull();
  });

  it("compares the whole endpoint, not just the origin", () => {
    // One host can front `/mcp` and `/mcp-v2` as unrelated portals with unrelated tokens.
    const configured = env({
      MCP_PORTAL_URL: "https://gw.example.com/mcp-v2",
      MCP_PORTAL_AUTH: "token",
      MCP_PORTAL_TOKEN: "v2-secret",
    });
    expect(portalTokenFor(configured, "https://gw.example.com/mcp")).toBeNull();
  });
});
