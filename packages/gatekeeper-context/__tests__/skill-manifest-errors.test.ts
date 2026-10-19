import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "workshop.example";

type TestEnv = { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> };
const { COLLECTIONS } = env as unknown as TestEnv;

let nextId = 0;

async function createCollection() {
  let id = `skill-errors-${nextId++}`;
  let collection = COLLECTIONS.get(COLLECTIONS.idFromName(domainName(DOMAIN, id)));
  let now = new Date();
  await collection.initialize({
    id, title: "Pricing", description: "", visibility: "private",
    created: now, lastUpdated: now, documentCount: 0, content: { source: "web" },
  }, DOMAIN, "owner");
  return collection;
}

// A git push stores SKILL.md as-is, so the collection can hold one createContextSkill would refuse.
// The shapes below are a real report's: a plain scalar containing ": ", and over 1024 characters.
const TABLES = "Tables covered: invoices, subscriptions, usage. ";
const manifest = (description: string) =>
  `---\nname: pricing-analytics\ndescription: ${description}\n---\n# Pricing analytics\n`;

describe("invalid skill manifests", () => {
  it("lists why each manifest failed, and keeps them out of the agent's skills", async () => {
    let collection = await createCollection();
    await collection.putContextDocument("SKILL.md", {
      description: "", body: manifest(`Answers pricing questions. ${TABLES}`),
    });
    await collection.putContextDocument("long/SKILL.md", {
      description: "", body: manifest(JSON.stringify(TABLES.repeat(22))),
    });
    await collection.putContextDocument("valid/SKILL.md", {
      description: "", body: manifest("Answers pricing questions."),
    });

    let documents = await collection.listContextDocuments();
    expect(documents.map(({ path, skillName, skillError }) => ({ path, skillName, skillError })))
      .toEqual([
        { path: "SKILL.md", skillName: undefined, skillError: "Skill frontmatter is not valid YAML." },
        {
          path: "long/SKILL.md",
          skillName: undefined,
          skillError: "Skill description must be at most 1024 characters.",
        },
        { path: "valid/SKILL.md", skillName: "pricing-analytics", skillError: undefined },
      ]);
    expect((await collection.listAgentSkills()).map(skill => skill.path)).toEqual(["valid/SKILL.md"]);
  });

  it("clears the error once the manifest is fixed", async () => {
    let collection = await createCollection();
    await collection.putContextDocument("SKILL.md", {
      description: "", body: manifest(`Answers pricing questions. ${TABLES}`),
    });
    await collection.putContextDocument("SKILL.md", {
      description: "", body: manifest(JSON.stringify(`Answers pricing questions. ${TABLES}`)),
    });

    let [document] = await collection.listContextDocuments();
    expect(document.skillName).toBe("pricing-analytics");
    expect(document).not.toHaveProperty("skillError");
  });
});
