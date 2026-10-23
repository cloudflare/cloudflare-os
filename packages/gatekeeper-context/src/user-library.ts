// Per-account library: the collections this account created, those shared with it, and (from the
// domain registry/KV) every public one. Index entries are discovery only; each listing asks the
// collection itself whether the account still holds a role on it.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { EnabledCollectionInfo, VENDOR_ID } from "./context-types.js";
import { listPublicCollectionsFromKv } from "./collection-kv.js";
import { MAX_COLLECTION_FANOUT, mapWithConcurrency } from "./concurrency.js";
import { domainName } from "./domain.js";
import { obsContext } from "./observability.js";

const logger = obsContext.createLogger({
  component: "gatekeeper.context", vendorId: VENDOR_ID,
});

// Records written before sharing also carry a title, description, icon and lastUpdated, which
// nothing reads: listings take metadata live from the collection.
type OwnedRecord = {
  id: string;
};

type SharedRecord = {
  id: string;
  addedAt: Date;
};

function makeUserLibraryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      ownedCollections: collection<OwnedRecord>()({ primaryKey: "id" }),
      sharedCollections: collection<SharedRecord>()({ primaryKey: "id" }),
    },
    singletons: {
      // Set once the account starts disconnecting, and kept after its index is wiped, so a share
      // racing the disconnect can't index a collection the disconnect will never visit.
      disconnected: false,
    },
  });
}

export class UserLibraryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeUserLibraryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeUserLibraryStorage(ctx.storage);
  }

  #assertConnected(): void {
    if (this.storage.disconnected.get()) {
      throw new Error("This person's Skills account was disconnected.");
    }
  }

  // --- Collections this account created ---

  createOwnedCollection(id: string): void {
    this.#assertConnected();
    this.storage.ownedCollections.put({ id });
  }

  removeOwnedCollection(id: string): void {
    this.storage.ownedCollections.delete(id);
  }

  // --- Collections shared with this account ---

  /** Idempotent, so a share that failed after this write can simply be repeated. */
  addSharedCollection(id: string): void {
    this.#assertConnected();
    if (!this.storage.sharedCollections.get(id)) {
      this.storage.sharedCollections.put({ id, addedAt: new Date() });
    }
  }

  /** Drop every index entry for a collection this account no longer holds a role on. */
  forgetCollection(id: string): void {
    this.storage.sharedCollections.delete(id);
    this.storage.ownedCollections.delete(id);
  }

  // --- Disconnection ---

  /**
   * Refuse every later share, then return every collection ID in either index: the private
   * collections this account may hold a role on. In one step, so a share either lands in the
   * returned list or is refused.
   */
  beginDisconnect(): string[] {
    this.storage.disconnected.put(true);
    return this.#indexedCollectionIds();
  }

  /** Wipe this library once the account has been removed from its collections. */
  async finishDisconnect(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.storage.disconnected.put(true);
  }

  #indexedCollectionIds(): string[] {
    let ids = new Set<string>();
    for (let record of this.storage.ownedCollections.list()) ids.add(record.id);
    for (let record of this.storage.sharedCollections.list()) ids.add(record.id);
    return [...ids];
  }

  // --- The library as agents and the management UI see it ---

  /** The account's library: its private collections, checked live, then every public one. */
  async listLibrary(domain: string, accountId: string): Promise<EnabledCollectionInfo[]> {
    let [privateCollections, publicCollections] = await Promise.all([
      this.listPrivateLibrary(domain, accountId),
      listPublicCollectionsFromKv(this.env, domain),
    ]);
    let seen = new Set(privateCollections.map(entry => entry.id));
    let result = [...privateCollections];
    for (let entry of publicCollections) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      result.push({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        icon: entry.icon,
        source: "public",
        lastUpdated: entry.lastUpdated,
      });
    }
    return result;
  }

  /**
   * The private collections the account holds a role on, checked live against each collection.
   * Entries it no longer holds a role on are left out, and those whose collection is gone are
   * forgotten. A collection that can't be reached is left out of this listing only.
   */
  async listPrivateLibrary(domain: string, accountId: string): Promise<EnabledCollectionInfo[]> {
    let entries = await mapWithConcurrency(this.#indexedCollectionIds(), MAX_COLLECTION_FANOUT,
      id => this.#privateEntry(domain, accountId, id));
    return entries.filter(entry => entry !== null);
  }

  /** Whether one private collection is in the account's library, checked as listings check it. */
  async hasPrivateLibraryCollection(domain: string, accountId: string, id: string): Promise<boolean> {
    if (!this.storage.sharedCollections.get(id) && !this.storage.ownedCollections.get(id)) {
      return false;
    }
    return !!await this.#privateEntry(domain, accountId, id);
  }

  async #privateEntry(
      domain: string, accountId: string, id: string): Promise<EnabledCollectionInfo | null> {
    let collections = this.ctx.exports.ContextCollectionDurableObject;
    let entry;
    try {
      entry = await collections.get(collections.idFromName(domainName(domain, id)))
          .getLibraryEntry(accountId);
    } catch (err) {
      logger.warn("failed to check a library collection", {
        event: "library.collection.check.failed", collectionId: id, error: err,
      });
      return null;
    }
    let { access, metadata } = entry;
    // Collection IDs are never reused, so one that is gone stays gone.
    if (!access.exists) this.forgetCollection(id);
    if (!metadata) return null;
    return {
      id,
      title: metadata.title,
      description: metadata.description,
      icon: metadata.icon,
      source: "private",
      lastUpdated: metadata.lastUpdated,
      membership: { role: access.role!, shared: access.shared },
    };
  }
}
