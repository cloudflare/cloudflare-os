import { describe, expect, it } from "vitest";
import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES, AGENT_CATALOG_MAX_TITLE_LENGTH,
  boundAgentCatalog,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  completeAgentCatalogSnapshot, formatAgentCatalogPrompt,
  formatAlwaysAvailableResourcesPrompt, normalizeAgentCatalog,
} from "../src/agent-catalog";

describe("normalizeAgentCatalog", () => {
  it("sorts entries, strips control characters, and truncates long fields to the max bounds", () => {
    let catalog = normalizeAgentCatalog({
      entries: [
        { id: "2", title: "  Zebra\u0000  ", description: "D".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH + 100) },
        { id: "1", title: "T".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH + 50), description: " First collection " },
      ],
    });

    expect(catalog).toEqual({
      entries: [
        { id: "1", title: "T".repeat(AGENT_CATALOG_MAX_TITLE_LENGTH), description: "First collection" },
        { id: "2", title: "Zebra", description: "D".repeat(AGENT_CATALOG_MAX_DESCRIPTION_LENGTH) },
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
    expect(message).toContain("Check the entries listed above before starting a task");
    expect(message).toContain('A catalog marked `"truncated":true` is partial');
  });

  it("describes the catalogs only when a resource published entries", () => {
    let message = formatAlwaysAvailableResourcesPrompt([
      {title: "Empty", name: "EMPTY", catalog: null},
    ]);

    expect(message).toContain("- Empty: `env.EMPTY`");
    expect(message).not.toContain("Check the entries listed above");
  });
});

describe("boundAgentCatalog", () => {
  it("enforces provider-side count and metadata limits", () => {
    let entries = Array.from({length: 30}, (_, index) => ({
      id: `${index}`.repeat(300),
      title: `Title ${index}`.repeat(30),
      description: `Description ${index}`.repeat(100),
    }));

    let catalog = boundAgentCatalog(entries, {limit: Number.POSITIVE_INFINITY});

    expect(catalog.entries).toHaveLength(0);
    expect(catalog.truncated).toBe(true);
    let bounded = boundAgentCatalog(entries, {limit: 1000});
    expect(bounded.entries).toHaveLength(25);
    expect(bounded.entries[0].id).toHaveLength(256);
    expect(bounded.entries[0].title).toHaveLength(100);
    expect(bounded.entries[0].description).toHaveLength(400);
    expect(bounded.truncated).toBe(true);
    expect(boundAgentCatalog(entries, {limit: -1}).entries).toEqual([]);
    expect(boundAgentCatalog(entries, {limit: 2.9}).entries).toHaveLength(2);
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


