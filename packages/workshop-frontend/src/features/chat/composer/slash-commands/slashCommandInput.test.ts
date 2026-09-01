import { describe, expect, it } from "vitest";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";
import {
  exactSlashCommandMatches, filterSlashCommandCatalog, parseSlashCommandInput,
  stripSlashCommandToken,
} from "./slashCommandInput";

function parsed(input: string, cursorPosition = 1) {
  const result = parseSlashCommandInput(input, cursorPosition);
  expect(result).not.toBeNull();
  if (!result) throw new Error(`Expected slash command input: ${input}`);
  return result;
}

const choices: SlashCommandChoice[] = [{
  selection: { gatekeeperId: 1, commandId: "skill-deploy" },
  name: "deploy",
  description: "Use the deployment runbook.",
  providerLabel: "Context Library",
  resourceLabel: "Runbooks",
}, {
  selection: { gatekeeperId: 2, commandId: "workflow-deploy" },
  name: "deploy",
  description: "Run the deployment workflow.",
  providerLabel: "GitHub",
}];

describe("slash command composer input", () => {
  it("separates the command from its prompt tail", () => {
    expect(parsed("/deploy staging")).toMatchObject({
      query: "deploy", tail: "staging", tokenEnd: 7, tailStart: 8,
    });
    expect(parsed("/deploy")).toMatchObject({ query: "deploy", tail: "" });
  });

  it("opens on a bare slash anywhere but treats double slash as text", () => {
    expect(parseSlashCommandInput("/", 1)).toMatchObject({ query: "", tokenStart: 0, tokenEnd: 1 });
    expect(parseSlashCommandInput("hello /", 7))
      .toMatchObject({ query: "", tokenStart: 6, tokenEnd: 7 });
    expect(parseSlashCommandInput("//deploy staging", 2)).toBeNull();
    expect(parseSlashCommandInput("try //deploy staging", 8)).toBeNull();
  });

  it("finds a command at the cursor anywhere in the message", () => {
    const input = "Please use /deploy for staging";
    expect(parseSlashCommandInput(input, input.indexOf("deploy") + 3)).toMatchObject({
      query: "deploy", tokenStart: 11, tokenEnd: 18,
    });
  });

  it("requires selection when command names are ambiguous", () => {
    expect(exactSlashCommandMatches(choices, parsed("/deploy staging"))).toEqual(choices);
    expect(exactSlashCommandMatches(choices, parsed("/dep staging"))).toEqual([]);
  });

  it("filters a loaded catalog with normalized whitespace", () => {
    expect(filterSlashCommandCatalog(choices, "runbook")).toEqual([choices[0]]);
    expect(filterSlashCommandCatalog(choices, "github")).toEqual([choices[1]]);
    expect(filterSlashCommandCatalog([
      { ...choices[0], description: "Review   a deployment runbook" },
    ], " review a ")).toHaveLength(1);
  });

  it("strips a selected command and reports its argument position", () => {
    expect(stripSlashCommandToken("Please use /deploy for staging", { start: 11, length: 7 }))
      .toEqual({ args: "Please use for staging", commandPosition: 11 });
    expect(stripSlashCommandToken("/deploy staging", { start: 0, length: 7 }))
      .toEqual({ args: "staging", commandPosition: 0 });
    expect(stripSlashCommandToken("ship it with /deploy", { start: 13, length: 7 }))
      .toEqual({ args: "ship it with", commandPosition: "ship it with".length });
  });
});
