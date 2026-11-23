import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configuratorHtml } from "./html.ts";
import type { ConfiguratorRuntime } from "./runtime.ts";

const runtime: ConfiguratorRuntime = { script: "start();\r\n", sourceMap: null, css: "body{margin:0}" };
const module = { script: "globalThis.m = function () {\nreturn {};\n};", sourceMap: null };

const scriptSources = (html: string): string[] => {
  const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
  return policy.split("; ").find(directive => directive.startsWith("script-src "))?.split(" ").slice(1) ?? [];
};
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("configuratorHtml", () => {
  // Hashes alone: anything the build did not write -- an inline handler, a `javascript:` URL, an
  // injected script, `eval` -- is refused.
  it("lets exactly the scripts it inlines run, as the browser will read them", () => {
    const html = configuratorHtml(runtime, module);
    const inlined = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    expect(inlined).toEqual([module.script, "start();\n"]);
    expect(scriptSources(html).toSorted()).toEqual(inlined.map(hash).toSorted());
  });

  it("refuses text that would close its element or hide the rest of it in a comment", () => {
    expect(() => configuratorHtml(runtime, { ...module, script: 'x = "</SCRIPT>";' })).toThrow(/<\/SCRIPT/);
    expect(() => configuratorHtml(runtime, { ...module, script: 'x = "<!--";' })).toThrow(/<!--/);
    expect(() => configuratorHtml({ ...runtime, css: "a{content:'</style>'}" }, module)).toThrow(/<\/style/);
  });
});
