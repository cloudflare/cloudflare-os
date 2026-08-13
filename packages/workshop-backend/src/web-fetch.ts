// Built-in WebFetch capability for the agent.
//
// Provides an HTTP GET against arbitrary public HTTPS URLs. There is intentionally no
// support for POST/PUT/DELETE/PATCH or for forwarding credentials.
//
// Document-to-Markdown conversion is delegated to Cloudflare Workers AI's
// `env.WORKERS_AI.toMarkdown()` utility, which handles HTML, PDF, DOCX, XLSX/XLS, ODT/ODS,
// CSV, XML, and Apple Numbers documents. Image conversion is intentionally NOT exposed here
// because it uses paid Workers AI models. Plain-text, JSON, and other unknown content types
// pass through unconverted.
//
// SSRF protection: relies on workerd's post-DNS-lookup IP address filtering. The
// `global_fetch_strictly_public` compatibility flag (set in wrangler.jsonc) restricts
// `fetch()` to public IP addresses; reserved ranges (loopback, RFC1918, link-local,
// cloud-metadata, etc.) are rejected by the runtime, *after* the hostname has been
// resolved. This is the only correct place to enforce such restrictions, since a symbolic
// hostname can resolve to anything. `wrangler dev` reconfigures its global outbound to
// permit fetching from any address (so localhost services stay reachable), so the flag
// only takes effect in production -- an acceptable tradeoff for dev.

import type { AiGatewayConfig } from "./ai-gateway";

/**
 * The bits of the Workers AI binding and gateway config that `webFetch` needs. Kept narrow
 * so the caller can pass a stub in tests without constructing a full Cloudflare.Env.
 */
export type WebFetchEnv = {
  ai: Ai;
  gateway: AiGatewayConfig | null;
};

export type WebFetchInput = {
  url: string;
  /**
   * If true, return the exact response bytes (decoded as UTF-8) without any document
   * conversion. If false or omitted, supported document formats (HTML, PDF, DOCX, ...) are
   * converted to Markdown via env.WORKERS_AI.toMarkdown().
   */
  raw?: boolean;
  /** Caller-requested cap on body length (characters). Server enforces its own hard cap on top. */
  maxBytes?: number;
};

export type WebFetchResult = {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
};

// Hard server-side limits.
const HARD_MAX_BYTES = 5 * 1024 * 1024;     // 5 MiB after which we always truncate
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;  // 1 MiB default cap when caller didn't specify
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "GadgetsWebFetch/1.0";

/**
 * Validate a URL string for use with webFetch. Throws on bad input. Returns the parsed URL
 * on success.
 *
 * Note: we do NOT inspect the hostname for "looks-internal" patterns here. That kind of
 * blocklist is fundamentally unsound because a symbolic hostname can resolve to any IP at
 * fetch time. SSRF protection is provided post-DNS-lookup by workerd (see the file header).
 */
export function validateWebFetchUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Only https:// URLs are allowed; got ${parsed.protocol}//. ` +
        `Use the HTTPS version of this URL.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  return parsed;
}

// Read up to `maxBytes` from the body of a response. Returns the raw bytes (so callers can
// hand them to either a text decoder or a Blob) and a flag indicating whether the stream
// was truncated.
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (total + value.byteLength > maxBytes) {
        // Take a partial slice to fill the budget exactly, then stop.
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // If we stopped early, cancel the rest of the stream to free server-side resources.
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        // Ignore.
      }
    }
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: combined, truncated };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}

// Strip parameters from a Content-Type header (e.g. `text/html; charset=utf-8` -> `text/html`).
function baseContentType(contentType: string): string {
  const i = contentType.indexOf(";");
  return (i >= 0 ? contentType.slice(0, i) : contentType).trim().toLowerCase();
}

// MIME types that `env.WORKERS_AI.toMarkdown()` can convert for free (no Workers AI model
// usage). Derived from the public list of supported formats:
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/
//
// Image MIME types are intentionally excluded -- image conversion uses paid Workers AI
// models (object detection + Gemma-3 for image-to-text), and we don't want webFetch to
// silently incur per-fetch costs.
const TO_MARKDOWN_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/pdf",
  "application/xml",
  "text/xml",
  "text/csv",
  // Office / OpenDocument
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.ms-excel",                                                // .xls
  "application/vnd.ms-excel.sheet.macroenabled.12",                          // .xlsm
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",                   // .xlsb
  "application/vnd.oasis.opendocument.spreadsheet",                          // .ods
  "application/vnd.oasis.opendocument.text",                                 // .odt
  "application/vnd.apple.numbers",                                           // .numbers
]);

// `toMarkdown()` uses the Workers AI binding, so only apply the same-account Workers AI gateway
// resolved by AiGatewayConfig. A cross-account platform gateway cannot be used by this binding.
function buildGatewayOptions(
  gateway: AiGatewayConfig | null,
): GatewayOptions | undefined {
  if (!gateway) return undefined;
  if (!gateway.workersAiGateway) return undefined;
  return { id: gateway.workersAiGateway, metadata: { tool: "webFetch", automated: true } };
}

// Attempt to convert a document to Markdown using the Workers AI binding. Returns the
// Markdown body on success, or null if the document's MIME type isn't in the supported
// allow-list. Throws (with a contextual error) if the conversion itself fails.
async function convertToMarkdown(
  env: WebFetchEnv,
  bytes: Uint8Array,
  contentType: string,
  url: URL,
): Promise<string | null> {
  const mime = baseContentType(contentType);
  if (!TO_MARKDOWN_MIME_TYPES.has(mime)) {
    return null;
  }

  // Build a name from the URL path so toMarkdown's format detection has a hint.
  const pathBasename = url.pathname.split("/").filter(Boolean).pop() || "document";

  const result = await env.ai.toMarkdown(
    {
      name: pathBasename,
      blob: new Blob([bytes], { type: mime }),
    },
    {
      gateway: buildGatewayOptions(env.gateway),
      conversionOptions: {
        // Resolve relative links against the page's own origin.
        html: {
          hostname: url.origin,
          // Skip per-image summarization (which would invoke paid Workers AI models). The
          // agent gets a Markdown skeleton with image alt text and src URLs, which is
          // sufficient for documentation-lookup use cases.
          images: { convert: false, convertOGImage: false },
        },
      },
    },
  );

  if (result.format === "error") {
    throw new Error(`Markdown conversion failed: ${result.error}`);
  }
  return result.data;
}



// Parse the Content-Signal response header (https://contentsignals.org/) and check whether
// a specific signal is present and set to "no". The header is a comma-separated list of
// key=value pairs, e.g. `ai-train=yes, search=yes, ai-input=no`.
function contentSignalDenies(response: Response, signal: string): boolean {
  const header = response.headers.get("content-signal");
  if (!header) return false;
  for (const part of header.split(",")) {
    const [key, value] = part.split("=").map((s) => s.trim().toLowerCase());
    if (key === signal && value === "no") return true;
  }
  return false;
}

/**
 * Format a `WebFetchResult` as a single string for the agent: a small YAML frontmatter
 * header followed by `---` then the body. This is friendlier to LLMs than a JSON-wrapped
 * object, since the body lives inline rather than as an escaped JSON string.
 */
export function formatWebFetchResult(result: WebFetchResult): string {
  const lines = [
    "---",
    `url: ${result.finalUrl}`,
    `status: ${result.status}`,
    `content-type: ${result.contentType || "(unspecified)"}`,
    `truncated: ${result.truncated}`,
    "---",
    "",
    result.body,
  ];
  return lines.join("\n");
}

export async function webFetch(
  env: WebFetchEnv,
  input: WebFetchInput,
): Promise<WebFetchResult> {
  const parsed = validateWebFetchUrl(input.url);

  const requestedMax = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxBytes = Math.min(
    Math.max(1, Math.floor(requestedMax)),
    HARD_MAX_BYTES,
  );

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/markdown,text/html;q=0.9,text/plain;q=0.9,application/json;q=0.9,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      signal: abortController.signal,
    });
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(err.message))
    ) {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  // `response.url` is set by the runtime to the final URL after any redirects. Fall back
  // to the original URL if it happens to be empty.
  const finalUrl = response.url ? new URL(response.url) : parsed;
  const contentType = response.headers.get("content-type") ?? "";

  // Respect the Content-Signal header (https://contentsignals.org/). If the site
  // explicitly sets `ai-input=no`, we must not feed its content to the AI agent.
  if (contentSignalDenies(response, "ai-input")) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore.
    }
    throw new Error(
      `The site at ${finalUrl} sets Content-Signal: ai-input=no, indicating that ` +
        `it does not permit its content to be used as AI input.`,
    );
  }

  const { bytes, truncated } = await readBodyCapped(response, maxBytes);

  let body: string;
  if (input.raw) {
    body = decodeUtf8(bytes);
  } else {
    const md = await convertToMarkdown(env, bytes, contentType, finalUrl);
    body = md !== null ? md : decodeUtf8(bytes);
  }

  return {
    status: response.status,
    finalUrl: finalUrl.toString(),
    contentType,
    body,
    truncated,
  };
}
