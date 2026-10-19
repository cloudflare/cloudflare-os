// Agent read path over the account's library. Every returned result is authorized as an observation;
// results revealing collection contents are attributed to those collections for observer checks.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { ObservationGate, ObservationInput } from "@gadgets/gatekeeper-kit/observers";
import {
  ContextSearchResult, ContextListing, ContextListingEntry, ContextReadResult,
  decodeDocId, encodeDocId, isTextContentType, VENDOR_ID,
  type ContextLibrary,
} from "./context-types.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import { listPublicCollectionsFromKv } from "./collection-kv.js";
import { MAX_COLLECTION_FANOUT, mapWithConcurrency } from "./concurrency.js";
import { domainName } from "./domain.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

@validateRpc()
export class LibraryReadSession extends RpcTarget implements ContextLibrary {
  // Cache public discovery, not existence: every use checks that each collection is still public
  // and live. Private membership is never cached, so existing sessions honor revocations and new
  // shares made after they started.
  #publicIds?: Promise<string[]>;

  constructor(
    private env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private domain: string,
    private accountId: string,
    private gate: ObservationGate,
  ) {
    super();
  }

  /** Release the authorizer owned by this read session's gate. */
  [Symbol.dispose](): void {
    this.gate[Symbol.dispose]();
  }

  #collection(id: string): DurableObjectStub<ContextCollectionDurableObject> {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib(): DurableObjectStub<UserLibraryDurableObject> {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #discoveredPublicIds(): Promise<string[]> {
    return this.#publicIds ??= listPublicCollectionsFromKv(this.env, this.domain).then(
      entries => entries.map(entry => entry.id),
      (err: unknown) => {
        // Not cached, so the next call tries again.
        this.#publicIds = undefined;
        throw err;
      });
  }

  async #isLivePublic(collectionId: string): Promise<boolean> {
    let access = await this.#collection(collectionId).getAccess(this.accountId);
    return access.exists && access.visibility === "public";
  }

  // Private collections first, as the library lists them.
  async #libraryIds(): Promise<string[]> {
    let [privateCollections, discovered] = await Promise.all([
      this.#userLib().listPrivateLibrary(this.domain, this.accountId),
      this.#discoveredPublicIds(),
    ]);
    let live = await mapWithConcurrency(discovered, MAX_COLLECTION_FANOUT, async id => {
      try {
        return await this.#isLivePublic(id) ? id : null;
      } catch (err) {
        logger.warn("failed to check public collection access", {
          event: "collection.access.check.failed", collectionId: id, error: err,
        });
        return null;
      }
    });
    let publicIds = live.filter(id => id !== null);
    return [...new Set([...privateCollections.map(collection => collection.id), ...publicIds])];
  }

  async #inLibrary(collectionId: string): Promise<boolean> {
    return await this.#userLib().hasPrivateLibraryCollection(this.domain, this.accountId, collectionId)
      || ((await this.#discoveredPublicIds()).includes(collectionId) && await this.#isLivePublic(collectionId));
  }

  // A read revealing no collection contents is authorized against the admission baseline, so it
  // does not constrain who may observe the workspace.
  #authorize(collectionIds: string[], description: ObservationInput): Promise<void> {
    return this.gate.authorize(description, collectionIds.length > 0
      ? { kind: "collections", ids: collectionIds }
      : { kind: "baseline" });
  }

  async search(query: string, opts?: {
    collectionId?: string;
    limit?: number;
  }): Promise<ContextSearchResult[]> {
    let limit = opts?.limit ?? 20;

    let targetIds: string[];
    if (opts?.collectionId) {
      if (!await this.#inLibrary(opts.collectionId)) return [];
      targetIds = [opts.collectionId];
    } else {
      targetIds = await this.#libraryIds();
    }

    let perCollection = await mapWithConcurrency(targetIds, MAX_COLLECTION_FANOUT, async (collectionId) => {
      try {
        let hits = await this.#collection(collectionId).search(query, limit);
        return hits.map((r): ContextSearchResult => ({
          docId: encodeDocId(collectionId, r.path),
          collectionId,
          title: r.name,
          path: r.path,
          description: r.description,
          snippet: r.snippet,
          score: r.score,
        }));
      } catch (err) {
        logger.warn("failed to search collection", {
          event: "collection.search.failed", collectionId, error: err,
        });
        return [];
      }
    });

    let results = perCollection.flat();
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    results = results.slice(0, limit);

    // Nothing matched → nothing was observed, so don't record an observation (mirrors read()).
    if (results.length === 0) return results;
    let collectionIds = [...new Set(results.map(r => r.collectionId).filter((id): id is string => !!id))];
    // Authorize after fetching, before returning data.
    await this.#authorize(collectionIds, {
      title: `Context search: ${query}`,
      description:
        `Searched the Context Library for \`${query}\`. Returned ${results.length} result(s)` +
        (collectionIds.length ? ` across ${collectionIds.length} collection(s).` : "."),
    });
    return results;
  }

  async list(opts?: {
    collectionId?: string;
    path?: string;
  }): Promise<ContextListing> {
    let listing = await this.#fetchListing(opts);
    // Nothing listed → nothing was observed, so don't record an observation (mirrors read()).
    if (listing.entries.length === 0) return listing;
    // Collection titles, descriptions, and counts are discovery metadata the agent catalog already
    // advertises unobserved, so only drilling into a collection attributes the read to it.
    let collectionIds = opts?.collectionId ? [opts.collectionId] : [];
    await this.#authorize(collectionIds, {
      title: opts?.collectionId
        ? `Context listing: ${opts.collectionId}${opts.path ? "/" + opts.path : ""}`
        : "Context listing: collections",
      description: opts?.collectionId
        ? `Listed contents of Context Library collection \`${opts.collectionId}\`.`
        : "Listed the user's Context Library collections.",
    });
    return listing;
  }

  async read(docId: string): Promise<ContextReadResult | null> {
    let decoded = decodeDocId(docId);
    // Malformed ids are "not found", not RPC errors.
    if (!decoded) return null;
    let { collectionId, path } = decoded;

    if (!await this.#inLibrary(collectionId)) return null;

    let doc = await this.#collection(collectionId).getContextDocument(path);
    // No document found (missing or inaccessible) → nothing was observed, so don't record one.
    if (!doc) return null;

    await this.#authorize([collectionId], {
      title: `Context read: ${doc.name}`,
      description: `Read Context Library document \`${docId}\`.`,
    });

    let content = isTextContentType(doc.contentType)
      ? doc.body
      : `data:${doc.contentType};base64,${doc.body}`;
    return {
      docId,
      title: doc.name,
      path: doc.path,
      description: doc.description,
      content,
    };
  }

  // Fetch without recording; list() authorizes.
  async #fetchListing(opts?: { collectionId?: string; path?: string }): Promise<ContextListing> {
    if (!opts?.collectionId) {
      let libraryIds = await this.#libraryIds();
      let collectionEntries = await mapWithConcurrency(libraryIds, MAX_COLLECTION_FANOUT,
        async (collectionId): Promise<ContextListingEntry | null> => {
          try {
            let meta = await this.#collection(collectionId).getMetadata();
            return {
              type: "collection",
              id: collectionId,
              title: meta.title,
              description: meta.description,
              documentCount: meta.documentCount,
            };
          } catch (err) {
            logger.warn("failed to list collection", {
              event: "collection.list.failed", collectionId, error: err,
            });
            return null;
          }
        });
      return { entries: collectionEntries.filter((e): e is ContextListingEntry => e !== null) };
    }

    if (!await this.#inLibrary(opts.collectionId)) {
      return { collectionId: opts.collectionId, entries: [] };
    }

    let pathPrefix = opts.path ? opts.path + "/" : "";
    let docs = await this.#collection(opts.collectionId).listContextDocuments(pathPrefix || undefined);

    let entries: ContextListingEntry[] = [];
    let seenDirs = new Set<string>();
    for (let doc of docs) {
      let relativePath = doc.path.slice(pathPrefix.length);
      let slashIdx = relativePath.indexOf("/");
      if (slashIdx >= 0) {
        let dirName = relativePath.slice(0, slashIdx);
        let dirPath = pathPrefix + dirName;
        if (!seenDirs.has(dirPath)) {
          seenDirs.add(dirPath);
          entries.push({ type: "directory", path: dirPath, name: dirName });
        }
      } else {
        entries.push({
          type: "document",
          docId: encodeDocId(opts.collectionId, doc.path),
          path: doc.path,
          name: doc.name,
          description: doc.description,
          contentType: doc.contentType,
        });
      }
    }

    return { collectionId: opts.collectionId, path: opts.path, entries };
  }
}
