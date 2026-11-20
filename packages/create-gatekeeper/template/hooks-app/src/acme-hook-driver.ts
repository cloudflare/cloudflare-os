// Where Acme Service events come from: one webhook for the whole deployment, which an admin
// registers with Acme Service by hand (many providers have it in the OAuth app's settings),
// delivering to `POST {BASE_URL}/webhook` and signing with `ACME_WEBHOOK_SECRET`. Until that
// secret is set, subscribing is refused and the route is inert.
//
// The route verifies each delivery and hands its event to the deployment's one `AcmeHookDriver`.
// Disconnecting drops the connection's hooks (`forgetHooks`).
//
// STOP(webhook-source): Whether this is how the provider delivers. One that has the integration
// add a webhook per account or per object through its API wants `--hooks subscription` instead.
// One whose push carries no content, only a prompt to read what changed since a cursor, as a
// mailbox's does, has neither shape: see gatekeeper-google's gmail-hooks.ts.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { HookRegistry } from "@gadgets/gatekeeper-kit/hook-registry";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { HookController, HookInitiator, HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import type { Env } from "./acme-env";
import {
  DISCONNECTED, HOOKS_NOT_CONFIGURED, MAX_DELIVERY_BYTES, SIGNATURE_HEADER, logger, parseDelivery, signed,
  type AcmeEventHookTarget, type AcmeHookProps, type Capabilities, type Registration, type StoredEvent,
} from "./acme-hooks";

/** Whether this deployment receives the provider's webhook. */
export const hooksConfigured = (env: Env): boolean => Boolean(env.ACME_WEBHOOK_SECRET);

/** The deployment's one driver. */
const driver = (exports: Cloudflare.Exports) => exports.AcmeHookDriver.getByName("webhook");

/** Set when a disconnected connection's hooks are dropped, so that enabling one later is refused. */
const forgottenKey = (userObjectId: string) => `forgotten:${userObjectId}`;

/**
 * Drop the hooks of connection `userObjectId`, which is disconnecting. Best effort: should it
 * fail, nothing retries it, and the hooks' firings fail without a grant.
 */
export async function forgetHooks(exports: Cloudflare.Exports, userObjectId: string): Promise<void> {
  await driver(exports).forgetAccount(userObjectId).catch((error: unknown) => {
    logger.warn("failed to drop the hooks of a disconnected connection", { event: "hooks.forget.failed", error });
  });
}

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

  // STOP(webhook-tenant): The webhook reports every account that installed the app. Where object
  // IDs are not unique across the provider's accounts, keep the account an event names (from the
  // signed payload) in `StoredEvent`, and the connection's in `Registration`, and match on both:
  // a bare ID re-read in another account could pair this event with someone else's object.
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

/**
 * Handle one delivery to `POST {BASE_URL}{path}`: verify it, and hand its event to the driver.
 * Answered at once; delivery to hooks happens from the driver's alarm.
 */
export async function handleWebhook(request: Request, path: string, env: Env, exports: Cloudflare.Exports): Promise<Response> {
  const secret = env.ACME_WEBHOOK_SECRET;
  if (!secret || path !== "/webhook") return new Response("Not Found", { status: 404 });
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature) return new Response("Unauthorized", { status: 401 });
  let body: Uint8Array;
  try {
    body = await readBytesCapped(request, MAX_DELIVERY_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return new Response("Payload Too Large", { status: 413 });
    throw error;
  }
  if (!await signed(secret, signature, body)) return new Response("Unauthorized", { status: 401 });
  const event = parseDelivery(body);
  if (event) await driver(exports).ingest(event);
  return new Response(null, { status: 204 });
}
