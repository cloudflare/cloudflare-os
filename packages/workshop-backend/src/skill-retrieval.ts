import type {AiChatMessage} from "@gadgets/workshop-shared/api";
import type {AgentCatalog, AgentCatalogEntry} from "@gadgets/workshop-shared/gatekeeper";

const AGENT_SKILL_DESCRIPTION_PREFIX = "Agent Skill.";
const AGENT_SKILL_INSTRUCTION_END = "console.log(document.content). ";
const AGENT_SKILL_PATH_SUFFIX = "/SKILL.md";
const DEFAULT_SKILL_RESULT_LIMIT = 8;
const MAX_RETRIEVAL_QUERY_LENGTH = 4000;
const RRF_RANK_OFFSET = 60;
const SEMANTIC_RANKING_TIMEOUT_MS = 3000;
const LEXICAL_STOP_WORDS = new Set([
  "and", "are", "for", "from", "into", "the", "this", "that", "with", "you", "your",
]);

export type SkillRetrievalStrategy = "full" | "hybrid" | "lexical";
export type SemanticFailure = "invalid_response" | "provider_error" | "timeout";

export type SkillCatalogRetrievalResult = {
  catalog: AgentCatalog;
  strategy: SkillRetrievalStrategy;
  skillCount: number;
  selectedSkillCount: number;
  semanticFailure?: SemanticFailure;
};

export type PromptSkillRetrievalResult = {
  catalog: AgentCatalog | null;
  retrieval?: SkillCatalogRetrievalResult;
};

type SemanticRanker = (
  query: string,
  entries: AgentCatalogEntry[],
) => Promise<number[]>;

class InvalidSemanticRankingError extends Error {}

function isAgentSkill(entry: AgentCatalogEntry): boolean {
  return entry.id.endsWith(AGENT_SKILL_PATH_SUFFIX) &&
    entry.description.startsWith(AGENT_SKILL_DESCRIPTION_PREFIX);
}

function normalizeWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/)
      .filter(word => word.length > 1 && !LEXICAL_STOP_WORDS.has(word));
}

function skillPurpose(entry: AgentCatalogEntry): string {
  let instructionEnd = entry.description.indexOf(AGENT_SKILL_INSTRUCTION_END);
  return instructionEnd < 0
    ? entry.description.slice(AGENT_SKILL_DESCRIPTION_PREFIX.length).trim()
    : entry.description.slice(instructionEnd + AGENT_SKILL_INSTRUCTION_END.length);
}

function isExactMention(entry: AgentCatalogEntry, query: string): boolean {
  let title = normalizeWords(entry.title).join(" ");
  let normalizedQuery = normalizeWords(query).join(" ");
  return Boolean(title && ` ${normalizedQuery} `.includes(` ${title} `));
}

function lexicalScore(entry: AgentCatalogEntry, query: string, queryWords: Set<string>): number {
  let descriptionWords = new Set(normalizeWords(skillPurpose(entry)));
  let score = isExactMention(entry, query) ? 100 : 0;
  let titleWords = new Set(normalizeWords(entry.title));
  for (let word of queryWords) {
    if (titleWords.has(word)) {
      score += 10;
    } else if (descriptionWords.has(word)) {
      score += 1;
    }
  }
  return score;
}

function uniqueIndices(...rankings: number[][]): number[] {
  let seen = new Set<number>();
  return rankings.flat().filter(index => {
    if (seen.has(index)) return false;
    seen.add(index);
    return true;
  });
}

function semanticFailure(error: unknown): SemanticFailure {
  if (error instanceof InvalidSemanticRankingError) return "invalid_response";
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "timeout";
  }
  return "provider_error";
}

function rankLexically(entries: AgentCatalogEntry[], query: string): number[] {
  let queryWords = new Set(normalizeWords(query));
  return entries
      .map((entry, index) => ({index, score: lexicalScore(entry, query, queryWords)}))
      .filter(result => result.score > 0)
      .toSorted((left, right) => right.score - left.score || left.index - right.index)
      .map(result => result.index);
}

function reciprocalRankFusion(rankings: Array<{indices: number[], weight: number}>): number[] {
  let scores = new Map<number, number>();
  for (let {indices, weight} of rankings) {
    for (let rank = 0; rank < indices.length; rank++) {
      let index = indices[rank];
      scores.set(index, (scores.get(index) ?? 0) + weight / (RRF_RANK_OFFSET + rank + 1));
    }
  }
  return [...scores]
      .toSorted(([leftIndex, leftScore], [rightIndex, rightScore]) =>
        rightScore - leftScore || leftIndex - rightIndex)
      .map(([index]) => index);
}

function filteredCatalog(
    catalog: AgentCatalog,
    collectionEntries: AgentCatalogEntry[],
    skillEntries: AgentCatalogEntry[],
    rankedIndices: number[],
    limit: number): AgentCatalog {
  let selected = rankedIndices.slice(0, limit).map(index => skillEntries[index]);
  return {
    entries: [...collectionEntries, ...selected],
    ...(catalog.truncated || selected.length < skillEntries.length ? {truncated: true} : {}),
  };
}

/**
 * Return the latest direct user request for skill retrieval. Slash-command expansions already
 * selected and loaded an exact skill, so reranking their generated message would be redundant.
 */
export function skillRetrievalQuery(messages: AiChatMessage[]): string | undefined {
  for (let message of messages.toReversed()) {
    if (message.author.type !== "user") continue;
    if (message.type !== "message") return undefined;
    if (message.generatedBySlashCommandSequence !== undefined) return undefined;
    let query = message.message.trim();
    return query ? query.slice(0, MAX_RETRIEVAL_QUERY_LENGTH) : undefined;
  }
  return undefined;
}

/** Whether a deployment explicitly enabled the experimental retrieval path. */
export function semanticSkillRetrievalEnabled(value: string | undefined): boolean {
  return value === "true";
}

/** Apply the pilot only to direct user turns against the authorized Context catalog. */
export async function retrieveContextSkillsForPrompt(
    enabled: string | undefined,
    vendorId: string | undefined,
    catalog: AgentCatalog | null,
    messages: AiChatMessage[],
    semanticRanker: SemanticRanker): Promise<PromptSkillRetrievalResult> {
  if (!semanticSkillRetrievalEnabled(enabled) || vendorId?.toLowerCase() !== "context" || !catalog) {
    return {catalog};
  }
  let query = skillRetrievalQuery(messages);
  if (!query) return {catalog};
  let retrieval = await retrieveSkillCatalog(catalog, query, semanticRanker);
  return {catalog: retrieval.catalog, retrieval};
}

/**
 * Reduce an authorized Context catalog to the skills most relevant to this turn. The caller owns
 * authorization; this function only ranks entries it was given and never resolves additional IDs.
 */
export async function retrieveSkillCatalog(
    catalog: AgentCatalog,
    query: string,
    semanticRanker: SemanticRanker,
    limit = DEFAULT_SKILL_RESULT_LIMIT): Promise<SkillCatalogRetrievalResult> {
  let collectionEntries = catalog.entries.filter(entry => !isAgentSkill(entry));
  let skillEntries = catalog.entries.filter(isAgentSkill);
  if (skillEntries.length <= limit) {
    return {
      catalog,
      strategy: "full",
      skillCount: skillEntries.length,
      selectedSkillCount: skillEntries.length,
    };
  }

  let lexical = rankLexically(skillEntries, query);
  let exact = skillEntries
      .map((entry, index) => ({entry, index}))
      .filter(({entry}) => isExactMention(entry, query))
      .map(({index}) => index);
  if (exact.length > 0) {
    let ranked = uniqueIndices(exact, lexical);
    let reduced = filteredCatalog(catalog, collectionEntries, skillEntries, ranked, limit);
    return {
      catalog: reduced,
      strategy: "lexical",
      skillCount: skillEntries.length,
      selectedSkillCount: reduced.entries.length - collectionEntries.length,
    };
  }
  try {
    let semantic = await semanticRanker(query, skillEntries);
    if (semantic.length === 0 && lexical.length > 0) {
      let reduced = filteredCatalog(
        catalog, collectionEntries, skillEntries, lexical, limit);
      return {
        catalog: reduced,
        strategy: "lexical",
        skillCount: skillEntries.length,
        selectedSkillCount: reduced.entries.length - collectionEntries.length,
      };
    }
    let fused = reciprocalRankFusion([
      {indices: lexical, weight: 1},
      {indices: semantic, weight: 2},
    ]);
    let exactSet = new Set(exact);
    let ranked = [...exact, ...fused.filter(index => !exactSet.has(index))];
    if (ranked.length > 0) {
      let reduced = filteredCatalog(
        catalog, collectionEntries, skillEntries, ranked, limit);
      return {
        catalog: reduced,
        strategy: "hybrid",
        skillCount: skillEntries.length,
        selectedSkillCount: reduced.entries.length - collectionEntries.length,
      };
    }
  } catch (error) {
    if (lexical.length > 0) {
      let reduced = filteredCatalog(
        catalog, collectionEntries, skillEntries, lexical, limit);
      return {
        catalog: reduced,
        strategy: "lexical",
        skillCount: skillEntries.length,
        selectedSkillCount: reduced.entries.length - collectionEntries.length,
        semanticFailure: semanticFailure(error),
      };
    }
    return {
      catalog,
      strategy: "full",
      skillCount: skillEntries.length,
      selectedSkillCount: skillEntries.length,
      semanticFailure: semanticFailure(error),
    };
  }

  return {
    catalog,
    strategy: "full",
    skillCount: skillEntries.length,
    selectedSkillCount: skillEntries.length,
  };
}

/** Rank catalog entries with Workers AI's query/context semantic scorer. */
export async function rankSkillsWithWorkersAi(
    ai: Ai,
    query: string,
    entries: AgentCatalogEntry[]): Promise<number[]> {
  let result = await ai.run("@cf/baai/bge-m3", {
    query,
    contexts: entries.map(entry => ({
      text: `${entry.title.replaceAll("-", " ")}. ${skillPurpose(entry)}`,
    })),
    truncate_inputs: true,
  }, {
    signal: AbortSignal.timeout(SEMANTIC_RANKING_TIMEOUT_MS),
  });
  if (!("response" in result) || !Array.isArray(result.response)) {
    throw new InvalidSemanticRankingError("Workers AI returned no semantic skill ranking.");
  }

  let seen = new Set<number>();
  let ranked = result.response.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InvalidSemanticRankingError("Workers AI returned a malformed skill ranking.");
    }
    let id = item.id;
    if (!Number.isInteger(id) || id! < 0 || id! >= entries.length || seen.has(id!) ||
        !Number.isFinite(item.score)) {
      throw new InvalidSemanticRankingError("Workers AI returned a malformed skill ranking.");
    }
    seen.add(id!);
    return {id: id!, score: item.score!};
  });
  if (ranked.length !== entries.length) {
    throw new InvalidSemanticRankingError("Workers AI returned an incomplete skill ranking.");
  }
  return ranked
      .toSorted((left, right) => right.score - left.score || left.id - right.id)
      .map(item => item.id);
}
