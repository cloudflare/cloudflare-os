export type ChatAccountConfiguratorValues = {
  scope?: string | null;
};

/** The whole-account Chat resource needs nothing chosen; the iframe only checks the account's grant. */
export interface ChatAccountConfiguratorRpc {
  /**
   * Whether the account's Google consent still covers everything the resource needs, which starting
   * a conversation does. An account granted before the resource gained a scope, or that declined
   * one, doesn't, though the Workshop may still list the resource as granted.
   */
  canStartConversations(): Promise<boolean>;
}
