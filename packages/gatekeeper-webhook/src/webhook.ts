import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import {
  CONNECT_TIMEOUT_MS,
  generateNonce,
  hexEncode,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  constantTimeEqual,
  type TimedNonce,
} from "@gadgets/gatekeeper-kit/connect-nonce";
import { connectHandoffPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { readTextCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  AccountDescription,
  ActionKind,
  ApprovalQueue,
  ConnectHandoff,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperUser,
  GatekeeperUserVerifier,
  HookController,
  HookInitiator,
  HookTargetMetadata,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";
import type {
  WebhookCredential,
  WebhookCredentialOptions,
  WebhookEvent,
  WebhookHook,
  WebhookSession,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import CONFIGURATOR_HTML from "./generated/webhook-configurator-ui.txt";
import type { WebhookConfiguratorRpc } from "./configurator/webhook-configurator-types.js";

const MAX_BODY_BYTES = 512 * 1024;
const VENDOR_ID = "webhook";
const ENDPOINT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ENDPOINT_LABEL_LENGTH = 80;
const MAX_CREDENTIAL_PREFIX_LENGTH = 128;
const MAX_PRESENTED_CREDENTIAL_LENGTH = 256;
const CREDENTIAL_RESERVATION_MS = 5 * 60 * 1000;
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_PREFIX_RE = /^[\x20-\x7e]*$/;
const RESERVED_CREDENTIAL_HEADERS = new Set([
  "connection", "content-length", "content-type", "host", "idempotency-key", "transfer-encoding",
]);
const RECEIPT_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 10_000;
const ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'>" +
      "<path fill='%23f48120' d='M88 40h80v48h48v80h-48v48H88v-48H40V88h48zm16 64v48h48v-48z'/></svg>",
  ),
};
const logger = createLogger<{
  vendorId: string;
  deliveryId?: string;
  failureStage?: "start" | "authorize" | "callback";
}>({
  component: "gatekeeper.webhook",
  vendorId: VENDOR_ID,
});

type Env = Cloudflare.Env & { BASE_URL?: string };
type AccountProps = { accountId: string };
type EndpointRecord = { endpointId: string; label: string };
type EndpointProps = AccountProps & EndpointRecord;
type HookProps = EndpointProps & { hookId: string };
type HookTarget = RpcTarget & WebhookHook;
type StoredCredential = { headerName: string; valueHash: string };
type CredentialReservation = { id: string; expiresAt: number };
type EndpointState = {
  endpointId: string;
  ownerAccountId: string;
  status: "active" | "revoked";
  credentialReservation?: CredentialReservation;
};

function baseUrl(env: Env): string {
  const value = stripTrailingSlashes(
    env.BASE_URL ?? "http://localhost:8787/gatekeeper/webhook",
  );
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !local) {
    throw new Error("Webhook BASE_URL must use HTTPS outside local development.");
  }
  return value;
}

function basePath(env: Env): string {
  const path = new URL(baseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function webhookUrl(env: Env, endpointId: string): string {
  return `${baseUrl(env)}/hooks/${endpointId}`;
}

function supportedResource(env: Env): SupportedResource {
  return {
    urlPattern: `${baseUrl(env)}/hooks/:endpointId`,
    title: "Webhook",
    description: "Receive authenticated JSON webhook requests.",
  };
}

function receiver(exports: Cloudflare.Exports, endpointId: string) {
  return exports.WebhookReceiver.getByName(endpointId);
}

function registry(exports: Cloudflare.Exports, endpointId: string) {
  // An unknown endpoint reaches one of only 256 registry objects, never its receiver.
  return exports.WebhookEndpointRegistry.getByName(endpointId.slice(0, 2));
}

async function sha256Hex(value: string): Promise<string> {
  return hexEncode(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ));
}

function credentialOptions(options?: WebhookCredentialOptions): {
  headerName: string; valuePrefix: string;
} {
  const headerName = options?.headerName?.trim() || "Authorization";
  if (headerName.length > 128 || !HEADER_NAME_RE.test(headerName)) {
    throw new Error("Use a valid HTTP credential header name of at most 128 characters.");
  }
  if (RESERVED_CREDENTIAL_HEADERS.has(headerName.toLowerCase())) {
    throw new Error(`${headerName} is reserved by the webhook protocol and cannot carry a credential.`);
  }
  const valuePrefix = options?.valuePrefix
    ?? (headerName.toLowerCase() === "authorization" ? "Bearer " : "");
  if (valuePrefix.length > MAX_CREDENTIAL_PREFIX_LENGTH ||
      !HEADER_VALUE_PREFIX_RE.test(valuePrefix)) {
    throw new Error("Use a printable ASCII credential value prefix of at most 128 characters.");
  }
  return { headerName, valuePrefix };
}

function validateEndpointId(value: string | undefined): string {
  const endpointId = value?.trim().toLowerCase();
  if (!endpointId || !ENDPOINT_ID_RE.test(endpointId)) {
    throw new Error("Invalid webhook endpoint ID.");
  }
  return endpointId;
}

function validateEndpointLabel(value: string | null | undefined): string {
  const label = value?.trim() || "Webhook endpoint";
  if (label.length > MAX_ENDPOINT_LABEL_LENGTH) {
    throw new Error(`Webhook labels must be at most ${MAX_ENDPOINT_LABEL_LENGTH} characters.`);
  }
  return label;
}

function endpointIdFromPath(env: Env, pathname: string): string | null {
  const escapedBase = basePath(env).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedBase}/hooks/([^/]+)$`, "i").exec(pathname);
  if (!match) return null;
  try {
    const endpointId = validateEndpointId(decodeURIComponent(match[1]!));
    return match[1] === endpointId ? endpointId : null;
  } catch {
    return null;
  }
}

function parseWebhookJson(text: string): WebhookEvent["payload"] {
  // JSON.parse without a reviver can only produce values in the JSON algebra. Keep the standard
  // library's imprecise `any` return type contained at this boundary instead of walking the tree
  // a second time with a recursive validator.
  return JSON.parse(text) as WebhookEvent["payload"];
}

async function eventId(request: Request): Promise<{ id: string; keyed: boolean }> {
  const idempotencyKey = request.headers.get("idempotency-key");
  return idempotencyKey
    ? { id: await sha256Hex(`key:${idempotencyKey}`), keyed: true }
    : { id: crypto.randomUUID(), keyed: false };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const connect = new RegExp(
      `^${basePath(env).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/connect/([a-f\\d]{64})/([a-f\\d]{64})$`,
      "i",
    ).exec(url.pathname);
    if (connect && request.method === "GET") {
      const account = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(connect[1]!));
      const handoff = await account.complete(connect[2]!);
      return handoff
        ? htmlResponse(connectHandoffPageHtml(handoff))
        : new Response("Connection link expired.", { status: 400 });
    }

    const endpointId = endpointIdFromPath(env, url.pathname);
    if (!endpointId) return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const indexed = await registry(ctx.exports, endpointId).getCredential(endpointId);
    const presented = indexed ? request.headers.get(indexed.headerName) : null;
    const presentedHash = presented && presented.length <= MAX_PRESENTED_CREDENTIAL_LENGTH
      ? await sha256Hex(presented) : null;
    if (!indexed || !presentedHash ||
        !constantTimeEqual(presentedHash, indexed.valueHash)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if ((request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "application/json") {
      return new Response("Content-Type must be application/json.", { status: 415 });
    }

    let text: string;
    try {
      text = await readTextCapped(new Response(request.body, { headers: request.headers }), MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) return new Response("Payload Too Large", { status: 413 });
      throw error;
    }
    let payload: WebhookEvent["payload"];
    try {
      payload = parseWebhookJson(text);
    } catch {
      return new Response("Body must be valid JSON.", { status: 400 });
    }

    const { id, keyed } = await eventId(request);
    const event: WebhookEvent = {
      id,
      timestamp: new Date().toISOString(),
      payload,
    };
    const status = await receiver(ctx.exports, endpointId).deliver(presentedHash, event, keyed);
    const message = status === 204
      ? null
      : status === 401
        ? "Unauthorized"
        : status === 409
          ? "No webhook subscription is enabled."
          : "Webhook delivery failed.";
    return new Response(message, {
      status,
    });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Webhook",
      url: baseUrl(this.env),
      logo: ICON,
      tagline: "Trigger gadgets with an authenticated HTTP POST",
      description: "A minimal JSON webhook endpoint for event-driven gadgets.",
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).begin(callback, nonce);
    return { url: `${baseUrl(this.env)}/connect/${id}/${nonce}` };
  }

  async getSupportedResources(): Promise<SupportedResource[]> { return [supportedResource(this.env)]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}

export class UserAccount extends DurableObject<Env> {
  #connects = new SerialTaskQueue();
  async begin(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<TimedNonce>("nonce", {
      value: nonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
    });
    this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
  }

  async complete(nonce: string): Promise<ConnectHandoff | null> {
    return this.#connects.run(async () => {
      const stored = this.ctx.storage.kv.get<TimedNonce>("nonce");
      if (!isLiveNonce(stored, nonce, Date.now())) return null;
      const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) return null;
      // Completion is exactly once. If the reply is lost, the user starts a fresh connection;
      // retrying this account could otherwise leave two Workshop handoffs able to revoke it.
      this.ctx.storage.kv.delete("nonce");
      try {
        const handoff = await callback.complete(this.ctx.exports.GatekeeperUserImpl({
          props: { accountId: this.ctx.id.toString() },
        }));
        this.ctx.storage.kv.delete("callback");
        this.ctx.storage.deleteAlarm();
        return handoff;
      } finally {
        disposeStub(callback);
      }
    });
  }

  async alarm(): Promise<void> { await this.ctx.storage.deleteAll(); }
  async registerEndpoint(endpoint: EndpointRecord): Promise<boolean> {
    if (this.ctx.storage.kv.get<boolean>("revoked")) return false;
    this.ctx.storage.kv.put(`endpoint:${endpoint.endpointId}`, endpoint);
    return true;
  }
  async removeEndpoint(endpointId: string): Promise<void> {
    this.ctx.storage.kv.delete(`endpoint:${endpointId}`);
  }
  async getEndpoint(endpointId: string): Promise<EndpointRecord | null> {
    return this.ctx.storage.kv.get<EndpointRecord>(`endpoint:${endpointId}`) ?? null;
  }
  async listEndpoints(): Promise<EndpointRecord[]> {
    return [...this.ctx.storage.kv.list({ prefix: "endpoint:" })]
      .map(([, endpoint]) => endpoint as EndpointRecord);
  }
  async revokeAndListEndpoints(): Promise<EndpointRecord[]> {
    this.ctx.storage.kv.put("revoked", true);
    return this.listEndpoints();
  }
}

const configuratorEnvs = new WeakMap<object, Env>();
const configuratorAccounts = new WeakMap<object, string>();
const configuratorExports = new WeakMap<object, Cloudflare.Exports>();

@validateRpc()
class WebhookConfiguratorUI extends RpcTarget implements WebhookConfiguratorRpc {
  constructor(env: Env, exports: Cloudflare.Exports, accountId: string) {
    super();
    configuratorEnvs.set(this, env);
    configuratorAccounts.set(this, accountId);
    configuratorExports.set(this, exports);
  }
  async getLabel(endpointIdValue: string): Promise<string> {
    const accountId = configuratorAccounts.get(this);
    const exports = configuratorExports.get(this);
    if (!accountId || !exports) throw new Error("Webhook configurator is not initialized.");
    const account = exports.UserAccount.get(exports.UserAccount.idFromString(accountId));
    const endpoint = await account.getEndpoint(validateEndpointId(endpointIdValue));
    if (!endpoint) throw new Error("This webhook endpoint does not belong to the connected account.");
    return endpoint.label;
  }
  async resourceUrl(
    endpointIdValue: string | null | undefined,
    labelValue: string | null | undefined,
  ): Promise<string> {
    const env = configuratorEnvs.get(this);
    const accountId = configuratorAccounts.get(this);
    const exports = configuratorExports.get(this);
    if (!env || !accountId || !exports) throw new Error("Webhook configurator is not initialized.");
    const endpoint: EndpointRecord = {
      endpointId: validateEndpointId(endpointIdValue ?? undefined),
      label: validateEndpointLabel(labelValue),
    };
    const account = exports.UserAccount.get(
      exports.UserAccount.idFromString(accountId),
    );
    if (!(await account.registerEndpoint(endpoint))) {
      throw new Error("This webhook connection has been revoked.");
    }
    if (!(await receiver(exports, endpoint.endpointId).claim(accountId, endpoint.endpointId))) {
      await account.removeEndpoint(endpoint.endpointId);
      throw new Error("This webhook endpoint is already owned by another account.");
    }
    return webhookUrl(env, endpoint.endpointId);
  }
}

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: "Webhook", avatar: ICON };
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return [supportedResource(this.env)]; }
  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<WebhookSession>>; resource: SupportedResource;
  }> {
    const endpointId = endpointIdFromPath(this.env, new URL(url).pathname);
    if (!endpointId) {
      throw new Error("This webhook URL does not belong to the connected account.");
    }
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.accountId),
    );
    const endpoint = await account.getEndpoint(endpointId);
    if (!endpoint || url !== webhookUrl(this.env, endpoint.endpointId)) {
      throw new Error("This webhook URL does not belong to the connected account.");
    }
    return {
      class: this.ctx.exports.WebhookGatekeeper({
        props: { ...this.ctx.props, ...endpoint },
      }),
      resource: supportedResource(this.env),
    };
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    if (pattern !== supportedResource(this.env).urlPattern) {
      throw new Error(`Unsupported webhook resource type: ${pattern}`);
    }
    return {
      iframeHtml: CONFIGURATOR_HTML,
      ui: new RpcStub(new WebhookConfiguratorUI(
        this.env, this.ctx.exports, this.ctx.props.accountId,
      )),
    };
  }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  async revoke(): Promise<void> {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.accountId),
    );
    const endpoints = await account.revokeAndListEndpoints();
    await Promise.all(endpoints.map(endpoint =>
      receiver(this.ctx.exports, endpoint.endpointId)
        .disableAll(this.ctx.props.accountId, endpoint.endpointId)));
  }
  reconnect(): Promise<{ url: string }> { throw new Error("This connection has no user credentials."); }
  commitReconnect(_stageId: string): Promise<void> { throw new Error("No reconnect is pending."); }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.WebhookVerifier({});
  }
}

@validateRpc()
export class WebhookVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
class WebhookSessionImpl extends RpcTarget implements WebhookSession {
  constructor(
    private readonly ctx: DurableObjectState<EndpointProps>,
    private readonly env: Env,
    private readonly queue: RpcStub<ApprovalQueue>,
    private readonly url: string,
  ) { super(); }

  async subscribe(callback: RpcStub<HookTarget>): Promise<void> {
    const controller = this.ctx.exports.WebhookHookController({
      props: { ...this.ctx.props, hookId: crypto.randomUUID() },
    });
    // @ts-ignore Workers widens the controller's hook type across the generic RPC boundary.
    await this.queue.bindHook(controller, callback, {
      title: "Receive webhook requests",
      description: "Receive authenticated JSON requests sent to this webhook endpoint.",
    });
  }
  async getTriggerUrl(): Promise<string> { return this.url; }
  async issueCredential(options?: WebhookCredentialOptions): Promise<WebhookCredential> {
    const { headerName, valuePrefix } = credentialOptions(options);
    const endpointReceiver = receiver(this.ctx.exports, this.ctx.props.endpointId);
    const reservationId = await endpointReceiver.reserveCredential(this.ctx.props.accountId);
    if (!reservationId) {
      throw new Error("This webhook endpoint cannot issue a credential right now. Please retry.");
    }
    try {
      await this.queue.authorizeObservation({
        title: "Issue webhook credential",
        description: "Create a new credential for configuring this webhook sender.",
      });
      const headerValue = `${valuePrefix}${generateNonce()}`;
      const credential = { headerName, valueHash: await sha256Hex(headerValue) };
      if (!(await endpointReceiver.commitCredential(
        this.ctx.props.accountId, this.ctx.props.endpointId, reservationId, credential,
      ))) throw new Error("Webhook credential issuance expired. Please try again.");
      return { url: this.url, headerName, headerValue };
    } finally {
      await endpointReceiver.releaseCredentialReservation(
        this.ctx.props.accountId, reservationId,
      );
    }
  }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

@validateRpc()
export class WebhookGatekeeper extends DurableObject<Env, EndpointProps>
  implements Gatekeeper<WebhookSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: webhookUrl(this.env, this.ctx.props.endpointId),
      title: this.ctx.props.label,
      snippet: "Receive authenticated JSON webhook requests.",
      suggestedBindingName: "WEBHOOK",
      tsType: "WebhookSession",
      hookTsType: "WebhookHook",
    };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<WebhookSession> {
    return new WebhookSessionImpl(
      this.ctx,
      this.env,
      queue.dup(),
      webhookUrl(this.env, this.ctx.props.endpointId),
    );
  }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("Webhook payloads and credentials are private to their connected owner.");
  }
  async removeObserver(_id: string): Promise<void> {}
  applyAction(_action: number): Promise<void> { throw new Error("Webhook has no actions."); }
  async rejectAction(_action: number): Promise<void> {}
  revertAction(_action: number): Promise<void> { throw new Error("Webhook has no actions."); }
}

@validateRpc()
export class WebhookHookController extends WorkerEntrypoint<Env, HookProps>
  implements HookController<HookTarget> {
  async enable(
    initiator: Fetcher<HookInitiator<HookTarget>>,
    _target: HookTargetMetadata,
  ): Promise<void> {
    await receiver(this.ctx.exports, this.ctx.props.endpointId).enable(
      this.ctx.props.accountId,
      this.ctx.props.hookId,
      initiator,
    );
  }
  async disable(): Promise<void> {
    await receiver(this.ctx.exports, this.ctx.props.endpointId).disable(this.ctx.props.hookId);
  }
}

export class WebhookEndpointRegistry extends DurableObject<Env> {
  async getCredential(endpointId: string): Promise<StoredCredential | null> {
    return this.ctx.storage.kv.get<StoredCredential>(endpointId) ?? null;
  }
  async putCredential(endpointId: string, credential: StoredCredential): Promise<void> {
    this.ctx.storage.kv.put(endpointId, credential);
  }
  async deleteCredential(endpointId: string): Promise<void> {
    this.ctx.storage.kv.delete(endpointId);
  }
}

export class WebhookReceiver extends DurableObject<Env> {
  #mutations = new SerialTaskQueue();
  #inFlight = new Map<string, Promise<number>>();
  #activeDeliveries = new Set<Promise<number>>();

  async claim(accountId: string, endpointId: string): Promise<boolean> {
    return this.#mutations.run(() => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (state?.status === "revoked" ||
          (state && (state.ownerAccountId !== accountId || state.endpointId !== endpointId))) return false;
      if (!state) {
        this.ctx.storage.kv.put<EndpointState>("state", {
          endpointId, ownerAccountId: accountId, status: "active",
        });
        // Unknown UUIDs never reach this write: the table is created only after registration.
        this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS webhook_receipts (
          event_id TEXT PRIMARY KEY, delivered_at INTEGER NOT NULL
        )`);
      }
      return true;
    });
  }

  async reserveCredential(accountId: string): Promise<string | null> {
    return this.#mutations.run(() => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (!state || state.ownerAccountId !== accountId || state.status !== "active") return null;
      const now = Date.now();
      if (state.credentialReservation && state.credentialReservation.expiresAt > now) return null;
      const id = generateNonce();
      this.ctx.storage.kv.put<EndpointState>("state", {
        ...state, credentialReservation: { id, expiresAt: now + CREDENTIAL_RESERVATION_MS },
      });
      return id;
    });
  }

  async commitCredential(
    accountId: string,
    endpointId: string,
    reservationId: string,
    credential: StoredCredential,
  ): Promise<boolean> {
    return this.#mutations.run(async () => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (!state || state.ownerAccountId !== accountId || state.endpointId !== endpointId ||
          state.status !== "active" ||
          state.credentialReservation?.id !== reservationId ||
          state.credentialReservation.expiresAt <= Date.now()) return false;
      await registry(this.ctx.exports, endpointId).putCredential(endpointId, credential);
      const { credentialReservation: _, ...rest } = state;
      this.ctx.storage.kv.put<EndpointState>("state", rest);
      return true;
    });
  }

  async releaseCredentialReservation(accountId: string, reservationId: string): Promise<void> {
    await this.#mutations.run(() => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (!state || state.ownerAccountId !== accountId ||
          state.credentialReservation?.id !== reservationId) return;
      const { credentialReservation: _, ...rest } = state;
      this.ctx.storage.kv.put<EndpointState>("state", rest);
    });
  }

  async enable(
    accountId: string,
    hookId: string,
    initiator: Fetcher<HookInitiator<HookTarget>>,
  ): Promise<void> {
    await this.#mutations.run(() => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (!state || state.ownerAccountId !== accountId || state.status !== "active") {
        throw new Error("This webhook endpoint has been revoked.");
      }
      const stored = this.ctx.storage.kv.get<StoredHook>("hook");
      try {
        this.ctx.storage.kv.put<StoredHook>("hook", { hookId, initiator });
      } finally {
        disposeStub(stored?.initiator);
      }
    });
  }
  async disable(hookId: string): Promise<void> {
    await this.#mutations.run(() => {
      const stored = this.ctx.storage.kv.get<StoredHook>("hook");
      try {
        if (stored?.hookId === hookId) this.ctx.storage.kv.delete("hook");
      } finally {
        disposeStub(stored?.initiator);
      }
    });
  }
  async disableAll(accountId: string, endpointId: string): Promise<void> {
    const owned = await this.#mutations.run(async () => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (state && (state.ownerAccountId !== accountId || state.endpointId !== endpointId)) return false;
      const stored = this.ctx.storage.kv.get<StoredHook>("hook");
      try {
        this.ctx.storage.kv.put<EndpointState>("state", {
          endpointId, ownerAccountId: accountId, status: "revoked",
        });
        this.ctx.storage.kv.delete("hook");
        await registry(this.ctx.exports, endpointId).deleteCredential(endpointId);
      } finally {
        disposeStub(stored?.initiator);
      }
      return true;
    });
    await Promise.allSettled(this.#activeDeliveries);
    if (owned && this.ctx.storage.sql.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_receipts'",
    ).toArray().length) {
      this.ctx.storage.sql.exec("DELETE FROM webhook_receipts");
    }
  }

  async deliver(credentialHash: string, event: WebhookEvent, keyed = true): Promise<number> {
    const admitted = await this.#mutations.run(async () => {
      const state = this.ctx.storage.kv.get<EndpointState>("state");
      if (state?.status !== "active") return { status: 401 };
      const current = await registry(this.ctx.exports, state.endpointId)
        .getCredential(state.endpointId);
      if (!current || !constantTimeEqual(credentialHash, current.valueHash)) {
        return { status: 401 };
      }
      if (keyed && this.#wasDelivered(event.id)) return { status: 204 };
      const running = keyed ? this.#inFlight.get(event.id) : undefined;
      if (running) return { delivery: running };
      const delivery = this.#deliver(event, keyed).finally(() => {
        if (keyed) this.#inFlight.delete(event.id);
        this.#activeDeliveries.delete(delivery);
      });
      if (keyed) this.#inFlight.set(event.id, delivery);
      this.#activeDeliveries.add(delivery);
      return { delivery };
    });
    return admitted.delivery ?? admitted.status;
  }

  async #deliver(event: WebhookEvent, keyed: boolean): Promise<number> {
    const stored = this.ctx.storage.kv.get<StoredHook>("hook");
    if (!stored) return 409;
    let failureStage: "start" | "authorize" | "callback" = "start";
    try {
      // Await admission so a rejected start is handled here rather than becoming an unobserved
      // pipelined-stub rejection. The returned aggregate stub owns both capabilities.
      using hook = await stored.initiator.startHook();
      failureStage = "authorize";
      await hook.approvalQueue.authorizeObservation({
        title: "Webhook received",
        description: "Received an authenticated JSON webhook request.",
      });
      failureStage = "callback";
      await hook.callback.onWebhook(event);
      if (keyed) {
        this.ctx.storage.sql.exec(
          `INSERT INTO webhook_receipts VALUES (?, ?)
           ON CONFLICT(event_id) DO UPDATE SET delivered_at = excluded.delivered_at`,
          event.id, Date.now(),
        );
        this.#trimReceipts();
      }
      return 204;
    } catch {
      // User callback exceptions may contain webhook payloads. Log only the failed stage.
      logger.error("webhook callback failed", {
        event: "webhook.callback.failed",
        deliveryId: event.id,
        failureStage,
      });
      return 502;
    } finally {
      disposeStub(stored.initiator);
    }
  }

  #wasDelivered(deliveryId: string): boolean {
    return this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM webhook_receipts WHERE event_id = ? AND delivered_at >= ?",
        deliveryId,
        Date.now() - RECEIPT_RETENTION_MS,
      )
      .toArray().length > 0;
  }

  #trimReceipts(): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM webhook_receipts WHERE delivered_at < ?",
      Date.now() - RECEIPT_RETENTION_MS,
    );
    this.ctx.storage.sql.exec(`DELETE FROM webhook_receipts WHERE rowid IN (
      SELECT rowid FROM webhook_receipts ORDER BY delivered_at DESC LIMIT -1 OFFSET ?
    )`, MAX_RECEIPTS);
  }
}

type StoredHook = {
  hookId: string;
  initiator: Fetcher<HookInitiator<HookTarget>>;
};

function disposeStub(value: unknown): void {
  (value as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.();
}
