// Per-account library: the collections this account created, those shared with it, and (from the
// domain registry/KV) every public one. Index entries are discovery only; each listing asks the
// collection itself whether the account still holds a role on it.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionSummary, EnabledCollectionInfo, OwnedCollectionRecord,
} from "./context-types.js";
import { listPublicCollectionsFromKv } from "./collection-kv.js";
import { domainName } from "./domain.js";

type OwnedRecord = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  lastUpdated: Date;
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
    singletons: {},
  });
}

export class UserLibraryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeUserLibraryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeUserLibraryStorage(ctx.storage);
  }

  // --- Collections this account created ---

  createOwnedCollection(id: string, title: string, description: string, icon?: string): void {
    this.storage.ownedCollections.put({ id, title, description, icon, lastUpdated: new Date() });
  }

  /** Refresh the denormalized owned record. */
  updateOwnedCollection(id: string, summary: ContextCollectionSummary): void {
    let record = this.storage.ownedCollections.get(id);
    if (record) {
      record.title = summary.title;
      record.description = summary.description;
      record.icon = summary.icon;
      record.lastUpdated = summary.lastUpdated;
      this.storage.ownedCollections.put(record);
    }
  }

  removeOwnedCollection(id: string): void {
    this.storage.ownedCollections.delete(id);
  }

  listOwnedCollections(): OwnedCollectionRecord[] {
    let result = [...this.storage.ownedCollections.list()].map(r => ({
      id: r.id,
      title: r.title,
      description: r.description,
      icon: r.icon,
      lastUpdated: r.lastUpdated,
    }));
    result.sort((a, b) => b.lastUpdated.valueOf() - a.lastUpdated.valueOf());
    return result;
  }

  // --- Collections shared with this account ---

  /** Idempotent, so a share that failed after this write can simply be repeated. */
  addSharedCollection(id: string): void {
    if (!this.storage.sharedCollections.get(id)) {
      this.storage.sharedCollections.put({ id, addedAt: new Date() });
    }
  }

  /** Drop every index entry for a collection this account no longer holds a role on. */
  forgetCollection(id: string): void {
    this.storage.sharedCollections.delete(id);
    this.storage.ownedCollections.delete(id);
  }

  /** Every collection ID in either index: the private collections this account may hold a role on. */
  listIndexedCollectionIds(): string[] {
    let ids = new Set<string>();
    for (let record of this.storage.ownedCollections.list()) ids.add(record.id);
    for (let record of this.storage.sharedCollections.list()) ids.add(record.id);
    return [...ids];
  }

  /** Wipe this library after the caller removes the account from its collections. */
  async deleteAll(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // --- The library as agents and the management UI see it ---

  /**
   * The account's library, checked live against each private collection: an entry the account no
   * longer holds a role on, or whose collection was deleted, is left out.
   */
  async listLibrary(domain: string, accountId: string): Promise<EnabledCollectionInfo[]> {
    let [privateCollections, publicCollections] = await Promise.all([
      Promise.all(this.listIndexedCollectionIds().map(id => this.#privateEntry(domain, accountId, id))),
      listPublicCollectionsFromKv(this.env, domain),
    ]);
    let result: EnabledCollectionInfo[] = [];
    let seen = new Set<string>();
    for (let entry of privateCollections) {
      if (!entry) continue;
      seen.add(entry.id);
      result.push(entry);
    }
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

  /** Whether one collection is in the account's library, checked as `listLibrary` checks it. */
  async hasLibraryCollection(domain: string, accountId: string, id: string): Promise<boolean> {
    if (this.storage.sharedCollections.get(id) || this.storage.ownedCollections.get(id)) {
      return !!await this.#privateEntry(domain, accountId, id);
    }
    return (await listPublicCollectionsFromKv(this.env, domain)).some(entry => entry.id === id);
  }

  async #privateEntry(
      domain: string, accountId: string, id: string): Promise<EnabledCollectionInfo | null> {
    let collections = this.ctx.exports.ContextCollectionDurableObject;
    let entry = await collections.get(collections.idFromName(domainName(domain, id)))
        .getLibraryEntry(accountId);
    if (!entry) return null;
    let { metadata, access } = entry;
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
