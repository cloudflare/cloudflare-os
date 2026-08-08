export type WebhookEndpointConfiguratorValues = {
  title?: string | null;
  description?: string | null;
  /** Comma-separated upper-case HTTP methods; empty means the default, POST only. */
  methods?: string | null;
};

export interface WebhookEndpointConfiguratorRpc {
  /** Creates the endpoint and returns its URL. No token is issued here. */
  createEndpoint(title: string, description: string, methods?: string): Promise<string>;
}
