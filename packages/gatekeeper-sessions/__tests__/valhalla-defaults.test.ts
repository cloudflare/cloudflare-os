import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const source = await readFile(new URL("../pi-image/build-valhalla-opencode.mjs", import.meta.url), "utf8");
const commandNames = ["eitri", "hugin", "munin", "polaris", "skuld", "tyr", "vegvisir", "vidar"];

interface Command {
  description: string;
  agent: string;
  template: string;
  model?: string;
}

async function generate(explicitModel?: string, names = commandNames) {
  const files = new Map<string, string>();
  const mkdir = vi.fn();
  const copyFile = vi.fn();
  // Minimal fixture derived from howlerops/valhalla at
  // 835b6b7958865c4a79d11d951efecbd2d6264c24: src/index.mjs forwards these
  // options; src/tyr.mjs and src/eitri.mjs interpolate them into templates,
  // not command.model. The other command bodies are irrelevant to this test.
  const plugin = vi.fn(async (_input: unknown, options: {
    tyr: { baroModel: string };
    eitri: { completionModel: string };
  }) => ({
    config(config: { command: Record<string, Command> }) {
      for (const name of names) {
        config.command[name] = {
          description: `${name} description`,
          agent: "build",
          template: name === "tyr"
            ? `baro --llm opencode -m ${options.tyr.baroModel} "$ARGUMENTS"`
            : name === "eitri"
              ? `COMPLETION_MODEL=${options.eitri.completionModel}`
              : `${name} $ARGUMENTS`,
          ...(explicitModel ? { model: explicitModel } : {}),
        };
      }
    },
  }));

  // Execute the real generator with injected imports and environment. No
  // Valhalla install, filesystem writes, or production settings are needed.
  const body = source.replace(/^import .*;\r?\n/gm, "");
  const run = new Function("copyFile", "mkdir", "writeFile", "AgenticCommandsPlugin", "process",
    `return (async () => {\n${body}\n})();`);
  await run(copyFile, mkdir, async (path: string, content: string) => {
    files.set(path, content);
  }, plugin, { env: { VALHALLA_PACKAGE_ROOT: "/fixture", VALHALLA_OUTPUT_ROOT: "/output" } });
  return { files, plugin, mkdir, copyFile };
}

describe("Valhalla generated delegation defaults", () => {
  it("sets external process defaults without pinning commands or writing saved settings", async () => {
    const { files, plugin, mkdir, copyFile } = await generate();
    expect(plugin).toHaveBeenCalledWith({}, {
      tyr: { baroModel: "openai/gpt-6-astra" },
      eitri: { completionModel: "openai/gpt-6-astra" },
    });
    expect([...files.keys()]).toEqual(commandNames.map((name) => `/output/command/${name}.md`));
    expect(files.get("/output/command/tyr.md")).toContain('baro --llm opencode -m openai/gpt-6-astra "$ARGUMENTS"');
    expect(files.get("/output/command/eitri.md")).toContain("COMPLETION_MODEL=openai/gpt-6-astra");
    for (const [path, content] of files) {
      expect(content).toContain('description: "');
      expect(content).toContain("agent: build");
      expect(content).not.toMatch(/^model:/m);
      expect(content).not.toContain("gpt-5.3-codex-spark");
      if (!path.endsWith("/tyr.md") && !path.endsWith("/eitri.md")) {
        expect(content).not.toContain("gpt-6-astra");
      }
    }
    expect(mkdir.mock.calls).toEqual([
      ["/output/command", { recursive: true }],
      ["/output/skills/vegvisir", { recursive: true }],
    ]);
    expect(copyFile).toHaveBeenCalledExactlyOnceWith(
      "/fixture/pi/skills/vegvisir/SKILL.md", "/output/skills/vegvisir/SKILL.md",
    );
  });

  it("preserves an explicit upstream command model rather than replacing it", async () => {
    const { files } = await generate("provider/explicit-model");
    for (const content of files.values()) {
      expect(content).toMatch(/^model: provider\/explicit-model$/m);
      expect(content).not.toMatch(/^model: openai\/gpt-6-astra$/m);
    }
  });

  it("still rejects unexpected upstream commands", async () => {
    await expect(generate(undefined, [...commandNames, "unexpected"]))
      .rejects.toThrow("Unexpected Valhalla OpenCode commands:");
  });
});
