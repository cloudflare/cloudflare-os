import { describe, it, expect } from "vitest";
import type { UiBundle } from "@gadgets/workshop-shared/api";
import { buildUiBundle } from "../src/ui-bundle";

function bundle(files: Record<string, string>): UiBundle {
  return buildUiBundle(new Map(Object.entries(files)))!;
}

// The message a rewritten `import()` of a bad path rejects with, read back out of its `data:` URL.
function dynamicImportMessage(code: string): string {
  let url = JSON.parse(code.match(/import\(("data:[^"]*")\)/)![1]!) as string;
  let thrower = decodeURIComponent(url.slice("data:text/javascript,".length));
  return JSON.parse(thrower.match(/^throw new Error\((.*)\);$/)![1]!) as string;
}

describe("buildUiBundle", () => {
  it("ships a single-file UI as it is, and nothing without client.js", () => {
    expect(bundle({"client.js": "gadget.ready();", "server.js": "export class Gadget {}"}))
        .toEqual({jsCode: "gadget.ready();"});
    expect(buildUiBundle(new Map([["server.js", "export class Gadget {}"]]))).toBeNull();
  });

  it("rewrites relative imports and ships only what client.js reaches", () => {
    expect(bundle({
      "client.js": `import { List } from "./ui/list.js";\nlet home = () => import('./pages/home.js');`,
      "ui/list.js": `import { fmt } from "../lib/fmt.js";\nexport * from "../client.js";`,
      "pages/home.js": "export let page = 1;",
      "lib/fmt.js": "export let fmt = String;",
      "server.js": `import { key } from "./lib/secret.js";`,
      "lib/secret.js": "export let key = 'SECRET';",
      "unused.js": "export let unused = 1;",
    })).toEqual({
      modules: [
        {path: "client.js", code: `import { List } from "gadget:ui/list.js";\n` +
            `let home = () => import("gadget:pages/home.js");`},
        {path: "ui/list.js",
          code: `import { fmt } from "gadget:lib/fmt.js";\nexport * from "gadget:client.js";`},
        {path: "pages/home.js", code: "export let page = 1;"},
        {path: "lib/fmt.js", code: "export let fmt = String;"},
      ],
    });
  });

  it("canonicalizes paths, so two spellings of one file are one module", () => {
    expect(bundle({
      "client.js": `import "./b.js";\nimport "./a/../b.js";`,
      "b.js": "export let state = {};",
    })).toEqual({
      modules: [
        {path: "client.js", code: `import "gadget:b.js";\nimport "gadget:b.js";`},
        {path: "b.js", code: "export let state = {};"},
      ],
    });
  });

  it("throws on a static import of a missing file, naming importer, line, specifier and path", () => {
    expect(() => bundle({
      "client.js": `import "./ui/list.js";`,
      "ui/list.js": `export let a = 1;\n\nimport { b } from "./parts/../missing.js";`,
    })).toThrow(/^ui\/list\.js:3: "\.\/parts\/\.\.\/missing\.js" .*ui\/missing\.js/);
  });

  it("makes a string-literal import() of a missing file reject with the same message", () => {
    let {jsCode} = bundle({"client.js": `button.onclick = () => import("./pages/../gone.js");`}) as
        {jsCode: string};
    expect(dynamicImportMessage(jsCode))
        .toMatch(/^client\.js:1: "\.\/pages\/\.\.\/gone\.js" .*gone\.js/);
  });

  it("refuses server.js and ships none of it", () => {
    let server = "export class Gadget { secret = 'SECRET'; }";
    expect(() => bundle({"client.js": `import { Gadget } from "./server.js";`, "server.js": server}))
        .toThrow(/^client\.js:1: .*server\.js/);
    expect(JSON.stringify(bundle({"client.js": `import("./server.js");`, "server.js": server})))
        .not.toContain("SECRET");
  });

  it("throws on a bare import, telling the agent the RPC names are globals", () => {
    expect(() => bundle({"client.js": `import { RpcTarget } from "capnweb";`}))
        .toThrow(/^client\.js:1: "capnweb" .*globals/);
  });

  it("throws on an internal gadget: key, even in a dynamic import", () => {
    expect(() => bundle({"client.js": `import("gadget:ui/list.js");`, "ui/list.js": ""}))
        .toThrow(/^client\.js:1: "gadget:ui\/list\.js"/);
  });

  it("throws on a path with a quote or a space, static or dynamic", () => {
    let files = {"ui/it's.js": "", "ui/my list.js": ""};
    expect(() => bundle({...files, "client.js": `import "./ui/it's.js";`}))
        .toThrow(/^client\.js:1: .*quotes/);
    expect(() => bundle({...files, "client.js": `\nimport("./ui/my list.js");`}))
        .toThrow(/^client\.js:2: .*whitespace/);
  });

  it("ships a computed import() and a module it can't scan as written", () => {
    let view = `import "./other.js";\nlet v = <div>hi</div>;`;
    expect(bundle({
      "client.js": "import \"./view.js\";\nimport(`./pages/${name}.js`);",
      "view.js": view,
      "other.js": "",
      "pages/home.js": "",
    })).toEqual({
      modules: [
        {path: "client.js", code: "import \"gadget:view.js\";\nimport(`./pages/${name}.js`);"},
        {path: "view.js", code: view},
      ],
    });
  });
});
