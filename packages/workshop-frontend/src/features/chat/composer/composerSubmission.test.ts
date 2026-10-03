import { describe, expect, it } from "vitest";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { buildComposerSubmission } from "./composerSubmission";

const description: ResourceDescription = {
  url: "https://example.com/q3",
  title: "Q3 Plan",
  snippet: "Planning document",
  suggestedBindingName: "plan",
  tsType: "Plan",
};

const deployCommand = {
  selection: { gatekeeperId: 42, commandId: "deploy" },
  name: "deploy",
  description: "Deploy the current project",
  providerLabel: "GitHub",
};

describe("composer submission", () => {
  it("resolves editor tokens against the trimmed message", () => {
    const logoSlot = "\u2003\u2060\u00a0";
    const text = `  Ask ${logoSlot}Document about Q3 Plan  `;

    const result = buildComposerSubmission({
      document: {
        text,
        capsules: [{
          start: text.indexOf("Q3 Plan"),
          length: "Q3 Plan".length,
          gatekeeperId: 7,
          description,
          vendorId: "docs",
        }],
        formats: [{
          start: text.indexOf(logoSlot),
          length: logoSlot.length + "Document".length,
          noun: "Document",
          icon: "fileText",
        }],
        command: null,
      },
      hasAttachments: false,
    });

    expect(result).toEqual({
      ok: true,
      submission: {
        message: "Ask Document about [0]",
        capsules: [{
          position: "Ask Document about ".length,
          length: 3,
          gatekeeperId: 7,
          description,
          vendorId: "docs",
        }],
        formats: [{
          position: "Ask ".length,
          length: "Document".length,
          noun: "Document",
          icon: "fileText",
        }],
      },
    });
  });

  it("removes an inline slash command after reducing earlier format tokens", () => {
    const logoSlot = "\u2003\u2060\u00a0";
    const commandToken = "/deploy";
    const text = `make ${logoSlot}Document using ${commandToken} today`;

    const result = buildComposerSubmission({
      document: {
        text,
        capsules: [],
        formats: [{
          start: text.indexOf(logoSlot),
          length: logoSlot.length + "Document".length,
          noun: "Document",
          icon: "fileText",
        }],
        command: {
          start: text.indexOf(commandToken),
          length: commandToken.length,
          choice: deployCommand,
        },
      },
      hasAttachments: false,
    });

    expect(result).toEqual({
      ok: true,
      submission: {
        message: {
          id: deployCommand.selection,
          args: "make Document using today",
          commandPosition: "make Document using ".length,
        },
        formats: [{
          position: "make ".length,
          length: "Document".length,
          noun: "Document",
          icon: "fileText",
        }],
      },
    });
  });

  it.each([
    { capsules: [{ start: 0, length: 4, gatekeeperId: 7, description }], hasAttachments: false },
    { capsules: [], hasAttachments: true },
  ])("rejects slash commands with resources or attachments", ({ capsules, hasAttachments }) => {
    expect(buildComposerSubmission({
      document: {
        text: "test",
        capsules,
        formats: [],
        command: { start: 0, length: 4, choice: deployCommand },
      },
      hasAttachments,
    })).toEqual({ ok: false, error: "slash-command-with-extras" });
  });
});
