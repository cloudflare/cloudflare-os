import { describe, it, expect } from "vitest";
import type { UiBundle } from "@gadgets/workshop-shared/api";
import { buildUiBundle } from "../src/ui-bundle";

function bundle(files: Record<string, string>): UiBundle {
  return buildUiBundle(new Map(Object.entries(files)))!;
}

// Starts a client.js that calls main().
const MAIN = "\nexport default { main(gadget) {} };";

describe("buildUiBundle", () => {
  it("ships a legacy client.js as it is, and nothing without client.js", () => {
    expect(bundle({"client.js": "gadget.ready();", "server.js": "export class Gadget {}"}))
        .toEqual({jsCode: "gadget.ready();"});
    expect(buildUiBundle(new Map([["server.js", "export class Gadget {}"]]))).toBeNull();
  });

  it("keeps a client.js legacy when it imports only data: URLs and has no default export", () => {
    let code = `import { x } from "data:text/javascript,export let x = 1";\nexport let y = x;`;
    expect(bundle({"client.js": code})).toEqual({jsCode: code});
  });

  it("ships a client.js with a default export as modules, even alone", () => {
    expect(bundle({"client.js": MAIN})).toEqual({modules: [{path: "client.js", code: MAIN}]});
    let renamed = "let app = { main() {} };\nexport { app as default };";
    expect(bundle({"client.js": renamed}))
        .toEqual({modules: [{path: "client.js", code: renamed}]});
  });

  it("throws when client.js imports a module but has no default export, naming the import", () => {
    expect(() => bundle({"client.js": `gadget.ready();\nimport "./ui/list.js";`, "ui/list.js": ""}))
        .toThrow(/^client\.js:2: "\.\/ui\/list\.js" is imported, so client\.js must start the UI /);
    expect(() => bundle({"client.js": `import { RpcTarget } from "capnweb";`}))
        .toThrow(/^client\.js:1: "capnweb" is imported, so client\.js must start the UI /);
  });

  it("lets UI modules import capnweb as written, for the page's import map", () => {
    let client = `import { RpcTarget } from "capnweb";\nimport "./ui/list.js";${MAIN}`;
    let list = `import { RpcStub } from "capnweb";`;
    expect(bundle({"client.js": client, "ui/list.js": list})).toEqual({
      modules: [
        {path: "client.js",
          code: `import { RpcTarget } from "capnweb";\nimport "gadget:ui/list.js";${MAIN}`},
        {path: "ui/list.js", code: list},
      ],
    });
  });

  it("rewrites relative imports and ships only what client.js reaches", () => {
    expect(bundle({
      "client.js": `import { List } from "./ui/list.js";\nimport './pages/home.js';${MAIN}`,
      "ui/list.js": `import { fmt } from "../lib/fmt.js";\nexport * from "../client.js";`,
      "pages/home.js": "export let page = 1;",
      "lib/fmt.js": "export let fmt = String;",
      "server.js": `import { key } from "./lib/secret.js";`,
      "lib/secret.js": "export let key = 'SECRET';",
      "unused.js": "export let unused = 1;",
    })).toEqual({
      modules: [
        {path: "client.js",
          code: `import { List } from "gadget:ui/list.js";\nimport 'gadget:pages/home.js';${MAIN}`},
        {path: "ui/list.js",
          code: `import { fmt } from "gadget:lib/fmt.js";\nexport * from "gadget:client.js";`},
        {path: "pages/home.js", code: "export let page = 1;"},
        {path: "lib/fmt.js", code: "export let fmt = String;"},
      ],
    });
  });

  it("canonicalizes paths, so two spellings of one file are one module", () => {
    expect(bundle({
      "client.js": `import "./b.js";\nimport "./a/../b.js";${MAIN}`,
      "b.js": "export let state = {};",
    })).toEqual({
      modules: [
        {path: "client.js", code: `import "gadget:b.js";\nimport "gadget:b.js";${MAIN}`},
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

  it("throws on any import(), even of a file it could follow", () => {
    let files = {"pages/home.js": "export let page = 1;"};
    for (let call of [`import("./pages/home.js")`, "import(`./pages/${name}.js`)",
                      `import("data:text/javascript,")`]) {
      expect(() => bundle({...files, "client.js": `let x = 1;\nbutton.onclick = () => ${call};`}))
          .toThrow(/^client\.js:2: import\(\) isn't supported/);
    }
  });

  it("allows import.meta", () => {
    expect(bundle({"client.js": "console.log(import.meta.url);"}))
        .toEqual({jsCode: "console.log(import.meta.url);"});
  });

  it("refuses server.js and ships none of it", () => {
    let server = "export class Gadget { secret = 'SECRET'; }";
    expect(() => bundle({"client.js": `import { Gadget } from "./server.js";`, "server.js": server}))
        .toThrow(/^client\.js:1: .*server\.js/);
  });

  it("throws on a bare import other than capnweb", () => {
    expect(() => bundle({"client.js": `import { html } from "lit";${MAIN}`}))
        .toThrow(/^client\.js:1: "lit" can't be imported: .*"capnweb"/);
  });

  it("throws on an internal gadget: key", () => {
    expect(() => bundle({"client.js": `import "gadget:ui/list.js";`, "ui/list.js": ""}))
        .toThrow(/^client\.js:1: "gadget:ui\/list\.js"/);
  });

  it("throws on a path with a quote or a space", () => {
    let files = {"ui/it's.js": "", "ui/my list.js": ""};
    expect(() => bundle({...files, "client.js": `import "./ui/it's.js";`}))
        .toThrow(/^client\.js:1: .*quotes/);
    expect(() => bundle({...files, "client.js": `\nimport "./ui/my list.js";`}))
        .toThrow(/^client\.js:2: .*whitespace/);
  });

  it("ships a module it can't scan as written", () => {
    let view = `import "./other.js";\nlet v = <div>hi</div>;`;
    expect(bundle({
      "client.js": `import "./view.js";${MAIN}`,
      "view.js": view,
      "other.js": "",
    })).toEqual({
      modules: [
        {path: "client.js", code: `import "gadget:view.js";${MAIN}`},
        {path: "view.js", code: view},
      ],
    });
  });
});
