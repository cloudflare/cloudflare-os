export type XConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type XListConfiguratorValues = {
  /**
   * The chosen List's ID. Named after the `:listId` group of the resource URL pattern, so the
   * runtime pre-fills it from a known resource URL.
   */
  listId?: string | null;
};

export interface XListConfiguratorRpc {
  /**
   * The connected account's own Lists matching `query` by name, or, for a pasted List link or ID,
   * that List. Options' `value` is the List ID.
   */
  listLists(query: string): Promise<XConfiguratorOption[]>;
}
