// Server-managed models: models the deployment supplies to every user, with credentials that live
// in the deployment's environment rather than in each user's settings.
//
// This is the self-hosted counterpart to AI Gateway mode (see ai-gateway.ts). Both let an operator
// fund inference centrally, but a Gateway is Cloudflare-hosted and limited to the providers and
// models it knows about, whereas this points at any OpenAI-compatible endpoint -- an internal
// gateway, a corporate LLM proxy, a self-hosted router, or a vLLM/Ollama box. The two are
// independent and may be used together; server models are never re-routed through a Gateway.
//
// Users see these models in the picker alongside their own, but cannot edit or delete them and
// never handle the API token.

import { AiChatAuthorInfo, AiModelConfig, AiModelProvider } from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

const PROVIDERS: ReadonlySet<string> =
    new Set<AiModelProvider>(["openai", "anthropic", "google", "cloudflare", "ollama"]);

/** One entry of the SERVER_MODELS array, after validation. */
export type ServerModel = {
  id: string;
  name: string;
  config: AiModelConfig;
};

function fail(index: number, message: string): never {
  throw new Error(`SERVER_MODELS[${index}]: ${message}`);
}

function parseEntry(raw: unknown, index: number): ServerModel {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(index, "must be an object.");
  }
  const e = raw as Record<string, unknown>;

  const provider = e.provider;
  if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
    fail(index, `"provider" must be one of ${[...PROVIDERS].join(", ")}.`);
  }

  const model = e.model;
  if (typeof model !== "string" || model === "") {
    fail(index, `"model" is required.`);
  }

  // `id` is what the user's stored preference and every chat record refer to, so it must be
  // stable. It defaults to the model name, which is stable for the common single-endpoint case.
  const id = e.id === undefined ? model : e.id;
  if (typeof id !== "string" || id === "") {
    fail(index, `"id" must be a non-empty string.`);
  }

  const name = e.name === undefined ? id : e.name;
  if (typeof name !== "string" || name === "") {
    fail(index, `"name" must be a non-empty string.`);
  }

  if (e.apiUrl !== undefined && typeof e.apiUrl !== "string") {
    fail(index, `"apiUrl" must be a string.`);
  }
  if (e.apiToken !== undefined && typeof e.apiToken !== "string") {
    fail(index, `"apiToken" must be a string.`);
  }
  for (const key of ["contextWindow", "outputLimit"] as const) {
    if (e[key] !== undefined && (typeof e[key] !== "number" || !Number.isFinite(e[key]))) {
      fail(index, `"${key}" must be a number.`);
    }
  }

  return {
    id,
    name,
    config: {
      provider: provider as AiModelProvider,
      model,
      // Some endpoints (a trusted proxy on a private network, a local Ollama) want no
      // Authorization header at all; the providers already treat "" as "send nothing".
      apiToken: (e.apiToken as string | undefined) ?? "",
      ...(e.apiUrl !== undefined ? { apiUrl: e.apiUrl as string } : {}),
      ...(e.accountId !== undefined ? { accountId: String(e.accountId) } : {}),
      ...(e.contextWindow !== undefined ? { contextWindow: e.contextWindow as number } : {}),
      ...(e.outputLimit !== undefined ? { outputLimit: e.outputLimit as number } : {}),
      serverManaged: true,
    },
  };
}

export class ServerModelsConfig {
  /** Models by id, in configured order (which is the order the picker shows them in). */
  readonly models: ReadonlyMap<string, ServerModel>;

  constructor(json: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(
          `SERVER_MODELS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err });
    }
    if (!Array.isArray(parsed)) {
      throw new Error("SERVER_MODELS must be a JSON array of model objects.");
    }

    const models = new Map<string, ServerModel>();
    parsed.forEach((raw, i) => {
      const entry = parseEntry(raw, i);
      if (models.has(entry.id)) {
        fail(i, `duplicate id "${entry.id}".`);
      }
      models.set(entry.id, entry);
    });
    this.models = models;
  }

  /** The models offered to every user, as picker entries. */
  getModelList(): AiChatAuthorInfo[] {
    return [...this.models.values()].map(m => ({ type: "agent", id: m.id, name: m.name }));
  }

  /** Look up a server model by id, in the same shape a user-configured model resolves to. */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    const entry = this.models.get(modelId);
    if (!entry) return undefined;
    return {
      profile: { type: "agent", id: entry.id, name: entry.name },
      config: entry.config,
    };
  }

  has(modelId: string): boolean {
    return this.models.has(modelId);
  }
}

// Parsing is cheap but happens on hot paths (every listModels, every chat context), so memoize
// per env object.
const cache = new WeakMap<object, ServerModelsConfig | null>();

/**
 * Parse server-managed model configuration from the environment. Returns null when SERVER_MODELS
 * is unset or empty.
 *
 * Throws if SERVER_MODELS is present but malformed: a deployment that meant to supply models
 * should fail loudly rather than silently offer none.
 */
export function getServerModelsConfig(env: Cloudflare.Env): ServerModelsConfig | null {
  const raw = env.SERVER_MODELS;
  if (!raw || raw.trim() === "") return null;

  const cached = cache.get(env as unknown as object);
  if (cached !== undefined) return cached;

  const config = new ServerModelsConfig(raw);
  const result = config.models.size > 0 ? config : null;
  cache.set(env as unknown as object, result);
  return result;
}
