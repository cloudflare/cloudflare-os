import { describe, expect, it } from "vite-plus/test";
import { isBlockedHost, validateCustomEndpoint } from "../src/endpoint.js";
import type { InsecureEnv } from "../src/fetch.js";

function env(overrides: Record<string, string> = {}): InsecureEnv {
  return overrides as InsecureEnv;
}

describe("validateCustomEndpoint", () => {
  it("accepts an https endpoint and strips the fragment", () => {
    const result = validateCustomEndpoint(env(), " https://mcp.example.com/sse#frag ");
    expect(result).toEqual({ ok: true, url: "https://mcp.example.com/sse" });
  });

  it("rejects a blank or unparseable value", () => {
    expect(validateCustomEndpoint(env(), "").ok).toBe(false);
    expect(validateCustomEndpoint(env(), "not a url").ok).toBe(false);
  });

  it("requires https unless insecure mode is explicitly enabled", () => {
    expect(validateCustomEndpoint(env(), "http://mcp.example.com/mcp").ok).toBe(false);
    expect(validateCustomEndpoint(
      env({ MCP_ALLOW_INSECURE: "true" }), "http://localhost:1234/mcp").ok).toBe(true);
  });

  it("blocks loopback, private, link-local, IPv6, and metadata hosts", () => {
    for (const host of [
      "localhost", "app.localhost", "127.0.0.1", "0.0.0.0", "10.1.2.3", "192.168.0.5", "172.16.9.9",
      "169.254.169.254", "metadata.google.internal", "thing.internal",
      // IPv6 loopback and unique-local, which a URL renders bracketed.
      "[::1]", "[fd00::1]", "[fc00::1]",
    ]) {
      expect(validateCustomEndpoint(env(), `https://${host}/mcp`).ok, host).toBe(false);
    }
  });

  it("sees through alternate spellings of a blocked address", () => {
    // `new URL()` accepts all of these and a resolver reads them as 127.0.0.1, so matching the
    // dotted-quad pattern alone would let every one of them straight through.
    for (const host of ["2130706433", "0x7f000001", "017700000001", "[::ffff:127.0.0.1]"]) {
      expect(validateCustomEndpoint(env(), `https://${host}/mcp`).ok, host).toBe(false);
    }
  });

  it("does not mistake ordinary hosts for encoded addresses", () => {
    for (const host of ["mcp.example.com", "8x8.com", "0x.example.com", "mcp.internal.example.com"]) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    expect(validateCustomEndpoint(env(), "https://user:pw@mcp.example.com/mcp").ok).toBe(false);
  });
});
