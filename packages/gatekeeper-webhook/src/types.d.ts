/** A normalized inbound webhook delivery. */
export interface WebhookEvent {
  /** Stable across retries only when the sender supplies `Idempotency-Key`; otherwise unique. */
  id: string;
  /** Time the gatekeeper accepted the delivery, in ISO 8601 format. */
  timestamp: string;
  /** The complete JSON document sent by the webhook caller. */
  payload: unknown;
}

/**
 * Persistent callback implemented by a Gadget. Delivery is at least once: if callback work takes
 * effect but its reply is lost, the sender may retry with the same event ID.
 */
export interface WebhookHook {
  onWebhook(event: WebhookEvent): Promise<void>;
}

/** Options for the authentication header sent by a webhook provider. */
export interface WebhookCredentialOptions {
  /** Header carrying the secret. Defaults to `Authorization`. */
  headerName?: string;
  /** Text prepended to the generated secret. Defaults to `Bearer ` for Authorization, otherwise empty. */
  valuePrefix?: string;
}

/** Newly-issued credentials for configuring a webhook sender. */
export interface WebhookCredential {
  /** HTTP endpoint to which the sender should POST JSON. */
  url: string;
  /** Name of the HTTP header that carries the credential. */
  headerName: string;
  /** Complete one-time header value, including any configured prefix. */
  headerValue: string;
}

/**
 * Capability for an HTTP webhook endpoint.
 *
 * `subscribe()` registers a disabled hook. The user must enable it in Connections before requests
 * can invoke the callback. Make callback effects idempotent using `event.id`; delivery is at least
 * once when a sender retries with an `Idempotency-Key`.
 */
export interface WebhookSession {
  /**
   * Subscribes to inbound webhook deliveries.
   *
   * The hook remains disabled until the user enables it in Connections.
   * @param callback A persistent `WebhookHook` stub.
   */
  subscribe(callback: RpcStub<WebhookHook>): Promise<void>;
  /** Returns the HTTP endpoint to which callers should POST JSON. */
  getTriggerUrl(): Promise<string>;
  /**
   * Issues or rotates this endpoint's credential. Rotation invalidates the previous value.
   * Each returned header value is shown only once. Pass it directly to the sender or its provider
   * gatekeeper; do not log it, display it in agent output, or persist it in Gadget storage.
   */
  issueCredential(options?: WebhookCredentialOptions): Promise<WebhookCredential>;
}
