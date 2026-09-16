import { describe, expect, it } from "vitest";
import { scanModule } from "../src/scan.ts";

describe("module scan", () => {
  it.each([
    ['import x from "./a";', "./a"],
    ['import type { T } from "./a";', "./a"],
    ['export * from "./a";', "./a"],
    ['export { x } from "./a";', "./a"],
    ['import x = require("./a");', "./a"],
    ['const m = import("./a");', "./a"],
    ["const m = import(`./a`);", "./a"],
    ['const m = require("./a");', "./a"],
    ['type T = import("./a").T;', "./a"],
    ['type T = typeof import("./a");', "./a"],
    ['const m = import("./a", { with: { type: "json" } });', "./a"],
    ['import /* initialize */ "./a";', "./a"],
    ["import //x\r\"./a\";", "./a"],
  ])("reads the specifier of %s", (source, specifier) => {
    expect(scanModule("client.ts", source)).toEqual({specifiers: [specifier]});
  });

  it.each([
    "const require = (x: string) => x;",
    "let require;",
    "function require(x: string) {}",
    "class require {}",
    "function f(require: string) {}",
    "const { require } = globalThis;",
    "const [require] = [];",
    'import require from "./a";',
    'import { r as require } from "./a";',
    'import * as require from "./a";',
    'import require = require("./a");',
    "try {} catch (require) {}",
  ])("sees the module bind require in %s", source => {
    expect(scanModule("client.ts", source).rebindsRequire).toBe(true);
  });

  it.each([
    "const { require: r } = globalThis;",
    "foo.require = 1;",
    "const o = { require: 1 };",
    "type T = { require: number };",
    'import { require as r } from "./a";',
    'require("./a");',
  ])("does not see a binding of require in %s", source => {
    expect(scanModule("client.ts", source).rebindsRequire).toBeUndefined();
  });

  it("decodes an escaped specifier", () => {
    expect(scanModule("client.ts", 'import x from "./\\u0061/b";').specifiers).toEqual(["./a/b"]);
  });

  it.each([
    ["import(p)", "import"],
    ["import(`./${x}`)", "import"],
    ['import("./a" + x)', "import"],
    ["require()", "require"],
    ["require(p)", "require"],
    ["(require)(p)", "require"],
    ["(require as any)(p)", "require"],
    ["require!(p)", "require"],
    ["(<any>require)(p)", "require"],
    ["(require satisfies any)(p)", "require"],
    ["((require))(p)", "require"],
    ["export const load = (name: string) => import //x\r(`../outside/${name}.js`);", "import"],
  ])("reports %s as a dynamic import of a computed path", (source, keyword) => {
    expect(scanModule("client.ts", source)).toEqual({specifiers: [], dynamic: keyword});
  });

  it.each([
    "foo.require(p);",
    "const u = import.meta.url;",
    "// import(x)",
    '/* require(p) */ const s = "import(x)";',
    "const t = `require(${p})`;",
    // Not a require call to esbuild either: it becomes the `__require` shim the output check catches.
    "(0, require)(p);",
  ])("does not read %s as an import", source => {
    expect(scanModule("client.ts", source)).toEqual({specifiers: []});
  });

  it("reads the JavaScript a shipped module is written in", () => {
    let source = 'import { a } from "./a.js";\nconst b = require("./b.cjs");\nconst c = require(p);';
    for (let path of ["server.js", "server.mjs", "server.cjs"]) {
      expect(scanModule(path, source)).toEqual({specifiers: ["./a.js", "./b.cjs"], dynamic: "require"});
    }
  });
});
