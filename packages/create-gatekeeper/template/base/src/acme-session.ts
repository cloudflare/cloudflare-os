// The capability a gadget holds for one item. A read asks the provider, reports what it depends
// on, and only then returns; a change is staged for the user's approval and never made here.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { AcmeAction, AcmeActions } from "./acme-actions";
import type { Rest, WireItem } from "./acme-api";
import { itemSubresourceId } from "./acme-resources";
// #if hooks
import type { AcmeEventHookTarget } from "./acme-hooks";
// #endif
import { itemUrl } from "./acme-urls";
import type { AcmeItem, AcmeItemInfo } from "./types";

/** What a session may ask of the gatekeeper Durable Object that minted it. */
export type SessionHost = {
  /** Runs a read as the connected user; safe to repeat with a refreshed credential. */
  read<T>(op: (api: Rest) => Promise<T>): Promise<T>;
  /** The actions still waiting for a decision, oldest first. */
  pending(): AcmeAction[];
  /** Stages an action for the user's approval. */
  submit<K extends keyof AcmeActions>(queue: RpcStub<ApprovalQueue>, kind: K, payload: AcmeActions[K]): Promise<void>;
  // #if hooks
  /** Asks the user to approve a hook on the binding's item. */
  subscribe(queue: RpcStub<ApprovalQueue>, hook: RpcStub<AcmeEventHookTarget>): Promise<void>;
  // #endif
};

/**
 * Authorizes a read. Every read goes through here, which requires the `subresources` the shared
 * type leaves optional: a read that names none adds no requirement.
 */
export async function authorizeRead(
  queue: RpcStub<ApprovalQueue>, description: ObservationDescription & { subresources: string[] },
): Promise<void> {
  await queue.authorizeObservation(description);
}

/** An item as gadgets see it. */
export function toItem(wire: WireItem): AcmeItemInfo {
  return { id: wire.id, title: wire.title, updatedAt: wire.updated_at, url: itemUrl(wire.id) };
}

@validateRpc()
export class AcmeItemImpl extends RpcTarget implements AcmeItem {
  readonly #host: SessionHost;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #itemId: string;

  constructor(host: SessionHost, queue: RpcStub<ApprovalQueue>, itemId: string) {
    super();
    this.#host = host;
    this.#queue = queue;
    this.#itemId = itemId;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  async get(): Promise<AcmeItemInfo> {
    // What is waiting, taken before the read: a rename approved while the item is read or
    // authorized leaves the journal, and would show in neither. One applied before the read is
    // laid over its own result, which changes nothing.
    const pending = this.#host.pending();
    const wire = await this.#host.read(api => api.get("/items/{id}", { path: { id: this.#itemId } }));
    // Authorized after the read and before anything is returned, with every dependency named.
    await authorizeRead(this.#queue, {
      title: "Read the Acme Service item",
      description: `Read item ${this.#itemId}.`,
      subresources: [itemSubresourceId(this.#itemId)],
    });
    // A rename still waiting for approval shows, since its action goes on with a simulated result.
    let item = toItem(wire);
    for (const { kind, payload } of pending) {
      if (kind === "rename" && payload.itemId === this.#itemId) {
        item = { ...item, title: payload.title, updatedAt: payload.stagedAt };
      }
    }
    return item;
  }

  async rename(title: string): Promise<void> {
    if (title.trim() === "") throw new Error("title must be a non-empty string.");
    // Nothing read here is returned to the caller, so nothing is reported as an observation.
    await this.#host.submit(this.#queue, "rename", { itemId: this.#itemId, title, stagedAt: new Date().toISOString() });
  }
  // #if hooks

  async subscribe(hook: RpcStub<AcmeEventHookTarget>): Promise<void> {
    // The hook is not stored here: it is bound to this session, and the overseer hands it back,
    // bound to a new one, for each delivery.
    await this.#host.subscribe(this.#queue, hook);
  }
  // #endif
}
