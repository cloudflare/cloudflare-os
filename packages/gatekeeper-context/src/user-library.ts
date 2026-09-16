// Per-account index of owned private collections. Public collections live in the domain registry/KV.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import {
  ContextCollectionSummary, ContextCollectionVisibility, OwnedCollectionRecord,
} from "./context-types.js";
import { listPublicCollectionsFromKv } from "./collection-kv.js";

type OwnedRecord = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  lastUpdated: Date;
};

function makeUserLibraryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      ownedCollections: collection<OwnedRecord>()({ primaryKey: "id" }),
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

  // --- Private collections (the user's own) ---

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

  /** Wipe this library after the caller deletes owned collection content. */
  async deleteAll(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  hasOwned(id: string): boolean {
    return !!this.storage.ownedCollections.get(id);
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

  // --- Enabled set (own private + every public collection) ---

  /**
   * Enabled collection visibility for the agent read path. Owned wins on overlap so private is never
   * downgraded to public.
   */
  async getEnabledCollections(domain: string): Promise<Map<string, ContextCollectionVisibility>> {
    let result = new Map<string, ContextCollectionVisibility>();
    for (let record of this.storage.ownedCollections.list()) result.set(record.id, "private");
    for (let entry of await listPublicCollectionsFromKv(this.env, domain)) {
      if (!result.has(entry.id)) result.set(entry.id, "public");
    }
    return result;
  }
}
