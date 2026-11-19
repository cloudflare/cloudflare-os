// Session API exposed to Gadgets/agents by the Acme Service gatekeeper.
//
// STOP(session-api): This is an invented interface over an invented provider. Design the real one
// from what gadgets need, not from the provider's endpoints (see the write-gatekeeper skill).
//
// Everything you can see is what the connected Acme Service user can see.

/** One Acme Service item. */
export interface AcmeItem {
  /** The item as it is now, including a change of yours still waiting for approval. */
  get(): Promise<AcmeItemInfo>;

  /** Renames the item. Needs the user's approval. */
  rename(title: string): Promise<void>;
}

export interface AcmeItemInfo {
  id: string;
  title: string;
  /** When the item last changed, as an ISO 8601 timestamp. */
  updatedAt: string;
  /** The item's page in Acme Service. */
  url: string;
}
