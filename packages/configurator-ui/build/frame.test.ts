// The generated frame as the Workshop hosts it: built by `build/`, loaded into a sandboxed `srcdoc`
// iframe in Chromium, and driven over the real Cap'n Web session. What the component suites cannot
// see: that the bundle runs on preact/compat at all, that its content security policy admits exactly
// the scripts the build wrote, and that the host protocol (handshake, readiness, sizing, collection,
// error reports) still holds.
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configuratorHtml } from "./html.ts";
import { transpileConfiguratorModule } from "./module.ts";
import { buildConfiguratorRuntime } from "./runtime.ts";

const sourceBase = "app:///gatekeeper/test/configurator";
const LONG_FOLDER = "Foo Bar Baz Qux - The Very Long Quux Corge Grault Garply Waldo Fred Plugh Xyzzy Thud, " +
  "Wibble Wobble Wubble Flob";

const FOLDER_PICKER = `
import { Autocomplete, Field, Section, h } from "@gadgets/configurator-ui";
export default {
  initial: { folderId: null },
  isReady: ({ values }) => Boolean(values.folderId),
  resourceUrl: ({ values }) => "https://files.example.com/folders/" + values.folderId,
  render: ({ values, setValues, ui }) => (
    <Section title="Folder">
      <Field label="Folder">
        <Autocomplete name="folderId" value={values.folderId} placeholder="Search folders..."
          loadOptions={query => ui.searchFolders(query)} onChange={folderId => setValues({ folderId })} />
      </Field>
    </Section>
  ),
};
`;

const FAILING_RENDER = `
import { h } from "@gadgets/configurator-ui";
export default { initial: {}, resourceUrl: () => "", render() { throw new Error("render failure"); } };
`;

const frameHtml = async (source: string, frontendReporting: boolean) => {
  const runtime = await buildConfiguratorRuntime({ frontendReporting, sourceUrl: `${sourceBase}/runtime.js` });
  const module = transpileConfiguratorModule(source, { fileName: "test-ui.tsx", sourceBase, frontendReporting });
  return configuratorHtml(runtime, module);
};

/** What {@link HOST_SCRIPT} leaves on the host page's global object for the test to read. */
type HostGlobals = {
  events: unknown[][];
  frameStub: { collectResourceUrl(): Promise<string> };
};

/** The Workshop's side, reduced to what the frame sees: `ResourceConfiguratorHost` and a gatekeeper. */
const HOST_SCRIPT = `
import { RpcTarget, newMessagePortRpcSession } from "capnweb";
const folders = ["Projects", "Proposals", "Personal", ${JSON.stringify(LONG_FOLDER)}];
const events = globalThis.events = [];
class Gatekeeper extends RpcTarget {
  async searchFolders(query) {
    events.push(["search", query]);
    return folders.filter(title => title.toLowerCase().includes(query.toLowerCase()))
      .map(title => ({ value: title.toLowerCase(), title }));
  }
}
class Host extends RpcTarget {
  get gatekeeper() { return new Gatekeeper(); }
  async getInitialResource() { return null; }
  resize(height, layoutHeight) {
    events.push(["resize", height, layoutHeight]);
    document.getElementById("frame").style.height = height + "px";
  }
  setSelectionReady(ready) { events.push(["ready", ready]); }
  forwardScroll() {}
}
window.addEventListener("message", event => {
  if (event.data?.type === "handshake") globalThis.frameStub = newMessagePortRpcSession(event.ports[0], new Host());
  else events.push(["message", event.data]);
});
fetch("/frame.html").then(response => response.text()).then(html => {
  document.getElementById("frame").srcdoc = html;
});
`;

let browser: Browser;
let hostPage: string;

beforeAll(async () => {
  browser = await chromium.launch();
  const bundled = await build({
    stdin: { contents: HOST_SCRIPT, resolveDir: join(import.meta.dirname, "..") },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  hostPage = `<!DOCTYPE html><html><body>
<iframe id="frame" sandbox="allow-scripts" style="width:600px;height:80px;border:0"></iframe>
<button id="host-control">Add connection</button>
<script type="module">${bundled.outputFiles[0]!.text}</script>
</body></html>`;
});

afterAll(async () => {
  await browser?.close();
});

type Hosted = { page: Page; frame: () => Frame; events(): Promise<unknown[][]>; consoleErrors: string[] };

const host = async (html: string): Promise<Hosted> => {
  const page = await browser.newPage();
  const consoleErrors: string[] = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", error => consoleErrors.push(error.message));
  await page.route("http://host.test/**", route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/frame.html") return route.fulfill({ body: html, contentType: "text/plain" });
    return route.fulfill({ body: hostPage, contentType: "text/html" });
  });
  await page.goto("http://host.test/");
  const frame = () => {
    const child = page.frames().find(candidate => candidate !== page.mainFrame());
    if (!child) throw new Error("The configurator frame is missing.");
    return child;
  };
  return {
    page,
    frame,
    events: () => page.evaluate(() => {
      // Set by HOST_SCRIPT before the frame loads.
      const hostGlobals = globalThis as unknown as HostGlobals;
      return hostGlobals.events;
    }),
    consoleErrors,
  };
};

const collect = (page: Page) => page.evaluate(async () => {
  // Set by HOST_SCRIPT once the frame's handshake arrives.
  const hostGlobals = globalThis as unknown as HostGlobals;
  try {
    return { url: String(await hostGlobals.frameStub.collectResourceUrl()) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

describe("generated configurator frame", () => {
  it("runs under its own policy and completes the host protocol", async () => {
    const { page, frame, events, consoleErrors } = await host(await frameHtml(FOLDER_PICKER, false));
    try {
      const input = frame().getByRole("combobox", { name: "Folder" });
      await input.click();
      await input.pressSequentially("pro");
      await frame().getByRole("option", { name: "Proposals" }).waitFor();
      await expect.poll(async () => (await events()).filter(([kind]) => kind === "search").at(-1))
        .toEqual(["search", "pro"]);
      await input.press("ArrowDown");
      await input.press("ArrowDown");
      await input.press("Enter");

      await expect.poll(async () => (await events()).filter(([kind]) => kind === "ready").map(([, ready]) => ready))
        .toEqual([false, true]);
      expect(await collect(page)).toEqual({ url: "https://files.example.com/folders/proposals" });
      // The frame grew to fit the open popup and reserved only the form's own height for it.
      const sizes = (await events()).filter(([kind]) => kind === "resize") as [string, number, number][];
      expect(sizes.some(([, height, layoutHeight]) => height > layoutHeight + 40)).toBe(true);
      // A script the policy refused, or a missing global, would show here.
      expect(consoleErrors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

  // Only the generated frame has the runtime's styles, so only here can a row overflow the popup.
  it("cuts a long option short to the popup's width, and offers it whole on hover", async () => {
    const { page, frame } = await host(await frameHtml(FOLDER_PICKER, false));
    try {
      await frame().getByRole("combobox", { name: "Folder" }).click();
      const long = frame().getByRole("option", { name: LONG_FOLDER });
      await long.waitFor();
      expect(await frame().getByRole("listbox").evaluate(list => list.scrollWidth - list.clientWidth)).toBe(0);

      const tooltip = (option: typeof long) =>
        option.evaluate(node => node.querySelector("[title]")?.getAttribute("title") ?? "");
      await long.hover();
      expect(await tooltip(long)).toBe(LONG_FOLDER);
      const short = frame().getByRole("option", { name: "Projects" });
      await short.hover();
      expect(await tooltip(short)).toBe("");
    } finally {
      await page.close();
    }
  }, 30_000);

  // Base UI sees focus move only within the frame's document, which leaving for the host is not.
  it("closes its popup when focus leaves the frame for the host", async () => {
    const { page, frame } = await host(await frameHtml(FOLDER_PICKER, false));
    try {
      const option = frame().getByRole("option", { name: "Projects" });
      for (const leave of [() => page.keyboard.press("Tab"), () => page.click("#host-control")]) {
        await frame().getByRole("combobox", { name: "Folder" }).click();
        await option.waitFor();
        await leave();
        expect(await page.locator("#host-control").evaluate(node => node.matches(":focus"))).toBe(true);
        await option.waitFor({ state: "hidden" });
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  it("reports a failed render to the host when reporting is built in, and never becomes ready", async () => {
    const { page, events } = await host(await frameHtml(FAILING_RENDER, true));
    try {
      await expect.poll(async () => (await events()).filter(([kind]) => kind === "message").length)
        .toBeGreaterThan(0);
      const [[, message]] = (await events()).filter(([kind]) => kind === "message");
      expect(message).toMatchObject({
        type: "gadgets.frontend-error.v1",
        report: { failureSite: "configurator.render", handled: false, exception: { message: "render failure" } },
      });
      expect((await events()).filter(([kind]) => kind === "ready")).toEqual([["ready", false]]);
      expect(await collect(page)).toEqual({ error: expect.stringMatching(/failed to render/i) });
    } finally {
      await page.close();
    }
  }, 30_000);
});
