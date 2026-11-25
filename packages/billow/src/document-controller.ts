import type { BillowDocument, ItemRegistry } from "./types.js";
import { createUniqueId, defaultCreateId, getItemDefinition, normalizeDocument } from "./model.js";

export interface DocumentControllerSnapshot<Registry extends ItemRegistry> {
  readonly document: BillowDocument<Registry>;
  readonly reservedItemIds: ReadonlySet<string>;
}

/**
 * Owns the current document and the rules it must satisfy: normalized, every item type in the
 * registry, no duplicate IDs, and accepted by the user's `validateDocument`.
 *
 * It also tracks `reservedItemIds`: the IDs of every item that has been in the document since
 * history was last reset. An ID stays reserved after its item is deleted, so a newly created
 * item can never collide with one that undo brings back. New IDs come from `createUniqueId`,
 * which skips reserved ones. An ID is released only when the edit that created it is rejected
 * (`releaseId`), when history is reset (`resetIds`), or when a failed edit is rolled back
 * (`restore`).
 *
 * `snapshot`/`restore` let the editor roll a failed edit back (see `withRollback`).
 */
export class DocumentController<Registry extends ItemRegistry> {
  private currentDocument: BillowDocument<Registry>;
  private readonly reservedItemIds = new Set<string>();
  private readonly validateDocument: ((document: BillowDocument<Registry>) => boolean) | undefined;
  private readonly createId: () => string;

  constructor(
    private readonly registry: Registry,
    document: BillowDocument<Registry>,
    validateDocument?: (document: BillowDocument<Registry>) => boolean,
    createId: () => string = defaultCreateId,
  ) {
    this.validateDocument = validateDocument;
    this.createId = createId;
    this.currentDocument = this.normalize(document);
    this.assertValid(this.currentDocument);
    this.reserveIds(this.currentDocument);
  }

  get document(): BillowDocument<Registry> {
    return this.currentDocument;
  }

  set document(document: BillowDocument<Registry>) {
    this.currentDocument = document;
  }

  normalize(document: BillowDocument<Registry>): BillowDocument<Registry> {
    const normalized = normalizeDocument(document);
    this.validateItems(normalized);
    return normalized;
  }

  isValid(document: BillowDocument<Registry>): boolean {
    return this.validateDocument?.(document) ?? true;
  }

  assertValid(document: BillowDocument<Registry>): void {
    if (!this.isValid(document)) throw new TypeError("Document rejected by validateDocument");
  }

  validateItems(document: BillowDocument<Registry>): void {
    const ids = new Set<string>();
    for (const node of document) {
      if (typeof node === "string") continue;
      getItemDefinition(this.registry, node.itemType);
      if (ids.has(node.id)) throw new TypeError(`Duplicate item ID: ${node.id}`);
      ids.add(node.id);
    }
  }

  reserveIds(document: BillowDocument<Registry>): void {
    for (const node of document) {
      if (typeof node !== "string") this.reservedItemIds.add(node.id);
    }
  }

  resetIds(document: BillowDocument<Registry>): void {
    this.reservedItemIds.clear();
    this.reserveIds(document);
  }

  createUniqueId(): string {
    return createUniqueId(this.createId, this.reservedItemIds);
  }

  releaseId(id: string): void {
    this.reservedItemIds.delete(id);
  }

  snapshot(): DocumentControllerSnapshot<Registry> {
    return {
      document: this.currentDocument,
      reservedItemIds: new Set(this.reservedItemIds),
    };
  }

  restore(snapshot: DocumentControllerSnapshot<Registry>): void {
    this.currentDocument = snapshot.document;
    this.reservedItemIds.clear();
    for (const id of snapshot.reservedItemIds) this.reservedItemIds.add(id);
  }
}
