/** Hardened HTML and browser request guards for gatekeeper connect flows. */

import {
  CONNECT_HANDOFF_ACK_MESSAGE_TYPE,
  CONNECT_HANDOFF_MESSAGE_TYPE,
  type ConnectHandoff,
} from "@gadgets/workshop-shared/gatekeeper";

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

/**
 * Serializes a value for a `<script>` body. `<`, `>` and `&` become `\uXXXX` escapes so no value —
 * not even one containing `</script>` — can end the script early; the two line terminators JSON
 * allows but JavaScript did not are escaped for older parsers.
 * @param value JSON-serializable value.
 * @returns A JavaScript expression evaluating to the value.
 */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The page a connect flow lands on when it has finished. It delivers the handoff ticket to the
 * Workshop and closes itself, over one of two transports:
 *
 * - `postMessage` to the window that opened it — and *only* to `handoff.targetOrigin`, the
 *   Workshop's origin, so a browser drops the message if the opener is anyone else. This is the
 *   sign-in path (the login page keeps the popup handle) and the dev-server path, where the Workshop
 *   is on another origin.
 * - A `BroadcastChannel` named `CONNECT_HANDOFF_MESSAGE_TYPE`, when this page is itself on the
 *   Workshop's origin and has no opener. The Workshop disowns connect popups before navigating them
 *   (so no provider page ever holds a handle to the Workshop window), and a same-origin channel is
 *   the only thing a disowned popup can still reach; the browser scopes it to that origin. The
 *   envelope is repeated every second until a Workshop tab answers with a
 *   `CONNECT_HANDOFF_ACK_MESSAGE_TYPE` envelope for this ticket (a tab whose session is
 *   mid-reconnect would miss a one-shot broadcast, and the connect would fail silently); the ticket
 *   is single-use server-side, so the repeats are harmless. After 30 seconds unacknowledged the
 *   page gives up and tells the user, as below.
 *
 * Without either it can reach no Workshop, so it tells the user to go back and start again; a flow
 * opened from a phished link on another origin ends here with its ticket unredeemed. The connection
 * itself is inert until the Workshop redeems the ticket on the initiating user's session (see
 * `GatekeeperVendor.connectAccount`).
 * @param handoff The handoff returned by `GatekeeperConnectCallback.complete()` /
 *   `reconnectComplete()`. Its `targetOrigin` must be exactly an origin.
 * @returns Escaped HTML; serve it with `htmlResponse()`.
 *
 * @example
 * ```ts
 * const handoff = await callback.complete(account);
 * return htmlResponse(connectHandoffPageHtml(handoff));
 * ```
 */
export function connectHandoffPageHtml(handoff: ConnectHandoff): string {
  let origin: string;
  try {
    origin = new URL(handoff.targetOrigin).origin;
  } catch {
    origin = "";
  }
  if (origin === "" || origin === "null" || origin !== handoff.targetOrigin) {
    throw new Error("The connect handoff's targetOrigin is not an origin.");
  }
  const envelope = { type: CONNECT_HANDOFF_MESSAGE_TYPE, ticket: handoff.ticket };
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Connected</title><style>${PAGE_STYLE}</style></head>
<body><main><h1 id="title">Connected</h1>
<p class="sub" id="detail">Returning to the Workshop…</p></main>
<script>
(function () {
  var envelope = ${scriptLiteral(envelope)};
  var target = ${scriptLiteral(origin)};
  function unreachable() {
    document.getElementById("title").textContent = "This window couldn't reach the Workshop";
    document.getElementById("detail").textContent =
      "Go back to the Workshop tab and start the connection again.";
  }
  var opener = window.opener;
  if (opener && !opener.closed) {
    opener.postMessage(envelope, target);
  } else if (window.location.origin === target && "BroadcastChannel" in window) {
    // Repeated until a Workshop tab acknowledges this ticket: a tab mid-reconnect misses a one-shot
    // broadcast, and the ticket is single-use server-side, so repeating is safe.
    var channel = new BroadcastChannel(${scriptLiteral(CONNECT_HANDOFF_MESSAGE_TYPE)});
    var repeat = setInterval(function () { channel.postMessage(envelope); }, 1000);
    channel.postMessage(envelope);
    channel.onmessage = function (e) {
      if (e.data && e.data.type === ${scriptLiteral(CONNECT_HANDOFF_ACK_MESSAGE_TYPE)} &&
          e.data.ticket === envelope.ticket) {
        clearInterval(repeat);
        window.close();
      }
    };
    setTimeout(function () { clearInterval(repeat); unreachable(); }, 30000);
    return;
  } else {
    unreachable();
    return;
  }
  // The Workshop closes this window once it has redeemed the ticket; this is the fallback.
  setTimeout(function () { window.close(); }, 2000);
})();
</script></body></html>`;
}

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
