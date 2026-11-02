// Hosts a generated configurator frame as the Workshop does: a sandboxed `srcdoc` iframe in
// Chromium, driven over the real Cap'n Web session, with the gatekeeper capability faked so each
// test decides what every call answers and when. Needs the generated frames (`build:configurator`,
// which `test:run` runs first).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

/** A gatekeeper call the frame made, answered by the test or by a preset answer. */
export type Call = {
  method: string;
  args: unknown[];
  answered: boolean;
  resolve(value: unknown): void;
  reject(message: string): void;
};
export type Answer = (...args: unknown[]) => unknown;

/** What the frame has told the host so far. */
export type HostState = { ready: boolean | undefined; ensured: string[][] };

const FRAMES = {
  sharepoint: {
    pattern: "https://*.sharepoint.com/*",
    methods: ["getStatus", "loadItems", "resourceUrlFor", "locate"],
  },
  outlook: {
    pattern: "https://outlook.office.com/*",
    methods: ["getStatus", "openSharedMailbox", "listFolders", "searchPeople", "findConversations", "resourceUrlFor", "locate"],
  },
  calendar: {
    pattern: "https://outlook.office.com/calendar/*",
    methods: ["getStatus", "listCalendars", "openColleague", "resourceUrlFor", "locate"],
  },
} as const;

export type FrameName = keyof typeof FRAMES;

const frameHtml = (name: FrameName) => readFileSync(`${import.meta.dirname}/../src/generated/${name}-configurator-ui.txt`, "utf8");
// The browser build capnweb publishes for `import`, which has no imports of its own.
const capnwebSource = readFileSync(fileURLToPath(import.meta.resolve("capnweb")), "utf8");

/**
 * The Workshop's side, reduced to what the frame sees: `ResourceConfiguratorHost` and a gatekeeper
 * whose every method asks the test, through `gatekeeperCall`, what to answer.
 */
const hostPage = (methods: readonly string[]) => `<!DOCTYPE html><html><body>
<iframe id="frame" sandbox="allow-scripts" style="width:600px;height:80px;border:0"></iframe>
<button id="host-control">Add connection</button>
<script type="module">
import { RpcTarget, newMessagePortRpcSession } from "./capnweb.js";
const state = globalThis.state = { ready: undefined, ensured: [] };
class Gatekeeper extends RpcTarget {}
for (const method of ${JSON.stringify(methods)}) {
  Gatekeeper.prototype[method] = function (...args) { return globalThis.gatekeeperCall(method, args); };
}
class Host extends RpcTarget {
  get gatekeeper() { return new Gatekeeper(); }
  async getInitialResource() { return globalThis.initialResource; }
  async getAcceptedResourceUrlPatterns() { return [globalThis.pattern]; }
  resize(height) { document.getElementById("frame").style.height = height + "px"; }
  setSelectionReady(ready) { state.ready = ready; }
  forwardScroll() {}
  async ensureResources(patterns) { state.ensured.push(patterns); return true; }
}
window.addEventListener("message", event => {
  if (event.data?.type === "handshake") globalThis.frameStub = newMessagePortRpcSession(event.ports[0], new Host());
});
fetch("/frame.html").then(response => response.text()).then(html => {
  document.getElementById("frame").srcdoc = html;
});
</script>
</body></html>`;

/** What {@link hostPage} leaves on the host window for the test to read. */
type HostGlobals = { state: HostState; frameStub: { collectResourceUrl(): Promise<string> } };

export type Hosted = {
  page: Page;
  /** The configurator's frame. */
  frame(): Frame;
  calls: Call[];
  /** The calls of `method` still waiting for an answer. */
  waiting(method: string): Call[];
  /** Every call of `method`, answered or not. */
  callsOf(method: string): Call[];
  state(): Promise<HostState>;
  /** The frame's visible text, whitespace collapsed. */
  text(): Promise<string>;
  /** Asks the frame for its resource URL, as the Workshop's Add button does. */
  collect(): Promise<{ url: string } | { error: string }>;
  /** What the frame binds: the draft it hands the gatekeeper for the resource URL. */
  collected(): Promise<unknown>;
  /** Console errors and uncaught exceptions on the host page and in the frame. */
  consoleErrors: string[];
};

let browser: Browser | undefined;
const pages: Page[] = [];

/** Registers the suite's browser: launched once, and every frame's page closed after each test. */
export function useFrameHost(): void {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterEach(async () => {
    await Promise.all(pages.splice(0).map(page => page.close()));
  });
  afterAll(async () => {
    await browser?.close();
    browser = undefined;
  });
}

/**
 * Starts the frame. `answers` answer calls at once; any other call waits for the test to answer it
 * with `resolve` or `reject`.
 */
export async function startFrame(
  name: FrameName,
  { answers = {}, initialResource }: { answers?: Record<string, Answer>; initialResource?: string } = {},
): Promise<Hosted> {
  if (!browser) throw new Error("call useFrameHost() at the top of the suite");
  const { pattern, methods } = FRAMES[name];
  const page = await browser.newPage();
  pages.push(page);
  const consoleErrors: string[] = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => consoleErrors.push(error.message));

  const calls: Call[] = [];
  await page.exposeFunction("gatekeeperCall", (method: string, args: unknown[]) => new Promise((resolve, reject) => {
    const call: Call = {
      method, args, answered: false,
      resolve: value => { call.answered = true; resolve(value); },
      reject: message => { call.answered = true; reject(new Error(message)); },
    };
    calls.push(call);
    const handler = answers[method];
    if (handler === undefined) return;
    try {
      call.resolve(handler(...args));
    } catch (error) {
      call.reject((error as Error).message);
    }
  }));
  await page.addInitScript(({ pattern, initialResource }) => {
    Object.assign(globalThis, {
      pattern,
      initialResource: initialResource === undefined ? null : { resourceUrl: initialResource, resourceUrlPattern: pattern },
    });
  }, { pattern, initialResource });
  const html = frameHtml(name);
  await page.route("http://host.test/**", route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/frame.html") return route.fulfill({ body: html, contentType: "text/plain" });
    if (pathname === "/capnweb.js") return route.fulfill({ body: capnwebSource, contentType: "text/javascript" });
    return route.fulfill({ body: hostPage(methods), contentType: "text/html" });
  });
  await page.goto("http://host.test/");

  const frame = () => {
    const child = page.frames().find(candidate => candidate !== page.mainFrame());
    if (!child) throw new Error("The configurator frame is missing.");
    return child;
  };
  const callsOf = (method: string) => calls.filter(call => call.method === method);
  const hosted: Hosted = {
    page, frame, calls, callsOf, consoleErrors,
    waiting: method => callsOf(method).filter(call => !call.answered),
    state: () => page.evaluate(() => (globalThis as unknown as HostGlobals).state),
    text: async () => (await frame().locator("#root").innerText()).replace(/\s+/g, " ").trim(),
    collect: () => page.evaluate(async () => {
      try {
        return { url: String(await (globalThis as unknown as HostGlobals).frameStub.collectResourceUrl()) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }),
    async collected() {
      const before = callsOf("resourceUrlFor").length;
      // Its answer is whatever the test gives the call, and the page may close before it arrives.
      hosted.collect().catch(() => {});
      await vi.waitFor(() => {
        if (callsOf("resourceUrlFor").length === before) throw new Error("the frame has not asked for its resource URL");
      });
      return callsOf("resourceUrlFor").at(-1)!.args[0];
    },
  };
  // The frame is up once it has asked the gatekeeper anything.
  await vi.waitFor(() => {
    if (calls.length === 0) throw new Error("the frame has not started");
  }, { timeout: 10_000 });
  return hosted;
}
