import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES, AGENT_CATALOG_MAX_ID_LENGTH,
  AGENT_CATALOG_MAX_TITLE_LENGTH, boundAgentCatalog,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  completeAgentCatalogSnapshot, formatAgentCatalogPrompt,
  formatAlwaysAvailableResourcesPrompt, normalizeAgentCatalog,
} from "../src/agent-catalog";

describe("normalizeAgentCatalog", () => {
  it("sorts entries, strips control characters, and truncates long fields to the max bounds", () => {
    let catalog = normalizeAgentCatalog({
      entries: [
        { id: "2".repeat(AGENT_CATALOG_MAX_ID_LENGTH + 10), title: "  Zebra\u0000  ",
          description: "D".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH + 100) },
        { id: "1", title: "T".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH + 50), description: " First collection " },
      ],
    });

    expect(catalog).toEqual({
      entries: [
        { id: "1", title: "T".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH), description: "First collection" },
        { id: "2".repeat(AGENT_CATALOG_MAX_ID_LENGTH), title: "Zebra",
          description: "D".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH) },
      ],
    });
  });

  it("truncates to the maximum entry count", () => {
    let entries = Array.from({ length: AGENT_CATALOG_MAX_ENTRIES + 5 }, (_, i) => ({
      id: `${i}`, title: `Collection ${String(i).padStart(2, "0")}`, description: "x",
    }));

    let catalog = normalizeAgentCatalog({ entries });

    expect(catalog.entries.length).toBe(AGENT_CATALOG_MAX_ENTRIES);
    expect(catalog.truncated).toBe(true);
  });

  it("drops from the tail in provider order, then sorts the survivors", () => {
    // The gatekeeper puts what must survive first (the Context Library leads with its collections),
    // so a title that sorts last must still be kept when the cap clamps the list.
    let entries = [
      {id: "keep", title: "Zulu collection", description: "survives despite sorting last"},
      ...Array.from({length: AGENT_CATALOG_MAX_ENTRIES}, (_, i) => ({
        id: `skill${i}`, title: `aa-skill-${String(i).padStart(4, "0")}`, description: "x",
      })),
    ];

    let catalog = normalizeAgentCatalog({entries});

    expect(catalog.entries).toHaveLength(AGENT_CATALOG_MAX_ENTRIES);
    expect(catalog.entries.at(-1)).toEqual(entries[0]);
    expect(catalog.truncated).toBe(true);
  });

  it("normalizes control characters without emitting false truncation", () => {
    expect(normalizeAgentCatalog({
      entries: [{id: "id", title: "Title\u009f", description: "Description"}],
    })).toEqual({
      entries: [{id: "id", title: "Title", description: "Description"}],
    });
  });

  it("preserves provider truncation and removes unusable entries", () => {
    let catalog = normalizeAgentCatalog({
      entries: [
        { id: "", title: "Missing ID", description: "Ignored" },
        { id: "valid", title: "", description: "Ignored" },
        { id: "valid", title: "Useful", description: "Catalog entry" },
      ],
      truncated: true,
    });

    expect(catalog).toEqual({
      entries: [{ id: "valid", title: "Useful", description: "Catalog entry" }],
      truncated: true,
    });
  });

  it("inlines each resource's catalog as JSON and omits it when empty", () => {
    let catalog = {
      entries: [{ id: "abc", title: "Runbooks", description: "deploy steps" }],
      truncated: true,
    };
    let serialized =
      '{"entries":[{"id":"abc","title":"Runbooks","description":"deploy steps"}],"truncated":true}';

    expect(formatAgentCatalogPrompt(catalog)).toBe(`\n${serialized}`);
    expect(formatAgentCatalogPrompt({entries: []})).toBe("");
    expect(formatAgentCatalogPrompt(null)).toBe("");

    let message = formatAlwaysAvailableResourcesPrompt([
      {title: "Context", name: "CONTEXT", catalog},
      {title: "Empty", name: "EMPTY", catalog: {entries: []}},
    ]);
    expect(message).toContain(`- Context: \`env.CONTEXT\`\n${serialized}`);
    // A resource with no catalog gets just its env line, nothing inlined.
    expect(message).toContain("- Empty: `env.EMPTY`");
    expect(message).not.toContain("- Empty: `env.EMPTY`\n{");
  });
});

describe("boundAgentCatalog", () => {
  it("clamps the count and each field, keeping the order it was given", () => {
    let entries = Array.from({length: AGENT_CATALOG_MAX_ENTRIES + 5}, (_, index) => ({
      id: `${index}-${"i".repeat(AGENT_CATALOG_MAX_ID_LENGTH)}`,
      title: `${index}-${"t".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH)}`,
      description: `${index}-${"d".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH)}`,
    }));

    let catalog = boundAgentCatalog(entries);

    expect(catalog.entries).toHaveLength(AGENT_CATALOG_MAX_ENTRIES);
    expect(catalog.entries[0].id).toHaveLength(AGENT_CATALOG_MAX_ID_LENGTH);
    expect(catalog.entries[0].title).toHaveLength(AGENT_CATALOG_MAX_TITLE_LENGTH);
    expect(catalog.entries[0].description).toHaveLength(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH);
    // Order preserved, so the caller decides which entries survive.
    expect(catalog.entries[0].id.startsWith("0-")).toBe(true);
    expect(catalog.truncated).toBe(true);
  });

  it("reports no truncation when everything fits", () => {
    expect(boundAgentCatalog([{id: "a", title: "A", description: "d"}])).toEqual({
      entries: [{id: "a", title: "A", description: "d"}],
      truncated: false,
    });
  });
});

describe("completeAgentCatalogSnapshot", () => {
  it("loads each catalog once and preserves null snapshots", async () => {
    let calls: number[] = [];
    let first = await completeAgentCatalogSnapshot(undefined, [2, 1], async gatekeeperId => {
      calls.push(gatekeeperId);
      return gatekeeperId === 1 ? {entries: []} : null;
    });
    let second = await completeAgentCatalogSnapshot(first.snapshots, [2, 1], async gatekeeperId => {
      calls.push(gatekeeperId);
      return {entries: []};
    });

    expect(first).toEqual({
      snapshots: [
        {gatekeeperId: 1, catalog: {entries: []}},
        {gatekeeperId: 2, catalog: null},
      ],
      changed: true,
    });
    expect(second).toEqual({snapshots: first.snapshots, changed: false});
    expect(calls.toSorted()).toEqual([1, 2]);
  });

  it("prunes snapshots for removed gatekeepers", async () => {
    let result = await completeAgentCatalogSnapshot([
      {gatekeeperId: 1, catalog: {entries: []}},
      {gatekeeperId: 2, catalog: null},
    ], [1], async () => {
      throw new Error("existing catalogs must not be reloaded");
    });

    expect(result).toEqual({
      snapshots: [{gatekeeperId: 1, catalog: {entries: []}}],
      changed: true,
    });
  });
});


