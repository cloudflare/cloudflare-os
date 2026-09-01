// The pages every gatekeeper serves in a browser tab during connect: "you can close this window",
// "that link expired", and "it didn't work, here's why". Anything a gatekeeper *asks* the user is
// vendor-specific and keeps its own markup.

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]!);
}

/**
 * Diverges deliberately from the module this was taken from: connect pages open in their own tab
 * and are never framed (the srcDoc-framed surfaces are gatekeeper app UIs, a different module), and
 * a connect URL carries a nonce that must not leak through `Referer`. `nosniff` joins them for the
 * same reason they are here rather than at each call site: a vendor form built on `PAGE_STYLE`
 * inherits all four without having to remember them, and a gatekeeper that interpolates provider
 * text into a page must never have that text content-sniffed into another type. The path segment is
 * the bearer capability and the page may echo account identifiers, so `no-store` prevents either
 * from landing in a shared cache -- a guard no shipped OAuth page carries.
 */
export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Refuse connect links not opened by the Workshop, with a localhost exception for Vite dev. */
export function connectNavigationError(req: Request): "untrusted-navigation" | undefined {
  const site = req.headers.get("sec-fetch-site");
  const trustedSite = site === "same-origin" ||
    (site === "same-site" && new URL(req.url).hostname === "localhost");
  if (req.method !== "GET" || !trustedSite) return "untrusted-navigation";
  return undefined;
}

/**
 * The bare media type, parameters dropped and case folded. Substring matching is not good enough
 * here: `application/jsonp` contains `application/json`, and so does the *parameter* in
 * `text/plain; x=application/json`, while a real `multipart/form-data; boundary=…` has to pass.
 */
function mediaType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * Classifies a browser mutation on a capability URL. `undefined` means acceptable; otherwise the
 * caller renders its own refusal (Marketo answers JSON 403/415, a form-based flow answers HTML).
 * A missing Origin header is refused: browsers send it on POST, and a non-browser caller has no
 * business on a browser capability URL. `contentType` names a media type, compared exactly.
 */
export function connectMutationError(
  req: Request,
  options: { contentType: string },
): "cross-origin" | "unsupported-content-type" | undefined {
  if (req.headers.get("origin") !== new URL(req.url).origin) return "cross-origin";
  if (mediaType(req.headers.get("content-type")) !== mediaType(options.contentType)) {
    return "unsupported-content-type";
  }
  return undefined;
}

/**
 * The palette and page frame every connect page shares.
 *
 * These pages open outside the Workshop, so they cannot reach Tailwind or Kumo. The tokens are
 * copied from `workshop-frontend/src/styles.css` (both palettes) so the tab still reads as the same
 * product. Only the base palette: a deployment's admin-chosen accent lives in AdminConfig, which a
 * gatekeeper has no business reading. CSS variables rather than literals, since a gatekeeper with a
 * form appends its own rules.
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

/** A minimal page reporting that connecting failed, with a reason the user can act on. */
export function errorPageHtml(title: string, detail: string): string {
  const escapedTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedTitle}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapedTitle}</h1>
<p class="sub">${escapeHtml(detail)}</p></main></body></html>`;
}
