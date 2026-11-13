import type { DriveNodePage } from "./drive-configurator-types";

export type CreationLocationConfiguratorValues = {
  /** The chosen folder, by its {@link DriveNode} id: `folder:root` for My Drive. */
  folder?: string | null;
};

export interface CreationLocationConfiguratorRpc {
  /**
   * One page of the folders at a location (`folder:root` for My Drive, `shared-drives`,
   * `shared-with-me`, or a folder), or, when `query` is not empty, of every folder anywhere whose
   * name contains it. Each says whether this account can put files in it.
   */
  listFolders(parentId: string, query: string, cursor: string | null): Promise<DriveNodePage>;
  /** Whether the account holds the grant that putting a creation in a folder needs; asked again after a consent pop-up. */
  hasCreationAccess(): Promise<boolean>;
}
