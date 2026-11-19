import type { ConfiguratorOption } from "./configurator-option";
export type { ConfiguratorOption };

export type GoogleGroupConfiguratorValues = {
  /** The chosen group's address, lowercase. */
  group?: string | null;
  /** `anyone` when the group takes mail from outside the organization; otherwise it doesn't. */
  senders?: string | null;
}

/** What a group's newest mail and its settings say about connecting it. */
export type GoogleGroupConfiguratorGroupCheck = {
  /**
   * `ready` when some of the newest mail can be shown, `empty` when none has reached the mailbox,
   * and `unverified` when it has but none can be shown, since none arrived in a way Google vouches
   * for.
   */
  mail: "ready" | "empty" | "unverified";
  /**
   * Whether the account is in the group directly, as its own lookup answers: `hidden` when the
   * group won't show it its members. A member's own account makes the same lookup once the gadget
   * is shared, so a group that hides its members from them admits none of them. `manager` when
   * the account manages or owns the group: its lookup succeeds whatever the group shows ordinary
   * members, so it says nothing of theirs.
   */
  membership: "member" | "manager" | "none" | "hidden";
};

/** The address checked is another address of the group at `aliasOf`, which is the one to connect it by. */
export type GoogleGroupConfiguratorAlias = { aliasOf: string };

export interface GoogleGroupConfiguratorRpc {
  /** Whether the account lets this app read its mail, which the group's mail is read from. */
  canReadMail(): Promise<boolean>;
  /**
   * The groups with a mailbox that the account belongs to directly, matching the search query, by
   * address. Rejects, in words to show, when Google won't list them.
   */
  listGroups(query: string): Promise<ConfiguratorOption[]>;
  /**
   * Whether mail sent to the group at `address` can be shown, and to its members, on a connection
   * that takes the group to receive mail from outside the organization or not. An address that is
   * only an alias of a group isn't checked: the answer names the group's main address instead.
   */
  checkGroup(address: string, outsideSenders: boolean):
    Promise<GoogleGroupConfiguratorGroupCheck | GoogleGroupConfiguratorAlias>;
}
