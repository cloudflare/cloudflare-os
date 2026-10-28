import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  validateWebFetchUrl,
  webFetch,
  formatWebFetchResult,
  type WebFetchEnv,
} from "../src/web-fetch.js";
import { AiGatewayConfig } from "../src/ai-gateway.js";

// A minimal stand-in for the Workers AI binding's toMarkdown method. The real signature
// accepts a single document or an array of documents; we only use the single-document form
// in webFetch, so the stub mirrors only that branch.
type ToMarkdownStub = ReturnType<typeof vi.fn>;

function makeEnv(toMarkdown?: ToMarkdownStub, gateway: AiGatewayConfig | null = null): WebFetchEnv {
  const stub =
    toMarkdown ??
    vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "stub-id",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 0,
      data: `[converted from ${doc.blob.type}]`,
    }));

  // The Ai type has many methods we don't use; cast through unknown so we only need to
  // provide what webFetch actually touches.
  return {
    ai: { toMarkdown: stub } as unknown as Ai,
    gateway,
  };
}

describe("validateWebFetchUrl", () => {
  it("accepts ordinary public https URLs", () => {
    expect(() => validateWebFetchUrl("https://example.com/")).not.toThrow();
    expect(() =>
      validateWebFetchUrl("https://docs.example.com/path/to/page?x=1#frag"),
    ).not.toThrow();
  });

  it("rejects non-https schemes", () => {
    expect(() => validateWebFetchUrl("http://example.com/")).toThrow(/https/);
    expect(() => validateWebFetchUrl("ftp://example.com/")).toThrow();
    expect(() => validateWebFetchUrl("file:///etc/passwd")).toThrow();
    expect(() => validateWebFetchUrl("data:text/plain,hi")).toThrow();
    expect(() => validateWebFetchUrl("javascript:alert(1)")).toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => validateWebFetchUrl("not a url")).toThrow(/Invalid URL/);
    expect(() => validateWebFetchUrl("")).toThrow(/Invalid URL/);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => validateWebFetchUrl("https://user:pass@example.com/")).toThrow(
      /credentials/,
    );
  });

  describe("with allowedHosts", () => {
    const allowed = new Set(["docs.example.com"]);

    it("accepts a path on a listed host", () => {
      expect(validateWebFetchUrl("https://docs.example.com/guide/#intro", allowed).href)
        .toBe("https://docs.example.com/guide/#intro");
      expect(() => validateWebFetchUrl("https://DOCS.example.com:443/", allowed)).not.toThrow();
    });

    it("rejects any other host, subdomains and ports included", () => {
      for (const url of [
        "https://example.com/",
        "https://api.docs.example.com/",
        "https://docs.example.com.evil.test/",
        "https://docs.example.com:8443/",
        "https://docs.example.com./",
      ]) {
        expect(() => validateWebFetchUrl(url, allowed), url).toThrow(/may only fetch from docs\.example\.com/);
      }
    });

    it("rejects a query string, which can make the host act on data the agent chose", () => {
      expect(() => validateWebFetchUrl("https://docs.example.com/search?q=secret", allowed))
        .toThrow(/query string/);
    });

    it("rejects Cloudflare's /cdn-cgi/ paths, however they are spelled", () => {
      for (const path of [
        "/cdn-cgi/image/w=1/https://evil.test/x",
        "//cdn-cgi/trace",
        "/%63dn-cgi/trace",
        "/CDN-CGI/trace",
        "/docs/..%2fcdn-cgi/trace",
        "/docs/..%5Ccdn-cgi/trace",
      ]) {
        expect(() => validateWebFetchUrl(`https://docs.example.com${path}`, allowed), path).toThrow(/cdn-cgi/);
      }
      expect(() => validateWebFetchUrl("https://docs.example.com/cdn-cgi-endpoint/", allowed)).not.toThrow();
    });
  });

  // Note: there are deliberately no tests asserting that "internal-looking" hostnames are
  // rejected. SSRF protection happens post-DNS-lookup at the workerd layer (via the
  // global_fetch_strictly_public compatibility flag), not via string-matching in this
  // function. A symbolic hostname can resolve to anything, so a textual blocklist would be
  // fundamentally unsound.
});

describe("webFetch document conversion", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockResponse(body: BodyInit, contentType: string, status = 200) {
    globalThis.fetch = vi.fn(async () =>
      new Response(body, {
        status,
        headers: { "content-type": contentType },
      }),
    ) as unknown as typeof globalThis.fetch;
  }

  it("hands HTML responses to env.AI.toMarkdown", async () => {
    mockResponse("<h1>Title</h1><p>Body</p>", "text/html; charset=utf-8");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 5,
      data: "# Title\n\nBody",
    }));
    const env = makeEnv(toMarkdown);

    const result = await webFetch(env, { url: "https://example.com/page" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    const [doc, options] = toMarkdown.mock.calls[0];
    expect(doc.blob.type).toBe("text/html");
    expect(options.gateway).toBeUndefined();
    expect(options.conversionOptions.html.hostname).toBe("https://example.com");
    expect(options.conversionOptions.html.images.convert).toBe(false);
    expect(result.body).toBe("# Title\n\nBody");
  });

  it("passes a same-account AI gateway to toMarkdown", async () => {
    mockResponse("<h1>Title</h1>", "text/html");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 1,
      data: "# Title",
    }));
    // WORKERS_AI is what makes the gateway same-account: it is both the binding toMarkdown runs on
    // and the gateway transport, and the overseer takes `ai` and this config from the one env, so a
    // config built without it describes a deployment where the conversion could not happen at all.
    const gateway = new AiGatewayConfig({
      CF_AI_GATEWAY: "workers-ai-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      WORKERS_AI: {} as Ai,
    } as Cloudflare.Env);

    await webFetch(makeEnv(toMarkdown, gateway), { url: "https://example.com/page" });

    expect(toMarkdown.mock.calls[0][1].gateway).toEqual({
      id: "workers-ai-gateway",
      metadata: { tool: "webFetch", automated: true },
    });
  });

  it("does not pass a gateway to toMarkdown when the gateway is cross-account", async () => {
    mockResponse("<h1>Title</h1>", "text/html");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 1,
      data: "# Title",
    }));
    // CF_AI_GATEWAY_USE_BINDING=false marks the platform gateway as living in a different
    // account; the binding-based toMarkdown call can't log through it. WORKERS_AI stays bound --
    // that is the whole shape of the opt-out: the binding is still there for the conversion, it
    // just can't reach this gateway.
    const gateway = new AiGatewayConfig({
      CF_AI_GATEWAY: "platform-gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
      CF_AI_GATEWAY_API_TOKEN: "gateway-token",
      CF_AI_GATEWAY_USE_BINDING: "false",
      WORKERS_AI: {} as Ai,
    } as Cloudflare.Env);

    await webFetch(makeEnv(toMarkdown, gateway), { url: "https://example.com/page" });

    expect(toMarkdown.mock.calls[0][1].gateway).toBeUndefined();
  });

  it("hands PDF responses to env.AI.toMarkdown", async () => {
    // PDFs are binary; the actual bytes don't matter for the test since toMarkdown is
    // stubbed.
    mockResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 1,
      data: "PDF text content",
    }));
    const env = makeEnv(toMarkdown);

    const result = await webFetch(env, { url: "https://example.com/doc.pdf" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(toMarkdown.mock.calls[0][0].blob.type).toBe("application/pdf");
    expect(result.body).toBe("PDF text content");
  });

  it("passes plain text through unconverted", async () => {
    mockResponse("just some text", "text/plain");

    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, { url: "https://example.com/file.txt" });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(result.body).toBe("just some text");
  });

  it("passes JSON through unconverted", async () => {
    mockResponse('{"a":1}', "application/json");
    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, { url: "https://example.com/api" });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(result.body).toBe('{"a":1}');
  });

  it("returns raw body when raw=true, skipping toMarkdown even for HTML", async () => {
    mockResponse("<h1>Raw</h1>", "text/html");
    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, {
      url: "https://example.com/",
      raw: true,
    });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(result.body).toBe("<h1>Raw</h1>");
  });

  it("surfaces a contextual error when toMarkdown returns format='error'", async () => {
    mockResponse("<html>broken</html>", "text/html");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "error" as const,
      error: "parser blew up",
    }));
    const env = makeEnv(toMarkdown);

    await expect(
      webFetch(env, { url: "https://example.com/" }),
    ).rejects.toThrow(/parser blew up/);
  });

  it("strips parameters from Content-Type before matching the conversion allow-list", async () => {
    // Same as the HTML test but with a charset suffix; behavior should be identical.
    mockResponse("<p>hi</p>", "text/html; charset=us-ascii");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 0,
      data: "hi",
    }));
    const env = makeEnv(toMarkdown);

    await webFetch(env, { url: "https://example.com/" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
  });

  it("does NOT call toMarkdown for image MIME types (cost guardrail)", async () => {
    // Image conversion uses paid Workers AI models. We explicitly exclude images from the
    // allow-list so a webFetch call can never trigger that path.
    mockResponse(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");

    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, { url: "https://example.com/x.jpg" });
    expect(toMarkdown).not.toHaveBeenCalled();
    // Body is decoded as UTF-8 (with replacement chars for invalid sequences); the test
    // only cares that the call didn't go through toMarkdown.
    expect(typeof result.body).toBe("string");
  });
});

const redirect = (location: string, status = 302) => () =>
  new Response(null, { status, headers: { location } });
const page = (body: string) => () =>
  new Response(body, { headers: { "content-type": "text/plain" } });

describe("webFetch redirects", () => {
  let requested: string[];

  beforeEach(() => {
    requested = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Answers each URL from `routes`, and records the URLs requested.
  function serve(routes: Record<string, () => Response>) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch of ${url}`);
      return route();
    });
  }

  it("follows relative and absolute redirects and reports the final URL", async () => {
    serve({
      "https://example.com/old": redirect("/new", 301),
      "https://example.com/new": redirect("https://www.example.com/page", 308),
      "https://www.example.com/page": page("hello"),
    });

    const result = await webFetch(makeEnv(), { url: "https://example.com/old" });
    expect(result).toMatchObject({ status: 200, finalUrl: "https://www.example.com/page", body: "hello" });
    expect(requested).toEqual(["https://example.com/old", "https://example.com/new", "https://www.example.com/page"]);
  });

  it("refuses a redirect to http: without requesting it", async () => {
    serve({ "https://example.com/": redirect("http://example.com/") });

    await expect(webFetch(makeEnv(), { url: "https://example.com/" }))
      .rejects.toThrow(/redirected to http:\/\/example\.com\/, which is not allowed: Only https/);
    expect(requested).toEqual(["https://example.com/"]);
  });

  it("refuses a redirect off the allowed hosts without requesting it", async () => {
    serve({ "https://docs.example.com/": redirect("https://evil.test/?d=secret") });
    const env = { ...makeEnv(), allowedHosts: new Set(["docs.example.com"]) };

    await expect(webFetch(env, { url: "https://docs.example.com/" }))
      .rejects.toThrow(/redirected to https:\/\/evil\.test\/\?d=secret, which is not allowed/);
    expect(requested).toEqual(["https://docs.example.com/"]);
  });

  it("returns a redirect status without a Location as the response", async () => {
    serve({ "https://example.com/": () => new Response("moved, somewhere", { status: 302 }) });

    const result = await webFetch(makeEnv(), { url: "https://example.com/", raw: true });
    expect(result).toMatchObject({ status: 302, finalUrl: "https://example.com/", body: "moved, somewhere" });
  });

  it("gives up after 20 redirects", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i <= 20; ++i) routes[`https://example.com/${i}`] = redirect(`/${i + 1}`);
    serve(routes);

    await expect(webFetch(makeEnv(), { url: "https://example.com/0" })).rejects.toThrow(/after 20 redirects/);
    expect(requested).toHaveLength(21);
  });
});

describe("formatWebFetchResult", () => {
  it("emits YAML frontmatter followed by the body", () => {
    const out = formatWebFetchResult({
      status: 200,
      finalUrl: "https://example.com/page",
      contentType: "text/html; charset=utf-8",
      body: "# Title\n\nBody",
      truncated: false,
    });
    expect(out).toBe(
      "---\n" +
        "url: https://example.com/page\n" +
        "status: 200\n" +
        "content-type: text/html; charset=utf-8\n" +
        "truncated: false\n" +
        "---\n" +
        "\n" +
        "# Title\n\nBody",
    );
  });

  it("reflects the truncated flag", () => {
    const out = formatWebFetchResult({
      status: 200,
      finalUrl: "https://example.com/",
      contentType: "text/plain",
      body: "hi",
      truncated: true,
    });
    expect(out).toContain("truncated: true");
  });

  it("renders an empty content-type as (unspecified)", () => {
    const out = formatWebFetchResult({
      status: 204,
      finalUrl: "https://example.com/",
      contentType: "",
      body: "",
      truncated: false,
    });
    expect(out).toContain("content-type: (unspecified)");
  });
});
