import { describe, expect, it } from "vitest";
import type { ComposerDocument } from "./composerDocument";
import {
  applyComposerTextEdit,
  insertComposerCapsule,
  insertComposerFormat,
  refineComposerResourceUrl,
  removeComposerDocumentToken,
  replaceComposerUrlWithCapsule,
  resolveComposerSlashCommand,
} from "./composerDocument";

const description = {
  url: "https://example.com/plan",
  title: "Plan",
  snippet: "Project plan",
  suggestedBindingName: "plan",
  tsType: "Plan",
};

const commandChoice = {
  selection: { gatekeeperId: 42, commandId: "review" },
  name: "review",
  description: "Review the project",
  providerLabel: "Projects",
};

const emptyDocument = (text: string): ComposerDocument => ({
  text,
  capsules: [],
  formats: [],
  command: null,
});

const capsule = { gatekeeperId: 7, description };

describe("composer document transitions", () => {
  it("shifts every later token for a text edit", () => {
    const document: ComposerDocument = {
      text: "Ask Plan for Document /review",
      capsules: [{ start: 4, length: 4, gatekeeperId: 1, description }],
      formats: [{ start: 13, length: 8, noun: "Document", icon: "fileText" }],
      command: { start: 22, length: 7, choice: commandChoice },
    };

    expect(applyComposerTextEdit(document, `Please ${document.text}`, 7).document).toEqual({
      text: "Please Ask Plan for Document /review",
      capsules: [{ start: 11, length: 4, gatekeeperId: 1, description }],
      formats: [{ start: 20, length: 8, noun: "Document", icon: "fileText" }],
      command: { start: 29, length: 7, choice: commandChoice },
    });
  });

  it("rejects insertion inside an atomic capsule", () => {
    const document: ComposerDocument = {
      ...emptyDocument("Ask Plan today"),
      capsules: [{ start: 4, length: 4, gatekeeperId: 1, description }],
    };

    expect(applyComposerTextEdit(document, "Ask PlXan today", 7)).toEqual({
      document,
      caret: 6,
      rejected: true,
    });
  });

  it("removes a touched capsule as one atomic region", () => {
    const document: ComposerDocument = {
      ...emptyDocument("Ask Plan then continue"),
      capsules: [{ start: 4, length: 4, gatekeeperId: 1, description }],
      formats: [{ start: 14, length: 8, noun: "continue", icon: "fileText" }],
    };

    expect(applyComposerTextEdit(document, "Ask Xlan then continue", 5)).toEqual({
      document: {
        text: "Ask  then continue",
        capsules: [],
        formats: [{ start: 10, length: 8, noun: "continue", icon: "fileText" }],
        command: null,
      },
      caret: 4,
    });
  });

  it("removes an atomic token and shifts later ranges", () => {
    const document: ComposerDocument = {
      ...emptyDocument("Plan Document"),
      capsules: [{ start: 0, length: 4, gatekeeperId: 1, description }],
      formats: [{ start: 5, length: 8, noun: "Document", icon: "fileText" }],
    };

    expect(removeComposerDocumentToken(document, { start: 0, length: 4 })).toEqual({
      document: {
        text: "Document",
        capsules: [],
        formats: [{ start: 0, length: 8, noun: "Document", icon: "fileText" }],
        command: null,
      },
      caret: 0,
    });
  });

  it("resolves a slash command and shifts later tokens", () => {
    const document: ComposerDocument = {
      ...emptyDocument("try /rev with Plan"),
      capsules: [{ start: 14, length: 4, gatekeeperId: 1, description }],
    };
    const commandText = "/review";

    expect(resolveComposerSlashCommand(document, commandChoice, 4, 8, commandText)).toEqual({
      document: {
        text: "try /review with Plan",
        capsules: [{ start: 17, length: 4, gatekeeperId: 1, description }],
        formats: [],
        command: { start: 4, length: 7, choice: commandChoice },
      },
      caret: 12,
    });
  });

  it("inserts a format and shifts every later token", () => {
    const document: ComposerDocument = {
      ...emptyDocument("Use Plan /review"),
      capsules: [{ start: 4, length: 4, gatekeeperId: 1, description }],
      command: { start: 9, length: 7, choice: commandChoice },
    };
    const format = { noun: "Document", icon: "fileText" as const };

    expect(insertComposerFormat(document, 0, format, "Document")).toEqual({
      document: {
        text: "Document Use Plan /review",
        capsules: [{ start: 13, length: 4, gatekeeperId: 1, description }],
        formats: [{ ...format, start: 0, length: 8 }],
        command: { start: 18, length: 7, choice: commandChoice },
      },
      caret: 9,
    });
  });

  it("inserts a resource capsule and shifts tokens at the insertion point", () => {
    const document: ComposerDocument = {
      ...emptyDocument("Use Document"),
      formats: [{ start: 4, length: 8, noun: "Document", icon: "fileText" }],
    };

    expect(insertComposerCapsule(document, 4, capsule, "Plan")).toEqual({
      document: {
        text: "Use Plan Document",
        capsules: [{ ...capsule, start: 4, length: 4 }],
        formats: [{ start: 9, length: 8, noun: "Document", icon: "fileText" }],
        command: null,
      },
      caret: 9,
    });
  });

  it("replaces the expected URL with a capsule and shifts later tokens", () => {
    const url = "https://example.com/plan";
    const document: ComposerDocument = {
      ...emptyDocument(`${url} Document`),
      formats: [{ start: url.length + 1, length: 8, noun: "Document", icon: "fileText" }],
    };

    expect(replaceComposerUrlWithCapsule(
      document,
      { text: url, start: 0, end: url.length },
      capsule,
      "Plan",
    )).toEqual({
      document: {
        text: "Plan Document",
        capsules: [{ ...capsule, start: 0, length: 4 }],
        formats: [{ start: 5, length: 8, noun: "Document", icon: "fileText" }],
        command: null,
      },
      caret: 5,
    });
  });

  it("rejects URL replacement when the captured text is stale", () => {
    expect(replaceComposerUrlWithCapsule(
      emptyDocument("https://example.com/other"),
      { text: "https://example.com/plan", start: 0, end: 24 },
      capsule,
      "Plan ",
    )).toBeNull();
  });

  it("refines a URL, shifts ranges, and returns its placeholder selection", () => {
    const url = "https://example.com/projects";
    const newUrl = "https://example.com/projects/PROJECT_ID";
    const document: ComposerDocument = {
      ...emptyDocument(`${url} Document`),
      formats: [{ start: url.length + 1, length: 8, noun: "Document", icon: "fileText" }],
    };

    expect(refineComposerResourceUrl(
      document,
      { text: url, start: 0, end: url.length },
      newUrl,
      { start: newUrl.indexOf("PROJECT_ID"), end: newUrl.length },
    )).toEqual({
      document: {
        text: `${newUrl} Document`,
        capsules: [],
        formats: [{ start: newUrl.length + 1, length: 8, noun: "Document", icon: "fileText" }],
        command: null,
      },
      activeUrl: { text: newUrl, start: 0, end: newUrl.length },
      selection: { start: newUrl.indexOf("PROJECT_ID"), end: newUrl.length },
    });
  });
});
