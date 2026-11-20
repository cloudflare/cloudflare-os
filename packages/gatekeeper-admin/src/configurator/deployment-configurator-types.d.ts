export type DeploymentConfiguratorValues = {
  /**
   * No user-selectable values: the account has one resource, the deployment. A placeholder field
   * gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface DeploymentConfiguratorRpc {
  /** Returns the URL of the account's one resource. */
  resourceUrl(): Promise<string>;
}
