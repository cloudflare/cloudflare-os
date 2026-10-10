// The search itself, apart from the Worker's entrypoints so it runs under Node in tests.

import { z } from "zod";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { WebSearchResult } from "./types.js";

// Pinned rather than left to the API's default, so the provider stays one with zero data
// retention.
const PROVIDER = "ceramic";

// Every account has an AI Gateway named "default", so the gatekeeper needs no configuration.
const GATEWAY_ID = "default";

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

/**
 * Searches the web for `query` through the Workers AI binding. Calls `audit` once, before the
 * query is sent, and throws without sending anything if the query is empty or too long, or `audit`
 * throws.
 */
export async function search(
  ai: Pick<Ai, "websearch">,
  query: string,
  audit: (description: ObservationDescription) => Promise<void>,
): Promise<WebSearchResult[]> {
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
    throw new Error(`A search query must be 1 to ${MAX_QUERY_CHARS} characters.`);
  }

  // Recorded first: the query is what leaves, and a refused or failed record must stop it.
  await audit(describeSearch(query));
  const response = await ai.websearch(
      { gatewayId: GATEWAY_ID, query, provider: PROVIDER, limit: MAX_RESULTS });
  if (!response.ok) {
    // Not the body, which may quote the query back.
    throw new Error(`Web search failed with HTTP ${response.status}.`);
  }
  return RESPONSE_SCHEMA.parse(await response.json()).items;
}

// Built with the kit's builder, so the query is shown exactly: as a literal field, escaped as JSON
// if it contains invisible characters.
function describeSearch(query: string): ObservationDescription {
  const { description, fields } = buildDescription(
      `Searches the public web through AI Gateway, with the "${PROVIDER}" provider.`)
    .inline("Query", query)
    .finish();
  return { title: "Search the web", description, fields, reachesPublicWeb: true };
}
