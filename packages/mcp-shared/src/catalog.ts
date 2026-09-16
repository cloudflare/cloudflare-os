// The described tool catalog of one binding: fetched, cached, scoped, and classified. A broad grant
// can cover definitions omitted by this bounded catalog; `HydratedTools` remembers those when the
// facet discovers them directly from the endpoint.
//
// The cache is per gatekeeper facet, so per binding rather than per account. That wastes
// `tools/list` calls, but a shared cache would be a channel between two otherwise unrelated
// bindings, and a scoped grant is meant not to see what a wider one fetched.

import { isValidToolName, type McpTool } from "./client.js";
import { fetchTools, type ConnectionAccount, type ConnectionEnv } from "./connection.js";
import { looksLikePortal, toolBelongsToServer } from "./portal.js";
import { scopeAllows, type ToolScope } from "./scope.js";
import type { McpLog } from "./log.js";
import {
  catalogRevision,
  classifyTool,
  MAX_TOOLS_PER_SERVER,
  type ClassifiedTool,
  type ServerTrust,
} from "./tools.js";

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
  /** Absolute deadline shared with the facet operation that requested this catalog. */
  deadline?: number;
};

/** A binding's currently described tools and whether their endpoint is a portal. */
export type ScopedCatalog = {
  /** Scoped and classified definitions retained in the bounded catalog. */
  tools: ClassifiedTool[];
  /** Whether the endpoint is known or conservatively assumed to be a portal. */
  isPortal: boolean;
  /** False when this catalog proves an absent tool name does not exist. */
  truncated: boolean;
};

/**
 * Returns the tools this binding may call and its endpoint kind, refreshing stale cached data.
 *
 * A changed catalog is adopted rather than pinned, since refusing to see new tools would break
 * working Gadgets, but the change is logged and a scoped binding cannot widen: a tool list is a set
 * of names and a server scope is a name prefix.
 */
export async function scopedCatalog(request: CatalogRequest): Promise<ScopedCatalog> {
  const cached = request.store.get<CachedCatalog>("catalog");
  let tools = cached?.tools;
  let truncated = cached?.truncated ?? false;

  if (!cached || Date.now() - cached.fetchedAt > CATALOG_TTL_MS) {
    try {
      const serverId = request.scope.serverId;
      const fetched = await fetchTools(
        request.env,
        request.account,
        request.endpoint,
        serverId ? tool => toolBelongsToServer(tool.name, serverId) : undefined,
        { deadline: request.deadline },
      );
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
  // A server-scoped grant can only be minted by the portal connector, and its filtered listing no
  // longer contains the `portal_list_servers` that `looksLikePortal` looks for. Deciding from the
  // scope first is what keeps the `portal_*` exclusion in force: without it, a `#server=portal`
  // grant would filter down to exactly the portal's own tools, find no evidence of a portal, and let
  // a Gadget call `portal_toggle_servers` to widen its own reach.
  const isPortal = request.scope.serverId !== undefined
    || looksLikePortal(all, { truncated, cap: MAX_TOOLS_PER_SERVER });
  return {
    isPortal,
    truncated,
    tools: all
      .filter(tool => scopeAllows(request.scope, tool.name, isPortal))
      .map(tool => classifyTool(tool, request.trust)),
  };
}

/**
 * Memory-only cache for definitions fetched beyond a binding's bounded catalog.
 *
 * Broad grants may cover tools past the catalog cut, so definitions and absences are remembered for
 * one TTL to avoid repeating a paginated lookup on every call.
 */
export class HydratedTools {
  // Insertion-ordered, which is what makes the eviction below the oldest entry.
  #entries = new Map<string, { fetchedAt: number; tool: McpTool | null; bytes: number }>();
  #loads = new Map<string, Promise<McpTool | undefined>>();
  #totalBytes = 0;

  /** Maximum definitions and remembered absences retained per facet activation. */
  static readonly MAX_ENTRIES = MAX_TOOLS_PER_SERVER;
  /** Aggregate retained definition budget per facet activation. */
  static readonly MAX_BYTES = 1024 * 1024;

  #fresh(name: string): { tool: McpTool | null } | undefined {
    const cached = this.#entries.get(name);
    if (!cached) return undefined;
    if (Date.now() - cached.fetchedAt > CATALOG_TTL_MS) {
      this.#entries.delete(name);
      this.#totalBytes -= cached.bytes;
      return undefined;
    }
    return cached;
  }

  #remember(name: string, tool: McpTool | null): void {
    const existing = this.#entries.get(name);
    if (existing) {
      this.#entries.delete(name);
      this.#totalBytes -= existing.bytes;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(tool)).byteLength;
    while (this.#entries.size >= HydratedTools.MAX_ENTRIES
        || this.#totalBytes + bytes > HydratedTools.MAX_BYTES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      const removed = this.#entries.get(oldest.value);
      this.#entries.delete(oldest.value);
      this.#totalBytes -= removed?.bytes ?? 0;
    }
    if (bytes > HydratedTools.MAX_BYTES) return;
    this.#entries.set(name, { fetchedAt: Date.now(), tool, bytes });
    this.#totalBytes += bytes;
  }

  #load(
    name: string,
    load: (name: string) => Promise<McpTool | undefined>,
  ): Promise<McpTool | undefined> {
    const existing = this.#loads.get(name);
    if (existing) return existing;
    if (this.#loads.size >= HydratedTools.MAX_ENTRIES) {
      throw new Error("Too many MCP tool definitions are already loading.");
    }

    const pending = load(name).then(loaded => {
      this.#remember(name, loaded ?? null);
      return loaded;
    }).finally(() => {
      if (this.#loads.get(name) === pending) this.#loads.delete(name);
    });
    this.#loads.set(name, pending);
    return pending;
  }

  /**
   * Returns the named tool, coalescing concurrent loads and caching a result for one TTL.
   *
   * `load` is expected to enforce the caller's scope: this cache is keyed by name alone and holds
   * whatever it is given, so it can neither widen nor narrow a grant. A failed load is not cached,
   * allowing a later call to recover from a transient endpoint failure.
   */
  async resolve(
    name: string,
    load: (name: string) => Promise<McpTool | undefined>,
  ): Promise<McpTool | undefined> {
    if (!isValidToolName(name)) return undefined;
    const cached = this.#fresh(name);
    if (cached) return cached.tool ?? undefined;
    return this.#load(name, load);
  }
}
