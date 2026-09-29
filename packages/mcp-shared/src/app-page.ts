// The sidecar page: the Host document of MCP Apps for a gatekeeper app link, and the sandbox proxy
// the specification requires between that Host and the View.
//
// Three nested documents, and the middle one is the whole point. A web Host MUST wrap the View in a
// sandbox proxy whose origin differs from the Host's; this deployment serves everything from one
// origin, so both frames are opaque (`sandbox="allow-scripts"`, deliberately *not*
// `allow-same-origin`). A srcdoc frame that kept its parent's origin would hand the View the Host's
// origin — and the app token is in the Host's URL — which is exactly the escape that rule exists to
// prevent. Origin checks are therefore meaningless on this channel and identity is the boundary
// instead: the proxy relays by `event.source`, and the Host answers only what came from the sandbox
// frame's `contentWindow`, so a View that posts to the Host directly is ignored rather than served.
//
// The page is a string because this package is Worker-only (`lib: ["ESNext"]`, no DOM) and because
// it is the only browser code in the feature. Nothing the server supplied reaches it outside a
// `scriptLiteral` (a JSON literal) or an `escapeHtml` (a text node) — the app's own HTML included,
// which no document we wrote ever parses as markup: the proxy hands it to the View with
// `setAttribute("srcdoc", ...)`.

import { escapeHtml, PAGE_STYLE, scriptLiteral } from "@gadgets/gatekeeper-kit/connect-pages";

import { APP_PROTOCOL_VERSION, type AppViewPage } from "./apps.js";

/**
 * The query parameter that marks a load as the sidecar window this page opened for itself.
 *
 * A link in the chat opens a tab, and asking the browser for a window of a chosen size takes a
 * gesture in a document: this page's own button is where that gesture can happen. The window it
 * opens carries this marker, and the offer is made from the marker's absence, which is also what
 * keeps that window from offering to open another one.
 */
export const APP_SIDECAR_PARAM = "sidecar";

// The window this page asks for, in CSS pixels, and the features that make it one: `popup` is what
// asks for a window rather than a tab. A browser is free to clamp the size to the screen, and a
// smaller window is still the sidecar the specification describes. The size is a judgement about the
// app: wide enough for the dashboards these servers render, and short enough to fit the laptop
// viewport it is most likely to land on.
const SIDECAR_WINDOW_FEATURES = "popup,width=900,height=700";

/**
 * The frame the specification mandates between the Host and the app.
 *
 * It loads the app document the Host approved, under the policy the Host rendered, and it moves
 * messages between the Host and the View — except `ui/notifications/sandbox-*`, which is its own
 * channel with the Host and is never relayed. It is opaque-origin like the View, so it too checks
 * identity rather than origin.
 */
const SANDBOX_PROXY_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>html,body{height:100%;margin:0}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body>
<iframe id="view" sandbox="allow-scripts"></iframe>
<script>
(function () {
  var view = document.getElementById("view");

  var attribute = function (value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  };

  var load = function (params) {
    // The Host sends a finished policy, not the declared domains: the builder that widens the
    // defaults is typechecked and unit-tested server-side, and rebuilding a security-critical
    // string inside this untypechecked script is precisely what we are avoiding. The proxy's job is
    // to apply what the Host approved.
    //
    // A View is never loaded without one: a missing or empty policy is a bug upstream, and the
    // unsafe reading of it — run the app unrestricted — is the one thing worse than not loading it.
    if (!params || typeof params.csp !== "string" || params.csp === "") return;
    if (params.sandbox) view.setAttribute("sandbox", params.sandbox);
    if (params.allow) view.setAttribute("allow", params.allow);
    view.setAttribute("srcdoc",
      '<meta http-equiv="Content-Security-Policy" content="' + attribute(params.csp) + '">' +
      params.html);
  };

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (message && typeof message === "object" && typeof message.method === "string" &&
        message.method.indexOf("ui/notifications/sandbox-") === 0) {
      if (message.method === "ui/notifications/sandbox-resource-ready") load(message.params);
      return;
    }
    // Both frames are opaque-origin, so there is no origin to compare: what came from the View goes
    // up to the Host, and everything else — the Host's answers, its notifications — goes down.
    if (event.source === view.contentWindow) window.parent.postMessage(message, "*");
    else view.contentWindow.postMessage(message, "*");
  });

  window.parent.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {},
  }, "*");
})();
</script></body></html>`;

/**
 * `PAGE_STYLE` lays out a centred card, which is what a connect page is; this page is a frame that
 * fills a window, so it keeps the palette and typography and replaces the layout.
 */
const APP_PAGE_STYLE = `
  html { height: 100%; }
  body { display: block; height: 100%; padding: 0; }
  main { display: flex; flex-direction: column; height: 100%; max-width: none; }
  header { display: flex; align-items: baseline; gap: 8px; padding: 10px 16px;
           border-bottom: 1px solid var(--line); background: var(--control); }
  header h1 { margin: 0; font-size: 14px; }
  header p.sub { margin: 0; font-size: 12px; white-space: nowrap; overflow: hidden;
                 text-overflow: ellipsis; }
  p.err { margin: 10px 16px 0; }
  p.ask { margin: 10px 16px 0; font-size: 13px; color: var(--subtle); }
  p.sidecar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0;
              padding: 8px 16px; border-bottom: 1px solid var(--line); font-size: 12px;
              color: var(--subtle); }
  p.sidecar button { font: inherit; color: var(--brand); background: none; border: 0; padding: 0;
                     cursor: pointer; text-decoration: underline; }
  p.ask a { color: var(--brand); }
  iframe { flex: 1 1 auto; min-height: 0; width: 100%; border: 0; background: var(--control); }
`;

/**
 * The Host half of the protocol, as a script body: the sandbox handshake, `ui/initialize`, the call
 * snapshot, and the proxy for the three methods a View may call.
 *
 * Every interpolated value is a `scriptLiteral`, so this function is the one place in the feature
 * where server data becomes browser code — and it becomes data there, never markup.
 */
function hostScript(view: AppViewPage, pageUrl: string): string {
  return `(function () {
  // Only what the View needs from the server: the subject of \`ui/initialize\` is a handshake, not
  // a dump of the link.
  var view = ${scriptLiteral({
    html: view.html,
    csp: view.csp,
    allow: view.allow,
    call: view.call,
  })};

  // The endpoint is one path segment below the page's own URL, derived here rather than sent:
  // whatever query or fragment the visitor arrived with must not survive into the fetch URL.
  var endpoint = new URL(${scriptLiteral(pageUrl)});
  endpoint.pathname = endpoint.pathname.replace(/\\/+$/, "") + "/rpc";
  endpoint.search = "";
  endpoint.hash = "";
  var rpc = endpoint.href;

  var sandbox = document.getElementById("sandbox");
  var started = false;

  var post = function (message) { sandbox.contentWindow.postMessage(message, "*"); };
  var reply = function (id, result) {
    post({ jsonrpc: "2.0", id: id, result: result });
  };
  var fail = function (id, code, message) {
    post({ jsonrpc: "2.0", id: id, error: { code: code, message: message } });
  };
  var notify = function (method, params) {
    post({ jsonrpc: "2.0", method: method, params: params });
  };

  // Only what a window can honour; a View feature-detects these before it calls one. There is no
  // \`message\` or \`updateModelContext\` because a sidecar has no conversation, no \`sampling\`
  // because it has no sampler, and no \`downloadFile\`. \`sandbox\` carries no sub-fields: the
  // applied policy travels on the sandbox channel below, and both sub-fields are optional.
  var capabilities = {
    openLinks: {},
    serverTools: {},
    serverResources: {},
    logging: {},
    sandbox: {},
  };

  // A sidecar window shows the app in the viewport below this page's one-line header and never
  // switches, so \`fullscreen\` is the only display mode this host has.
  var theme = function () {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };

  // A call is the only thing here that can fail: the token expired, or the tab went offline. The
  // View is an MCP client, so its failure has to arrive as JSON-RPC, not as silence.
  var LOST = "The connection to the server was lost. Open the result again from the chat.";

  // The three allowed methods, answered by the account at this page's own /rpc. The View never
  // learns that URL: the token is in it, and this document is the only holder.
  var callRpc = function (id, message) {
    fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    }).then(function (response) {
      return response.text();
    }).then(function (body) {
      var payload = null;
      try { payload = JSON.parse(body); } catch (error) { payload = null; }
      // A refusal is JSON-RPC too, so anything that is not one is the link failing rather than the
      // method: an error page, or a body cut short by the DO's response limit.
      if (payload && payload.jsonrpc === "2.0") { post(payload); return; }
      fail(id, -32603, LOST);
    }).catch(function () {
      fail(id, -32603, LOST);
    });
  };

  // Replaced rather than accumulated: the strip shows the app's most recent request, nothing else.
  var offer = function (url) {
    var link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    var strip = document.getElementById("asked");
    strip.textContent = "The app asked to open: ";
    strip.appendChild(link);
    strip.hidden = false;
  };

  var openLink = function (id, params) {
    var url = params && typeof params.url === "string" ? params.url : "";
    var target = null;
    try { target = new URL(url); } catch (error) { target = null; }
    // The app is untrusted HTML and this window is the one holding the token, so nothing but http
    // and https is handed to the browser: no \`javascript:\` URL runs in this document, and a View
    // cannot ask the host to open a scheme that reaches back into it.
    if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
      reply(id, { isError: true });
      return;
    }
    // \`noopener,noreferrer\`: the opened page must not hold a handle on this window. No click
    // activation survives postMessage, so the browser's popup blocker usually refuses the tab and
    // returns null; the URL is then offered in the page, where a real gesture can open it.
    var opened = window.open(target.href, "_blank", "noopener,noreferrer");
    if (!opened) offer(target.href);
    reply(id, opened ? {} : { isError: true });
  };

  // The specification's order: tool-input before tool-result, at most once, and nothing at all to
  // the View until it has said \`initialized\`.
  var start = function () {
    if (started) return;
    started = true;
    if (view.call) {
      notify("ui/notifications/tool-input", { arguments: view.call.input });
      // A result too large for the link was dropped before the link was minted. The app gets the
      // arguments and no result — the truth — and the page says why nothing follows.
      if (view.call.result !== undefined) notify("ui/notifications/tool-result", view.call.result);
    }
    // The theme and the mode once more, as the update the specification expects a host to send.
    notify("ui/notifications/host-context-changed", { theme: theme(), displayMode: "fullscreen" });
  };

  var onNotification = function (message) {
    if (message.method === "ui/notifications/initialized") { start(); return; }
    if (message.method === "ui/notifications/sandbox-proxy-ready") {
      // From the proxy, which is the only frame the guard below lets through. It is loaded once and
      // never reloaded, so this document is sent once.
      post({
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: view.html, csp: view.csp, allow: view.allow },
      });
      return;
    }
    if (message.method === "notifications/message") {
      // The View's logs are its own: the console, never the page and never the user.
      var params = message.params || {};
      var write = { debug: "debug", info: "info", warning: "warn", error: "error" }[params.level];
      console[write || "log"]("[app]", params.data);
    }
    // \`ui/notifications/size-changed\` lands here and is ignored: the container is declared fixed,
    // and the frame follows the window by itself. So do \`notifications/cancelled\` and
    // \`notifications/progress\` — this Host issues no requests to cancel — and
    // \`ui/notifications/request-teardown\`, which the specification lets a host defer or ignore:
    // the window is the user's to close. A notification is never answered, not even an unknown
    // one, because there is no id to answer.
  };

  var onRequest = function (id, message) {
    if (message.method === "ui/initialize") {
      reply(id, {
        protocolVersion: ${scriptLiteral(APP_PROTOCOL_VERSION)},
        hostInfo: { name: "Gadgets", version: "1.0.0" },
        hostCapabilities: capabilities,
        hostContext: {
          theme: theme(),
          displayMode: "fullscreen",
          // Fixed, not flexible, and that is deliberate: the specification only obliges a host
          // to resize with \`size-changed\` when the container is flexible. The View frame is
          // CSS-sized to the window, so it follows a resize by itself; this is its start size.
          containerDimensions: { width: window.innerWidth, height: window.innerHeight },
        },
      });
      return;
    }
    if (message.method === "ui/open-link") { openLink(id, message.params); return; }
    if (message.method === "ui/request-display-mode") {
      // Never a switch: the app already fills the window. The specification wants the resulting
      // mode back whether or not anything changed, which is also what an unavailable mode gets.
      reply(id, { mode: "fullscreen" });
      return;
    }
    if (message.method === "ui/resource-teardown") {
      // Only meaningful the other way round — a Host asking a View to release what it holds — but
      // a View that sends it is told the same thing either way: acknowledged, and nothing closes
      // under the user.
      reply(id, {});
      return;
    }
    if (message.method === "tools/call" || message.method === "resources/read" ||
        message.method === "ping") {
      callRpc(id, message);
      return;
    }
    // Everything else — \`ui/message\`, \`ui/update-model-context\`, \`ui/download-file\` and
    // app-provided tools — is refused by name rather than ignored, so a View stops waiting.

    fail(id, -32601, "This host does not implement " + message.method);
  };

  // The security boundary. The View is not a child of this document, so it can postMessage this
  // window directly, and this window's URL is the one holding the token. Both frames are
  // opaque-origin and therefore have no origin to check: the sandbox frame's own \`contentWindow\`
  // is the only identity that means anything, and everything else is dropped without an answer.
  window.addEventListener("message", function (event) {
    if (event.source !== sandbox.contentWindow) return;
    var message = event.data;
    if (!message || typeof message !== "object" || typeof message.method !== "string") return;
    if ("id" in message) onRequest(message.id, message);
    else onNotification(message);
  });
})();`;
}

/**
 * The strip that offers the sidecar window, or nothing when this page already is one.
 *
 * Rendered rather than injected by the script, so the button is in the document before the
 * script runs and a reader of this page's source sees the offer exactly when the page means to
 * make it.
 */
function sidecarOffer(offer: boolean): string {
  if (!offer) return "";
  return `<p class="sidecar"><span>Showing in a tab.</span>
<button type="button" id="sidecar-open">Open in a sidecar window</button>
<span id="sidecar-note"></span></p>`;
}

/**
 * The one thing this page offers that the app cannot ask for: a window sized for it.
 *
 * A link opens a tab, and only a gesture in a document can ask the browser for a window of a
 * chosen size. This page has the user in front of it, so it trades one click for the
 * specification's sidecar: the window it opens is this same page, marker and all, so nothing is
 * re-fetched to be shown again — what opens is what is already on screen.
 */
function sidecarOfferScript(pageUrl: string): string {
  return `(function () {
  var button = document.getElementById("sidecar-open");
  var note = document.getElementById("sidecar-note");
  var target = new URL(${scriptLiteral(pageUrl)});
  target.searchParams.set(${scriptLiteral(APP_SIDECAR_PARAM)}, "1");
  // Named from the link's own token, so a second click brings the window already showing this app
  // forward instead of opening another one, and two links never end up sharing a window.
  var name = "gadgets-app-" + target.pathname.split("/").pop().slice(-32);

  button.addEventListener("click", function () {
    var popup = window.open(target.href, name, ${scriptLiteral(SIDECAR_WINDOW_FEATURES)});
    if (!popup) {
      note.textContent =
        "Your browser blocked the window. Allow pop-ups for this site and try again.";
      return;
    }
    // Disowned by hand rather than with \`noopener\`, which makes a successful open
    // indistinguishable from a blocked one: no page in this flow holds a handle on this one.
    try { popup.opener = null; } catch (error) { /* already gone: nothing to disown */ }
    note.textContent = "Opened in its own window.";
    // The app is in that window now and this tab is the leftover. A browser may refuse to close
    // a tab it did not open from script, in which case the app stays in this one as well.
    try { window.close(); } catch (error) { /* not this page's to close */ }
  });
})();`;
}

/**
 * The one thing the page itself has to say about a call: an account drops a result too large to
 * keep, and a View that simply never receives `ui/notifications/tool-result` would look stale.
 */
function droppedResultNote(view: AppViewPage): string {
  if (!view.call || view.call.result !== undefined) return "";
  return `<p class="err">This result was too large to keep, so the app has the arguments and ` +
  `not the output.</p>`;
}

/**
 * Builds the popup document: the Host half of MCP Apps, with the sandbox proxy nested inside it.
 *
 * No CSP of this page's own: a `srcdoc` child inherits its parent's policy, so a `default-src` here
 * would be inherited by the proxy and its app, whose domains are the resource's business and not
 * the page's. The View's policy travels as the `<meta http-equiv>` the proxy prepends, and
 * `htmlResponse` still sends `frame-ancestors 'none'`, which is what keeps this document — the one
 * with the token in its URL — out of someone else's frame.
 * @param view Everything the sidecar renders, resolved by the account.
 * @param pageUrl The page's own URL: where the script derives its JSON-RPC endpoint, and whether
 * this is a tab a link opened (which offers a suitably sized window) or that window itself.
 * @returns The Host document.
 */
export function appPageHtml(input: { view: AppViewPage; pageUrl: string }): string {
  const title = escapeHtml(input.view.title ?? input.view.uri);
  // The window this page opens for itself carries the marker; the load a chat link produced does
  // not, and that difference is the whole of what decides which of the two this is.
  const offerSidecar = !new URL(input.pageUrl).searchParams.has(APP_SIDECAR_PARAM);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title><style>${PAGE_STYLE}</style><style>${APP_PAGE_STYLE}</style></head>
<body><main><header><h1>${title}</h1><p class="sub">${escapeHtml(input.view.uri)}</p></header>
${sidecarOffer(offerSidecar)}
<p class="ask" id="asked" hidden></p>
${droppedResultNote(input.view)}
<iframe id="sandbox" sandbox="allow-scripts" srcdoc="${escapeHtml(SANDBOX_PROXY_HTML)}"></iframe>
</main>
<script>
${hostScript(input.view, input.pageUrl)}
${offerSidecar ? sidecarOfferScript(input.pageUrl) : ""}
</script></body></html>`;
}
