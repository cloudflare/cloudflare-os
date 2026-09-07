import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { AgenticCommandsPlugin } from "@howlerops/valhalla";

const packageRoot = process.env.VALHALLA_PACKAGE_ROOT ??
  "/opt/odie-pi/node_modules/@howlerops/valhalla";
const root = process.env.VALHALLA_OUTPUT_ROOT ?? "/opt/odie-valhalla/opencode";
const commandDir = `${root}/command`;
const skillDir = `${root}/skills/vegvisir`;

// Baro and AutoAgent run externally: they cannot implicitly inherit the current
// OpenCode session's model. These options set embedded delegation defaults only;
// explicit user selections take precedence, and saved settings are not rewritten.
const hooks = await AgenticCommandsPlugin({}, {
  tyr: { baroModel: "openai/gpt-6-astra" },
  eitri: { completionModel: "openai/gpt-6-astra" },
});
const config = { command: {} };
await hooks.config(config);
const expectedCommands = ["eitri", "hugin", "munin", "polaris", "skuld", "tyr", "vegvisir", "vidar"];
const commandNames = Object.keys(config.command).toSorted();
if (JSON.stringify(commandNames) !== JSON.stringify(expectedCommands)) {
  throw new Error(`Unexpected Valhalla OpenCode commands: ${commandNames.join(", ")}.`);
}

await mkdir(commandDir, { recursive: true });
for (const [name, command] of Object.entries(config.command)) {
  const frontmatter = [
    "---",
    `description: ${JSON.stringify(command.description || "Agentic command")}`,
    command.agent ? `agent: ${command.agent}` : "",
    command.model ? `model: ${command.model}` : "",
    "---",
  ].filter(Boolean).join("\n");
  await writeFile(`${commandDir}/${name}.md`, `${frontmatter}\n\n${command.template}\n`);
}

await mkdir(skillDir, { recursive: true });
await copyFile(
  `${packageRoot}/pi/skills/vegvisir/SKILL.md`,
  `${skillDir}/SKILL.md`,
);
