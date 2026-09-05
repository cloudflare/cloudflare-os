import { SUGGESTED_MODELS, type CodingSessionRuntime } from "@gadgets/workshop-shared/api";
import { WORKSHOP_MCP_HOST } from "./mcp-policy.js";

export const PI_CONFIG_DIR = "/workspace/.odie-pi";
export const PI_EXTENSION_PATH = `${PI_CONFIG_DIR}/odie-runtime.ts`;
export const PRIME_AGENT_CONFIG_DIR = "/workspace/.odie-prime-agent";
export const PRIME_AGENT_EXTENSION_PATH = `${PRIME_AGENT_CONFIG_DIR}/odie-runtime.ts`;
export const VALHALLA_ROOT = "/opt/odie-pi/node_modules/@howlerops/valhalla";

const VALHALLA_PROMPTS = ["hugin", "tyr", "munin", "eitri", "vidar", "skuld", "polaris"];
const TEAM_PI_MODEL_ID = "gpt-6-astra";
const TEAM_PI_MODEL_IDS = [TEAM_PI_MODEL_ID, "gpt-5.6-sol"] as const;

export function codingSessionRuntime(runtime: unknown): CodingSessionRuntime {
  if (runtime === undefined || runtime === "opencode") return "opencode";
  if (runtime === "pi" || runtime === "prime-agent") return runtime;
  throw new Error("Invalid coding session runtime.");
}

export function assertRuntimeEnabled(runtime: CodingSessionRuntime, enabled: string | undefined): void {
  if (runtime !== "opencode" && enabled !== "true") {
    const label = runtime === "pi" ? "Pi" : "Prime Agent";
    throw new Error(`${label} coding sessions are not enabled for this deployment.`);
  }
}

export function piCommand(): [string, ...string[]] {
  return [
    "/usr/local/bin/pi",
    "--provider", "odie-team-pi",
    "--model", TEAM_PI_MODEL_ID,
    "--models", TEAM_PI_MODEL_IDS.map(id => `odie-team-pi/${id}`).join(","),
    "--tui-mode", "fullscreen",
    "--no-extensions",
    "--extension", PI_EXTENSION_PATH,
    "--no-skills",
    "--skill", `${VALHALLA_ROOT}/pi/skills/vegvisir/SKILL.md`,
    "--no-prompt-templates",
    ...VALHALLA_PROMPTS.flatMap(name => [
      "--prompt-template", `${VALHALLA_ROOT}/pi/prompts/${name}.md`,
    ]),
    "--no-themes",
    "--no-context-files",
    "--no-approve",
  ];
}

export function primeAgentCommand(): [string, ...string[]] {
  return [
    "/usr/local/bin/prime-agent",
    "--offline",
    "--provider", "odie-team-pi",
    "--model", TEAM_PI_MODEL_ID,
    "--models", TEAM_PI_MODEL_IDS.map(id => `odie-team-pi/${id}`).join(","),
    "--no-extensions",
    "--extension", PRIME_AGENT_EXTENSION_PATH,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
  ];
}

export function primeAgentEnvironment(): Record<string, string> {
  return {
    PRIME_AGENT_CODING_AGENT_DIR: PRIME_AGENT_CONFIG_DIR,
    PRIME_AGENT_KERNEL_PYTHON: "/opt/odie-prime-agent/kernel-venv/bin/python",
    PRIME_AGENT_TELEMETRY: "0",
    PI_OFFLINE: "1",
  };
}

export function primeAgentExtensionSource(teamPiBaseUrl: string): string {
  const providerBaseUrl = new URL("codex", ensureTrailingSlash(teamPiBaseUrl)).toString();
  return `export default function odieRuntime(pi) {
  pi.registerProvider("odie-team-pi", {
    name: "Team PI Codex",
    baseUrl: ${JSON.stringify(providerBaseUrl)},
    apiKey: "synthetic",
    api: "openai-responses",
    models: ${JSON.stringify(teamPiRuntimeModels())},
  });
}
`;
}

export function primeAgentSettings(): Record<string, unknown> {
  return {
    telemetry: { enabled: false },
    mcpServers: {
      workshop: {
        type: "http",
        url: `https://${WORKSHOP_MCP_HOST}/mcp`,
      },
    },
  };
}

export function openCodeCommand(repository: string): [string, ...string[]] {
  return [
    "/bin/bash",
    "-lc",
    `cd /workspace/${repository} && exec opencode`,
  ];
}

export function piEnvironment(): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: PI_CONFIG_DIR,
    PI_OFFLINE: "1",
  };
}

export function piExtensionSource(teamPiBaseUrl: string): string {
  const providerBaseUrl = new URL("codex", ensureTrailingSlash(teamPiBaseUrl)).toString();
  const workshopMcpUrl = `https://${WORKSHOP_MCP_HOST}/mcp`;
  return `import { createMcpAdapter } from "/opt/odie-pi/node_modules/pi-mcp-adapter/index.ts";

export default function odieRuntime(pi) {
  pi.registerProvider("odie-team-pi", {
    name: "Team PI Codex",
    baseUrl: ${JSON.stringify(providerBaseUrl)},
    apiKey: "synthetic",
    api: "openai-responses",
    models: ${JSON.stringify(teamPiRuntimeModels())},
  });
  createMcpAdapter({
    config: {
      mcpServers: {
        workshop: {
          url: ${JSON.stringify(workshopMcpUrl)},
          auth: false,
          oauth: false,
          lifecycle: "eager",
          requestTimeoutMs: 30000,
        },
      },
      settings: {
        hostConfigDiscovery: "off",
        scriptMode: false,
      },
    },
  })(pi);
}
`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function teamPiRuntimeModels(): Array<Record<string, unknown>> {
  return TEAM_PI_MODEL_IDS.map(id => {
    const model = SUGGESTED_MODELS.openai[id]!;
    return {
      id,
      name: model.name,
      reasoning: true,
      input: ["text", "image"],
      cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.outputLimit,
    };
  });
}
