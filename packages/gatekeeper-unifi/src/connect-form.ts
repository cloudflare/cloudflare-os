/**
 * The connect page: two forms, one per connection mode, and the parsing and validation of what
 * they post. A reconnect shows only the account's own mode, and a direct connection's console URL
 * can't be changed by reconnecting, so a reconnect can't repoint every existing binding at another
 * console.
 *
 * Pure: imported by the Node tests.
 */

import { escapeHtml, htmlResponse, PAGE_STYLE } from "@gadgets/gatekeeper-kit/connect-pages";

/** What the user submitted. */
export type ConnectInput =
  | { mode: "cloud"; apiKey: string }
  | {
    mode: "direct";
    /** The normalized console URL; absent on a reconnect, which keeps the stored one. */
    baseUrl?: string;
    apiKey: string;
    access?: { clientId: string; clientSecret: string };
  };

/** Which form to show. */
export type ConnectPageMode =
  | { kind: "connect" }
  | { kind: "reconnect"; mode: "cloud" }
  | { kind: "reconnect"; mode: "direct"; baseUrl: string };

/** The largest form body read; the fields are a URL and a few short keys. */
export const MAX_CONNECT_FORM_BYTES = 16 * 1024;

/** Content type the form posts with, which the POST handler insists on. */
export const CONNECT_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** Path segments that mean a pasted URL is a UniFi page or API URL, not a reverse-proxy prefix. */
const UNIFI_PATH_ROOTS = new Set([
  "network", "protect", "access", "talk", "connect", "innerspace", "drive", "login", "proxy",
  "manage", "settings",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A console URL the form can't use; its message is shown on the form. */
export class ConsoleUrlError extends Error {}

/**
 * Normalizes a pasted console URL to the base the API is reached under: its origin, plus a path
 * prefix if a reverse proxy adds one. A pasted UniFi page URL is cut back to the origin.
 * @param raw What the user typed.
 * @returns The base URL, without a trailing slash.
 * @throws ConsoleUrlError when it can't be used.
 */
export function normalizeConsoleUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new ConsoleUrlError("Enter the console's address.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ConsoleUrlError("That isn't a valid address.");
  }
  if (url.username || url.password) {
    throw new ConsoleUrlError("Leave credentials out of the address; enter the API key below.");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConsoleUrlError(
      "Use https://. The API key would travel unencrypted over http, which is only allowed to " +
      "this machine itself.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConsoleUrlError("The address must start with https://.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const prefix = segments.length > 0 && !UNIFI_PATH_ROOTS.has(segments[0]!.toLowerCase())
    ? `/${segments.join("/")}`
    : "";
  return `${url.origin}${prefix}`;
}

/** Whether a string looks like an API key: printable, no whitespace, a sensible length. */
function plausibleKey(value: string): boolean {
  return /^[\x21-\x7e]{16,512}$/.test(value);
}

/**
 * Parses a posted form.
 * @param body The urlencoded body.
 * @param page Which form was shown; a reconnect only accepts its own mode.
 * @returns The input, or a message to show on the re-rendered form.
 */
export function parseConnectForm(
  body: string, page: ConnectPageMode,
): { ok: true; input: ConnectInput } | { ok: false; mode: "cloud" | "direct"; message: string } {
  const form = new URLSearchParams(body);
  const mode = form.get("mode") === "direct" ? "direct" : "cloud";
  if (page.kind === "reconnect" && page.mode !== mode) {
    return { ok: false, mode: page.mode, message: "Reconnect with the same kind of connection." };
  }
  if (mode === "cloud") {
    const apiKey = (form.get("cloudApiKey") ?? "").trim();
    if (!plausibleKey(apiKey)) {
      return { ok: false, mode, message: "Paste the API key from unifi.ui.com → Settings → API Keys." };
    }
    return { ok: true, input: { mode, apiKey } };
  }

  const apiKey = (form.get("localApiKey") ?? "").trim();
  const clientId = (form.get("accessClientId") ?? "").trim();
  const clientSecret = (form.get("accessClientSecret") ?? "").trim();
  if ((clientId === "") !== (clientSecret === "")) {
    return {
      ok: false, mode,
      message: "Enter both the Cloudflare Access client ID and secret, or neither.",
    };
  }
  const access = clientId === "" ? undefined : { clientId, clientSecret };
  let baseUrl: string | undefined;
  if (page.kind === "connect") {
    try {
      baseUrl = normalizeConsoleUrl(form.get("consoleUrl") ?? "");
    } catch (error) {
      return { ok: false, mode, message: error instanceof ConsoleUrlError ? error.message : "Check the address." };
    }
  }
  if (!plausibleKey(apiKey)) {
    return { ok: false, mode, message: "Paste the API key you created on the console, under Integrations." };
  }
  return { ok: true, input: { mode, apiKey, ...(baseUrl !== undefined && { baseUrl }), ...(access && { access }) } };
}

const FORM_STYLE = `
  section { border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin: 0 0 16px;
            background: var(--control); }
  h2 { font-size: 15px; font-weight: 600; color: var(--strong); margin: 0 0 4px; }
  p.hint { margin: 0 0 12px; color: var(--subtle); font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 10px 0 4px; }
  input[type=text], input[type=password], input[type=url] {
    box-sizing: border-box; width: 100%; padding: 8px 10px; font: inherit; font-size: 14px;
    color: var(--text); background: var(--base); border: 1px solid var(--line); border-radius: 6px; }
  details { margin: 10px 0 0; font-size: 13px; }
  summary { cursor: pointer; color: var(--subtle); }
  button { margin: 14px 0 0; padding: 8px 14px; font: inherit; font-size: 14px; font-weight: 500;
           color: var(--on-contrast); background: var(--contrast); border: 0; border-radius: 6px;
           cursor: pointer; }
  code { font-size: 12px; }
`;

/**
 * Renders the connect page.
 * @param action The path both forms post to.
 * @param page Which forms to show.
 * @param error A message to show on one form, after a failed submission.
 * @returns Escaped HTML.
 */
export function connectFormHtml(
  action: string, page: ConnectPageMode, error?: { mode: "cloud" | "direct"; message: string },
): string {
  const errorFor = (mode: "cloud" | "direct") =>
    error?.mode === mode ? `<p class="err" role="alert">${escapeHtml(error.message)}</p>` : "";
  const cloud = `<section>
<h2>UniFi account</h2>
<p class="hint">Reaches every console you own through UniFi's cloud, from anywhere. Create a key at
<b>unifi.ui.com</b> → Settings → API Keys. Needs UniFi OS 5.0.3 or later on the console.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="mode" value="cloud">
${errorFor("cloud")}
<label for="cloudApiKey">Site Manager API key</label>
<input type="password" id="cloudApiKey" name="cloudApiKey" required autocomplete="off" spellcheck="false">
<button type="submit">Connect</button>
</form></section>`;

  const reconnectUrl = page.kind === "reconnect" && page.mode === "direct" ? page.baseUrl : null;
  const direct = `<section>
<h2>Directly to a console</h2>
<p class="hint">Talks to one console's own API, so this server must be able to reach it with a
trusted HTTPS certificate: on your network for a self-hosted Workshop, or through a tunnel. Create a
key on the console under <b>Integrations</b>.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="mode" value="direct">
${errorFor("direct")}
${reconnectUrl === null
    ? `<label for="consoleUrl">Console address</label>
<input type="url" id="consoleUrl" name="consoleUrl" required placeholder="https://unifi.example.com" spellcheck="false">`
    : `<p class="hint">Console: <code>${escapeHtml(reconnectUrl)}</code></p>`}
<label for="localApiKey">API key</label>
<input type="password" id="localApiKey" name="localApiKey" required autocomplete="off" spellcheck="false">
<details><summary>Behind Cloudflare Access?</summary>
<label for="accessClientId">Service token client ID</label>
<input type="text" id="accessClientId" name="accessClientId" autocomplete="off" spellcheck="false">
<label for="accessClientSecret">Service token client secret</label>
<input type="password" id="accessClientSecret" name="accessClientSecret" autocomplete="off" spellcheck="false">
</details>
<button type="submit">Connect</button>
</form></section>`;

  const sections = page.kind === "connect" ? `${cloud}\n${direct}` : page.mode === "cloud" ? cloud : direct;
  const heading = page.kind === "connect" ? "Connect UniFi" : "Reconnect UniFi";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main><h1>${heading}</h1>
<p class="sub">The key stays with this connection; agents and gadgets never see it.</p>
${sections}
</main></body></html>`;
}

/**
 * Serves a page holding a form that posts back to this origin. `htmlResponse` sends
 * `Referrer-Policy: no-referrer`, under which browsers post the form with `Origin: null` and the
 * POST's origin check would refuse every submission, so this page relaxes it to same-origin.
 * @param html The page.
 * @param status The status.
 * @returns The response.
 */
export function formResponse(html: string, status = 200): Response {
  const response = htmlResponse(html, status);
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}
