// KV helpers for the per-domain public-collections snapshot. The registry DO is the only writer;
// user sessions read it when building their enabled collection set.

import { ContextCollectionMetadata, ContextCollectionSummary } from "./context-types.js";

// Namespaces sharing domains; NUL never appears in configured domains.
const KV_SEP = "\u0000";

/** A domain's public-collections snapshot. */
export function publicCollectionsKvKey(domain: string): string {
  return `${domain}${KV_SEP}.public`;
}

function parsePublicCollections(raw: string): ContextCollectionSummary[] {
  let list = JSON.parse(raw) as ContextCollectionSummary[];
  for (let entry of list) {
    entry.lastUpdated = new Date(entry.lastUpdated);
  }
  return list;
}

/** The public collections for a domain (readable by every user in that domain). */
export async function listPublicCollectionsFromKv(
  env: Pick<Cloudflare.Env, 'CONTEXT_COLLECTIONS'>,
  domain: string,
): Promise<ContextCollectionSummary[]> {
  let raw = await env.CONTEXT_COLLECTIONS.get(publicCollectionsKvKey(domain));
  if (!raw) {
    return [];
  }
  return parsePublicCollections(raw);
}

export function metadataToSummary(metadata: ContextCollectionMetadata): ContextCollectionSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    description: metadata.description,
    icon: metadata.icon,
    visibility: metadata.visibility,
    documentCount: metadata.documentCount,
    lastUpdated: metadata.lastUpdated,
  };
}
