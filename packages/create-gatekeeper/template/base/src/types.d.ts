// #if hooks
import type { RpcStub } from "cloudflare:workers";

// #endif
// Session API exposed to Gadgets/agents by the Acme Service gatekeeper.
//
// STOP(session-api): This is an invented interface over an invented provider. Design the real one
// from what gadgets need, not from the provider's endpoints (see the write-gatekeeper skill).
//
// Everything you can see is what the connected Acme Service user can see.

/** One Acme Service item. */
export interface AcmeItem {
  /** The item as it is now. */
  get(): Promise<AcmeItemInfo>;

  /** Renames the item. `get()` returns the new title from then on. Throws if `title` is blank. */
  rename(title: string): Promise<void>;
  // #if hooks

  /**
   * Have `hook.receiveEvent()` called each time the item changes, whoever changed it. The hook
   * starts disabled, and nothing is delivered until the user enables it. Every call creates a
   * distinct hook. Throws if this deployment has not configured Acme Service hooks.
   *
   * `hook` must be a persistent stub that restores through a Gadget's `[restore]()` method: inside
   * the Gadget, create it with `this.ctx.restore(params)`.
   */
  subscribe(hook: RpcStub<AcmeEventHook>): Promise<void>;
  // #endif
}
// #if hooks

/** What a gadget implements to receive events; see `AcmeItem.subscribe()`. */
export interface AcmeEventHook {
  receiveEvent(event: AcmeEvent): Promise<void>;
}

export interface AcmeEvent {
  /** Unique to the event; a delivery that is retried repeats it. */
  id: string;
  kind: "updated";
  /** When it happened, as an ISO 8601 timestamp. */
  occurredAt: string;
  /** The item as it is now. */
  item: AcmeItemInfo;
}
// #endif

export interface AcmeItemInfo {
  id: string;
  title: string;
  /** When the item last changed, as an ISO 8601 timestamp. */
  updatedAt: string;
  /** The item's page in Acme Service. */
  url: string;
}
