// Where Acme Service events come from: webhooks this gatekeeper adds itself, through the provider's
// API as the connected user, one per watched item, delivering to
// `POST {BASE_URL}/webhook/{driver id}`. Hooks need an origin the provider can reach, so an
// `https` one: `BASE_URL`'s, or where that is not one, as in local development, a tunnel's, set
// as `ACME_WEBHOOK_ORIGIN`.
//
// One `AcmeHookDriver` per connection holds its enabled hooks and its webhooks. It adds a webhook
// to an item when the first hook there is enabled and deletes it with the last, signs them with a
// secret of its own, verifies each delivery, and hourly checks each webhook is still there.
// Disconnecting deletes the connection's webhooks while its credential still can (`forgetHooks`).
//
// STOP(webhook-source): Whether this is how the provider delivers. One with a single webhook for
// the whole app, set by hand or in the OAuth app's settings, wants `--hooks app` instead. One
// whose push carries no content, only a prompt to read what changed since a cursor, as a
// mailbox's does, has neither shape: see gatekeeper-google's gmail-hooks.ts.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { disposeStubs } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { isCredentialsExpired } from "@gadgets/gatekeeper-kit/credentials";
import { HookRegistry } from "@gadgets/gatekeeper-kit/hook-registry";
import { HttpError } from "@gadgets/gatekeeper-kit/http-errors";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import {
  stripTrailingSlashes, type HookController, type HookInitiator, type HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { createApi, type Rest } from "./acme-api";
import { accountSource } from "./acme-credentials";
import { getBasePath, getBaseUrl, type Env } from "./acme-env";
import {
  DISCONNECTED, HOOKS_NOT_CONFIGURED, MAX_DELIVERY_BYTES, SIGNATURE_HEADER, logger, parseDelivery, signed,
  type AcmeEventHookTarget, type AcmeHookProps, type Capabilities, type Registration, type StoredEvent,
} from "./acme-hooks";

/** This Worker's base URL as the provider reaches it, or undefined where that is not over `https`. */
function webhookBase(env: Env): string | undefined {
  const base = env.ACME_WEBHOOK_ORIGIN
    ? `${stripTrailingSlashes(env.ACME_WEBHOOK_ORIGIN)}${getBasePath(env)}` : getBaseUrl(env);
  return base.startsWith("https://") ? base : undefined;
}

/** Whether the provider can reach this deployment's webhook route. */
export const hooksConfigured = (env: Env): boolean => webhookBase(env) !== undefined;

/** The driver of connection `userObjectId`. */
const driver = (exports: Cloudflare.Exports, userObjectId: string) => exports.AcmeHookDriver.getByName(userObjectId);

/**
 * Drop the hooks of connection `userObjectId`, which is disconnecting, and delete its webhooks
 * while its credential still can.
 * @throws Error while the provider may yet delete one, which keeps the connection: disconnecting
 * again finishes. Where the Workshop disconnects as part of something else and goes on regardless
 * (replacing a grant on signing in again, removing an account it provisioned), nothing asks
 * again, and the grant stays until the account is; gatekeeper-github's has the same limit.
 */
export async function forgetHooks(exports: Cloudflare.Exports, userObjectId: string): Promise<void> {
  let gone = true;
  try {
    // Asked again, of a stub of its own, should the driver restart mid-answer: it takes up where it was.
    gone = await driver(exports, userObjectId).revoke().catch(() => driver(exports, userObjectId).revoke());
  } catch (error) {
    // A driver that failed must not leave a disconnected connection's grant live.
    logger.warn("failed to drop the hooks of a disconnected connection", { event: "hooks.forget.failed", error });
  }
  if (!gone) {
    throw new Error("Acme Service failed to delete some of this connection's webhooks, so it is still connected. " +
      "Disconnect it again to finish.");
  }
}

@validateRpc()
export class AcmeHookController extends WorkerEntrypoint<Env, AcmeHookProps>
    implements HookController<AcmeEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<AcmeEventHookTarget>>, _target: HookTargetMetadata): Promise<void> {
    const { key, delivery, ...registration } = this.ctx.props;
    await driver(this.ctx.exports, registration.userObjectId).register(key, registration, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await driver(this.ctx.exports, this.ctx.props.userObjectId).unregister(this.ctx.props.key);
  }
}

const HOUR_MS = 60 * 60 * 1000;

/** A webhook this driver added to an item. */
type Webhook = { id: string; itemId: string };

const webhookKey = (itemId: string) => `webhook:${itemId}`;

/**
 * Whether a request the provider failed may succeed if made again: it erred, limited it or never
 * answered rather than refusing, and the credential is not known to be dead. A bare 401 is one
 * the account could not rule on; a dead credential comes as its own error.
 */
const retryable = (error: unknown) => error instanceof HttpError
  ? error.status >= 500 || error.status === 429 || error.status === 401
  : !isCredentialsExpired(error);

/**
 * One per connection, named by its `UserAccount` id. Storage: `account` (that id), `secret` (the
 * key its webhooks sign deliveries with), `webhook:` per watched item, `checkAt` (when to next
 * check them at the provider), the registry's `reg:`/`caps:` per hook and its queue's rows, and
 * `revoked` once the connection is disconnected, which refuses everything for good. A webhook
 * stays on record, and `account` with it, until the provider has deleted it or can't.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class AcmeHookDriver extends DurableObject<Env> {
  /** Webhook additions and removals, one at a time, so that each sees what the last did. */
  #changes = new SerialTaskQueue();
  #hooks = new HookRegistry<AcmeEventHookTarget, StoredEvent, Registration>(this.ctx.storage.kv, () => {
    logger.warn("dropped an Acme Service event after repeated delivery failures", { event: "hooks.delivery.dropped" });
  });

  async register(key: string, registration: Registration, capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
    kv.put("account", registration.userObjectId);
    await this.#changes.run(async () => {
      await this.#ensureWebhook(registration.itemId);
      // Recorded in the same change, so a removal queued after it sees this hook.
      this.ctx.storage.transactionSync(() => this.#hooks.set(key, registration, capabilities));
    });
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    // In turn, so that it finds a hook whose enabling is still under way.
    await this.#changes.run(async () => {
      const registration = this.#hooks.remove(key);
      if (registration) await this.#deleteUnwatched(registration.itemId);
    });
    await this.#reschedule();
  }

  /**
   * The connection is being disconnected, while its credential still works: stop delivering for
   * good, and delete its webhooks, which the provider would otherwise keep delivering to. Called
   * again after the provider failed to delete some, it tries those again.
   * @returns Whether every webhook is gone, or beyond this connection's deleting.
   */
  async revoke(): Promise<boolean> {
    const kv = this.ctx.storage.kv;
    if (!kv.get("revoked")) {
      // Listed in full before any is deleted. The webhooks, and the account that deletes them,
      // stay until they are gone.
      for (const [key, value] of Array.from(kv.list())) {
        if (key === "account" || key.startsWith("webhook:")) continue;
        if (key.startsWith("caps:")) disposeStubs(value as Capabilities);
        kv.delete(key);
      }
      // Refused from now on even if never used: a first enable could otherwise come between this
      // answer and the credential's end, and add a webhook nothing would delete.
      kv.put("revoked", true);
    }
    // A change in flight finishes first, recording what it added for this to delete.
    const gone = await this.#changes.run(async () => {
      await Promise.all(this.#webhooks().map(webhook => this.#deleteWebhook(webhook)));
      return this.#webhooks().length === 0;
    });
    if (gone) kv.delete("account");
    await this.#reschedule();
    return gone;
  }

  /**
   * Verify one delivery and queue its event for each hook that watches for it.
   * @returns The HTTP status to answer the provider with.
   */
  async ingest(signature: string, delivered: ReadableStream<Uint8Array>): Promise<number> {
    const kv = this.ctx.storage.kv;
    const secret = kv.get<string>("secret");
    if (!secret || kv.get("revoked")) {
      await delivered.cancel();
      return 404;
    }
    let body: Uint8Array;
    try {
      body = await readBytesCapped(new Response(delivered), MAX_DELIVERY_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) return 413;
      throw error;
    }
    if (!await signed(secret, signature, body)) return 401;
    const event = parseDelivery(body);
    // No longer this driver's webhook: every hook on the item has been disabled.
    if (!event || !kv.get(webhookKey(event.itemId))) return 204;
    const now = Date.now();
    const watching = this.#registrations(event.itemId);
    for (const [key] of watching) this.#hooks.enqueue(key, event.id, event, now);
    if (watching.length > 0) await this.#wakeBy(now);
    return 204;
  }

  /** The driver's one alarm: the hourly check of its webhooks, and whatever delivery is due. */
  async alarm(): Promise<void> {
    if ((this.ctx.storage.kv.get<number>("checkAt") ?? Infinity) <= Date.now()) await this.#checkWebhooks();
    await this.#hooks.run(Date.now());
    await this.#reschedule();
  }

  // STOP(webhook-upkeep): What the provider's webhooks need kept up. One that expires is renewed
  // here before it does; one the provider turns off after failed deliveries is turned back on; and
  // where the provider does not retry a failed delivery itself, ask it to redeliver what it lists
  // as failed (gatekeeper-github's hourly check does all three for GitHub).
  /** Delete each webhook no hook needs any more, and add again each one that is gone. */
  async #checkWebhooks(): Promise<void> {
    this.ctx.storage.kv.put("checkAt", Date.now() + HOUR_MS);
    for (const { id, itemId } of this.#webhooks()) {
      await this.#changes.run(async () => {
        // Removed or replaced while this check waited its turn.
        if (this.ctx.storage.kv.get<Webhook>(webhookKey(itemId))?.id !== id) return;
        if (this.#registrations(itemId).length === 0) return await this.#deleteUnwatched(itemId);
        const found = await this.#api(api => api.get("/items/{id}/webhooks/{webhook}", { path: { id: itemId, webhook: id } }))
          .catch((error: unknown) => {
            if (error instanceof HttpError && error.status === 404) return undefined;
            throw error;
          });
        if (found !== undefined) return;
        // Its record stays until the new one replaces it, so a failure here is found again.
        await this.#addWebhook(itemId);
        logger.info("added again an Acme Service webhook that was gone", { event: "hooks.webhook.restored" });
      }).catch((error: unknown) => {
        // Tried again at the next check.
        logger.warn("failed to check an Acme Service webhook", { event: "hooks.webhook.check.failed", error });
      });
    }
  }

  // STOP(webhook-subscription): How the provider's API adds a webhook: the call, what it is scoped
  // to (an object, a project, the account), the events to ask for, and whether the provider signs
  // with a secret given here or one it answers with. If its answer can be lost and it lets two
  // webhooks stand at one URL, look for the one already there before adding (gatekeeper-github's
  // `unrecorded:` records do). The user approved the hook, not a provider write: say in the hook's
  // description that enabling it adds a webhook, if the provider shows one to other people.
  /** Give `itemId` this driver's webhook, unless it has one on record. */
  async #ensureWebhook(itemId: string): Promise<void> {
    if (this.ctx.storage.kv.get("revoked")) throw new Error(DISCONNECTED);
    if (!this.ctx.storage.kv.get(webhookKey(itemId))) await this.#addWebhook(itemId);
  }

  /** Add a webhook to `itemId`, and record it as the item's. */
  async #addWebhook(itemId: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const base = webhookBase(this.env);
    if (base === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
    let secret = kv.get<string>("secret");
    if (secret === undefined) {
      secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
      kv.put("secret", secret);
    }
    const url = `${base}/webhook/${this.ctx.id}`;
    const { id } = await this.#api(api => api.post("/items/{id}/webhooks", { path: { id: itemId }, body: { url, secret } }));
    kv.put<Webhook>(webhookKey(itemId), { id, itemId });
    // Disconnected meanwhile: revoke(), which waits for this change, deletes what it recorded.
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
  }

  /** Delete `itemId`'s webhook if no hook watches the item any more. Never throws: disabling must not fail. */
  async #deleteUnwatched(itemId: string): Promise<void> {
    const webhook = this.ctx.storage.kv.get<Webhook>(webhookKey(itemId));
    if (webhook && this.#registrations(itemId).length === 0) await this.#deleteWebhook(webhook);
  }

  /**
   * Delete a webhook at the provider, and its record once the provider has, or can't: a refusal
   * is final, and whoever administers the item can delete it. The record stays while the provider
   * may yet delete it if asked again, which `revoke()` and the hourly check do.
   */
  async #deleteWebhook({ id, itemId }: Webhook): Promise<void> {
    try {
      await this.#api(api => api.delete("/items/{id}/webhooks/{webhook}", { path: { id: itemId, webhook: id } }));
    } catch (error) {
      if (retryable(error)) {
        logger.warn("failed to delete an Acme Service webhook, which is tried again", { event: "hooks.webhook.delete.failed", error });
        return;
      }
      if (!(error instanceof HttpError && error.status === 404)) {
        logger.error("left an Acme Service webhook the connection can't delete", { event: "hooks.webhook.delete.abandoned", error });
      }
    }
    // Only if still this one: a webhook added since, for a later hook, is another's to delete.
    if (this.ctx.storage.kv.get<Webhook>(webhookKey(itemId))?.id === id) this.ctx.storage.kv.delete(webhookKey(itemId));
  }

  /** Calls the provider as the connection, which may change its own webhooks. */
  #api<T>(op: (api: Rest) => Promise<T>): Promise<T> {
    const account = this.ctx.storage.kv.get<string>("account")!;
    return accountSource(this.ctx.exports, account).run(creds => op(createApi(creds.accessToken, "write")));
  }

  #webhooks(): Webhook[] {
    return Array.from(this.ctx.storage.kv.list<Webhook>({ prefix: "webhook:" }), ([, webhook]) => webhook);
  }

  /** The enabled hooks on `itemId`, by key. */
  #registrations(itemId: string): [string, Registration][] {
    return this.#hooks.entries().filter(([, registration]) => registration.itemId === itemId);
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }

  /** Set the alarm for the earlier of the next delivery and, while there are webhooks, their next check. */
  async #reschedule(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const times = [this.#hooks.nextDue()].filter(due => due !== undefined);
    if (this.#webhooks().length > 0) {
      let checkAt = kv.get<number>("checkAt");
      if (checkAt === undefined) kv.put("checkAt", checkAt = Date.now() + HOUR_MS);
      times.push(checkAt);
    } else {
      kv.delete("checkAt");
    }
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
}

/**
 * Handle one delivery to `POST {BASE_URL}{path}`, where `path` names the driver whose webhook it
 * is, which reads and verifies the body, as only it has the secret.
 */
export async function handleWebhook(request: Request, path: string, env: Env, exports: Cloudflare.Exports): Promise<Response> {
  let id: DurableObjectId;
  try {
    if (!hooksConfigured(env)) throw new Error(HOOKS_NOT_CONFIGURED);
    id = exports.AcmeHookDriver.idFromString(path.slice("/webhook/".length));
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature || !request.body) return new Response("Unauthorized", { status: 401 });
  // An early refusal, sparing the driver; it enforces the cap itself as it reads.
  if (Number(request.headers.get("Content-Length")) > MAX_DELIVERY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  return new Response(null, { status: await exports.AcmeHookDriver.get(id).ingest(signature, request.body) });
}
