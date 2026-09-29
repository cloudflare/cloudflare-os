import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_EXTENSION_ID,
  APP_MIME_TYPE,
  appResourceUri,
  clampAppResult,
  clampResourceMeta,
  MAX_APP_CSP_DOMAINS,
  MAX_APP_CSP_DOMAIN_CHARS,
  MAX_APP_RESULT_BYTES,
  MAX_UI_URI_CHARS,
  isAppMimeType,
  toolUiResourceUri,
  toolVisibleToApp,
  toolVisibleToModel,
  uiResourceUriInResult,
  viewAllowAttribute,
  viewCsp,
  type AppBinding,
  type AppToolResult,
} from "../src/apps.js";
import { clampToolDefinition, McpClient } from "../src/client.js";

afterEach(() => vi.unstubAllGlobals());

// The two ends of the app wire that belong to this package: what a client advertises, and what the
// sidecar gateway answers.
describe("the extension a client advertises", () => {
  it("declares MCP Apps support in initialize, and nothing else", async () => {
    const requests: Array<{ method?: string; params?: { capabilities?: unknown } }> = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "session" },
      });
    });

    await new McpClient("https://mcp.example.com/mcp", async () => null).initialize("Gadgets");

    expect(requests.map(request => request.method)).toEqual([
      "initialize", "notifications/initialized",
    ]);
    expect(requests[0]?.params?.capabilities).toEqual({
      extensions: {
        // Both spellings, because a server reads this list to decide whether to attach a view and
        // the ones written before the profile type existed would see only a refusal.
        [APP_EXTENSION_ID]: { mimeTypes: [APP_MIME_TYPE, "text/html"] },
      },
    });
  });
});

// The text of a result's first block, which every case below knows is a text block. Narrowed rather
// than cast, so a block that is not one fails the assertion instead of reading `undefined`.
function firstText(result: AppToolResult): string | undefined {
  const [block] = result.content;
  if (typeof block !== "object" || block === null || !("text" in block)) return undefined;
  return typeof block.text === "string" ? block.text : undefined;
}

const BINDING: AppBinding = {
  endpoint: "https://mcp.example/rpc",
  serverName: "Example MCP",
  scope: {},
  trust: "byo",
};

describe("appResourceUri", () => {
  it("reads a resource under the URI it declared, for an endpoint that serves it there", () => {
    expect(appResourceUri(BINDING, "ui://weather/current")).toBe("ui://weather/current");
  });

  it("reads a renamed resource under the prefix its endpoint serves it with", () => {
    // A portal lists and reads an upstream resource as `{serverId}_{uri}`, and refuses the URI the
    // upstream declared.
    const portal = { ...BINDING, resourceUriPrefix: "mcp-app-server_" };

    expect(appResourceUri(portal, "ui://demo/dashboard"))
      .toBe("mcp-app-server_ui://demo/dashboard");
  });
});

describe("toolUiResourceUri", () => {
  it("reads the resource a tool renders with", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://weather/current", visibility: ["model"] } },
    });
    expect(toolUiResourceUri(tool)).toBe("ui://weather/current");
    expect(tool.ui?.visibility).toEqual(["model"]);
  });

  it("reads the deprecated flat metadata key", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: { "ui/resourceUri": "ui://weather/legacy" },
    });
    expect(toolUiResourceUri(tool)).toBe("ui://weather/legacy");
  });

  it("ignores an association that is not a ui:// resource", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "https://weather.example.com/app.html" } },
    });
    expect(toolUiResourceUri(tool)).toBeUndefined();
  });

  it("keeps nothing else from a tool's metadata", () => {
    const tool = clampToolDefinition({
      name: "get_weather",
      inputSchema: { type: "object" },
      _meta: {
        ui: { resourceUri: "ui://weather/current", csp: { connectDomains: ["*"] } },
        "example/extension": { arbitrary: "x".repeat(1000) },
      },
    });
    expect(tool).toEqual({
      name: "get_weather",
      title: undefined,
      description: undefined,
      inputSchema: { type: "object" },
      annotations: undefined,
      ui: { resourceUri: "ui://weather/current", visibility: undefined },
    });
  });
});

describe("isAppMimeType", () => {
  it("reads the profile type, the bare media type, and their parameters as one document", () => {
    // Servers written before the profile type existed -- the playground ones users paste in -- serve
    // a bare `text/html`, and a document is qualified by its `ui://` URI, not by this string.
    for (const declared of ["text/html;profile=mcp-app", "text/html", "text/html; charset=utf-8",
                            "TEXT/HTML"]) {
      expect(isAppMimeType(declared)).toBe(true);
    }
    for (const declared of ["text/plain", "application/xhtml+xml", "text/htmlx", undefined]) {
      expect(isAppMimeType(declared)).toBe(false);
    }
  });
});

describe("uiResourceUriInResult", () => {
  it("prefers the result's own metadata", () => {
    expect(uiResourceUriInResult({
      _meta: { ui: { resourceUri: "ui://weather/current" } },
      content: [{ type: "resource_link", uri: "ui://weather/other" }],
    })).toBe("ui://weather/current");
  });

  it("falls back to a linked ui:// resource", () => {
    expect(uiResourceUriInResult({
      content: [
        { type: "text", text: "6°C" },
        { type: "resource_link", uri: "ui://weather/current" },
      ],
    })).toBe("ui://weather/current");
  });

  it("falls back to an embedded ui:// resource", () => {
    expect(uiResourceUriInResult({
      content: [{ type: "resource", resource: { uri: "ui://weather/current", text: "<html></html>" } }],
    })).toBe("ui://weather/current");
  });

  it("ignores a ui:// URI longer than the bound it is stored under", () => {
    // The URI is written to the action that produced it and into the link's token record, and the
    // server chooses its length. Dropping it keeps the bound; truncating it would name a resource
    // the server never meant.
    const long = `ui://demo/${"x".repeat(MAX_UI_URI_CHARS)}`;
    expect(uiResourceUriInResult({ _meta: { ui: { resourceUri: long } } })).toBeUndefined();
    expect(uiResourceUriInResult({
      _meta: { ui: { resourceUri: `ui://demo/${"x".repeat(MAX_UI_URI_CHARS - 10)}` } },
    })).toMatch(/^ui:\/\/demo\/x+$/);
  });

  it("ignores anything that is not a ui:// resource", () => {
    expect(uiResourceUriInResult({
      _meta: { ui: { resourceUri: "https://weather.example.com/app.html" } },
      content: [
        { type: "resource_link", uri: "https://weather.example.com/page" },
        { type: "resource", resource: { uri: "https://weather.example.com/raw" } },
        { type: "text", text: "ui://not-a-block" },
      ],
    })).toBeUndefined();
    expect(uiResourceUriInResult({})).toBeUndefined();
  });
});

describe("visibility", () => {
  it("shows a tool to both sides when nothing was declared", () => {
    expect(toolVisibleToModel({ name: "a" })).toBe(true);
    expect(toolVisibleToApp({ name: "a" })).toBe(true);
  });

  it("honours a declared side", () => {
    expect(toolVisibleToModel({ name: "a", ui: { visibility: ["app"] } })).toBe(false);
    expect(toolVisibleToApp({ name: "a", ui: { visibility: ["app"] } })).toBe(true);
    expect(toolVisibleToModel({ name: "a", ui: { visibility: ["model"] } })).toBe(true);
    expect(toolVisibleToApp({ name: "a", ui: { visibility: ["model"] } })).toBe(false);
  });

  it("hides a tool from both sides when the declaration survived empty", () => {
    const tool = clampToolDefinition({
      name: "a",
      inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://a", visibility: ["nobody"] } },
    });
    expect(toolVisibleToModel(tool)).toBe(false);
    expect(toolVisibleToApp(tool)).toBe(false);
  });
});

describe("viewCsp", () => {
  it("applies the specification's defaults when the resource declared nothing", () => {
    const expected = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self' data:",
      "font-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; ");
    expect(viewCsp(undefined)).toBe(expected);
    expect(viewCsp({})).toBe(expected);
  });

  it("widens a directive only by what the resource declared for it", () => {
    const csp = viewCsp({
      csp: {
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://player.example.com"],
        baseUriDomains: ["https://cdn.example.com"],
      },
    });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(csp).toContain("img-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("media-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("font-src https://cdn.example.com");
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).toContain("frame-src https://player.example.com");
    expect(csp).toContain("base-uri https://cdn.example.com");
    expect(csp).toContain("object-src 'none'");
  });

  it("keeps a resource domain out of the directives it did not declare", () => {
    const csp = viewCsp({ csp: { resourceDomains: ["https://cdn.example.com"] } });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("drops a declared domain that would end its directive", () => {
    const csp = viewCsp({
      csp: {
        connectDomains: [
          "https://ok.example.com",
          "https://bad.example.com; script-src 'unsafe-eval'",
          "https://two.example.com https://three.example.com",
        ],
      },
    });
    expect(csp.match(/connect-src[^;]*/g)).toEqual(["connect-src https://ok.example.com"]);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("cannot be widened past an unconditional object-src", () => {
    const csp = viewCsp({ csp: { resourceDomains: ["*"] } });
    expect(csp.match(/object-src[^;]*/g)).toEqual(["object-src 'none'"]);
  });

  it("cannot be widened or lengthened by a hostile declaration", () => {
    const declared = Array.from(
      { length: MAX_APP_CSP_DOMAINS * 4 },
      (_, index) => `https://host${index}.example.com`,
    );
    const csp = viewCsp({
      csp: {
        connectDomains: declared,
        resourceDomains: [
          "https://ok.example.com",
          "*",
          "data:",
          `https://${"a".repeat(MAX_APP_CSP_DOMAIN_CHARS)}.example.com`,
          "https://bad.example.com; script-src *",
        ],
      },
    });

    // Only the first declarations are read at all, so nothing past the cap can reach a directive.
    expect(csp.match(/connect-src[^;]*/g)).toEqual([
      `connect-src ${declared.slice(0, MAX_APP_CSP_DOMAINS).join(" ")}`,
    ]);
    // One usable origin is left in the other directive: the wildcard, the bare scheme, the over-long
    // host, and the injection all dropped rather than written into a policy.
    expect(csp.match(/script-src[^;]*/g)).toEqual([
      "script-src 'self' 'unsafe-inline' https://ok.example.com",
    ]);
    expect(csp.length).toBeLessThan(
      4 * MAX_APP_CSP_DOMAINS * (MAX_APP_CSP_DOMAIN_CHARS + 1) + 512);
  });
});

describe("viewAllowAttribute", () => {
  it("asks for nothing when the resource declared nothing", () => {
    expect(viewAllowAttribute(undefined)).toBeUndefined();
    expect(viewAllowAttribute({ permissions: {} })).toBeUndefined();
  });

  it("names the features the resource asked for", () => {
    expect(viewAllowAttribute({ permissions: { camera: true } })).toBe("camera");
    expect(viewAllowAttribute({
      permissions: { camera: true, microphone: true, geolocation: true, clipboardWrite: true },
    })).toBe("camera; microphone; geolocation; clipboard-write");
    expect(viewAllowAttribute({ permissions: { camera: false, geolocation: true } }))
      .toBe("geolocation");
  });
});

describe("clampResourceMeta", () => {
  it("reads the declared domains and permissions of a resource", () => {
    expect(clampResourceMeta({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: "https://cdn.example.com",
      },
      // The specification declares a permission by its presence, with an empty object for a value.
      permissions: { camera: {}, microphone: false },
      domain: "apps.example.com",
    })).toEqual({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: undefined,
        frameDomains: undefined,
        baseUriDomains: undefined,
      },
      permissions: { camera: true, microphone: false, geolocation: false, clipboardWrite: false },
    });
  });

  it("treats metadata that is not a declaration as no declaration", () => {
    expect(clampResourceMeta(undefined)).toBeUndefined();
    expect(clampResourceMeta("ui")).toBeUndefined();
    expect(clampResourceMeta(["ui"])).toBeUndefined();
    expect(clampResourceMeta({ csp: [] })).toEqual({ csp: undefined, permissions: undefined });
  });
});

describe("clampAppResult", () => {
  it("passes a result through unchanged while it fits", () => {
    expect(clampAppResult({
      content: [{ type: "text", text: "6°C" }],
      structuredContent: { temperature: 6 },
      isError: false,
    })).toEqual({
      content: [{ type: "text", text: "6°C" }],
      structuredContent: { temperature: 6 },
      isError: false,
    });
  });

  it("bounds what a window is sent", () => {
    const result = clampAppResult({
      content: [{ type: "text", text: "x".repeat(MAX_APP_RESULT_BYTES) }],
      structuredContent: { note: "dropped with the content" },
    });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_APP_RESULT_BYTES);
    expect(result.content).toHaveLength(1);
    expect(result.structuredContent).toBeUndefined();
  });

  it("clips the text block that does not fit and stops there", () => {
    const result = clampAppResult({
      content: [
        { type: "text", text: "y".repeat(MAX_APP_RESULT_BYTES) },
        { type: "text", text: "never reached" },
      ],
    });
    expect(result.content).toHaveLength(1);
    expect(firstText(result)?.endsWith("\u2026")).toBe(true);
  });

  it("drops a block it cannot clip, and the ones behind it", () => {
    const result = clampAppResult({
      content: [
        { type: "image", data: "A".repeat(MAX_APP_RESULT_BYTES), mimeType: "image/png" },
        { type: "text", text: "after the image" },
      ],
    });
    expect(result.content).toEqual([]);
  });

  it("counts non-ASCII text in bytes rather than characters", () => {
    const result = clampAppResult({ content: [{ type: "text", text: "é".repeat(MAX_APP_RESULT_BYTES) }] });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_APP_RESULT_BYTES);
    expect(firstText(result)).toMatch(/^é+…$/);
  });
});
