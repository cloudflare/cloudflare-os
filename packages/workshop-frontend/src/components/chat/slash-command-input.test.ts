import { describe, expect, it } from "vite-plus/test";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";
import {
  exactSlashCommandMatches, filterSlashCommandCatalog, parseSlashCommandInput,
  stripSlashCommandToken,
} from "./slash-command-input";

// Most cases put the caret inside the command token itself.
function parsed(input: string, cursorPosition = 1) {
  let result = parseSlashCommandInput(input, cursorPosition);
  expect(result).not.toBeNull();
  if (!result) throw new Error(`Expected slash command input: ${input}`);
  return result;
}

const choices: SlashCommandChoice[] = [{
  selection: {gatekeeperId: 1, commandId: "skill-deploy"},
  name: "deploy",
  description: "Use the deployment runbook.",
  providerLabel: "Context Library",
  resourceLabel: "Runbooks",
}, {
  selection: {gatekeeperId: 2, commandId: "workflow-deploy"},
  name: "deploy",
  description: "Run the deployment workflow.",
  providerLabel: "GitHub",
}];

describe("slash command composer input", () => {
  it("separates the command from its prompt tail", () => {
    expect(parsed("/deploy staging")).toMatchObject({
      query: "deploy",
      tail: "staging",
      tokenEnd: 7,
      tailStart: 8,
    });
    expect(parsed("/deploy")).toMatchObject({
      query: "deploy",
      tail: "",
    });
  });

  it("opens on a bare slash, wherever it is typed", () => {
    expect(parseSlashCommandInput("/", 1)).toMatchObject({query: "", tokenStart: 0, tokenEnd: 1});
    expect(parseSlashCommandInput("hello /", 7))
      .toMatchObject({query: "", tokenStart: 6, tokenEnd: 7});
  });

  it("finds a command at the cursor anywhere in the message", () => {
    const input = "Please use /deploy for staging";
    expect(parseSlashCommandInput(input, input.indexOf("deploy") + 3)).toMatchObject({
      query: "deploy",
      tokenStart: 11,
      tokenEnd: 18,
    });
  });

  it("leaves ordinary text and escaped slashes out of command parsing", () => {
    expect(parseSlashCommandInput("deploy staging", 1)).toBeNull();
    expect(parseSlashCommandInput("//deploy staging", 2)).toBeNull();
    expect(parseSlashCommandInput("try //deploy staging", 8)).toBeNull();
  });

  it("requires selection when command names are ambiguous", () => {
    expect(exactSlashCommandMatches(choices, parsed("/deploy staging"))).toEqual(choices);
    expect(exactSlashCommandMatches(choices, parsed("/dep staging"))).toEqual([]);
  });

  it("filters a loaded catalog locally", () => {
    expect(filterSlashCommandCatalog(choices, "runbook")).toEqual([choices[0]]);
    expect(filterSlashCommandCatalog(choices, "github")).toEqual([choices[1]]);
  });

  it("parses non-whitespace command tokens", () => {
    expect(parseSlashCommandInput("/skill:deploy", 1)).toMatchObject({query: "skill:deploy"});
    let weird: SlashCommandChoice = {
      ...choices[0],
      name: "skill:deploy",
      selection: {gatekeeperId: 1, commandId: "skill:deploy"},
    };
    expect(exactSlashCommandMatches([weird], parsed("/skill:deploy"))).toEqual([weird]);
  });

  it("strips a selected command token from the provider arguments", () => {
    expect(stripSlashCommandToken("Please use /deploy for staging", {start: 11, length: 7}).args)
      .toBe("Please use for staging");
    expect(stripSlashCommandToken("/deploy staging", {start: 0, length: 7}).args).toBe("staging");
    expect(stripSlashCommandToken("/deploy ", {start: 0, length: 7}).args).toBe("");
    expect(stripSlashCommandToken("ship it with /deploy", {start: 13, length: 7}).args)
      .toBe("ship it with");
  });

  // The transcript shows the command back where the user typed it, so the seam has to survive the
  // same whitespace collapsing and trimming that produced the arguments.
  it("reports where in the arguments the command was", () => {
    // Mid-sentence: the seam sits between the words the command was between.
    let mid = stripSlashCommandToken("Please use /deploy for staging", {start: 11, length: 7});
    expect(mid.args.slice(0, mid.commandPosition)).toBe("Please use ");
    expect(mid.commandPosition).toBe(11);

    // Leading: position 0, which is where a command with no recorded position renders anyway.
    expect(stripSlashCommandToken("/deploy staging", {start: 0, length: 7}).commandPosition).toBe(0);

    // Trailing: the trim removes the space the command left behind, so the seam has to be clamped
    // back onto the end of the string rather than pointing past it.
    let trailing = stripSlashCommandToken("ship it with /deploy", {start: 13, length: 7});
    expect(trailing.commandPosition).toBe(trailing.args.length);

    // Leading whitespace is trimmed away, so the seam moves left with the text.
    let padded = stripSlashCommandToken("   hi /deploy there", {start: 6, length: 7});
    expect(padded.args).toBe("hi there");
    expect(padded.args.slice(0, padded.commandPosition)).toBe("hi ");

    // Nothing but the command: no text to place it in.
    expect(stripSlashCommandToken("/deploy ", {start: 0, length: 7}))
      .toEqual({args: "", commandPosition: 0});
  });

  it("matches provider names without regard to case", () => {
    let mixedCase: SlashCommandChoice = {
      ...choices[0],
      name: "Deploy",
      selection: {gatekeeperId: 1, commandId: "mixed-case-deploy"},
    };
    expect(exactSlashCommandMatches([mixedCase], parsed("/deploy"))).toEqual([mixedCase]);
  });
});
