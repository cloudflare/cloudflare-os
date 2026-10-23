import { describe, expect, it } from "vitest";
import { buildConfiguratorRuntime } from "./runtime.ts";

describe("buildConfiguratorRuntime", () => {
  // Every frame embeds the runtime. If it carried one character beyond Latin-1, V8 would hold each
  // frame document at two bytes per character, doubling what the Workshop and the Worker keep.
  it("emits ASCII only", async () => {
    const { script, css } = await buildConfiguratorRuntime({ frontendReporting: false, sourceUrl: "app:///runtime.js" });
    expect(script).toMatch(/^\p{ASCII}*$/u);
    expect(css).toMatch(/^\p{ASCII}*$/u);
  }, 30_000);
});
