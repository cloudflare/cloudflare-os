import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createFauxCore, fauxAssistantMessage, fauxText, type Message } from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessage, AlwaysAvailableResource,
} from "@gadgets/workshop-shared/api";
import type { Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";
import {
  AGENT_CATALOG_MAX_DESCRIPTION_LENGTH, AGENT_CATALOG_MAX_ENTRIES, AGENT_CATALOG_MAX_ID_LENGTH,
  AGENT_CATALOG_MAX_TITLE_LENGTH, boundAgentCatalog,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  findCatalogChanges, formatAgentCatalogPrompt, formatAlwaysAvailableResourcesPrompt,
  formatCatalogChange, normalizeAgentCatalog, seenAlwaysAvailableResources,
} from "../src/agent-catalog";
import { runAgent } from "../src/agent";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

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

let skill = (title: string) => ({id: title, title, description: `The ${title} skill.`});
let skills = (...titles: string[]): AlwaysAvailableResource =>
  ({name: "CONTEXT", title: "Skills", catalog: {entries: titles.map(skill)}});
let unloaded: AlwaysAvailableResource = {name: "CONTEXT", title: "Skills", catalog: null};
let seen = (resource: AlwaysAvailableResource) => new Map([[resource.name, resource]]);
let note = (sequence: number, resource: AlwaysAvailableResource): AiChatMessage => ({
  chatId: 1, sequence, timestamp: new Date(0), author: {type: "agent", id: "m", name: "M"},
  type: "catalogChange", resources: [resource],
});

describe("catalog changes", () => {
  it("reports a changed catalog and a resource the agent hasn't seen, not an unchanged one", () => {
    let tasks: AlwaysAvailableResource = {name: "TASKS", title: "Tasks", catalog: null};
    expect(findCatalogChanges(seen(skills("Tax")), [skills("Tax", "Travel"), tasks]))
      .toEqual([skills("Tax", "Travel"), tasks]);
    expect(findCatalogChanges(seen(skills("Tax")), [skills("Tax")])).toEqual([]);
  });

  it("does not take a catalog that failed to load for a change", () => {
    expect(findCatalogChanges(seen(skills("Tax")), [unloaded])).toEqual([]);
  });

  it("compares a catalog the agent saw missing as an empty one", () => {
    expect(findCatalogChanges(seen(unloaded), [skills()])).toEqual([]);
    expect(findCatalogChanges(seen(unloaded), [skills("Tax")])).toEqual([skills("Tax")]);
  });

  it("tells the agent the entries added and those no longer listed, not those kept", () => {
    let text = formatCatalogChange(skills("Travel", "Visa"), skills("Tax", "Travel"));

    expect(text).toContain(`Added: [${JSON.stringify(skill("Visa"))}]`);
    expect(text).toContain(`No longer listed: [${JSON.stringify(skill("Tax"))}]`);
    expect(text).not.toContain(JSON.stringify(skill("Travel")));
  });

  it("applies only the changes recorded before a sequence", () => {
    let messages = [note(3, skills("Tax", "Travel")), note(7, skills("Travel"))];

    expect(seenAlwaysAvailableResources([skills("Tax")], messages, 7).get("CONTEXT"))
      .toEqual(skills("Tax", "Travel"));
  });

  it("tells the agent what changed since the change it was last told about", async () => {
    let stub = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      // (Bracket access reaches the private field with its real type.)
      let impl = instance["impl"];
      let user: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
      let current = skills("Tax");
      let facet = {
        describe: async () => ({
          title: current.title, url: "https://example.com", snippet: "",
          suggestedBindingName: current.name, tsType: "Skills",
        }),
        getAgentCatalog: async () => ({ entries: current.catalog?.entries ?? [] }),
      } satisfies Required<Pick<Gatekeeper<unknown>, "describe" | "getAgentCatalog">>;
      // A gatekeeper class cannot be minted in a test: the record holds one the workspace never
      // instantiates, and the facet supplies only the RPC methods a turn calls.
      impl.getGatekeeperFacet =
          (async () => facet) as unknown as OverseerDurableObject["impl"]["getGatekeeperFacet"];
      impl.storage.gatekeepers.put({
        id: 1, resourceTitle: current.title, class: {} as unknown as GatekeeperRecord["class"],
        creationSpec: { type: "ambient", vendorId: "skills", accountId: 1 },
      });
      impl.storage.chatMeta.put(
          { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) });

      // Each turn's catalog differs from the one before; returns what the turn's request held.
      let turn = async (catalog: AlwaysAvailableResource): Promise<string[]> => {
        current = catalog;
        impl.addChatMessages(1, user, [{ type: "message", message: "Go on." }]);
        let faux = createFauxCore({ models: [{ id: "faux-model" }] });
        faux.setResponses([fauxAssistantMessage(fauxText("Done."))]);
        let requests: Message[][] = [];
        await runAgent(impl, {
          model: faux.getModel(),
          stream: (model, context, options) => {
            requests.push(structuredClone(context.messages));
            return faux.stream(model, context, options);
          },
        }, 1, { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal,
            user, { provider: "cloudflare", model: "faux-model", apiToken: "" });
        return requests[0].flatMap(message => message.role === "toolResult"
            ? [message.content.map(part => part.type === "text" ? part.text : "").join("")] : []);
      };

      expect(await turn(skills("Tax"))).toEqual([]);
      let first = formatCatalogChange(skills("Tax", "Travel"), skills("Tax"));
      expect(await turn(skills("Tax", "Travel"))).toEqual([first]);
      expect(await turn(skills("Travel", "Visa"))).toEqual(
          [first, formatCatalogChange(skills("Travel", "Visa"), skills("Tax", "Travel"))]);
    });
  });
});
