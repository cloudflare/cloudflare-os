// Web Search request handling, separate from the Worker's RPC entrypoints.

import { z } from "zod";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { defineUpstream, type CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { WebSearchResult } from "./types.js";

// Pinned rather than left to the API's default. Credit-billed Ceramic searches have zero data
// retention; with an operator's own Ceramic key stored on the gateway, their Ceramic terms apply.
const PROVIDER = "ceramic";

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

/** The gatekeeper's vendor id, which is also the service its calls are counted under. */
export const VENDOR_ID = "websearch";

/**
 * The names this gatekeeper's calls to the Web Search API are counted under, one for each method
 * of the Workers AI binding it calls: `search` is `websearch()`.
 */
export const WEBSEARCH_OPERATIONS = ["search"] as const;

/** The name of one call: a member of `WEBSEARCH_OPERATIONS`. */
export type WebSearchOperation = (typeof WEBSEARCH_OPERATIONS)[number];

/**
 * The client every call to the Web Search API goes through and is counted by: one `subservice/v1`
 * point for each call, under the source `gatekeeper.websearch.api` and the service `websearch`.
 * The API is a method of a binding and no HTTP request, so a search goes through `call()`, which
 * sets no timeout and makes the call once: a search is billed by the call.
 */
export const websearchUpstream = defineUpstream({ vendorId: VENDOR_ID });

// What a search the binding answered came to: its results, or what the search fails with and how
// its call is counted. The search fails once the call is counted, so the call is counted by the
// status of the answer and by nothing else it holds. What the binding itself throws is no answer,
// and is counted by the client's own rule.
type Searched = { items: WebSearchResult[] } | { failure: unknown; counted: CallAnswer };

// How an answer that is no success is counted, as the client counts an HTTP answer of that status,
// and how a success that could not be read is.
const RATE_LIMITED: CallAnswer = { outcome: "refused", reason: "rate" };
const FAILED: CallAnswer = { outcome: "error", reason: "http" };
const UNREADABLE: CallAnswer = { outcome: "error", reason: "parse" };

/**
 * Searches the web for `query` through the Workers AI binding and the `CF_AI_GATEWAY` gateway, or
 * `default` when that is unset. Calls `audit` once, before the query is sent, and throws without
 * sending anything if the query is empty or too long, or `audit` throws. The binding's call, with
 * the reading of its answer, is counted through `websearchUpstream` as one `search`.
 */
export async function search(
  env: { AI: Pick<Ai, "websearch">; CF_AI_GATEWAY?: string },
  query: string,
  audit: (description: ObservationDescription) => Promise<void>,
): Promise<WebSearchResult[]> {
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
    throw new Error(`A search query must be 1 to ${MAX_QUERY_CHARS} characters.`);
  }

  // Recorded first: the query is what leaves, and a refused or failed record must stop it.
  await audit(describeSearch(query));
  const searched = await websearchUpstream.call("search" satisfies WebSearchOperation, async (): Promise<Searched> => {
    const response = await env.AI.websearch({
      gatewayId: env.CF_AI_GATEWAY ?? DEFAULT_GATEWAY, query, provider: PROVIDER,
      limit: MAX_RESULTS,
    });
    if (!response.ok) {
      // Not the body, which may quote the query back.
      const failure = new Error(`Web search failed with HTTP ${response.status}.`);
      return { failure, counted: response.status === 429 ? RATE_LIMITED : FAILED };
    }
    try {
      return { items: RESPONSE_SCHEMA.parse(await response.json()).items };
    } catch (failure) {
      return { failure, counted: UNREADABLE };
    }
  }, { answer: answered => "counted" in answered ? answered.counted : undefined });
  if ("failure" in searched) throw searched.failure;
  return searched.items;
}

// Built with the kit's builder, so the query is shown exactly: as a literal field, escaped as JSON
// if it contains invisible characters.
function describeSearch(query: string): ObservationDescription {
  const { description, fields } = buildDescription(
      `Searches the public web through AI Gateway, with the "${PROVIDER}" provider.`)
    .inline("Query", query)
    .finish();
  return { title: "Search the web", description, fields, subresources: [] };
}
