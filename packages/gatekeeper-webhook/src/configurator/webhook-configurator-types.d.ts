export type WebhookConfiguratorValues = {
  endpointId?: string | null;
  label?: string | null;
  endpointError?: string | null;
};

export interface WebhookConfiguratorRpc {
  getLabel(endpointId: string): Promise<string>;
  resourceUrl(
    endpointId: string | null | undefined,
    label: string | null | undefined,
  ): Promise<string>;
}
