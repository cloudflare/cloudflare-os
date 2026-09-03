/** Hardened HTML and browser request guards for gatekeeper connect flows. */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes a value for HTML text or a quoted attribute.
 * @param value Untrusted text.
 * @returns Escaped HTML text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]!);
}

/**
 * Builds an uncacheable, unframeable HTML response. Connect URLs carry bearer nonces, so responses
 * never cache or send referrers.
 * @param body HTML response body.
 * @param status HTTP status.
 * @returns A hardened HTML response.
 */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Normalizes a media type for exact comparison; substring checks would accept values such as
 * `application/jsonp`.
 * @param value Raw `Content-Type` header.
 * @returns Lowercase media type without parameters.
 */
function mediaType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * Classifies a browser mutation request. The expected origin is explicit rather than derived from
 * `req.url`, which a fronting proxy may rewrite; the browser's `Origin` names the configured base
 * URL the form was served under.
 * @param req Mutation request.
 * @param options Expected origin (a base URL is accepted) and media type.
 * @returns An error code, or `undefined` when accepted.
 *
 * @example
 * ```ts
 * const error = connectMutationError(req, { origin: baseUrl, contentType: "application/json" });
 * if (error) {
 *   const status = error === "cross-origin" ? 403 : 415;
 *   return htmlResponse(errorPageHtml("Connection failed", "Start again."), status);
 * }
 * ```
 */
export function connectMutationError(
  req: Request,
  options: { origin: string; contentType: string },
): "cross-origin" | "unsupported-content-type" | undefined {
  if (req.headers.get("origin") !== new URL(options.origin).origin) return "cross-origin";
  if (mediaType(req.headers.get("content-type")) !== mediaType(options.contentType)) {
    return "unsupported-content-type";
  }
  return undefined;
}

/**
 * Shared connect-page layout. Connect pages cannot load Workshop CSS, so this mirrors its palette.
 */
export const PAGE_STYLE = `
  :root {
    color-scheme: light dark;
    --font: "FT Kunst Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
            "Helvetica Neue", sans-serif;
    --base: #fcfcfb;
    --control: #ffffff;
    --line: #e8e7e4;
    --text: #1c1a18;
    --strong: #100f0d;
    --subtle: oklch(52% 0.006 60);
    --brand: #ff4801;
    --danger: oklch(63.7% 0.237 25.331);
    /* Kumo's primary button is "contrast": near-black in light mode, the accent in dark. */
    --contrast: #14110f;
    --on-contrast: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --base: oklch(0.115 0.012 285);
      --control: oklch(0.155 0.011 285);
      --line: oklch(0.34 0.022 285);
      --text: oklch(0.92 0.01 285);
      --strong: oklch(0.92 0.01 285);
      --subtle: oklch(0.66 0.02 285);
      --brand: #b84e00;
      --danger: oklch(70.4% 0.191 22.216);
      --contrast: #b84e00;
    }
  }

  body { font: 15px/1.5 var(--font); margin: 0; padding: 48px 20px; display: flex;
         justify-content: center; background: var(--base); color: var(--text);
         -webkit-font-smoothing: antialiased; }
  main { width: 100%; max-width: 420px; }
  h1 { font-size: 17px; font-weight: 600; color: var(--strong); margin: 0 0 6px;
       letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--subtle); font-size: 14px; }
  p.err { color: var(--danger); font-size: 13px; margin: 0 0 16px; }
`;

/** The page a popup-based connect flow lands on: reports success and closes its own tab. */
export const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected</title></head>
<body><p>Connected. You can close this window.</p><script>window.close();</script></body></html>`;

/** The page a connect link that has expired or been used already lands on. */
export const INVALID_LINK_HTML =
  errorPageHtml("This link has expired", "Start the connection again.");

/**
 * Renders a connect-flow error page.
 * @param title Error heading.
 * @param detail Error detail.
 * @returns Escaped HTML.
 */
export function errorPageHtml(title: string, detail: string): string {
  const escapedTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedTitle}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapedTitle}</h1>
<p class="sub">${escapeHtml(detail)}</p></main></body></html>`;
}
