import { describe, expect, it } from "vitest";

import { escapeHtml, scriptLiteral } from "@gadgets/gatekeeper-kit/connect-pages";

import { appPageHtml } from "../src/app-page.js";
import { APP_PROTOCOL_VERSION, type AppViewPage } from "../src/apps.js";

const PAGE_URL = `https://gatekeeper.example.com/app/${"a".repeat(64)}/${"b".repeat(64)}`;
const CSP = `default-src 'none'; script-src 'self' 'unsafe-inline'; ` +
  `report-uri "https://api.test/r"`;
const RESULT = { content: [{ type: "text", text: "sunny" }] };

function view(overrides: Partial<AppViewPage> = {}): AppViewPage {
  return {
    uri: "ui://weather/dashboard",
    title: "Weather",
    html: "<!DOCTYPE html><p>hello</p>",
    csp: CSP,
    call: { toolName: "forecast", input: { city: "SF" }, result: RESULT },
    ...overrides,
  };
}

function page(overrides: Partial<AppViewPage> = {}, pageUrl = PAGE_URL): string {
  return appPageHtml({ view: view(overrides), pageUrl });
}

type Recorder = { posted: unknown[]; postMessage(message: unknown, origin: string): void };

function recorder(): Recorder {
  const posted: unknown[] = [];
  return { posted, postMessage: message => { posted.push(message); } };
}

// The page is browser code in a string, so the only way to assert what it does is to run it against
// the globals it uses. These two harnesses are those globals: `window`, `document` and `fetch` for
// the Host, and the same three for the proxy document nested in its `srcdoc`, recovered the way an
// HTML parser would recover it.

/**
 * The Host's script: the page's only unescaped `<script>`, since the proxy's is an attribute.
 */
function hostScript(page: string): string {
  const open = page.indexOf("<script>") + "<script>".length;
  return page.slice(open, page.lastIndexOf("</script>"));
}

function unescapeHtml(value: string): string {
  const named: Record<string, string> = {
    "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&",
  };
  return value.replace(/&(?:lt|gt|quot|#39|amp);/g, entity => named[entity]!);
}

/** The proxy document as the browser reconstructs it from the `srcdoc` attribute. */
function proxyDocument(page: string): string {
  const marker = 'srcdoc="';
  const start = page.indexOf(marker) + marker.length;
  return unescapeHtml(page.slice(start, page.indexOf('"', start)));
}

/**
 * Lets the page's fetch chain — stub response, `.text()`, parse, reply — finish; no clock in it.
 */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
}

type Host = {
  /** The sandbox frame's window: what the Host posts to it, and the source it answers. */
  sandbox: Recorder;
  /** Delivers a message event whose `source` is `source`. */
  from(source: unknown, message: unknown): void;
  fetched: string[];
  opened: string[][];
  /** What the page offered in its strip, when it could not open a link itself. */
  offered: { label: string; hidden: boolean; link?: Record<string, unknown> };
  logs: unknown[][];
  /** The ids the page looked up, which is what says whether it wired a control at all. */
  requested: string[];
  /** The sidecar offer: what clicking its button did, and what the strip says afterwards. */
  sidecar: { click(): void; note: string };
  /** Whether the page closed itself after the window opened. */
  closed: boolean;
};

function runHost(
  page: string,
  options: { reply?: string; dark?: boolean; blocked?: boolean } = {},
): Host {
  const sandbox = recorder();
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const fetched: string[] = [];
  const opened: string[][] = [];
  const requested: string[] = [];
  let closed = false;
  const logs: unknown[][] = [];
  const write = (...args: unknown[]): number => logs.push(args);
  const reply = options.reply;
  const offered: Host["offered"] = { label: "", hidden: true };
  const host = {
    addEventListener(_type: string, listener: (event: { source: unknown; data: unknown }) => void) {
      listeners.push(listener);
    },
    matchMedia: () => ({ matches: options.dark ?? false }),
    innerWidth: 1024,
    innerHeight: 768,
    open: (...args: string[]) => { opened.push(args); return options.blocked ? null : {}; },
    close: () => { closed = true; },
  };
  // The strip the Host offers a blocked link in: assigning its label clears whatever was there, the
  // way the DOM does, and the anchor is the element `createElement` handed it.
  const asked = {
    get hidden() { return offered.hidden; },
    set hidden(value: boolean) { offered.hidden = value; },
    set textContent(value: string) { offered.label = value; delete offered.link; },
    appendChild(child: Record<string, unknown>) { offered.link = child; },
  };
  const sidecarListeners: (() => void)[] = [];
  const sidecarButton = {
    addEventListener(type: string, listener: () => void) {
      if (type === "click") sidecarListeners.push(listener);
    },
  };
  const sidecarNote = { textContent: "" };
  const document = {
    getElementById: (id: string) => {
      requested.push(id);
      return ({
        sandbox: { contentWindow: sandbox },
        asked,
        "sidecar-open": sidecarButton,
        "sidecar-note": sidecarNote,
      } as Record<string, unknown>)[id] ?? null;
    },
    createElement: (tag: string) => ({ tag }),
  };
  // Answers what the account's `/rpc` answers: the same id, a result of its own. `reply` replaces
  // the body with something that is not a reply at all, which is what an expired link yields.
  const fetch = async (url: string, init: { body?: string }) => {
    fetched.push(String(url));
    if (reply !== undefined) return { text: async () => reply };
    const message = JSON.parse(String(init.body));
    const result = { jsonrpc: "2.0", id: message.id, result: { echo: message.method } };
    return { text: async () => JSON.stringify(result) };
  };
  new Function("window", "document", "fetch", "console", hostScript(page))(
    host, document, fetch, { log: write, debug: write, info: write, warn: write, error: write });
  return {
    sandbox,
    fetched,
    opened,
    offered,
    logs,
    requested,
    get closed() { return closed; },
    sidecar: {
      click: () => { for (const listener of sidecarListeners) listener(); },
      get note() { return sidecarNote.textContent; },
    },
    from: (source, message) => {
      for (const listener of listeners) listener({ source, data: message });
    },
  };
}

type Proxy = {
  /** The nested frame: the window it is, what the proxy set on it, and what it posted to it. */
  view: { contentWindow: Recorder; attributes: Record<string, string>; posted: unknown[] };
  parent: unknown[];
  from(source: unknown, message: unknown): void;
};

function runProxy(page: string): Proxy {
  const document = proxyDocument(page);
  const open = document.indexOf("<script>") + "<script>".length;
  const script = document.slice(open, document.lastIndexOf("</script>"));
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const parent = recorder();
  const viewWindow = recorder();
  const attributes: Record<string, string> = {};
  const view = {
    contentWindow: viewWindow,
    setAttribute: (name: string, value: string) => { attributes[name] = value; },
  };
  const window = {
    parent: { postMessage: parent.postMessage },
    addEventListener(_type: string, listener: (event: { source: unknown; data: unknown }) => void) {
      listeners.push(listener);
    },
  };
  new Function("window", "document", script)(
    window, { getElementById: (id: string) => (id === "view" ? view : null) });
  return {
    view: { contentWindow: viewWindow, attributes, posted: viewWindow.posted },
    parent: parent.posted,
    from: (source, message) => {
      for (const listener of listeners) listener({ source, data: message });
    },
  };
}

/**
 * How often each of these raw sequences occurs, which is what a value escaping its position moves.
 */
function counts(page: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const tag of ["<script", "</script", "<iframe", "</iframe", "<img", "<style"]) {
    found[tag] = page.split(tag).length - 1;
  }
  return found;
}

describe("appPageHtml", () => {
  it("keeps a hostile resource inside its own position", () => {
    const attack = `</script><script>window.pwned = 1</script></iframe><img src=x onerror="pwned">`;
    const built = page({ html: attack, title: attack, uri: `ui://x/${attack}` });

    // Structure is what an escape would move: same tags, same counts, same page.
    expect(counts(built)).toEqual(counts(page()));
    // A raw delimiter from the value surviving into the document would be the escape itself.
    expect(built).not.toContain("</script><script>");
    expect(built).not.toContain("<img");
    // The app's document is a JSON literal, the title and uri are escaped text nodes, and there is
    // no third way in.
    expect(built).toContain(scriptLiteral(attack));
    expect(built).toContain(escapeHtml(attack));
    expect(built).not.toContain(attack);
  });

  it("serves the proxy document in an opaque-origin sandbox frame", () => {
    const built = page();
    const proxy = proxyDocument(built);

    expect(built).toContain('sandbox="allow-scripts" srcdoc="');
    expect(proxy).toContain('<iframe id="view" sandbox="allow-scripts">');
    // Not `allow-same-origin` anywhere: a frame that kept the Host's origin would be handed the
    // origin the token belongs to, which is the two-origin rule in one line.
    expect(built).not.toContain("allow-same-origin");
  });

  it("ignores everything that did not come from the sandbox frame", async () => {
    const built = page();
    const host = runHost(built);
    expect(hostScript(built)).toContain("event.source");

    // The View is the sandbox's child, not the Host's, so it can post to the Host directly — and
    // the token is in the Host's URL, so nothing it says may be answered.
    host.from({}, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    host.from({}, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "forecast" } });
    await settle();

    expect(host.sandbox.posted).toEqual([]);
    expect(host.fetched).toEqual([]);
  });

  it("answers the handshake with only the capabilities a window can honour", async () => {
    const host = runHost(page());
    host.from(host.sandbox, {
      jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" },
    });
    await settle();

    // Every field is asserted, so declaring one more — `sampling`, `message`, `updateModelContext`,
    // `downloadFile` — fails here: a View feature-detects what it is told it can call.
    expect(host.sandbox.posted).toEqual([{
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: APP_PROTOCOL_VERSION,
        hostInfo: { name: expect.any(String), version: expect.any(String) },
        hostCapabilities: {
          openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, sandbox: {},
        },
        hostContext: {
          theme: "light",
          displayMode: "fullscreen",
          containerDimensions: { width: 1024, height: 768 },
        },
      },
    }]);
  });

  it("replays the call after initialized, never before, and only once", async () => {
    const host = runHost(page(), { dark: true });
    const initialized = { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} };

    host.from(host.sandbox, initialized);
    await settle();
    expect(host.sandbox.posted).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "SF" } },
      },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: RESULT },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark", displayMode: "fullscreen" },
      },
    ]);

    // `tool-input` is sent at most once, so a View that says `initialized` twice gets no second
    // copy.
    host.from(host.sandbox, initialized);
    await settle();
    expect(host.sandbox.posted).toHaveLength(3);
  });

  it("sends a tool-input and no result when the result was dropped", async () => {
    const host = runHost(page({ call: { toolName: "forecast", input: { city: "SF" } } }));
    host.from(host.sandbox, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await settle();

    // An empty `tool-result` would tell the app the call returned nothing, which is not what
    // happened.
    expect(host.sandbox.posted).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { city: "SF" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: expect.anything(),
      },
    ]);
    // The page itself is where the reason is told.
    expect(page({ call: { toolName: "forecast", input: {} } })).toContain("too large to keep");
    expect(page()).not.toContain("too large to keep");
  });

  it("proxies the three allowed methods to its own endpoint and relays the reply", async () => {
    const host = runHost(page());
    for (const method of ["tools/call", "resources/read", "ping"]) {
      host.from(host.sandbox, { jsonrpc: "2.0", id: method, method, params: {} });
    }
    await settle();

    expect(host.fetched).toEqual([`${PAGE_URL}/rpc`, `${PAGE_URL}/rpc`, `${PAGE_URL}/rpc`]);
    expect(host.sandbox.posted).toEqual([
      { jsonrpc: "2.0", id: "tools/call", result: { echo: "tools/call" } },
      { jsonrpc: "2.0", id: "resources/read", result: { echo: "resources/read" } },
      { jsonrpc: "2.0", id: "ping", result: { echo: "ping" } },
    ]);

    // Whatever query the visitor arrived with belongs to the page, not to the endpoint.
    const queried = runHost(page({}, `${PAGE_URL}?from=chat#app`));
    queried.from(queried.sandbox, { jsonrpc: "2.0", id: 1, method: "ping" });
    await settle();
    expect(queried.fetched).toEqual([`${PAGE_URL}/rpc`]);
  });

  it("surfaces a link that no longer answers as a JSON-RPC error", async () => {
    const host = runHost(page(), { reply: "<!DOCTYPE html><title>This app link no longer works" });
    host.from(host.sandbox, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "x" } });
    await settle();

    expect(host.sandbox.posted).toEqual([
      { jsonrpc: "2.0", id: 9, error: { code: -32603, message: expect.any(String) } },
    ]);
  });

  it("answers the display mode and teardown requests a View is entitled to make", async () => {
    const host = runHost(page());
    host.from(host.sandbox, {
      jsonrpc: "2.0", id: 1, method: "ui/request-display-mode", params: { mode: "pip" },
    });
    host.from(host.sandbox, { jsonrpc: "2.0", id: 2, method: "ui/resource-teardown", params: {} });
    await settle();

    // The one mode a sidecar window has, returned whether or not anything changed, and an
    // acknowledgement that closes nothing: the window is the user's.
    expect(host.sandbox.posted).toEqual([
      { jsonrpc: "2.0", id: 1, result: { mode: "fullscreen" } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });

  it("refuses every method a sidecar window cannot honour", async () => {
    const host = runHost(page());
    const refused = ["ui/message", "ui/update-model-context", "ui/download-file", "tools/list"];
    for (const method of refused) host.from(host.sandbox, { jsonrpc: "2.0", id: method, method });
    // A notification has no id, so an unknown one is dropped rather than answered.
    host.from(host.sandbox, { jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
    host.from(host.sandbox, { jsonrpc: "2.0", method: "notifications/progress" });
    await settle();

    expect(host.sandbox.posted).toEqual(refused.map(method => ({
      jsonrpc: "2.0", id: method, error: { code: -32601, message: expect.any(String) },
    })));
    expect(host.fetched).toEqual([]);
  });

  it("opens http and https links, and nothing else", async () => {
    const host = runHost(page());
    const asked = [
      ["https://example.test/docs", {}],
      ["javascript:alert(document.cookie)", { isError: true }],
      ["file:///etc/passwd", { isError: true }],
      ["data:text/html,<script>pwned()</script>", { isError: true }],
    ];
    for (const [url] of asked) {
      host.from(host.sandbox, { jsonrpc: "2.0", id: url, method: "ui/open-link", params: { url } });
    }
    await settle();

    expect(host.opened).toEqual([["https://example.test/docs", "_blank", "noopener,noreferrer"]]);
    expect(host.sandbox.posted).toEqual(
      asked.map(([url, result]) => ({ jsonrpc: "2.0", id: url, result })),
    );
    // Nothing to offer: the one link that was allowed opened, and a scheme this host refuses is not
    // shown to the user as if it were a link either.
    expect(host.offered).toEqual({ label: "", hidden: true });
  });

  it("reports a link the browser refused, and offers it to the user instead", async () => {
    const host = runHost(page(), { blocked: true });
    host.from(host.sandbox, {
      jsonrpc: "2.0", id: 3, method: "ui/open-link", params: { url: "https://example.test/docs" },
    });
    await settle();

    // Answered honestly, and the page hands the user the click the browser's blocker wanted: no
    // gesture survives postMessage, so a host that only calls `window.open` opens nothing.
    expect(host.sandbox.posted).toEqual([{ jsonrpc: "2.0", id: 3, result: { isError: true } }]);
    expect(host.offered).toEqual({
      label: "The app asked to open: ",
      hidden: false,
      link: {
        tag: "a",
        href: "https://example.test/docs",
        textContent: "https://example.test/docs",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });
  });

  it("offers a window of its own, which is the one thing a link cannot ask for", () => {
    const host = runHost(page());
    // The mark-up is the button, so the offer exists before the script runs, and looking it up is
    // what wiring it means.
    expect(host.requested).toContain("sidecar-open");

    host.sidecar.click();

    // This page with the marker, sized, and named from the link: `popup` is what asks the browser
    // for a window rather than a tab, and the name is the link's, so a second click brings that
    // window forward instead of opening another.
    expect(host.opened).toEqual([
      [`${PAGE_URL}?sidecar=1`, `gadgets-app-${"b".repeat(32)}`, "popup,width=900,height=700"],
    ]);
    expect(host.sidecar.note).toBe("Opened in its own window.");
    // The tab was the leftover, and the app is in that window now.
    expect(host.closed).toBe(true);
  });

  it("stops offering once it is the window it opened", () => {
    const host = runHost(page({}, `${PAGE_URL}?sidecar=1`));

    // Nothing to click, so nothing can open a second window: the offer is made from the marker's
    // absence and this load has it.
    expect(host.requested).not.toContain("sidecar-open");
    host.sidecar.click();

    expect(host.opened).toEqual([]);
    expect(host.closed).toBe(false);
  });

  it("says so when the browser blocks the window rather than dropping the click", () => {
    const host = runHost(page(), { blocked: true });
    host.sidecar.click();

    expect(host.sidecar.note).toMatch(/blocked/);
    // Nothing opened, so the app is still here and this page stays open.
    expect(host.closed).toBe(false);
  });

  it("sends the View's logs to the console and nowhere else", async () => {
    const host = runHost(page());
    host.from(host.sandbox, {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "warning", data: "read the docs" },
    });
    // The notification a View sends about itself, which this Host has nothing to resize for.
    host.from(host.sandbox, { jsonrpc: "2.0", method: "ui/notifications/size-changed" });
    await settle();

    expect(host.logs).toEqual([["[app]", "read the docs"]]);
    expect(host.sandbox.posted).toEqual([]);
  });
});

describe("the sandbox proxy", () => {
  const load = (proxy: Proxy, params: Record<string, unknown>): void => {
    proxy.from({}, { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params });
  };

  it("asks the Host for the app once it is ready", () => {
    expect(runProxy(page()).parent).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
    ]);
  });

  it("loads the app under the policy the Host sent, in the View's own document", () => {
    const proxy = runProxy(page());
    load(proxy, { html: "<!DOCTYPE html><p>hello</p>", csp: CSP, allow: "camera; microphone" });

    // The policy is in the View's document as the policy it was, quotes and all: that meta element
    // is how the View is confined to the domains the resource declared.
    expect(proxy.view.attributes.srcdoc).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(unescapeHtml(proxy.view.attributes.srcdoc)).toContain(CSP);
    expect(proxy.view.attributes.srcdoc).toContain("<!DOCTYPE html><p>hello</p>");
    // The permissions the resource declared travel to the frame that needs them.
    expect(proxy.view.attributes.allow).toBe("camera; microphone");
  });

  it("refuses to load an app the Host sent no policy for", () => {
    const proxy = runProxy(page());
    load(proxy, { html: "<!DOCTYPE html><script>pwned()</script>" });
    load(proxy, { html: "<!DOCTYPE html>", csp: "" });

    expect(proxy.view.attributes.srcdoc).toBeUndefined();
  });

  it("relays by source and never relays the sandbox channel", () => {
    const proxy = runProxy(page());
    const toView = { jsonrpc: "2.0", id: 1, result: { hello: "view" } };
    const fromView = { jsonrpc: "2.0", id: 1, method: "ping", params: {} };

    proxy.from({}, toView);
    expect(proxy.view.posted).toEqual([toView]);
    proxy.from(proxy.view.contentWindow, fromView);
    expect(proxy.parent).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
      fromView,
    ]);

    // The sandbox channel is between the Host and the proxy document: a View that speaks it is
    // answered by nobody, and the Host never hears of it — the Host's own load is not relayed back.
    proxy.from(proxy.view.contentWindow, {
      jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {},
    });
    load(proxy, { html: "<p>x</p>", csp: CSP });
    expect(proxy.parent).toHaveLength(2);
    expect(proxy.view.posted).toEqual([toView]);
  });
});
