// Web Search request handling, separate from the Worker's RPC entrypoints.

import { z } from "zod";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type {
  GatekeeperAdminSetting, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  WEB_SEARCH_IN_MODEL, WEB_SEARCH_PROVIDER_SETTING,
} from "@gadgets/workshop-shared/web-search-gatekeeper";
import type { WebSearchResult } from "./types.js";

// The providers of Cloudflare's Web Search API that a search can run on.
const API_PROVIDER = z.enum(["ceramic", "linkup", "exa"]);
const API_PROVIDER_OPTIONS = [
  { value: "ceramic", label: "Ceramic" },
  { value: "linkup", label: "Linkup" },
  { value: "exa", label: "Exa" },
] satisfies { value: z.infer<typeof API_PROVIDER>; label: string }[];

const NO_FALLBACK = "none";

/**
 * The admin setting that says where searches run. The default names a provider, because
 * Cloudflare could change the API's default. It is never WEB_SEARCH_IN_MODEL: the Workshop takes
 * a deployment that has stored no choice as one that does not search in the model.
 */
export const PROVIDER_SETTING: GatekeeperAdminSetting = {
  id: WEB_SEARCH_PROVIDER_SETTING,
  label: "Search provider",
  help: "Where web searches run. Ceramic, Linkup and Exa run on Cloudflare's Web Search API. " +
      "When a search is billed to AI Gateway credits, Ceramic and Linkup do not keep the query, " +
      "and Exa can keep it. With the model's provider, a chat that has Web Search searches with " +
      "its model provider's own tool, on Anthropic and OpenAI models on AI Gateway. A search " +
      "costs more there. Every other search, such as a gadget's, goes to the Fallback search " +
      "provider, and fails until you choose one. If a provider account has web search off, " +
      "those chats fail on every message, so test your Anthropic and OpenAI models in the " +
      "Models tab after you choose it.",
  options: [...API_PROVIDER_OPTIONS, { value: WEB_SEARCH_IN_MODEL, label: "The model's provider" }],
  defaultValue: "ceramic",
};

/**
 * The admin setting that names the provider of every search that does not run in a model. It
 * applies only while PROVIDER_SETTING is WEB_SEARCH_IN_MODEL.
 */
export const FALLBACK_SETTING: GatekeeperAdminSetting = {
  id: "fallback",
  label: "Fallback search provider",
  help: "Runs every search that does not run in a model. Those are the searches of gadgets " +
      "and of code an agent runs, and of chats on Auto, Gemini, Workers AI or a user's own " +
      "model. They are also all searches in a workspace that holds restricted data, in a " +
      "workspace whose owner pays through their own Cloudflare account, and on a deployment " +
      "with no AI Gateway. With None, those searches fail. It is not a retry for a search that " +
      "failed.",
  options: [{ value: NO_FALLBACK, label: "None" }, ...API_PROVIDER_OPTIONS],
  defaultValue: NO_FALLBACK,
  shownWhen: { settingId: WEB_SEARCH_PROVIDER_SETTING, value: WEB_SEARCH_IN_MODEL },
};

// Every account has an AI Gateway named "default", so a deploy that sets no CF_AI_GATEWAY works.
const DEFAULT_GATEWAY = "default";

// The API's limit on a query's length.
const MAX_QUERY_CHARS = 1024;

const MAX_RESULTS = 10;

// What the caller sees of each result; zod drops the rest (image and favicon URLs).
const RESULT_SCHEMA = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  lastModifiedDate: z.string().optional(),
}) satisfies z.ZodType<WebSearchResult>;
const RESPONSE_SCHEMA = z.object({ items: z.array(RESULT_SCHEMA) });

// The provider that receives a search under `settings`, the choices the admin stored (see
// ApprovalQueue.getAdminSettings). A setting with no stored choice has its default. Throws for a
// choice that names no provider. A stored value that is not known is never read as a default:
// that would send queries to a provider nobody chose.
function chosenProvider(settings: Record<string, string>): z.infer<typeof API_PROVIDER> {
  const provider = settings[PROVIDER_SETTING.id] ?? PROVIDER_SETTING.defaultValue;
  const inModel = provider === WEB_SEARCH_IN_MODEL;
  const chosen = inModel
      ? settings[FALLBACK_SETTING.id] ?? FALLBACK_SETTING.defaultValue : provider;
  if (inModel && chosen === NO_FALLBACK) {
    throw new Error("Web search through this binding is off on this deployment: the admin " +
        "chose \"The model's provider\" as the Search provider, and no Fallback search " +
        "provider. If your model has a web search tool of its own, use that. A gadget cannot " +
        "search here. An admin can choose a Fallback search provider under Admin > Gatekeepers " +
        "> Web Search.");
  }
  const known = API_PROVIDER.safeParse(chosen);
  if (!known.success) {
    throw new Error("Web search is set to a provider this version does not offer. An admin " +
        "must choose one under Admin > Gatekeepers > Web Search.");
  }
  return known.data;
}

/**
 * Searches the web for `query` with the provider that `settings` chooses, through the Workers AI
 * binding and the `CF_AI_GATEWAY` gateway, or `default` when that is unset. Calls `audit` once,
 * before the query is sent. Throws without recording or sending anything if `settings` chooses no
 * provider or the query is empty or too long, and without sending anything if `audit` throws. A
 * search that fails is not sent to another provider.
 */
export async function search(
  env: { AI: Pick<Ai, "websearch">; CF_AI_GATEWAY?: string },
  settings: Record<string, string>,
  query: string,
  audit: (description: ObservationDescription) => Promise<void>,
): Promise<WebSearchResult[]> {
  const provider = chosenProvider(settings);
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
    throw new Error(`A search query must be 1 to ${MAX_QUERY_CHARS} characters.`);
  }

  // Recorded first: the query is what leaves, and a refused or failed record must stop it.
  await audit(describeSearch(query, provider));
  const response = await env.AI.websearch({
    gatewayId: env.CF_AI_GATEWAY ?? DEFAULT_GATEWAY, query, provider, limit: MAX_RESULTS,
  });
  if (!response.ok) {
    // Not the body, which may quote the query back.
    throw new Error(`Web search failed with HTTP ${response.status}.`);
  }
  return RESPONSE_SCHEMA.parse(await response.json()).items;
}

// Built with the kit's builder, so the query is shown exactly: as a literal field, escaped as JSON
// if it contains invisible characters.
function describeSearch(query: string, provider: string): ObservationDescription {
  const { description, fields } = buildDescription(
      `Searches the public web through AI Gateway, with the "${provider}" provider.`)
    .inline("Query", query)
    .finish();
  return { title: "Search the web", description, fields, subresources: [] };
}
