import {describe, expect, it, vi} from "vitest";
import type {AiChatMessage} from "@gadgets/workshop-shared/api";
import type {AgentCatalog} from "@gadgets/workshop-shared/gatekeeper";
import {
  rankSkillsWithWorkersAi, retrieveContextSkillsForPrompt, retrieveSkillCatalog,
  semanticSkillRetrievalEnabled, skillRetrievalQuery,
} from "../src/skill-retrieval";

const SKILL_PREFIX = "Agent Skill. Read with env[N].read(id) and " +
  "console.log(document.content). ";

function catalog(): AgentCatalog {
  return {
    entries: [
      {id: "collection", title: "Cloudflare", description: "Shared context"},
      {id: "collection/skills/account-plan/SKILL.md", title: "account-plan",
        description: `${SKILL_PREFIX}Build a strategic customer account plan.`},
      {id: "collection/skills/battlecard/SKILL.md", title: "battlecard",
        description: `${SKILL_PREFIX}Prepare competitive positioning against a named vendor.`},
      {id: "collection/skills/briefing/SKILL.md", title: "briefing",
        description: `${SKILL_PREFIX}Prepare an executive customer meeting brief.`},
      {id: "collection/skills/customer-call/SKILL.md", title: "customer-call",
        description: `${SKILL_PREFIX}Turn customer notes into a call report.`},
    ],
  };
}

function userMessage(message: string, slash = false): AiChatMessage {
  return {
    chatId: 1,
    sequence: 1,
    timestamp: new Date(0),
    author: {type: "user", id: "user", name: "User"},
    type: "message",
    message,
    ...(slash ? {generatedBySlashCommandSequence: 0} : {}),
  };
}

describe("skillRetrievalQuery", () => {
  it("uses the latest direct user request", () => {
    expect(skillRetrievalQuery([
      userMessage("first"),
      {...userMessage("latest"), sequence: 2},
    ])).toBe("latest");
  });

  it("bypasses generated slash-command messages", () => {
    expect(skillRetrievalQuery([userMessage("<agent_skill>...</agent_skill>", true)]))
        .toBeUndefined();
  });

  it("does not reuse a previous query for a built-in slash command", () => {
    expect(skillRetrievalQuery([
      userMessage("previous request"),
      {
        chatId: 1,
        sequence: 2,
        timestamp: new Date(1),
        author: {type: "user", id: "user", name: "User"},
        type: "slashCommand",
        request: {commandId: "compact", args: "", selection: {builtin: true, commandId: "compact"}},
      },
    ])).toBeUndefined();
  });
});

describe("semanticSkillRetrievalEnabled", () => {
  it("requires the exact opt-in value", () => {
    expect(semanticSkillRetrievalEnabled(undefined)).toBe(false);
    expect(semanticSkillRetrievalEnabled("false")).toBe(false);
    expect(semanticSkillRetrievalEnabled("True")).toBe(false);
    expect(semanticSkillRetrievalEnabled("true")).toBe(true);
  });
});

describe("retrieveContextSkillsForPrompt", () => {
  it("leaves the catalog untouched and never calls AI when disabled", async () => {
    let original = catalog();
    let ranker = vi.fn(async () => [0]);
    let result = await retrieveContextSkillsForPrompt(
      undefined, "context", original, [userMessage("prepare a briefing")], ranker);

    expect(result).toEqual({catalog: original});
    expect(ranker).not.toHaveBeenCalled();
  });

  it("leaves non-Context and slash-command catalogs untouched", async () => {
    let original = catalog();
    let ranker = vi.fn(async () => [0]);

    await expect(retrieveContextSkillsForPrompt(
      "true", "scheduler", original, [userMessage("prepare a briefing")], ranker))
        .resolves.toEqual({catalog: original});
    await expect(retrieveContextSkillsForPrompt(
      "true", "context", original, [userMessage("/briefing", true)], ranker))
        .resolves.toEqual({catalog: original});
    expect(ranker).not.toHaveBeenCalled();
  });

  it("retrieves from the supplied authorized Context catalog when enabled", async () => {
    let original = catalog();
    original.entries.push(...Array.from({length: 6}, (_, index) => ({
      id: `collection/skills/extra-${index}/SKILL.md`,
      title: `extra-${index}`,
      description: `${SKILL_PREFIX}Handle specialist workflow ${index}.`,
    })));
    let ranker = vi.fn(async (_query: string, entries: unknown[]) =>
      entries.map((_, index) => index));
    let result = await retrieveContextSkillsForPrompt(
      "true", "context", original, [userMessage("what should I do next")],
      ranker);

    expect(result.retrieval?.strategy).toBe("hybrid");
    expect(result.catalog?.entries).toHaveLength(9);
    expect(ranker).toHaveBeenCalledOnce();
  });
});

describe("retrieveSkillCatalog", () => {
  it("preserves collection entries and combines lexical and semantic ranks", async () => {
    let ranker = vi.fn(async () => [0, 2, 1, 3]);
    let result = await retrieveSkillCatalog(catalog(), "what should I do next", ranker, 2);

    expect(result.strategy).toBe("hybrid");
    expect(result.catalog.entries.map(entry => entry.title)).toEqual([
      "Cloudflare", "account-plan", "briefing",
    ]);
    expect(result.catalog.truncated).toBe(true);
    expect(ranker).toHaveBeenCalledOnce();
  });

  it("keeps an explicitly named skill ahead of conflicting semantic ranks", async () => {
    let ranker = vi.fn(async () => [1, 2, 3, 0]);
    let result = await retrieveSkillCatalog(
      catalog(), "use account-plan", ranker, 1);

    expect(result.catalog.entries.map(entry => entry.title)).toEqual([
      "Cloudflare", "account-plan",
    ]);
    expect(ranker).not.toHaveBeenCalled();
  });

  it("uses lexical results when semantic ranking fails", async () => {
    let failure = new Error("AI unavailable");
    let result = await retrieveSkillCatalog(
      catalog(), "competitive positioning against vendor", async () => { throw failure; }, 2);

    expect(result.strategy).toBe("lexical");
    expect(result.semanticFailure).toBe("provider_error");
    expect(result.catalog.entries.map(entry => entry.title)).toEqual([
      "Cloudflare", "battlecard",
    ]);
  });

  it("returns the unchanged full catalog when semantic and lexical retrieval fail", async () => {
    let original = catalog();
    let result = await retrieveSkillCatalog(
      original, "unrelated vocabulary", async () => { throw new Error("AI unavailable"); }, 2);

    expect(result.strategy).toBe("full");
    expect(result.catalog).toBe(original);
  });

  it("does not treat generated catalog instructions as lexical relevance", async () => {
    let original = catalog();
    let result = await retrieveSkillCatalog(
      original, "read the agent skill document", async () => { throw new Error("AI unavailable"); }, 2);

    expect(result.strategy).toBe("full");
    expect(result.catalog).toBe(original);
  });

  it("reports bounded semantic failure categories without returning provider errors", async () => {
    let result = await retrieveSkillCatalog(
      catalog(), "unrelated vocabulary", async () => {
        throw new DOMException("request included private prompt text", "TimeoutError");
      }, 2);

    expect(result.semanticFailure).toBe("timeout");
    expect(result).not.toHaveProperty("semanticError");
  });

  it("does not rank catalogs already within the result limit", async () => {
    let original = catalog();
    let ranker = vi.fn(async () => [0]);
    let result = await retrieveSkillCatalog(original, "account", ranker, 10);

    expect(result.catalog).toBe(original);
    expect(ranker).not.toHaveBeenCalled();
  });
});

describe("rankSkillsWithWorkersAi", () => {
  it("sorts a complete valid response by score", async () => {
    let ai = {
      run: vi.fn(async () => ({
        response: [
          {id: 2, score: 0.9}, {id: 1, score: 0.2},
          {id: 3, score: 0.1}, {id: 0, score: 0.8},
        ],
      })),
    } as unknown as Ai;
    let entries = catalog().entries.slice(1);

    await expect(rankSkillsWithWorkersAi(ai, "meeting prep", entries))
        .resolves.toEqual([2, 0, 1, 3]);
    expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      query: "meeting prep",
      contexts: entries.map(entry => ({
        text: `${entry.title.replaceAll("-", " ")}. ` + entry.description.slice(SKILL_PREFIX.length),
      })),
      truncate_inputs: true,
    }, {
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects malformed or incomplete rankings", async () => {
    let entries = catalog().entries.slice(1);
    let ai = {
      run: vi.fn(async () => ({response: [{id: 0, score: 1}]})),
    } as unknown as Ai;

    await expect(rankSkillsWithWorkersAi(ai, "meeting prep", entries))
        .rejects.toThrow("incomplete skill ranking");
  });
});
