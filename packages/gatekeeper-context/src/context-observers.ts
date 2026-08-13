import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";

/**
 * The non-standard method Context gatekeepers call on their own verifier. The overseer only passes
 * a verifier back to the vendor that minted it, so the gatekeeper may trust this result.
 */
export interface ContextVerifierApi extends GatekeeperUserVerifier {
  hasCollectionAccess(sharingDomain: string, collectionId: string): Promise<boolean>;
}

type ObserverKv = Pick<DurableObjectStorage["kv"], "get" | "put" | "delete" | "list">;

export type ContextObservationCheck = {
  excludeObservers?: string[];
  pendingCollections: string[];
  commit(): void;
};

type ObservedCollectionState = true | "pending" | "observed";

/**
 * Strategy C observer state for the broad Context Library singleton. Collections are the data sets:
 * public collections are domain-wide, while each private collection belongs to one account.
 */
export class ContextObserverTracker {
  constructor(private kv: ObserverKv, private sharingDomain: string) {}

  #observerKey(id: string): string { return `observer:${id}`; }
  #observedCollectionKey(collectionId: string): string {
    return `observedCollection:${collectionId}`;
  }

  #isCollectionObserved(collectionId: string): boolean {
    let state = this.#collectionState(collectionId);
    return state === true || state === "observed";
  }

  #collectionState(collectionId: string): ObservedCollectionState | undefined {
    return this.kv.get<ObservedCollectionState>(this.#observedCollectionKey(collectionId));
  }

  #listTrackedCollections(): string[] {
    let prefix = "observedCollection:";
    return [...this.kv.list<ObservedCollectionState>({ prefix })]
        .map(([key]) => key.slice(prefix.length));
  }

  *#listObservers(): IterableIterator<[string, Fetcher<ContextVerifierApi>]> {
    let prefix = "observer:";
    for (let [key, verifier] of this.kv.list<Fetcher<ContextVerifierApi>>({ prefix })) {
      yield [key.slice(prefix.length), verifier];
    }
  }

  async addObserver(id: string, verifier: Fetcher<ContextVerifierApi>): Promise<void> {
    let checked = new Set<string>();
    while (true) {
      let collections = this.#listTrackedCollections()
          .filter(collectionId => !checked.has(collectionId));
      if (collections.length === 0) {
        this.kv.put(this.#observerKey(id), verifier);
        return;
      }
      let access = await Promise.all(collections.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      if (access.some(hasAccess => !hasAccess)) {
        throw new Error(
          "This collaborator does not have access to a Context collection whose data this workspace " +
          "has read, so they cannot be allowed to observe it.",
        );
      }
      for (let collectionId of collections) checked.add(collectionId);
    }
  }

  removeObserver(id: string): void {
    this.kv.delete(this.#observerKey(id));
  }

  async prepareObservation(collectionIds: string[]): Promise<ContextObservationCheck> {
    let pendingCollections = [...new Set(collectionIds)]
        .filter(collectionId => !this.#isCollectionObserved(collectionId));
    if (pendingCollections.length === 0) return { pendingCollections, commit() {} };

    for (let collectionId of pendingCollections) {
      if (this.#collectionState(collectionId) === undefined) {
        this.kv.put(this.#observedCollectionKey(collectionId), "pending");
      }
    }

    let observerAccess = await Promise.all([...this.#listObservers()].map(async ([id, verifier]) => {
      let access = await Promise.all(pendingCollections.map(
        collectionId => verifier.hasCollectionAccess(this.sharingDomain, collectionId),
      ));
      return [id, access.every(hasAccess => hasAccess)] as const;
    }));
    let excluded = observerAccess.filter(([, hasAccess]) => !hasAccess).map(([id]) => id);
    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      pendingCollections,
      commit: () => this.commitObservation(pendingCollections),
    };
  }

  commitObservation(pendingCollections: string[]): void {
    for (let collectionId of pendingCollections) {
      this.kv.put(this.#observedCollectionKey(collectionId), "observed");
    }
  }
}
