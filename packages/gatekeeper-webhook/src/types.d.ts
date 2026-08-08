// Webhooks gives a workspace inbound HTTP endpoints that third-party services can POST to. Each
// endpoint has its own public URL and its own bearer token; a delivery wakes a persistent callback
// in this workspace with the request's headers, query, and body.
//
// The capability is scoped to the current workspace: endpoints registered here are only ever
// delivered here, and `list()` never crosses workspace boundaries, even though endpoints are
// coordinated per account.
//
// Registration creates a *disabled* hook. The user must enable it in Connections before the URL
// accepts deliveries. Until then the endpoint answers `503`. Tell the user this after registering —
// it is the single most common reason a new webhook "does nothing".
//
// The bearer token is returned exactly once, by the call that mints it (`register()` and
// `rotateToken()`). It is stored only as a hash, so it cannot be read back afterwards. Give it to
// the user immediately and tell them to paste it into the third-party service; if it is lost, call
// `rotateToken()` for a new one.
//
// A typical registration looks like this:
//
//     const callback = await ctx.restore({ type: "webhook" });
//     const endpoint = await WEBHOOKS.register(callback, {
//       title: "Stripe payment events",
//       description: "Receives Stripe payment_intent events and files them in the ledger gadget.",
//     });
//     // endpoint.url and endpoint.token go to the user. The token is not retrievable later.
//
// About `ctx.restore()`, which is the step registrations most often get stuck on:
//
//   - **A gadget must exist first.** `ctx.restore()` called from `executeCode` returns a stub
//     pointing at a *gadget's* persistent code, so create the gadget and write its `onWebhook`
//     before registering. With no gadget in the workspace, restoration fails outright.
//   - **You do not name the gadget.** The params carry your own tag (`{ type: "webhook" }`), not a
//     gadget id; the workspace resolves the target itself — its default gadget, or its only one.
//     There is no `gadget` field to pass and no per-gadget `restore` method to call instead.
//   - **Call it from `executeCode`, not from inside a gadget method invoked over RPC.**
//
// The gadget's persistent code implements `WebhookHook.onWebhook()`. What it does with an event is
// up to the gadget: file the payload, update state, or spawn an agent chat through an agent-spawner
// binding when the event needs judgment rather than a fixed transformation.
//
// Spawning an agent per delivery is the common case for alerts and anything else needing judgment.
// Note that an agent-spawner binding cannot be created from agent code — a human creates it once in
// the workspace's Connections panel ("Connect resource" -> "Agent"), choosing the model and the
// bindings spawned agents may use. Once it exists, `onWebhook` just calls `spawn(title, prompt)` on
// it. If the user asks you to set up webhook-driven agents and no spawner binding is bound yet, say
// so and ask them to add one; do not hunt for an API to create it.

/** A single inbound HTTP request delivered to a workspace callback. */
export type WebhookEvent = {
  /**
   * Stable ID for this delivery, unchanged across retries. Use it as an idempotency key: delivery
   * is at-least-once, so the same event can arrive more than once.
   */
  deliveryId: string;
  /** The endpoint that received the request, as returned by `register()`. */
  endpointId: string;
  /** Unix epoch milliseconds when the request was accepted, fixed across retries. */
  receivedAt: number;
  /** 1 on the first delivery attempt, incrementing on each retry of the same `deliveryId`. */
  attempt: number;
  /** The request's HTTP method, upper-case (`POST`, `PUT`, ...). */
  method: string;
  /**
   * Any extra path after the endpoint's own URL, always starting with `/`, or `""` when the request
   * hit the endpoint URL exactly. Services that append a subpath (`.../e/<id>/payments`) are
   * distinguishable here without registering a second endpoint.
   */
  subPath: string;
  /** Decoded query-string parameters. Repeated keys keep the last value. */
  query: Record<string, string>;
  /**
   * Request headers, lower-cased. Credentials are stripped before delivery: `authorization`,
   * `cookie`, and `proxy-authorization` are never present, so a signature header a service sends
   * for verification (`x-hub-signature-256`, `stripe-signature`, ...) is still visible here.
   *
   * Treat every value as untrusted third-party input, exactly like `body`.
   */
  headers: Record<string, string>;
  /** The `content-type` header, when the request had one. */
  contentType?: string;
  /** The raw request body as text, truncated to 128 KiB. Empty string when the body was empty. */
  body: string;
  /**
   * The body parsed as JSON, present only when the request declared a JSON content type and the
   * body actually parsed. Absent for form posts, plain text, XML, or malformed JSON — read `body`
   * in those cases.
   */
  json?: unknown;
  /** True when the body exceeded 128 KiB and `body` holds only its first 128 KiB. */
  truncated?: boolean;
};

/**
 * The interface a gadget implements to receive deliveries. Register the callback with
 * `ctx.restore()` so it survives the agent session that created it.
 *
 * `onWebhook()` runs without a user watching, so it must not wait on approval-gated work. Delivery
 * is at-least-once and retried on failure, so make the handler idempotent on `deliveryId`. A
 * handler that throws is retried with backoff; after eight attempts the delivery is marked failed
 * and appears in the Webhooks app under **Needs attention**.
 */
export interface WebhookHook {
  onWebhook(event: WebhookEvent): Promise<void>;
}

/** Registration details for a new endpoint. */
export type RegisterEndpointOptions = {
  /** Short label shown in Connections and the Webhooks app. Up to 200 characters. */
  title: string;
  /**
   * What this endpoint receives and what the workspace does with it. Shown to the user when they
   * decide whether to enable the hook, so describe the third-party service by name. Up to 2,000
   * characters.
   */
  description: string;
  /**
   * HTTP methods the endpoint accepts, upper-case. Defaults to `["POST"]`. A request using any
   * other method is rejected with `405` and never delivered.
   */
  methods?: string[];
};

/** The URL and one-time token minted for an endpoint. */
export type EndpointCredentials = {
  /** Opaque endpoint ID, stable for the endpoint's lifetime. */
  endpointId: string;
  /** The public URL to give the third-party service. */
  url: string;
  /**
   * The bearer token, returned only by the call that minted it. The service must send it as
   * `Authorization: Bearer <token>`. Not retrievable afterwards — pass it to the user now.
   */
  token: string;
};

/** How an endpoint is currently behaving. */
export type EndpointStatus =
  /** Registered but its hook is not enabled in Connections; the URL answers 503. */
  | "disabled"
  /** Enabled and accepting deliveries. */
  | "active"
  /** Enabled, but its most recent deliveries all failed after exhausting their retries. */
  | "failing";

/** A workspace endpoint as reported by `list()`. */
export type EndpointSummary = {
  endpointId: string;
  title: string;
  description: string;
  /** The public URL. The token is never included. */
  url: string;
  /**
   * False for an endpoint created from the workspace Connections panel, which issues no token.
   * Such an endpoint rejects every request until one is generated in the Webhooks app.
   */
  hasToken: boolean;
  methods: string[];
  status: EndpointStatus;
  /** Unix epoch milliseconds when the endpoint was registered. */
  createdAt: number;
  /** Unix epoch milliseconds of the most recent accepted delivery, when there has been one. */
  lastDeliveryAt?: number;
  /** Deliveries accepted since registration. */
  deliveryCount: number;
  /** Deliveries that exhausted their retries. */
  failedCount: number;
};

/** One recent delivery, as reported by `deliveries()`. Bodies are not retained. */
export type DeliverySummary = {
  deliveryId: string;
  endpointId: string;
  receivedAt: number;
  method: string;
  /** Byte length of the received body. */
  bodyBytes: number;
  /** Where the delivery ended up. */
  outcome: "queued" | "delivered" | "failed";
  /** Attempts made so far. */
  attempts: number;
  /** Why the last attempt failed, when it did. Never contains the request body. */
  error?: string;
};

/**
 * The ambient Webhooks binding, scoped to the current workspace.
 *
 * Endpoints are per workspace and per account: registering here never exposes another workspace's
 * endpoints, and `list()` shows only this workspace's.
 */
export interface WebhookSession {
  /**
   * Registers a new inbound endpoint and binds a disabled hook for it.
   *
   * The returned token is shown once. After this call, tell the user the URL, the token, and that
   * they must enable the hook in Connections before deliveries start.
   *
   * @param callback A persistent `WebhookHook` stub created with `ctx.restore()`.
   */
  register(
    callback: RpcStub<WebhookHook>,
    options: RegisterEndpointOptions,
  ): Promise<EndpointCredentials>;

  /** Lists this workspace's endpoints, including ones whose hook is not enabled yet. */
  list(): Promise<EndpointSummary[]>;

  /**
   * Mints a fresh bearer token for an endpoint and invalidates the previous one immediately. The
   * URL does not change. Use this when a token leaks or the user lost it.
   */
  rotateToken(endpointId: string): Promise<EndpointCredentials>;

  /**
   * Deletes an endpoint. The URL stops resolving immediately and queued deliveries are dropped.
   *
   * The Workshop hook the endpoint was bound to is not deleted by this call — it becomes inert, and
   * the user removes it from Connections. Tell them so, or they will see a hook that does nothing.
   */
  revoke(endpointId: string): Promise<void>;

  /**
   * Returns the most recent deliveries, newest first, for one endpoint or for the whole workspace.
   * At most 50 per endpoint are retained. Bodies are not retained — this is for diagnosing whether
   * a service is reaching the endpoint at all, not for replaying payloads.
   */
  deliveries(endpointId?: string, limit?: number): Promise<DeliverySummary[]>;
}

/**
 * The session a gadget gets from a **bound webhook endpoint** — one created in the workspace's
 * Connections panel ("Connect resource" -> "Webhook endpoint") rather than by `WEBHOOKS.register()`.
 *
 * It operates only the endpoint it is bound to: it cannot create endpoints or see any other. That
 * is what lets one workspace run several independent webhook flows at once. Bind each endpoint to
 * the gadget that handles it, and give that gadget only the connections its flow needs — a
 * deployment-alerts endpoint whose gadget holds a ClickHouse binding cannot reach GitHub, and vice
 * versa, because a gadget only ever sees its own bindings.
 *
 * The endpoint already exists by the time you see it; your job is to attach the handler:
 *
 *     const callback = await ctx.restore({ type: "webhook" });
 *     await ALERTS.onWebhook(callback);
 *
 * An endpoint created this way has **no bearer token yet** and rejects every request with `401`
 * until one is generated in the Webhooks app (or via `rotateToken()` here). Check `describe()` and
 * tell the user if `hasToken` is false — it is the first thing to get wrong.
 */
export interface WebhookEndpointSession {
  /**
   * Attaches this gadget's persistent callback, binding a *disabled* hook. The user enables it in
   * Connections to start delivery. Calling this again replaces the binding.
   *
   * @param callback A persistent `WebhookHook` stub created with `ctx.restore()`.
   */
  onWebhook(callback: RpcStub<WebhookHook>): Promise<void>;

  /** This endpoint's current state, including `hasToken` and whether its hook is enabled. */
  describe(): Promise<EndpointSummary>;

  /**
   * Mints a token for this endpoint — the first one if it has none, otherwise a replacement that
   * invalidates the previous immediately. Returned exactly once; give it to the user now.
   */
  rotateToken(): Promise<EndpointCredentials>;

  /** Recent deliveries to this endpoint, newest first. Bodies are not retained. */
  deliveries(limit?: number): Promise<DeliverySummary[]>;
}
