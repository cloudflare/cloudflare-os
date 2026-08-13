// The pages every MCP gatekeeper serves in a browser tab during connect: "you can close this
// window", "that link expired", and "it didn't work, here's why".
//
// Anything a gatekeeper asks the user is *not* here. Only `gatekeeper-mcp` has a question to ask (see
// its `connect-form.ts`); the gateway's endpoint is a deployment setting, so it has no form and would
// carry the form's markup and CSS for nothing.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/**
 * The palette and page frame every connect page shares.
 *
 * These pages open in their own browser tab, outside the Workshop, so they cannot reach Tailwind or
 * Kumo. The tokens are copied from `workshop-frontend/src/styles.css` (both palettes) so the tab
 * still reads as the same product. Only the base palette is copied: a deployment's admin-chosen
 * accent lives in the Workshop's AdminConfig, which a gatekeeper has no business reading.
 *
 * Form controls are absent, since a gatekeeper with a form appends its own rules, which is why the
 * tokens are CSS variables rather than literals.
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

export const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connected</title></head>
<body><p>Connected. You can close this window.</p><script>window.close();</script></body></html>`;

export const INVALID_LINK_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Link expired</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>This link has expired</h1>
<p class="sub">Start the connection again.</p></main></body></html>`;

/** A minimal page reporting that connecting failed, with a reason the user can act on. */
export function errorPageHtml(title: string, detail: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(detail)}</p></main></body></html>`;
}
