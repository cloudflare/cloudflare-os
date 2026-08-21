import { describe, expect, it } from "vitest";
import { findSandboxViolations } from "./source-checks.js";

function sources(files: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(files));
}

describe("findSandboxViolations", () => {
  it("finds an API that throws in the Gadget frame", () => {
    const found = findSandboxViolations(sources({
      "client.js": 'const seen = localStorage.getItem("people");',
    }));
    expect(found).toEqual([
      { file: "client.js", api: "localStorage", reason: "throws: the UI frame has an opaque origin" },
    ]);
  });

  it("reports the file each use came from", () => {
    const found = findSandboxViolations(sources({
      "client.js": "window.print();",
      "server.js": "export class Gadget {}",
    }));
    expect(found.map(v => `${v.file}:${v.api}`)).toEqual(["client.js:window.print("]);
  });

  it("finds an explicit global network call", () => {
    const found = findSandboxViolations(sources({
      "client.js": "window.fetch('/api');",
      "server.js": "this.fetch(request);",
    }));
    expect(found).toEqual([
      {
        file: "client.js",
        api: "window.fetch(",
        reason: "blocked: Gadget code has no outbound network",
      },
    ]);
  });

  it("ignores files that are not modules", () => {
    expect(findSandboxViolations(sources({ "README.md": "Uses localStorage for notes." })))
      .toEqual([]);
  });

  it("leaves an unqualified name alone, since a Gadget may define its own", () => {
    const found = findSandboxViolations(sources({
      "server.js": "async fetch(request) { return this.confirm(request); }",
    }));
    expect(found).toEqual([]);
  });

  it("finds nothing in source that stays inside the sandbox", () => {
    const found = findSandboxViolations(sources({
      "client.js": "document.body.append(el); gadget.subscribe(new Callback());",
    }));
    expect(found).toEqual([]);
  });
});
