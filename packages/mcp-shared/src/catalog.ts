// The tool catalog of one binding: fetched, cached, scoped, and classified. Where a grant's
// `ToolScope` becomes the set of tools a Gadget can name at all.
//
// The cache is per gatekeeper facet, so per binding rather than per account. That wastes
// `tools/list` calls, but a shared cache would be a channel between two otherwise unrelated
// bindings, and a scoped grant is meant not to see what a wider one fetched.

import type { McpTool } from "./client.js";
import { fetchTools, type ConnectionAccount, type ConnectionEnv } from "./connection.js";
import { looksLikePortal } from "./portal.js";
import { scopeAllows, type ToolScope } from "./scope.js";
import type { McpLog } from "./log.js";
import { catalogRevision, classifyTool, type ClassifiedTool, type ServerTrust }
  from "./tools.js";

/** How long a fetched tool catalog is reused before the server is asked again. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;

// Cached tool catalog plus the revision it was fetched at.
type CachedCatalog = {
  tools: McpTool[];
  revision: string;
  fetchedAt: number;
  // Whether a cap cut the listing short. Cached with the tools because `looksLikePortal` runs on
  // every call, including the ones served from here, and a flag left behind on the fetch path would
  // make an endpoint's portal-ness flip as soon as the cache was hit.
  truncated?: boolean;
};

/**
 * The key-value storage a facet lends this module. Structural so it does not depend on either
 * connector's Durable Object type; `ctx.storage.kv` satisfies it.
 */
export interface CatalogStore {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** What resolving a catalog needs. Everything here is owned by the calling facet. */
export type CatalogRequest = {
  store: CatalogStore;
  log: McpLog;
  env: ConnectionEnv;
  account: ConnectionAccount;
  endpoint: string;
  /** How much of the endpoint this binding may call. */
  scope: ToolScope;
  /**
   * Read from the deployment's current configuration on every call, never from stored account
   * state, so withdrawing the tier takes effect without a reconnect. See `ServerTrust`.
   */
  trust: ServerTrust;
};

/**
 * Returns the tools this binding may call, refreshing from the server when the cache is stale.
 *
 * A changed catalog is adopted rather than pinned, since refusing to see new tools would break
 * working Gadgets, but the change is logged and a scoped binding cannot widen: a tool list is a set
 * of names and a server scope is a name prefix.
 */
export async function scopedTools(request: CatalogRequest): Promise<ClassifiedTool[]> {
  const cached = request.store.get<CachedCatalog>("catalog");
  let tools = cached?.tools;
  let truncated = cached?.truncated ?? false;

  if (!cached || Date.now() - cached.fetchedAt > CATALOG_TTL_MS) {
    try {
      const fetched = await fetchTools(request.env, request.account, request.endpoint);
      const revision = await catalogRevision(fetched.tools);
      if (cached && cached.revision !== revision) {
        request.log.info("server tool catalog changed", {
          event: "catalog.changed", catalogRevision: revision, toolCount: fetched.tools.length,
        });
      }
      tools = fetched.tools;
      truncated = fetched.truncated;
      try {
        request.store.put<CachedCatalog>("catalog", {
          tools, revision, fetchedAt: Date.now(), truncated,
        });
      } catch (err) {
        // The client leaves 32 KiB below the documented per-value limit, but storage serialization
        // is not JSON and its overhead is not an API guarantee. A cache is an optimization: if the
        // runtime still rejects this value, use the fresh catalog now rather than turning a useful
        // server response into a failed operation. The next call will fetch it again.
        request.log.warn("could not cache tool catalog", {
          event: "catalog.cache.write.failed", error: err,
        });
      }
    } catch (err) {
      // Serve the last known catalog rather than breaking a running Gadget on a transient failure.
      if (!tools) throw err;
      request.log.warn("could not refresh tool catalog", {
        event: "catalog.refresh.failed", error: err,
      });
    }
  }

  // Whether the endpoint is a portal is read from the full list, before scoping hides the `portal_*`
  // tools that are the evidence.
  const all = tools ?? [];
  const isPortal = looksLikePortal(all, truncated);
  return all
    .filter(tool => scopeAllows(request.scope, tool.name, isPortal))
    .map(tool => classifyTool(tool, request.trust));
}
