/** Hardened HTML and browser request guards for gatekeeper connect flows. */

import type { ConnectHandoff } from "@gadgets/workshop-shared/gatekeeper";
import { requirePositiveInt } from "./positive-int";
import { ResponseTooLargeError, readTextCapped } from "./response-body";

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

/** A connect page's response; the two exported builders differ in what they let a form do. */
function pageResponse(body: string, status: number, referrerPolicy: string, formPolicy = ""): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `frame-ancestors 'none'${formPolicy}`,
      "Referrer-Policy": referrerPolicy,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Builds an uncacheable, unframeable HTML response. Connect URLs carry bearer nonces, so responses
 * never cache or send referrers.
 * @param body HTML response body.
 * @param status HTTP status.
 * @returns A hardened HTML response.
 */
export function htmlResponse(body: string, status = 200): Response {
  return pageResponse(body, status, "no-referrer");
}

/**
 * Builds the response for a page that holds a form guarded by `connectMutationError`: as
 * `htmlResponse`, but with `Referrer-Policy: same-origin`. Under `no-referrer` a browser posts the
 * page's forms with `Origin: null`, which the guard refuses, so the form could never be submitted.
 * `same-origin` still keeps the page's URL, a bearer capability, out of every cross-origin
 * `Referer`. The page's forms may also target only its own origin (`form-action 'self'`), so a
 * mistaken `action` cannot send a typed credential elsewhere. That covers the first request only:
 * not every browser applies it to a redirect, so the handler the form posts to must answer the
 * POST itself and never redirect it to another origin with a 307 or 308, which carry the body.
 * @param body HTML response body.
 * @param status HTTP status.
 * @returns A hardened HTML response whose forms name their origin.
 */
export function formPageResponse(body: string, status = 200): Response {
  return pageResponse(body, status, "same-origin", "; form-action 'self'");
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
 * URL the form was served under. A browser sends `Origin: null` when the submitting page has
 * `Referrer-Policy: no-referrer`, as `htmlResponse` pages do, so serve a guarded HTML form with
 * `Referrer-Policy: same-origin` instead.
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
    /* Darker than Kumo's danger: small error text on --base needs 4.5:1, and this reaches 6.2:1. */
    --danger: oklch(50.5% 0.213 27.518);
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
  main { width: 100%; max-width: 420px; overflow-wrap: anywhere; }
  h1 { font-size: 17px; font-weight: 600; color: var(--strong); margin: 0 0 6px;
       letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: var(--subtle); font-size: 14px; }
  p.err { color: var(--danger); font-size: 13px; margin: 0 0 16px; }
`;

/** Styles for `connectFormHtml`, on top of `PAGE_STYLE`. */
const FORM_STYLE = `
  /* An input's border is the only cue for where to type: 3:1 or more on --base and --control. */
  :root { --field-line: oklch(62% 0.006 60); }
  @media (prefers-color-scheme: dark) { :root { --field-line: oklch(52% 0.022 285); } }
  label { display: block; font-size: 13px; font-weight: 500; margin: 16px 0 6px; }
  /* 16px: a phone zooms the page to focus anything smaller. */
  input:not([type=hidden]) { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit;
         font-size: 16px; color: var(--text); background: var(--control);
         border: 1px solid var(--field-line); border-radius: 6px; }
  input::placeholder { color: var(--subtle); opacity: 1; }
  button { margin-top: 20px; padding: 8px 14px; font: inherit; font-weight: 500; cursor: pointer;
         color: var(--on-contrast); background: var(--contrast); border: 0; border-radius: 6px; }
`;

/** The error line's id. It has a `.`, which no field name can, so it is never an input's id. */
const ERROR_ID = "form.error";

/** The intro's id, out of a field name's reach as `ERROR_ID` is. */
const INTRO_ID = "form.intro";

/**
 * Disables the button once the form is submitted. A second click would post the nonce again, and
 * the browser shows the answer to the last request, which may be the one that lost. It reaches the
 * button through the event, because a field's name can hide any property of the form itself.
 */
const SUBMIT_ONCE = "if(event.submitter)event.submitter.disabled=true";

/** Renders an element's attributes in order: `true` is a bare name, `false` or `undefined` is left out. */
const attributes = (values: Record<string, string | boolean | undefined>): string =>
  Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) => value === true ? name : `${name}="${escapeHtml(String(value))}"`)
    .join(" ");

/** The name of the hidden field `connectFormHtml` carries the flow's nonce in. */
export const CONNECT_FORM_NONCE_FIELD = "nonce";

/** One input of a connect form. */
export type ConnectFormField = {
  /** The form field's name: a letter, then letters, digits, `_` or `-`. Not `nonce`. */
  name: string;
  /** What the input is labelled. */
  label: string;
  /**
   * Masks what is typed, for a key or token, and asks the browser not to fill the input with a
   * saved password. A password manager may still offer to save what is typed.
   */
  secret?: boolean;
  /** Example text shown while the input is empty. */
  placeholder?: string;
};

/**
 * Renders a connect page on which the user types what the provider has no OAuth flow for, such as
 * an API key. The form posts `application/x-www-form-urlencoded` to `action`, with the flow's
 * nonce in the hidden field `CONNECT_FORM_NONCE_FIELD`. Every value is escaped. Serve it with
 * `formPageResponse()`, not `htmlResponse()`, and read its submission with `readConnectForm()`.
 * @param options The page's heading and introduction, where the form posts, the nonce that names
 * this attempt, the inputs in order, the submit button's label (default "Connect"), and `error`,
 * which says above the inputs why the last submission was refused, when the form is shown again.
 * @returns Escaped HTML.
 * @throws Error for no fields, a malformed or repeated field name, or one named `nonce`.
 *
 * @example
 * ```ts
 * return formPageResponse(connectFormHtml({
 *   title: "Connect Vendor",
 *   intro: "Create an API key in Vendor, under Settings, and paste it here.",
 *   action: `${baseUrl}/${accountId}/key`,
 *   nonce: formNonce,
 *   fields: [{ name: "key", label: "API key", secret: true }],
 * }));
 * ```
 */
export function connectFormHtml(options: {
  title: string;
  intro: string;
  action: string;
  nonce: string;
  fields: readonly ConnectFormField[];
  submitLabel?: string;
  error?: string;
}): string {
  const names = options.fields.map(({ name }) => name);
  if (names.length === 0 || new Set(names).size !== names.length
      || names.some(name => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || name === CONNECT_FORM_NONCE_FIELD)) {
    throw new Error("A connect form needs fields with distinct names of letters, digits, \"_\" and "
      + `"-", none of them "${CONNECT_FORM_NONCE_FIELD}".`);
  }
  const title = escapeHtml(options.title);
  const refused = options.error !== undefined;
  const inputs = options.fields.map((field, index) => {
    const first = index === 0;
    return `<label for="${field.name}">${escapeHtml(field.label)}</label>\n<input ${attributes({
      id: field.name,
      name: field.name,
      type: field.secret ? "password" : "text",
      required: true,
      // "off" is ignored on a password input, and the Workshop's own sign-in is on this origin.
      autocomplete: field.secret ? "new-password" : undefined,
      "data-1p-ignore": field.secret,
      "data-lpignore": field.secret ? "true" : undefined,
      placeholder: field.placeholder,
      "aria-invalid": refused ? "true" : undefined,
      // Focus skips both lines: the first input takes it as the page loads, and an alert already
      // on the page then is not reliably announced.
      "aria-describedby":
        [refused && ERROR_ID, first && INTRO_ID].filter(Boolean).join(" ") || undefined,
      autofocus: first,
    })}>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main><h1>${title}</h1>
<p class="sub" id="${INTRO_ID}">${escapeHtml(options.intro)}</p>
${options.error !== undefined ? `<p class="err" id="${ERROR_ID}" role="alert">${escapeHtml(options.error)}</p>\n` : ""}<form method="post" action="${escapeHtml(options.action)}" onsubmit="${SUBMIT_ONCE}">
<input type="hidden" name="${CONNECT_FORM_NONCE_FIELD}" value="${escapeHtml(options.nonce)}">
${inputs}
<button type="submit">${escapeHtml(options.submitLabel ?? "Connect")}</button>
</form></main></body></html>`;
}

/** The page a refused connect-form submission gets. */
const refuse = (status: number): Response =>
  htmlResponse(errorPageHtml("Connection failed", "Start the connection again."), status);

/** The largest connect-form submission `readConnectForm` reads unless told otherwise. */
const MAX_CONNECT_FORM_BYTES = 16 * 1024;

/**
 * Reads the submission of a `connectFormHtml` form: refuses one that is not a POST from a page of
 * the deployment's origin (see `connectMutationError`), whose body is larger than `maxBytes`, or
 * whose body cannot be read, and otherwise parses its fields. The origin is the one the Workshop
 * and every gatekeeper of the deployment share, so this keeps other sites out, not other pages
 * of the deployment. A refusal comes back as the response to send, so
 * the caller tests the result with `instanceof Response`. The nonce is in the field
 * `CONNECT_FORM_NONCE_FIELD`; this function does not check it.
 * @param req The submission.
 * @param options `origin` is the gatekeeper's configured base URL, never `req.url`'s; `maxBytes`
 * caps the body (default 16 KiB).
 * @returns The form's fields, or the refusal to send.
 *
 * @example
 * ```ts
 * const form = await readConnectForm(req, { origin: baseUrl });
 * if (form instanceof Response) return form;
 * const result = await account.acceptKey(form.get(CONNECT_FORM_NONCE_FIELD) ?? "", form.get("key") ?? "");
 * ```
 */
export async function readConnectForm(
  req: Request,
  options: { origin: string; maxBytes?: number },
): Promise<URLSearchParams | Response> {
  // First, so that the caller's mistake throws on every call, not answered as the browser's.
  const maxBytes = requirePositiveInt("maxBytes", options.maxBytes ?? MAX_CONNECT_FORM_BYTES);
  if (req.method !== "POST") {
    const response = refuse(405);
    response.headers.set("Allow", "POST");
    return response;
  }
  const error = connectMutationError(req, {
    origin: options.origin, contentType: "application/x-www-form-urlencoded",
  });
  if (error) return refuse(error === "cross-origin" ? 403 : 415);
  try {
    return new URLSearchParams(await readTextCapped(req, maxBytes));
  } catch (caught) {
    if (caught instanceof ResponseTooLargeError) return refuse(413);
    // The body could not be read, such as when the browser went away mid-upload.
    return refuse(400);
  }
}

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
 * The page a finished connect, reconnect or sign-in flow lands on. It navigates the popup to the
 * Workshop's own handoff page, `<targetOrigin>/connect/handoff#<ticket>`, which redeems the ticket
 * over the popup's own session; this page holds no session and needs no RPC client.
 *
 * The ticket travels in the URL fragment, which a browser never sends to a server nor in a
 * `Referer` header, and `location.replace()` leaves no history entry to revisit; the ticket is
 * single-use and expires two minutes after the flow finishes. The destination is the
 * backend-supplied `targetOrigin`, validated to be exactly an origin, so the ticket reaches no
 * other document. A flow finished by anyone but its starter ends with a ticket that person's
 * session cannot redeem and no popup of the starter's carries. The connection itself is inert until
 * the Workshop redeems the ticket on the initiating user's session (see
 * `GatekeeperVendor.connectAccount`).
 *
 * The Workshop must serve `/connect/handoff` directly: a fragment survives an HTTP redirect, but the
 * page it lands on has to be the SPA. The path literal is duplicated here on purpose — the kit is
 * published to gatekeepers and must not depend on `workshop-frontend` — and each package pins it
 * with a test.
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
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Connected</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>Connected</h1>
<p class="sub">Returning to the Workshop…</p></main>
<script>
(function () {
  var ticket = ${scriptLiteral(handoff.ticket)};
  var target = ${scriptLiteral(origin)};
  window.location.replace(target + "/connect/handoff#" + encodeURIComponent(ticket));
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
