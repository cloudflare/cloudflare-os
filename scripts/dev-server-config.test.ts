import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getDevServerConfig,
  getMcpPortalUrl,
  getWranglerPortFromBackendHost,
} from "./dev-server-config.ts";

describe("getWranglerPortFromBackendHost", () => {
  it("extracts a port from a localhost backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost:9000"), "9000");
  });

  it("extracts a port from an IPv6 backend host", () => {
    assert.equal(getWranglerPortFromBackendHost("[::1]:9001"), "9001");
  });

  it("returns null when the backend host has no port", () => {
    assert.equal(getWranglerPortFromBackendHost("localhost"), null);
  });

  it("rejects invalid ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid IPv6 ports", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("[::1]:99999"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects port zero", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("localhost:0"),
        /VITE_BACKEND_HOST must include a valid port/);
  });

  it("rejects invalid hosts", () => {
    assert.throws(
        () => getWranglerPortFromBackendHost("http://localhost:9000"),
        /VITE_BACKEND_HOST must include a valid host/);
  });
});

describe("getDevServerConfig", () => {
  it("uses VITE_BACKEND_HOST as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig([], "localhost:9000"), {
      backendHost: "localhost:9000",
      wranglerPort: "9000",
    });
  });

  it("uses --port as the public host and Wrangler port", () => {
    assert.deepEqual(getDevServerConfig(["--port", "8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  it("accepts --port=value", () => {
    assert.deepEqual(getDevServerConfig(["--port=8899"]), {
      backendHost: "localhost:8899",
      wranglerPort: "8899",
    });
  });

  for (const args of [["--port"], ["--port", "nope"], ["--port=0"], ["--port=65536"]]) {
    it(`rejects invalid arguments: ${args.join(" ")}`, () => {
      assert.throws(() => getDevServerConfig(args), /--port must be an integer between 1 and 65535/);
    });
  }
});

describe("getMcpPortalUrl", () => {
  it("is absent when the flag is not given", () => {
    assert.equal(getMcpPortalUrl([]), null);
    assert.equal(getMcpPortalUrl(["--port", "9000", "--use-workers-ai-binding"]), null);
  });

  it("reads an https portal URL", () => {
    assert.equal(
        getMcpPortalUrl(["--mcp-portal-url", "https://mcp.example.com/mcp"]),
        "https://mcp.example.com/mcp");
  });

  it("accepts --mcp-portal-url=value", () => {
    assert.equal(
        getMcpPortalUrl(["--mcp-portal-url=https://mcp.example.com/mcp"]),
        "https://mcp.example.com/mcp");
  });

  it("keeps the host, path, and query of an http portal, which local dev uses", () => {
    assert.equal(
        getMcpPortalUrl(["--mcp-portal-url", "http://localhost:9000/mcp?codemode=off"]),
        "http://localhost:9000/mcp?codemode=off");
  });

  for (const args of [
    ["--mcp-portal-url"],
    ["--mcp-portal-url", "mcp.example.com/mcp"],
    ["--mcp-portal-url", "ftp://mcp.example.com/mcp"],
    ["--mcp-portal-url", "https://user:pass@mcp.example.com/mcp"],
  ]) {
    it(`rejects an unusable URL: ${args.join(" ")}`, () => {
      assert.throws(
          () => getMcpPortalUrl(args),
          /must be an absolute http:\/\/ or https:\/\/ URL|must not include credentials/);
    });
  }

  it("rejects a repeated flag rather than silently taking the last", () => {
    assert.throws(
        () => getMcpPortalUrl([
          "--mcp-portal-url", "https://one.example.com/mcp",
          "--mcp-portal-url", "https://two.example.com/mcp",
        ]),
        /--mcp-portal-url may only be specified once/);
  });
});
