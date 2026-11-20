// Acme Service event hooks. An admin registers one webhook with Acme Service by hand, delivering
// to `POST {BASE_URL}/webhook` and signing with `ACME_WEBHOOK_SECRET`; until that secret is set,
// subscribing is refused and the route is inert.
//
// `subscribe()` runs in the binding's facet, which mints a persistent stub to itself for delivery
// and binds an `AcmeHookController` carrying that stub in its props. The controller is a loopback
// entrypoint rather than the facet, since removing a connection deletes the facet in the same turn
// as it fires the unawaited `disable()`.
//
// The webhook route verifies each delivery and hands its event to the deployment's one
// `AcmeHookDriver`, which queues it once for every enabled hook that may watch it; the kit's
// `HookRegistry` keeps the hooks and delivers from the driver's alarm, retrying failures. Each
// delivery starts a firing, and the facet re-reads the item as the hook's owner, dropping what they
// can't see, before calling the hook. Disconnecting drops the connection's hooks (`forgetHooks`).

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { DELIVERED_RETENTION_MS } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { HookRegistry, type HookCapabilities, type HookDelivery } from "@gadgets/gatekeeper-kit/hook-registry";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import type {
  ApprovalQueue, HookController, HookDescription, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { isDenial, type WireItem } from "./acme-api";
import { itemSubresourceId } from "./acme-credentials";
import { VENDOR_ID, type Env } from "./acme-env";
import { authorizeRead, toItem, type SessionHost } from "./acme-session";
import { ITEM_ID } from "./acme-urls";
import { obsContext } from "./observability";
import type { AcmeEvent, AcmeEventHook } from "./types";

const logger = obsContext.createLogger({ component: "gatekeeper.acme.hooks", vendorId: VENDOR_ID });

export const HOOKS_NOT_CONFIGURED = "Acme Service hooks are not configured on this deployment.";

/** Whether this deployment receives the provider's webhook. */
export const hooksConfigured = (env: Env): boolean => Boolean(env.ACME_WEBHOOK_SECRET);

export type AcmeEventHookTarget = RpcTarget & AcmeEventHook;

/** An event as the driver queues it: what the webhook said, before any hook's owner re-reads it. */
type StoredEvent = { id: string; kind: AcmeEvent["kind"]; occurredAt: string; itemId: string };

/** What a hook watches, baked into its delivery stub. */
export type HookScope = { itemId: string };

/** The deployment's one driver. */
const driver = (exports: Cloudflare.Exports) => exports.AcmeHookDriver.getByName("webhook");

/** Set when a disconnected connection's hooks are dropped, so that enabling one later is refused. */
const forgottenKey = (userObjectId: string) => `forgotten:${userObjectId}`;

const DISCONNECTED = "This Acme Service account has been disconnected.";

/** Drop the hooks of connection `userObjectId`, which is disconnecting (see `UserAccount.revoke()`). */
export async function forgetHooks(exports: Cloudflare.Exports, userObjectId: string): Promise<void> {
  await driver(exports).forgetAccount(userObjectId);
}

/** How the Workshop asks the user to approve a hook; by object IDs only, as descriptions are public. */
export function hookDescription({ itemId }: HookScope): HookDescription {
  return {
    title: `Watch Acme Service item ${itemId}`,
    description: `Call this hook each time item ${itemId} changes, with the item as the connected user sees it.`,
  };
}

// ── Facet side ──────────────────────────────────────────────────────

/**
 * What a hook's delivery stub reaches: the binding's facet, which delivers an event if the hook's
 * owner can still see the item.
 */
export type AcmeHookDelivery = HookDelivery<AcmeEventHookTarget, StoredEvent>;

@validateRpc()
export class AcmeHookDeliveryImpl extends RpcTarget implements AcmeHookDelivery {
  readonly #host: SessionHost;
  readonly #scope: HookScope;

  constructor(host: SessionHost, scope: HookScope) {
    super();
    this.#host = host;
    this.#scope = scope;
  }

  async deliver(callback: RpcStub<AcmeEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
                event: StoredEvent): Promise<void> {
    if (event.itemId !== this.#scope.itemId) return;
    let wire: WireItem;
    try {
      // The webhook sees everything the provider's app does, so each event is re-read as the hook's owner.
      wire = await this.#host.read(api => api.get("/items/{id}", { path: { id: event.itemId } }));
    } catch (error) {
      if (!isDenial(error)) throw error;
      return;
    }
    // A hook delivery is a read: authorized, with every dependency named, before the hook is called.
    await authorizeRead(approvalQueue, {
      title: "Received an Acme Service item event",
      description: `Received item ${wire.id}'s ${event.kind} event with the item.`,
      subresources: [itemSubresourceId(wire.id)],
    });
    await callback.receiveEvent({
      id: event.id, kind: event.kind, occurredAt: event.occurredAt, item: toItem(wire),
    } satisfies AcmeEvent);
  }
}

// ── Controller ──────────────────────────────────────────────────────

/**
 * What the driver filters a hook's events by, a cheap check that spares firings, which the facet
 * repeats; and the connection it was bound through, whose disconnecting drops it.
 */
type Registration = { userObjectId: string; itemId: string };

type Capabilities = HookCapabilities<AcmeEventHookTarget, StoredEvent>;

/** Everything a hook needs once enabled, captured when the facet binds it. */
type AcmeHookProps = Registration & { key: string; delivery: RpcStub<AcmeHookDelivery> };

@validateRpc()
export class AcmeHookController extends WorkerEntrypoint<Env, AcmeHookProps>
    implements HookController<AcmeEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<AcmeEventHookTarget>>, _target: HookTargetMetadata): Promise<void> {
    if (!hooksConfigured(this.env)) throw new Error(HOOKS_NOT_CONFIGURED);
    const { key, delivery, ...registration } = this.ctx.props;
    await driver(this.ctx.exports).register(key, registration, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await driver(this.ctx.exports).unregister(this.ctx.props.key);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/**
 * The deployment's one driver (see `driver`). Its storage is the registry's: `reg:`/`caps:` per
 * enabled hook, and the delivery queue's `msg:` rows and `queue:` indexes; and `forgotten:` per
 * disconnected connection.
 */
export class AcmeHookDriver extends DurableObject<Env> {
  #hooks = new HookRegistry<AcmeEventHookTarget, StoredEvent, Registration>(this.ctx.storage.kv, () => {
    logger.warn("dropped an Acme Service event after repeated delivery failures", { event: "hooks.delivery.dropped" });
  });

  async register(key: string, registration: Registration, capabilities: Capabilities): Promise<void> {
    // Disconnected before or while it was being enabled: a hook can be approved long after binding.
    if (this.ctx.storage.kv.get(forgottenKey(registration.userObjectId)) !== undefined) throw new Error(DISCONNECTED);
    // Both of the hook's records, or neither.
    this.ctx.storage.transactionSync(() => this.#hooks.set(key, registration, capabilities));
  }

  async unregister(key: string): Promise<void> {
    this.#hooks.remove(key);
    await this.#reschedule();
  }

  /** Drop every hook of connection `userObjectId`, and refuse any it enables from now on. */
  async forgetAccount(userObjectId: string): Promise<void> {
    this.ctx.storage.kv.put(forgottenKey(userObjectId), Date.now());
    for (const [key, registration] of this.#hooks.entries()) {
      if (registration.userObjectId === userObjectId) this.#hooks.remove(key);
    }
    await this.#reschedule();
  }

  /** Queue `event` once for each enabled hook that may watch it. */
  async ingest(event: StoredEvent): Promise<void> {
    const now = Date.now();
    const watching = this.#hooks.entries().filter(([, registration]) => registration.itemId === event.itemId);
    for (const [key] of watching) this.#hooks.enqueue(key, event.id, event, now);
    // Due now, so no later than anything else queued.
    if (watching.length > 0) await this.ctx.storage.setAlarm(now);
  }

  async alarm(): Promise<void> {
    await this.#hooks.run(Date.now());
    await this.#reschedule();
  }

  async #reschedule(): Promise<void> {
    const due = this.#hooks.nextDue();
    if (due === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }
}

// ── Webhook deliveries ──────────────────────────────────────────────

// STOP(webhook-limits): The largest delivery the provider sends, and how fast it expects an answer.
const MAX_DELIVERY_BYTES = 256 * 1024;

/**
 * Handle one delivery to `POST {BASE_URL}/webhook`: verify it, and hand its event to the driver.
 * Answered at once; delivery to hooks happens from the driver's alarm.
 */
export async function handleWebhook(request: Request, env: Env, exports: Cloudflare.Exports): Promise<Response> {
  const secret = env.ACME_WEBHOOK_SECRET;
  if (!secret) return new Response("Not Found", { status: 404 });
  const signature = request.headers.get("X-Acme-Signature");
  if (!signature) return new Response("Unauthorized", { status: 401 });
  let body: Uint8Array;
  try {
    body = await readBytesCapped(request, MAX_DELIVERY_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return new Response("Payload Too Large", { status: 413 });
    throw error;
  }
  if (!await signed(secret, signature, body)) return new Response("Unauthorized", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const event = parseDelivery(payload);
  // An event no hook watches for, or one older than the queue remembers, which only a replay
  // delivers: the event's own id dedupes only that long.
  if (event && Date.parse(event.occurredAt) >= Date.now() - DELIVERED_RETENTION_MS) {
    await driver(exports).ingest(event);
  }
  return new Response(null, { status: 204 });
}

// STOP(webhook-signature): How the provider signs a delivery: the header, the algorithm, what is
// signed (often a timestamp with the body, which then bounds a replay), and how a rotated secret
// shows. Verify over the raw bytes, and compare in constant time.
/** Whether `header` is the body's hex HMAC-SHA256 under `secret`, in constant time. */
async function signed(secret: string, header: string, body: Uint8Array): Promise<boolean> {
  const hex = /^[0-9a-f]{64}$/i.exec(header.trim())?.[0];
  if (hex === undefined) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return crypto.subtle.timingSafeEqual(expected, Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)));
}

// STOP(webhook-payload): The provider's delivery format, and which of its event types a hook can
// watch. Take only identifiers from it: what a hook is given is re-read as the hook's owner.
/** The event a webhook payload reports, or undefined for one no hook watches for. */
function parseDelivery(payload: unknown): StoredEvent | undefined {
  const { id, type, occurred_at, item } = (payload ?? {}) as {
    id?: unknown; type?: unknown; occurred_at?: unknown; item?: { id?: unknown };
  };
  if (type !== "item.updated") return undefined;
  if (typeof id !== "string" || typeof occurred_at !== "string" || typeof item?.id !== "string" || !ITEM_ID.test(item.id)) {
    logger.warn("ignored an Acme Service event it could not read", { event: "hooks.delivery.unreadable" });
    return undefined;
  }
  if (Number.isNaN(Date.parse(occurred_at))) {
    // Nothing would stop its replay once its dedupe row is forgotten.
    logger.warn("ignored an Acme Service event with no usable timestamp", { event: "hooks.delivery.untimed" });
    return undefined;
  }
  return { id, kind: "updated", occurredAt: occurred_at, itemId: item.id };
}
