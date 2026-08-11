// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composerDraftStorageKey,
  decorateComposerDraft,
  readComposerDraft,
  serializeComposerDraft,
  writeComposerDraft,
  type StoredComposerDraft,
} from "./composerDraft";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";

const draft: StoredComposerDraft = {
  version: 1,
  text: "Create a Document",
  formats: [{ position: 9, length: 8, noun: "Document", icon: "fileText" }],
};

const deployCommand: SlashCommandChoice = {
  selection: { gatekeeperId: 42, commandId: "deploy" },
  name: "deploy",
  description: "Deploy the current project",
  providerLabel: "GitHub",
  resourceLabel: "octo/repo",
};

describe("composer drafts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("isolates structured drafts by user and destination", () => {
    const home = composerDraftStorageKey("user-a", "home");
    const chat = composerDraftStorageKey("user-a", "workspace:one:chat:2");
    const otherUser = composerDraftStorageKey("user-b", "home");

    writeComposerDraft(home, draft);
    writeComposerDraft(chat, { version: 1, text: "chat draft", formats: [] });

    expect(readComposerDraft(home)).toEqual(draft);
    expect(readComposerDraft(chat)?.text).toBe("chat draft");
    expect(readComposerDraft(otherUser)).toBeUndefined();
  });

  it("downgrades capsules to URLs and records formats against normalized text", () => {
    const logoSlot = "\u2003\u2060\u00a0";
    const text = `Use Q3 Plan to create a ${logoSlot}Document`;
    const formatStart = text.indexOf(logoSlot);

    const stored = serializeComposerDraft(
      text,
      [{ start: 4, length: "Q3 Plan".length, url: "https://example.com/q3" }],
      [{
        start: formatStart,
        length: logoSlot.length + "Document".length,
        noun: "Document",
        icon: "fileText",
      }],
    );

    expect(stored.text).toBe("Use https://example.com/q3 to create a Document");
    expect(stored.formats).toEqual([{
      position: stored.text.indexOf("Document"),
      length: "Document".length,
      noun: "Document",
      icon: "fileText",
    }]);
  });

  it("decorates restored formats and adjusts later token positions", () => {
    const stored: StoredComposerDraft = {
      version: 1,
      text: "Create a Document and a Sheet",
      formats: [
        { position: 9, length: 8, noun: "Document", icon: "fileText" },
        { position: 24, length: 5, noun: "Sheet", icon: "table" },
      ],
    };
    const logoSlot = "\u2003\u2060\u00a0";

    const restored = decorateComposerDraft(stored, ["data:doc", "data:sheet"], logoSlot);

    expect(restored.text).toBe(`Create a ${logoSlot}Document and a ${logoSlot}Sheet`);
    expect(restored.formats).toEqual([
      {
        start: 9,
        length: logoSlot.length + 8,
        noun: "Document",
        icon: "fileText",
        logo: "data:doc",
      },
      {
        start: 24 + logoSlot.length,
        length: logoSlot.length + 5,
        noun: "Sheet",
        icon: "table",
        logo: "data:sheet",
      },
    ]);
  });

  it("preserves an inline slash command through token normalization and decoration", () => {
    const logoSlot = "\u2003\u2060\u00a0";
    const text = `Use Q3 Plan as a ${logoSlot}Document, then /deploy it`;
    const formatStart = text.indexOf(logoSlot);
    const commandStart = text.indexOf("/deploy");

    const stored = serializeComposerDraft(
      text,
      [{ start: 4, length: "Q3 Plan".length, url: "https://example.com/q3" }],
      [{
        start: formatStart,
        length: logoSlot.length + "Document".length,
        noun: "Document",
        icon: "fileText",
      }],
      { start: commandStart, length: "/deploy".length, choice: deployCommand },
    );

    expect(stored.text).toBe("Use https://example.com/q3 as a Document, then /deploy it");
    expect(stored.command).toEqual({
      position: stored.text.indexOf("/deploy"),
      length: "/deploy".length,
      choice: deployCommand,
    });

    const restored = decorateComposerDraft(stored, ["data:doc"], logoSlot);
    expect(restored.command).toEqual({
      start: restored.text.indexOf("/deploy"),
      length: "/deploy".length,
      choice: deployCommand,
    });
  });

  it("round-trips the exact slash command provider selection", () => {
    const key = composerDraftStorageKey("user-a", "workspace:one:chat:2");
    const stored = serializeComposerDraft(
      "Please /deploy this",
      [],
      [],
      { start: 7, length: 7, choice: deployCommand },
    );

    writeComposerDraft(key, stored);

    expect(readComposerDraft(key)?.command?.choice).toEqual(deployCommand);
  });

  it("leaves a restored format undecorated when its icon cannot be rendered", () => {
    const restored = decorateComposerDraft(draft, [undefined], "\u2003\u2060\u00a0");

    expect(restored).toEqual({
      text: draft.text,
      formats: [{ start: 9, length: 8, noun: "Document", icon: "fileText" }],
    });
  });

  it("rejects stored format ranges that do not match the text", () => {
    const key = composerDraftStorageKey("user-a", "home");
    sessionStorage.setItem(key, JSON.stringify({
      ...draft,
      formats: [{ position: 0, length: 8, noun: "Document", icon: "fileText" }],
    }));

    expect(readComposerDraft(key)).toBeUndefined();
  });

  it("rejects stored slash command metadata that does not match the text", () => {
    const key = composerDraftStorageKey("user-a", "home");
    sessionStorage.setItem(key, JSON.stringify({
      version: 1,
      text: "Please /deploy this",
      formats: [],
      command: { position: 0, length: 7, choice: deployCommand },
    }));

    expect(readComposerDraft(key)).toBeUndefined();
  });

  it("rejects a built-in command stored under a different name", () => {
    const key = composerDraftStorageKey("user-a", "home");
    sessionStorage.setItem(key, JSON.stringify({
      version: 1,
      text: "/delete this",
      formats: [],
      command: {
        position: 0,
        length: 7,
        choice: {
          selection: { builtin: true, commandId: "compact" },
          name: "delete",
          description: "Misleading command",
          providerLabel: "Workshop",
        },
      },
    }));

    expect(readComposerDraft(key)).toBeUndefined();
  });

  it("removes a draft when the composer is cleared", () => {
    const key = composerDraftStorageKey("user-a", "home");
    writeComposerDraft(key, draft);

    writeComposerDraft(key, undefined);

    expect(readComposerDraft(key)).toBeUndefined();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("tolerates unavailable browser storage", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });

    expect(readComposerDraft("key")).toBeUndefined();
    expect(() => writeComposerDraft("key", draft)).not.toThrow();
  });
});
