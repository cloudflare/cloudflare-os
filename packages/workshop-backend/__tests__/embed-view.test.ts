import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { embeddedViewHtml } from "@gadgets/workshop-shared/embedded-views";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// embedView in executeCode (see plans/live-views.md): what a run hands back, what the harness
// refuses in the agent's code, what the kernel refuses of what the harness returns, and the HTML
// a view's frame runs.

const ALICE: AiChatAuthorInfo = { type: "user", id: "alice@example.com", name: "Alice" };
type Impl = OverseerDurableObject["impl"];

let doCounter = 0;
async function withImpl(fn: (impl: Impl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`embed-view-${++doCounter}`);
  await runInDurableObject(stub, ({ impl }) => fn(impl));
}

// `viewsLeft: null` runs the code as a chat no person reads does, with no embedView.
const run = (impl: Impl, body: string, viewsLeft: number | null = 4) =>
  impl.executeCodeMode(1, `export default async function() {\n${body}\n}`, ALICE, "some-model", {},
      undefined, undefined, viewsLeft ?? undefined);

describe("embedView", () => {
  it("hands back each view the code showed, with a script that runs on its data elsewhere",
      () => withImpl(async impl => {
    let { log, views, failed } = await run(impl, `
      const outside = 1;
      const data = { food: 420, at: new Date(0) };
      embedView({ title: "Arrow", html: "<p>x</p>", script: data => \`$\${data.food} at \${data.at}\`, data });
      embedView({ title: "Async arrow", html: "<p>x</p>", script: async (data) => data.food + 1, data });
      embedView({ title: "Function", html: "<p>x</p>", script: function (data) { return data.food + 2; }, data });
      embedView({ title: "Method", html: "", async script(data) { return data.food + 3; }, data });
      console.log("done");`);
    expect(failed).toBe(false);
    expect(log.split("\n")[0]).toBe("done");
    let more = await run(impl, `
      embedView({ title: "Named async", html: "", script: ({ async(data) { return data.food + 4; } }).async,
                  data: { food: 420 } });
      embedView({ title: "Plain", html: "<p>hi</p>" });`);
    expect(more.failed).toBe(false);
    views = [...views, ...more.views];
    expect(views.map(view => view.title))
        .toEqual(["Arrow", "Async arrow", "Function", "Method", "Named async", "Plain"]);
    expect(views[5]).toEqual({ title: "Plain", html: "<p>hi</p>" });
    // Each script is an expression that runs apart from the code that wrote it, as in a view.
    let ran = await run(impl, views.slice(0, 5).map(view =>
      `console.log(await (${view.script})(JSON.parse(${JSON.stringify(view.data)})));`).join("\n"));
    expect(ran.log).toBe("$420 at 1970-01-01T00:00:00.000Z\n421\n422\n423\n424");
  }));

  it("throws in the agent's code for a view it refuses, so the model reads why", () => withImpl(async impl => {
    let untitled = await run(impl, `embedView({ html: "<p>hi</p>" });`);
    expect(untitled.log).toContain("TypeError");
    expect(untitled).toMatchObject({ views: [], failed: true });

    let source = await run(impl, `embedView({ title: "T", html: "", script: "document.body.append('x')" });`);
    expect(source).toMatchObject({ views: [], failed: true });

    for (let script of ["Math.max", "function* (data) { yield data; }", 'class { }', '{ "script"(data) {} }.script']) {
      let refused = await run(impl, `embedView({ title: "T", html: "", script: ${script} });`);
      expect(refused, script).toMatchObject({ views: [], failed: true });
    }

    let quotedNative = await run(impl,
      `embedView({ title: "T", html: "", script: data => { document.title = "function x() { [native code] }"; } });`);
    expect(quotedNative.views).toHaveLength(1);
  }));

  it("fails the call, showing nothing, past the views the step has left", () => withImpl(async impl => {
    let fifth = await run(impl, `for (let i = 0; i < 5; i++) embedView({ title: "View " + i, html: "<p>x</p>" });`);
    expect(fifth).toMatchObject({ views: [], failed: true });

    let third = await run(impl, `for (let i = 0; i < 3; i++) embedView({ title: "View " + i, html: "<p>x</p>" });`, 2);
    expect(third).toMatchObject({ views: [], failed: true });

    let two = await run(impl, `for (let i = 0; i < 2; i++) embedView({ title: "View " + i, html: "<p>x</p>" });`, 2);
    expect(two.views).toHaveLength(2);
  }));

  it("fails the call for a view with no content, a long title or over 256 KiB, showing nothing",
      () => withImpl(async impl => {
    for (let body of [
      `embedView({ title: "Empty", html: "  " });`,
      `embedView({ title: "Just a title", html: "<title>T</title>" });`,
      `embedView({ title: "x".repeat(1024 * 1024), html: "<p>x</p>" });`,
      `embedView({ title: "Fine", html: "<p>x</p>" }); embedView({ title: "Big", html: "x".repeat(300 * 1024) });`,
    ]) {
      let result = await run(impl, body);
      expect(result, body).toMatchObject({ views: [], failed: true });
      expect(result.log, body).not.toBe("(function succeeded with no output)");
      expect(result.log.length, body).toBeLessThan(1024);
    }
    let drawn = await run(impl, `embedView({ title: "Drawn", html: "", script: () => {} });`);
    expect(drawn).toMatchObject({ views: [{ title: "Drawn" }], failed: false });
  }));

  it("refuses a view the code slipped past embedView's checks", () => withImpl(async impl => {
    // The harness runs in the agent's realm, so the code can change what embedView hands back: here
    // it pushes its own view in place of the one embedView checked.
    for (let forgedView of [
      `{ title: 7, html: ["<p>x</p>"] }`,
      `{ title: "T", html: "<p>x</p>", script: String.fromCharCode(0xD800) }`,
      // Under 256 KiB as UTF-8 JSON, but stored at 2 bytes per code unit.
      `{ title: "T", html: "é" + "x".repeat(200 * 1024) }`,
    ]) {
      let forged = await run(impl, `
        const push = Array.prototype.push;
        Array.prototype.push = function () { return push.call(this, ${forgedView}); };
        embedView({ title: "T", html: "<p>x</p>" });
        Array.prototype.push = push;`);
      expect(forged, forgedView).toMatchObject({ views: [], failed: true });
    }
  }));

  it("refuses a huge views array without walking it", () => withImpl(async impl => {
    let started = Date.now();
    let forged = await run(impl, `
      const push = Array.prototype.push;
      Array.prototype.push = function (view) { push.call(this, view); this.length = 50_000_000; };
      embedView({ title: "T", html: "<p>x</p>" });
      Array.prototype.push = push;`);
    expect(forged).toMatchObject({ views: [], failed: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  }));

  it("is not there when no person reads the chat", () => withImpl(async impl => {
    const body = `embedView({ title: "T", html: "<p>hi</p>" });`;
    expect((await run(impl, body)).views).toHaveLength(1);
    let result = await run(impl, body, null);
    expect(result).toMatchObject({ views: [], failed: true });
    expect(result.log).toContain("ReferenceError");
  }));

  it("drops the views of code that threw after showing them", () => withImpl(async impl => {
    let result = await run(impl, `embedView({ title: "T", html: "<p>hi</p>" }); throw new Error("x");`);
    expect(result).toMatchObject({ views: [], failed: true });
  }));
});

describe("embeddedViewHtml", () => {
  it("adds no markup from its script or data", () => {
    const html = embeddedViewHtml({
      title: "T", html: "<p></p>", script: '(data => { document.title = "</script>"; })',
      data: JSON.stringify({ note: "</script><img src=x onerror=alert(1)><!--" }),
    });
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<!--");
  });
});
