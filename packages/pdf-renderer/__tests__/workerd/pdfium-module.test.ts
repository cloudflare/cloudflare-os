import { describe, expect, it } from "vitest";
import { pdfiumModules } from "../../src/pdfium-module";

// The pool has module rules of its own (`modulesRules` in the vitest config), so a pool that
// cannot import the build as the Worker does fails here, where the reason is plain, before it
// fails wherever a PDF is rendered.
describe("the PDFium modules in the pool", () => {
  it("are imported as compiled modules: the build with its work counter, and the thunks", async () => {
    let { pdfium, thunks } = await pdfiumModules();
    expect(pdfium).toBeInstanceOf(WebAssembly.Module);
    expect(thunks).toBeInstanceOf(WebAssembly.Module);
    expect(WebAssembly.Module.exports(pdfium)).toContainEqual({ name: "work", kind: "global" });
    let imports = WebAssembly.Module.imports(pdfium);
    expect(imports).toHaveLength(34);
    expect(imports.every(entry => entry.kind === "function")).toBe(true);
    expect(WebAssembly.Module.exports(thunks).map(entry => entry.name)).toEqual(["r", "p"]);
  });
});
