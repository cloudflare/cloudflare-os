// Acme Service event hooks: what a hook is, whichever way its events arrive (acme-hook-driver.ts).
//
// `subscribe()` runs in the binding's facet, which mints a persistent stub to itself for delivery
// and binds an `AcmeHookController` carrying that stub in its props. The controller is a loopback
// entrypoint rather than the facet, since removing a connection deletes the facet in the same turn
// as it fires the unawaited `disable()`.
//
// A driver verifies each webhook delivery and queues its event once for every enabled hook that
// may watch it; the kit's `HookRegistry` keeps the hooks and delivers from the driver's alarm,
// retrying failures. Each delivery starts a firing, and the facet re-reads the item as the hook's
// owner, dropping what they can't see, before calling the hook.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { DELIVERED_RETENTION_MS } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import type { HookCapabilities, HookDelivery } from "@gadgets/gatekeeper-kit/hook-registry";
import type { ApprovalQueue, HookDescription } from "@gadgets/workshop-shared/gatekeeper";
import { isDenial, type WireItem } from "./acme-api";
import { VENDOR_ID } from "./acme-env";
import { itemSubresourceId } from "./acme-resources";
import { authorizeRead, toItem, type SessionHost } from "./acme-session";
import { ITEM_ID } from "./acme-urls";
import { obsContext } from "./observability";
import type { AcmeEvent, AcmeEventHook } from "./types";

/** The hooks' logger, the driver's too. */
export const logger = obsContext.createLogger({ component: "gatekeeper.acme.hooks", vendorId: VENDOR_ID });

export const HOOKS_NOT_CONFIGURED = "Acme Service hooks are not configured on this deployment.";
export const DISCONNECTED = "This Acme Service account has been disconnected.";

export type AcmeEventHookTarget = RpcTarget & AcmeEventHook;

/** An event as a driver queues it: what the webhook said, before any hook's owner re-reads it. */
export type StoredEvent = { id: string; kind: AcmeEvent["kind"]; occurredAt: string; itemId: string };

/** What a hook watches, baked into its delivery stub. */
export type HookScope = { itemId: string };

/**
 * What a driver filters a hook's events by, a cheap check that spares firings, which the facet
 * repeats; and the connection it was bound through, whose disconnecting drops it.
 */
export type Registration = { userObjectId: string; itemId: string };

export type Capabilities = HookCapabilities<AcmeEventHookTarget, StoredEvent>;

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type AcmeHookProps = Registration & { key: string; delivery: RpcStub<AcmeHookDelivery> };

/** How the Workshop asks the user to approve a hook; by object IDs only, as descriptions are public. */
export function hookDescription({ itemId }: HookScope): HookDescription {
  return {
    title: `Watch Acme Service item ${itemId}`,
    description: `Call this hook each time item ${itemId} changes, with the item as the connected user sees it.`,
  };
}

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
      // A webhook sees more than the hook's owner may, so each event is re-read as them.
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

// ── Webhook deliveries ──────────────────────────────────────────────

// STOP(webhook-limits): The largest delivery the provider sends, and how fast it expects an answer.
/** The most a delivery may be, which is refused rather than read when larger. */
export const MAX_DELIVERY_BYTES = 256 * 1024;

// STOP(webhook-signature): How the provider signs a delivery: the header, the algorithm, what is
// signed (often a timestamp with the body, which then bounds a replay), and how a rotated secret
// shows. Verify over the raw bytes, and compare in constant time.
/** The header a delivery's signature comes in. */
export const SIGNATURE_HEADER = "X-Acme-Signature";

/** Whether `header` is the body's hex HMAC-SHA256 under `secret`, in constant time. */
export async function signed(secret: string, header: string, body: Uint8Array): Promise<boolean> {
  const hex = /^[0-9a-f]{64}$/i.exec(header.trim())?.[0];
  if (hex === undefined) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return crypto.subtle.timingSafeEqual(expected, Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)));
}

// STOP(webhook-payload): The provider's delivery format, and which of its event types a hook can
// watch. Take only identifiers from it: what a hook is given is re-read as the hook's owner.
/**
 * The event a verified delivery reports, or undefined for one no hook is given: of a type none
 * watches, unreadable, or older than the queue remembers, which only a replay delivers, as the
 * event's own id dedupes only that long.
 */
export function parseDelivery(body: Uint8Array): StoredEvent | undefined {
  let payload: { id?: unknown; type?: unknown; occurred_at?: unknown; item?: { id?: unknown } } | null;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    payload = null;
  }
  const { id, type, occurred_at, item } = payload ?? {};
  if (type !== "item.updated") return undefined;
  if (typeof id !== "string" || typeof occurred_at !== "string" || typeof item?.id !== "string" || !ITEM_ID.test(item.id)) {
    logger.warn("ignored an Acme Service event it could not read", { event: "hooks.delivery.unreadable" });
    return undefined;
  }
  const at = Date.parse(occurred_at);
  if (Number.isNaN(at)) {
    // Nothing would stop its replay once its dedupe row is forgotten.
    logger.warn("ignored an Acme Service event with no usable timestamp", { event: "hooks.delivery.untimed" });
    return undefined;
  }
  return at < Date.now() - DELIVERED_RETENTION_MS ? undefined : { id, kind: "updated", occurredAt: occurred_at, itemId: item.id };
}
