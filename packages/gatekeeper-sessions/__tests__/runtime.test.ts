import { describe, expect, it } from "vitest";
import {
  assertRuntimeEnabled,
  codingSessionRuntime,
  openCodeCommand,
  piCommand,
  piEnvironment,
  piExtensionSource,
  primeAgentCommand,
  primeAgentEnvironment,
  primeAgentExtensionSource,
  primeAgentSettings,
} from "../src/runtime.js";

describe("coding session runtimes", () => {
  it("defaults legacy sessions to OpenCode and validates explicit runtimes", () => {
    expect(codingSessionRuntime(undefined)).toBe("opencode");
    expect(codingSessionRuntime("opencode")).toBe("opencode");
    expect(codingSessionRuntime("pi")).toBe("pi");
    expect(codingSessionRuntime("prime-agent")).toBe("prime-agent");
    expect(() => codingSessionRuntime("other")).toThrow("Invalid coding session runtime");
  });

  it("fails closed unless Pi is explicitly enabled", () => {
    expect(() => assertRuntimeEnabled("pi", undefined)).toThrow("not enabled");
    expect(() => assertRuntimeEnabled("pi", "false")).toThrow("not enabled");
    expect(() => assertRuntimeEnabled("pi", "true")).not.toThrow();
    expect(() => assertRuntimeEnabled("prime-agent", undefined)).toThrow("Prime Agent");
    expect(() => assertRuntimeEnabled("prime-agent", "true")).not.toThrow();
    expect(() => assertRuntimeEnabled("opencode", undefined)).not.toThrow();
  });

  it("starts Pi with only reviewed explicit resources", () => {
    const command = piCommand();
    expect(command.slice(0, 15)).toEqual([
      "/usr/local/bin/pi",
      "--provider", "odie-team-pi",
      "--model", "gpt-6-astra",
      "--models", "odie-team-pi/gpt-6-astra,odie-team-pi/gpt-5.6-sol",
      "--tui-mode", "fullscreen",
      "--no-extensions",
      "--extension", "/workspace/.odie-pi/odie-runtime.ts",
      "--no-skills",
      "--skill", "/opt/odie-pi/node_modules/@howlerops/valhalla/pi/skills/vegvisir/SKILL.md",
    ]);
    expect(command).toContain("--no-prompt-templates");
    for (const name of ["hugin", "tyr", "munin", "eitri", "vidar", "skuld", "polaris"]) {
      expect(command).toContain(`/opt/odie-pi/node_modules/@howlerops/valhalla/pi/prompts/${name}.md`);
    }
    expect(command.slice(-3)).toEqual([
      "--no-themes",
      "--no-context-files",
      "--no-approve",
    ]);
    expect(piEnvironment()).toEqual({
      PI_CODING_AGENT_DIR: "/workspace/.odie-pi",
      PI_OFFLINE: "1",
    });
  });

  it("starts Prime Agent with the managed Codex provider and isolated config", () => {
    expect(primeAgentCommand()).toEqual([
      "/usr/local/bin/prime-agent",
      "--offline",
      "--provider", "odie-team-pi",
      "--model", "gpt-6-astra",
      "--models", "odie-team-pi/gpt-6-astra,odie-team-pi/gpt-5.6-sol",
      "--no-extensions",
      "--extension", "/workspace/.odie-prime-agent/odie-runtime.ts",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ]);
    expect(primeAgentEnvironment()).toEqual({
      PRIME_AGENT_CODING_AGENT_DIR: "/workspace/.odie-prime-agent",
      PRIME_AGENT_KERNEL_PYTHON: "/opt/odie-prime-agent/kernel-venv/bin/python",
      PRIME_AGENT_TELEMETRY: "0",
      PI_OFFLINE: "1",
    });
  });

  it("starts OpenCode with a minimal repository-scoped command", () => {
    expect(openCodeCommand("odie-os")).toEqual([
      "/bin/bash",
      "-lc",
      "cd /workspace/odie-os && exec opencode",
    ]);
  });

  it("provides only Team PI and the isolated Workshop MCP server", () => {
    const source = piExtensionSource("https://team-pi-proxy.example.com/api/odie");

    expect(source).toContain('baseUrl: "https://team-pi-proxy.example.com/api/odie/codex"');
    expect(source).toContain('url: "https://workshop-mcp.internal/mcp"');
    expect(source).toContain('"id":"gpt-6-astra"');
    expect(source).toContain('"id":"gpt-5.6-sol"');
    expect(source).toContain('"inputTokensAbove":272000');
    expect(source).toContain('"input":20,"output":75,"cacheRead":2,"cacheWrite":25');
    expect(source).toContain('hostConfigDiscovery: "off"');
    expect(source).toContain("scriptMode: false");
    expect(source).not.toContain("TEAM_PI_CODEX_HMAC_SECRET");
  });

  it("routes Prime Agent through shared Codex without exposing relay credentials", () => {
    const source = primeAgentExtensionSource("https://team-pi-proxy.example.com/api/odie");

    expect(source).toContain('baseUrl: "https://team-pi-proxy.example.com/api/odie/codex"');
    expect(source).toContain('apiKey: "synthetic"');
    expect(source).toContain('"name":"GPT-6 Astra"');
    expect(source).toContain('"name":"GPT 5.6 Sol"');
    expect(source).toContain('"contextWindow":1050000,"maxTokens":128000');
    expect(source).not.toContain("TEAM_PI_CODEX_HMAC_SECRET");
    expect(primeAgentSettings()).toEqual({
      telemetry: { enabled: false },
      mcpServers: {
        workshop: { type: "http", url: "https://workshop-mcp.internal/mcp" },
      },
    });
  });
});
