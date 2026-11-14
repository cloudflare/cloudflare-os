import type { DriveNode, DriveNodePage } from "./drive-configurator-types";

export type CreationLocationConfiguratorValues = {
  /** The chosen folder, by its {@link DriveNode} id: `folder:root` for My Drive. */
  folder?: string | null;
  /**
   * The folder the agent that asked for the creation suggested, so the picker can say so, or null
   * when what it suggested names none this account can add files to.
   */
  suggested?: string | null;
};

export interface CreationLocationConfiguratorRpc {
  /**
   * One page of the folders at a location (`folder:root` for My Drive, `shared-drives`,
   * `shared-with-me`, or a folder), or, when `query` is not empty, of every folder anywhere whose
   * name contains it. Each says whether this account can put files in it.
   */
  listFolders(parentId: string, query: string, cursor: string | null): Promise<DriveNodePage>;
  /** The folder `id` names, with its path, or null if this account cannot see it or it is not a folder. */
  getFolder(id: string): Promise<DriveNode | null>;
  /**
   * The id of the folder, or My Drive, that a Drive link names, as a browser shows it or as
   * `resourceUrl()` mints it, or null if it names none this account can add files to.
   */
  folderForUrl(url: string): Promise<string | null>;
  /** Whether the account holds the grant that putting a creation in a folder needs; asked again after a consent pop-up. */
  hasCreationAccess(): Promise<boolean>;
}
