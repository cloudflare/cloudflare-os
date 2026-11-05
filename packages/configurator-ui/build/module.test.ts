import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { transpileConfiguratorModule } from "./module.ts";

const options = { fileName: "test-ui.tsx", sourceBase: "app:///gatekeeper/test/configurator", frontendReporting: false };

describe("transpileConfiguratorModule", () => {
  it("defines the module's default export, with JSX through the runtime's globals", () => {
    const { script, sourceMap } = transpileConfiguratorModule(
      'import { Field, h, type ConfiguratorUISpec } from "@gadgets/configurator-ui";\n' +
      'import type { Rpc } from "./test-types";\n' +
      'const label = "Folder";\n' +
      "export default { initial: {}, resourceUrl: () => \"\", render: () => <Field label={label} /> };\n",
      options);
    const frameGlobal: Record<string, unknown> = {
      h: (type: unknown, props: unknown) => ({ type, props }),
      Field: "Field",
    };
    runInNewContext(script, frameGlobal);
    const spec = (frameGlobal.__gadgetsConfiguratorModule as () => { render(): unknown })();
    expect(spec.render()).toEqual({ type: "Field", props: { label: "Folder" } });
    expect(sourceMap).toBeNull();
  });

  // V8 stores a string with one character beyond Latin-1 at two bytes per character, frame and all.
  it("writes non-ASCII text as ASCII escapes that mean the same", () => {
    const { script } = transpileConfiguratorModule(
      '// Pick a folder — or none\nexport default { placeholder: "Search…", icon: "📁" };\n', options);
    expect(script).not.toMatch(/[\u0080-\uffff]/);
    const frameGlobal: Record<string, unknown> = {};
    runInNewContext(script, frameGlobal);
    expect((frameGlobal.__gadgetsConfiguratorModule as () => unknown)())
      .toEqual({ placeholder: "Search…", icon: "📁" });
  });

  // The module runs alone in the frame: anything it imports besides the runtime would not resolve.
  it("refuses a module that imports code of its own", () => {
    expect(() => transpileConfiguratorModule(
      'import { parse } from "./urls";\nexport default { render: () => parse() };\n', options))
      .toThrow(/must be self-contained/);
  });
});
