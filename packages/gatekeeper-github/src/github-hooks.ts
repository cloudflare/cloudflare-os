// GitHub event hooks: one repository webhook per (connected account, repository), delivered to
// `POST {WEBHOOK_ORIGIN}{BASE_URL's path}/webhook/{driver id}`.
//
// `subscribe()` runs in the connection's facet, which mints a persistent stub to itself for
// delivery (an event's issue and pull request capabilities queue actions in the facet's storage, so
// the facet must build them) and binds a `GitHubHookController` carrying that stub in its props.
// As for Google Chat's hooks, the controller is a loopback entrypoint rather than the facet,
// because removing a connection deletes the facet in the same turn as it fires the unawaited
// `disable()`, which therefore only reaches a controller living outside the facet.
//
// One `GitHubHookDriver` per connected account holds its enabled hooks and its webhooks. It adds a
// webhook to a repository when the first hook there is enabled and deletes it with the last,
// verifies each delivery's signature, queues each event once for every hook that watches for it,
// and retries failed deliveries from its alarm. Hourly, it checks each webhook on GitHub, restoring
// one that someone has changed and asking GitHub to redeliver what GitHub failed to deliver.
// Disconnecting the account deletes its webhooks.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { isCredentialsExpired } from "@gadgets/gatekeeper-kit/credentials";
import {
  DELIVERED_RETENTION_MS, HookDeliveryQueue, disposeStubs,
} from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  GitHubApiError, withAccountApi,
  type GitHubApi, type GitHubRepoWebhookResponse, type GitHubWebhookDeliveryResponse, type PinnedRepo,
} from "./github-api";
import { getBasePath, webhookOrigin, type Env } from "./github-env";
import { parseWebhookEvent, type GitHubWebhookEvent, type WebhookPayload } from "./github-webhook-events";
import { obsContext } from "./observability";
import type { GitHubEventHook, GitHubEventKind } from "./types";

const logger = obsContext.createLogger({ component: "gatekeeper.github.hooks", vendorId: "github" });

export const HOOKS_NOT_CONFIGURED = "GitHub hooks are not configured on this deployment.";

export type GitHubEventHookTarget = RpcTarget & GitHubEventHook;

/**
 * Where a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`: everything
 * the binding watches, or (`number`) one issue or pull request in it.
 */
export type GitHubHookParams = { number?: number };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface GitHubHookDelivery extends RpcTarget {
  /**
   * Deliver `event` to one firing of the hook, as `HookInitiator.startHook()` returned it, if the
   * binding admits it; otherwise return without calling it.
   */
  deliver(callback: RpcStub<GitHubEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          event: GitHubWebhookEvent): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type GitHubHookProps = GitHubHookParams & {
  key: string;
  userObjectId: string;
  repo: PinnedRepo;
  events: GitHubEventKind[];
  delivery: RpcStub<GitHubHookDelivery>;
};

@validateRpc()
export class GitHubHookController extends WorkerEntrypoint<Env, GitHubHookProps>
    implements HookController<GitHubEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<GitHubEventHookTarget>>,
               _target: HookTargetMetadata): Promise<void> {
    const { key, userObjectId, delivery, ...registration } = this.ctx.props;
    await this.#driver().register(key, userObjectId, registration, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  async disable(): Promise<void> {
    await this.#driver().unregister(this.ctx.props.key);
  }

  #driver() {
    return this.ctx.exports.GitHubHookDriver.getByName(this.ctx.props.userObjectId);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** The webhook events that report each kind of event a hook can watch for. */
const WEBHOOK_EVENTS: Record<GitHubEventKind, string[]> = {
  issue: ["issues"],
  pullRequest: ["pull_request"],
  comment: ["issue_comment", "pull_request_review_comment"],
  review: ["pull_request_review"],
  push: ["push"],
  tag: ["push"],
};

const DISCONNECTED = "This GitHub account has been disconnected.";

const HOUR_MS = 60 * 60 * 1000;
/** How often the driver checks its webhooks on GitHub (see #checkWebhook). */
const CHECK_INTERVAL_MS = HOUR_MS;
/** How far back a check reads a webhook's deliveries: two checks' worth, so none falls between. */
const DELIVERY_LOOKBACK_MS = 2 * CHECK_INTERVAL_MS;
/**
 * How many redeliveries one check may ask GitHub for, shared fairly among the account's
 * repositories and oldest first within each; the rest wait for the next check, and are lost if they
 * age out of its lookback first. One that fails again is asked for again at the next check, until
 * GitHub stops allowing it after three days: that keeps failures recoverable through an outage, for
 * this many requests an hour at most.
 */
const MAX_REDELIVERIES_PER_CHECK = 20;
/**
 * The statuses the worker refuses a delivery with for good (see handleWebhookRequest() and
 * ingest()), which a redelivery would only repeat -- unless the refusal came before the check last
 * repaired the webhook (see undelivered()).
 */
const FINAL_REFUSALS = new Set([400, 404, 413]);

type Registration = Omit<GitHubHookProps, "key" | "userObjectId" | "delivery">;
type Capabilities = {
  delivery: RpcStub<GitHubHookDelivery>;
  initiator: Fetcher<HookInitiator<GitHubEventHookTarget>>;
};
/** A webhook this driver added to a repository. */
type Webhook = { id: number; repo: PinnedRepo };
/** A webhook this driver asked GitHub to add or change at `url`, whose id it may never have learned. */
type Unrecorded = { repo: PinnedRepo; url: string };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;
const webhookKey = (repoId: number) => `webhook:${repoId}`;
const unrecordedKey = (repoId: number, url: string) => `unrecorded:${repoId}:${url}`;
const repairedKey = (repoId: number) => `repaired:${repoId}`;

/**
 * One per connected account, named by its `UserAccount` id. Storage: `account` (that id), `viewer`
 * (the GitHub user id the account last read as), `secret` (the HMAC key its webhooks sign
 * deliveries with), per repository `webhook:` and `repaired:` (when its configuration was last
 * restored), `checkAt` (when to next check them on GitHub), `redeliverFrom` (the repository the
 * next check's redeliveries start with), `reg:`/`caps:` per hook, the delivery queue's `msg:` rows
 * and `queue:` indexes, and `revoked` once the account is disconnected, which refuses everything
 * for good. A webhook stays on record until GitHub has deleted it, or can't, and `account` with
 * it; `unrecorded:` notes, per repository and URL, a webhook GitHub was asked to add or change while
 * its id is yet to be recorded, so that one added though GitHub's answer was lost is found and
 * deleted.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class GitHubHookDriver extends DurableObject<Env> {
  /**
   * Webhook additions and removals, which run one at a time so that each sees what the last did:
   * a removal still in flight would otherwise delete the webhook an addition just adopted.
   */
  #webhookChanges = new SerialTaskQueue();
  /**
   * Reads of who the account is, which run one at a time so that a reconnect's, made as the new
   * user, is written last: a read still waiting on GitHub as the old one would otherwise land after
   * it.
   */
  #viewerReads = new SerialTaskQueue();
  #queue = new HookDeliveryQueue<GitHubWebhookEvent>(this.ctx.storage.kv, () => {
    logger.warn("dropped a GitHub event after repeated delivery failures", { event: "hooks.delivery.dropped" });
  });

  async register(key: string, userObjectId: string, registration: Registration,
                 capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
    kv.put("account", userObjectId);
    const { repo } = registration;
    await this.#webhookChanges.run(async () => {
      // Disconnected while an earlier change ran.
      if (kv.get("revoked")) throw new Error(DISCONNECTED);
      await this.#readViewer(userObjectId);
      const others = this.#registrations(repo).filter(([regKey]) => regKey !== registrationKey(key));
      await this.#ensureWebhook(repo, [registration, ...others.map(([, other]) => other)]);
      // Recorded in the same change, so a removal queued after it sees this hook.
      const replaced = kv.get<Capabilities>(capabilitiesKey(key));
      kv.put(registrationKey(key), registration);
      kv.put(capabilitiesKey(key), capabilities);
      disposeStubs(replaced);
    });
    await this.#reschedule();
  }

  async unregister(key: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    const registration = kv.get<Registration>(registrationKey(key));
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
    if (!registration) return;
    const { repo } = registration;
    await this.#webhookChanges.run(async () => {
      const webhook = kv.get<Webhook>(webhookKey(repo.id));
      if (!webhook) return;
      const remaining = this.#registrations(repo).map(([, other]) => other);
      if (remaining.length > 0) {
        // Narrowed to what the remaining hooks watch. Best effort, since disabling must not fail:
        // until an enable or the hourly check narrows it, deliveries no hook watches are only
        // filtered out here.
        await this.#ensureWebhook(repo, remaining).catch((error: unknown) => {
          logger.warn("failed to narrow a GitHub webhook's events", { event: "hooks.webhook.narrow.failed", error });
        });
        return;
      }
      // The repository's last hook: rather than leave GitHub delivering there, remove the webhook.
      kv.delete(repairedKey(repo.id));
      await this.#deleteWebhook(kv.get<string>("account")!, webhook);
    });
    await this.#reschedule();
  }

  /**
   * The account is being disconnected, while its token still works: stop delivering for good, and
   * delete its webhooks, which GitHub would otherwise keep delivering to. Called again after GitHub
   * failed to delete some, it tries those again.
   * @returns Whether every webhook is gone, or beyond the account's deleting; false while GitHub may
   *   yet delete one, which needs the account's token: the hourly check tries again meanwhile.
   */
  async revoke(): Promise<boolean> {
    const kv = this.ctx.storage.kv;
    const account = kv.get<string>("account");
    if (account === undefined) {
      // Never used, or done. Refused from now on all the same: a first enable could otherwise come
      // between this answer and the token's revocation, and add a webhook nothing would delete.
      kv.put("revoked", true);
      return true;
    }
    if (!kv.get("revoked")) {
      // Listed in full before any is deleted. The webhooks, and the account that deletes them, stay
      // until they are gone.
      for (const [key, value] of Array.from(kv.list())) {
        if (key === "account" || key.startsWith("webhook:") || key.startsWith("unrecorded:")) continue;
        if (key.startsWith("caps:")) disposeStubs(value as Capabilities);
        kv.delete(key);
      }
      kv.put("revoked", true);
    }
    // A change in flight finishes first, recording what it added for this to delete.
    const gone = await this.#webhookChanges.run(async () => {
      await Promise.all([
        ...this.#webhooks().map(webhook => this.#deleteWebhook(account, webhook)),
        ...this.#unrecorded().map(unrecorded => this.#deleteUnrecorded(account, unrecorded)),
      ]);
      return this.#webhooks().length === 0 && this.#unrecorded().length === 0;
    });
    if (gone) kv.delete("account");
    await this.#reschedule();
    return gone;
  }

  /**
   * The account's credentials were replaced, perhaps by another GitHub user's, whose own comments
   * and reviews are then the ones its hooks skip (see UserAccount.commitReconnect()).
   */
  async reconnected(): Promise<void> {
    const account = this.ctx.storage.kv.get<string>("account");
    if (account === undefined || this.ctx.storage.kv.get("revoked")) return;
    await this.#readViewer(account);
  }

  /**
   * Verify one webhook delivery and queue its event for each hook that watches for it.
   * @returns The HTTP status to answer GitHub with.
   */
  async ingest(name: string, signature: string, delivered: ReadableStream<Uint8Array>): Promise<number> {
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
    if (!await verifySignature(secret, signature, body)) return 401;
    // Sent as GitHub adds a webhook, perhaps before this driver has recorded it.
    if (name === "ping") return 204;
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return 400;
    }
    const repoId = payload?.repository?.id;
    // No longer this driver's webhook: every hook on the repository has been disabled.
    if (typeof repoId !== "number" || !kv.get(webhookKey(repoId))) return 404;
    // Named by its content, which the signature covers, so that a signed payload replayed under a
    // fresh delivery id is collapsed like a redelivery; and refused once older than that dedupe
    // window, by its own timestamps.
    const id = hex(await crypto.subtle.digest("SHA-256", body));
    const parsed = parseWebhookEvent(name, id, payload);
    if (!parsed) return 204;
    const now = Date.now();
    if (!Number.isFinite(parsed.at)) {
      // Nothing would stop its replay once its dedupe row is forgotten.
      logger.warn("refused a GitHub event with no usable timestamp", { event: "hooks.delivery.untimed" });
      return 204;
    }
    if (parsed.at < now - DELIVERED_RETENTION_MS) return 204;
    const { event, senderId } = parsed;
    // Read before any hook is registered (see register()), and kept until the account disconnects.
    const viewerId = kv.get<number>("viewer")!;
    let queued = false;
    for (const [regKey, registration] of this.#registrations({ id: repoId })) {
      if (!watches(registration, event, senderId, viewerId)) continue;
      this.#queue.enqueue(regKey.slice("reg:".length), id, event, now);
      queued = true;
    }
    if (queued) await this.#wakeBy(now);
    return 204;
  }

  /**
   * The driver's one alarm, which #wakeBy() and #reschedule() set for the earliest time either of
   * these is due:
   * - checking its webhooks on GitHub, hourly while it has any;
   * - delivering each queued event whose (re)try time has come, and forgetting finished ones.
   */
  async alarm(): Promise<void> {
    if ((this.ctx.storage.kv.get<number>("checkAt") ?? Infinity) <= Date.now()) await this.#checkWebhooks();
    await this.#queue.run(Date.now(), (hookKey, event) => this.#deliver(hookKey, event));
    await this.#reschedule();
  }

  async #deliver(hookKey: string, event: GitHubWebhookEvent): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(hookKey));
    if (!capabilities) return;
    try {
      // A refused firing is retried like a failed one, being indistinguishable from a transient
      // failure; disabling or deleting the hook unregisters it, which ends the retries. Awaited,
      // not pipelined: workerd can't pass a property of a pending result into another call.
      using hook = await capabilities.initiator.startHook();
      // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
      await capabilities.delivery.deliver(hook.callback, hook.approvalQueue, event);
    } finally {
      disposeStubs(capabilities);
    }
  }

  /**
   * Check each webhook on GitHub (see #checkWebhook), then ask GitHub to redeliver what it failed to
   * deliver to them, sharing one budget among them so that a busy repository can't starve the rest.
   */
  async #checkWebhooks(): Promise<void> {
    const kv = this.ctx.storage.kv;
    kv.put("checkAt", Date.now() + CHECK_INTERVAL_MS);
    const account = kv.get<string>("account");
    if (account === undefined) return;
    // Undefined while this deployment has hooks turned off, when only deletions go on.
    const url = this.#webhookUrl();
    // In case a reconnect's notice to this driver was lost.
    if (url !== undefined && !kv.get("revoked")) {
      await this.#readViewer(account).catch((error: unknown) => {
        logger.warn("failed to read who a GitHub account is", { event: "hooks.viewer.read.failed", error });
      });
    }
    for (const unrecorded of this.#unrecorded()) {
      // Unless it is the webhook of the hooks there, at the URL they deliver to, which just went
      // unrecorded: one at another, as before WEBHOOK_ORIGIN changed, is no hook's.
      const needed = () => this.#registrations(unrecorded.repo).length > 0 && (url === undefined || unrecorded.url === url);
      if (needed()) continue;
      await this.#webhookChanges.run(async () => {
        if (!needed()) await this.#deleteUnrecorded(account, unrecorded);
      }).catch((error: unknown) => {
        logger.warn("failed to delete a GitHub webhook", { event: "hooks.webhook.delete.failed", error });
      });
    }
    const checked: { webhook: Webhook; failed: GitHubWebhookDeliveryResponse[] }[] = [];
    for (const webhook of this.#webhooks()) {
      try {
        if (this.#registrations(webhook.repo).length === 0) {
          // No hook needs it any more: GitHub failed to delete it as the last was disabled, or as
          // the account was disconnected.
          await this.#webhookChanges.run(async () => {
            if (this.#registrations(webhook.repo).length === 0) await this.#deleteWebhook(account, webhook);
          });
          continue;
        }
        if (url !== undefined) checked.push({ webhook, failed: await this.#checkWebhook(account, url, webhook) });
      } catch (error) {
        // Tried again at the next check.
        logger.warn("failed to check a GitHub webhook", { event: "hooks.webhook.check.failed", error });
      }
    }
    // Started where the last check's split stopped: when more repositories need redeliveries than
    // a check makes, those one check leaves out go first in the next.
    const from = Math.max(0, checked.findIndex(({ webhook }) => webhook.repo.id === kv.get<number>("redeliverFrom")));
    const { shares, next } = fairShares(checked.map(({ failed }) => failed.length), MAX_REDELIVERIES_PER_CHECK, from);
    if (checked.length > 0) kv.put("redeliverFrom", checked[next]!.webhook.repo.id);
    for (const [i, { webhook: { id, repo }, failed }] of checked.entries()) {
      if (shares[i] === 0) continue;
      try {
        await this.#api(account, repo, async api => {
          for (const { id: deliveryId } of failed.slice(0, shares[i])) {
            await api.redeliverRepoWebhookDelivery(repo.id, id, deliveryId);
          }
        });
      } catch (error) {
        // The rest are asked for again at the next check, while it still reads them.
        logger.warn("failed to have GitHub redeliver to a webhook", { event: "hooks.webhook.redeliver.failed", error });
      }
    }
  }

  /**
   * Bring `webhook` back to what its hooks need if it no longer matches: deleted, deactivated,
   * pointed elsewhere, sending form-encoded payloads, not verifying this deployment's certificate,
   * subscribed to other events, or signing with another secret or none: GitHub never shows the
   * secret, but either fails deliveries here with 401.
   * @returns What GitHub failed to deliver to it lately, oldest first, to ask it to redeliver, as it
   *   never does itself.
   */
  async #checkWebhook(account: string, url: string, { id, repo }: Webhook): Promise<GitHubWebhookDeliveryResponse[]> {
    const read = await this.#api(account, repo, async api => {
      try {
        const found = await api.getRepoWebhook(repo.id, id);
        const since = Date.now() - DELIVERY_LOOKBACK_MS;
        return { found, deliveries: await api.listRepoWebhookDeliveries(repo.id, id, since) };
      } catch (error) {
        // Deleted, and its deliveries with it.
        if (error instanceof GitHubApiError && error.status === 404) return undefined;
        throw error;
      }
    });
    const events = webhookEvents(this.#registrations(repo).map(([, registration]) => registration));
    const intact = read !== undefined && deliversHere(read.found, url) && sameEvents(read.found.events ?? [], events)
      // By each delivery's latest attempt, so a 401 since redelivered successfully doesn't count.
      && !undelivered(read.deliveries).some(({ status_code }) => status_code === 401);
    if (!intact) {
      await this.#webhookChanges.run(async () => {
        const kv = this.ctx.storage.kv;
        // Removed or replaced while this check read it.
        if (kv.get<Webhook>(webhookKey(repo.id))?.id !== id) return;
        await this.#ensureWebhook(repo, this.#registrations(repo).map(([, registration]) => registration));
        kv.put(repairedKey(repo.id), Date.now());
        logger.info("reconfigured a GitHub webhook that no longer matched its hooks", {
          event: "hooks.webhook.reconfigured",
        });
      });
    }
    if (read === undefined) return [];
    const { deliveries } = read;
    if (deliveries.length > 0 && !deliveries.some(delivered)) {
      logger.error("GitHub failed every recent delivery to this deployment", {
        event: "hooks.webhook.deliveries.failing",
        deliveryStatuses: [...new Set(deliveries.map(({ status_code }) => status_code))],
      });
    }
    return undelivered(deliveries, this.ctx.storage.kv.get<number>(repairedKey(repo.id)));
  }

  /**
   * Give `repo` this driver's webhook, configured as it must be for `registrations`, the hooks it
   * serves: the recorded one, which an admin may have edited or deleted since; or the one an earlier
   * attempt left at this driver's URL unrecorded, which GitHub would let a new one stand beside if
   * their events differ; or a new one.
   */
  async #ensureWebhook(repo: PinnedRepo, registrations: Registration[]): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
    const account = kv.get<string>("account")!;
    const url = this.#webhookUrl();
    if (url === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
    let secret = kv.get<string>("secret");
    if (secret === undefined) {
      secret = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
      kv.put("secret", secret);
    }
    const config = { url, secret, events: webhookEvents(registrations) };
    const recorded = kv.get<Webhook>(webhookKey(repo.id));
    // Until the webhook GitHub answers with is recorded, in case its answer is lost; and the hourly
    // check that would then delete it scheduled now, before GitHub is asked, as nothing after may
    // run should this object restart meanwhile.
    kv.put<Unrecorded>(unrecordedKey(repo.id, url), { repo, url });
    await this.#reschedule();
    // `repaired` when it didn't deliver here until this restored it, as the hourly check would have.
    let made: { id: number; repaired: boolean };
    try {
      made = await this.#api(account, repo, async api => {
        if (recorded) {
          try {
            const repaired = !deliversHere(await api.getRepoWebhook(repo.id, recorded.id), url);
            return { id: (await api.updateRepoWebhook(repo.id, recorded.id, config)).id, repaired };
          } catch (error) {
            if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
          }
        }
        const existing = (await api.listRepoWebhooks(repo.id)).find(webhook => webhook.config.url === url);
        if (existing) {
          return { id: (await api.updateRepoWebhook(repo.id, existing.id, config)).id, repaired: !deliversHere(existing, url) };
        }
        return { id: (await api.createRepoWebhook(repo.id, config)).id, repaired: false };
      });
    } catch (error) {
      throw webhookRefusal(repo, error);
    }
    kv.put<Webhook>(webhookKey(repo.id), { id: made.id, repo });
    kv.delete(unrecordedKey(repo.id, url));
    // Disconnected meanwhile: revoke(), which waits for this change, deletes what it recorded.
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
    if (made.repaired) kv.put(repairedKey(repo.id), Date.now());
  }

  /**
   * Delete a webhook from GitHub, and its record once GitHub has, or can't: one beyond the account's
   * deleting, as when it has lost admin rights over the repository, is answered 404 here, and the
   * repository's admins can delete it. The record stays while GitHub may yet delete it if asked
   * again, which revoke() and the hourly check do.
   */
  async #deleteWebhook(account: string, { id, repo }: Webhook): Promise<void> {
    if (!await this.#settled(account, repo, api => api.deleteRepoWebhook(repo.id, id))) return;
    // Only if still this one: a webhook added since, for a later hook, is another's to delete.
    if (this.ctx.storage.kv.get<Webhook>(webhookKey(repo.id))?.id === id) this.ctx.storage.kv.delete(webhookKey(repo.id));
  }

  /** Delete the webhooks GitHub has at `url` on `repo`, if any, then forget it, as #deleteWebhook() does. */
  async #deleteUnrecorded(account: string, { repo, url }: Unrecorded): Promise<void> {
    const settled = await this.#settled(account, repo, async api => {
      for (const found of (await api.listRepoWebhooks(repo.id)).filter(webhook => webhook.config.url === url)) {
        await api.deleteRepoWebhook(repo.id, found.id);
      }
    });
    if (settled) this.ctx.storage.kv.delete(unrecordedKey(repo.id, url));
  }

  /**
   * Take a step towards deleting a webhook from GitHub.
   * @returns Whether that is settled: done, or beyond the account (a 404 meaning done already);
   *   false while GitHub may yet allow it, if asked again.
   */
  async #settled(account: string, repo: PinnedRepo, step: (api: GitHubApi) => Promise<unknown>): Promise<boolean> {
    try {
      await this.#api(account, repo, step);
    } catch (error) {
      if (retryable(error)) {
        logger.warn("failed to delete a GitHub webhook, which is tried again", { event: "hooks.webhook.delete.failed", error });
        return false;
      }
      // Otherwise, only the repository's admins can delete it now.
      if (!(error instanceof GitHubApiError && error.status === 404)) {
        logger.error("left a GitHub webhook the account can't delete", { event: "hooks.webhook.delete.abandoned", error });
      }
    }
    return true;
  }

  /** Read the GitHub user the account now is, whose own comments and reviews its hooks skip. */
  async #readViewer(account: string): Promise<void> {
    await this.#viewerReads.run(async () => {
      const { UserAccount } = this.ctx.exports;
      const { user } = await withAccountApi(UserAccount.get(UserAccount.idFromString(account)), api => api.getViewer());
      this.ctx.storage.kv.put("viewer", user.id);
    });
  }

  #api<T>(account: string, repo: PinnedRepo, fn: (api: GitHubApi) => Promise<T>): Promise<T> {
    const { UserAccount } = this.ctx.exports;
    return withAccountApi(UserAccount.get(UserAccount.idFromString(account)), fn, { repo });
  }

  /** Where this driver's webhooks deliver, unless this deployment has not configured hooks. */
  #webhookUrl(): string | undefined {
    const origin = webhookOrigin(this.env);
    return origin === undefined ? undefined : `${origin}${getBasePath(this.env)}/webhook/${this.ctx.id}`;
  }

  /** The webhooks this driver has added, one per repository. */
  #webhooks(): Webhook[] {
    return [...this.ctx.storage.kv.list<Webhook>({ prefix: "webhook:" })].map(([, webhook]) => webhook);
  }

  /** The webhooks GitHub was asked to add or change that are yet to be recorded. */
  #unrecorded(): Unrecorded[] {
    return [...this.ctx.storage.kv.list<Unrecorded>({ prefix: "unrecorded:" })].map(([, unrecorded]) => unrecorded);
  }

  /** The enabled hooks on `repo`, by their storage key. */
  #registrations(repo: Pick<PinnedRepo, "id">): [string, Registration][] {
    return [...this.ctx.storage.kv.list<Registration>({ prefix: "reg:" })]
      .filter(([, registration]) => registration.repo.id === repo.id);
  }

  async #wakeBy(time: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || time < current) await this.ctx.storage.setAlarm(time);
  }

  /**
   * Set the alarm for the earliest of the next delivery due and, while this driver has webhooks,
   * their next check; or clear it, if neither is pending.
   */
  async #reschedule(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const times: number[] = [];
    const due = this.#queue.nextDue();
    if (due !== undefined) times.push(due);
    if (this.#webhooks().length > 0 || this.#unrecorded().length > 0) {
      let checkAt = kv.get<number>("checkAt");
      if (checkAt === undefined) kv.put("checkAt", checkAt = Date.now() + CHECK_INTERVAL_MS);
      times.push(checkAt);
    } else {
      kv.delete("checkAt");
    }
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }
}

/**
 * Whether a hook on the event's repository watches for it, the account being GitHub user
 * `viewerId`. The facet re-checks the binding's scope at delivery.
 */
function watches({ number, events }: Registration, event: GitHubWebhookEvent,
                 senderId: number | undefined, viewerId: number): boolean {
  if (!events.includes(event.kind)) return false;
  if (number !== undefined && !("number" in event && event.number === number)) return false;
  // Never hand the account's own comments and reviews back to it, which a hook would answer.
  return !((event.kind === "comment" || event.kind === "review") && senderId === viewerId);
}

/** The webhook events GitHub must deliver for `registrations`. */
function webhookEvents(registrations: Registration[]): string[] {
  return [...new Set(registrations.flatMap(({ events }) => events.flatMap(kind => WEBHOOK_EVENTS[kind])))];
}

const sameEvents = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length && expected.every(event => actual.includes(event));

const delivered = ({ status_code }: GitHubWebhookDeliveryResponse) => status_code >= 200 && status_code < 300;

/**
 * Whether a request GitHub failed may succeed if made again: GitHub erred or limited it, or never
 * answered, rather than refusing it, and the account's token is not known to be dead. A 401 is no
 * refusal here: withAccountApi() reports a confirmed expiry as such, so a bare 401 is one it could
 * not adjudicate, as while GitHub fails to renew the token.
 */
function retryable(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return error.status >= 500 || error.status === 401 || error.rateLimited;
  }
  // A confirmed expiry, which withAccountApi() wraps.
  return !isCredentialsExpired((error as { cause?: unknown } | undefined)?.cause);
}

/**
 * Whether `webhook` delivers here as the driver configures it: active, to this deployment, as JSON,
 * verifying its certificate. What it refused while it didn't may have been refused for that alone.
 */
function deliversHere(webhook: GitHubRepoWebhookResponse, url: string): boolean {
  return webhook.active === true && webhook.config.url === url && webhook.config.content_type === "json"
    && String(webhook.config.insecure_ssl) === "0";
}

/**
 * What to ask GitHub to redeliver, oldest first: each delivery whose latest attempt failed, unless
 * the worker refused it for good. A refusal made before `repairedAt`, when the webhook's
 * configuration was last restored, by the hourly check or by enabling or disabling a hook there,
 * may have been the misconfiguration's -- a form-encoded payload's
 * 400, or another receiver's 404 -- so it is redelivered with the rest until it leaves the
 * lookback, since GitHub sends, encodes and signs a redelivery as the webhook is configured now.
 * `deliveries` are newest first. A redelivery of something already received is harmless: ingest()
 * collapses it.
 */
function undelivered(deliveries: GitHubWebhookDeliveryResponse[], repairedAt = -Infinity):
    GitHubWebhookDeliveryResponse[] {
  const latest = new Map<string, GitHubWebhookDeliveryResponse>();
  for (const delivery of deliveries) if (!latest.has(delivery.guid)) latest.set(delivery.guid, delivery);
  return [...latest.values()]
    .filter(delivery => !delivered(delivery) &&
      (!FINAL_REFUSALS.has(delivery.status_code) || Date.parse(delivery.delivered_at) < repairedAt))
    .toReversed();
}

/**
 * Split `budget` among `demands` max-min fairly: one each in turn from `start` while any wants
 * more, so one that wants many can't crowd out one that wants a few.
 * @returns Each share, and `next`, the demand after the last one given a share: where the next
 *   split starts, so that what this one left out comes first then.
 */
function fairShares(demands: number[], budget: number, start = 0): { shares: number[]; next: number } {
  const shares = demands.map(() => 0);
  let next = start;
  for (let left = budget, i = start, idle = 0; left > 0 && idle < demands.length; i = (i + 1) % demands.length) {
    if (shares[i]! < demands[i]!) {
      shares[i]!++;
      left--;
      idle = 0;
      next = (i + 1) % demands.length;
    } else {
      idle++;
    }
  }
  return { shares, next };
}

/** Why GitHub refused to add a webhook, in terms the user can act on. */
function webhookRefusal({ owner, repo }: PinnedRepo, error: unknown): unknown {
  if (!(error instanceof GitHubApiError)) return error;
  if (error.status === 404) {
    return new Error(`GitHub refused to add a webhook to ${owner}/${repo}: only the repository's admins ` +
      "can, and the connected account is not one.", { cause: error });
  }
  const reasons = (error.details as { errors?: { message?: unknown }[] } | undefined)?.errors
    ?.flatMap(({ message }) => typeof message === "string" ? [message] : []) ?? [];
  return new Error(`GitHub refused to add a webhook to ${owner}/${repo}: ` +
    `${[error.message, ...reasons].join("; ")}`, { cause: error });
}

// ── Webhook deliveries ──────────────────────────────────────────────

/**
 * Far above any event delivered here except a push of thousands of commits, which is refused
 * rather than held in memory: anyone who can see a webhook's URL can send a body this large.
 */
const MAX_DELIVERY_BYTES = 5 * 1024 * 1024;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

/**
 * Handle one delivery to `POST {BASE_URL}/webhook/{route}`, as `WEBHOOK_ORIGIN` reaches it, where
 * `route` names the driver whose webhook it is, which reads and verifies the body. GitHub doesn't
 * redeliver a failed delivery on its own.
 */
export async function handleWebhookRequest(request: Request, route: string, env: Env,
                                           exports: Cloudflare.Exports): Promise<Response> {
  let id: DurableObjectId;
  try {
    if (webhookOrigin(env) === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
    id = exports.GitHubHookDriver.idFromString(route);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const name = request.headers.get("X-GitHub-Event");
  if (!name || !request.body) return new Response("Bad Request", { status: 400 });
  // Refused as a wrong signature is, which has the hourly check restore the webhook's secret:
  // GitHub drops it when anyone updates the webhook without restating it.
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature) return new Response("Unauthorized", { status: 401 });
  // An early refusal, sparing the driver; it enforces the cap itself as it reads.
  if (Number(request.headers.get("Content-Length")) > MAX_DELIVERY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  const status = await exports.GitHubHookDriver.get(id).ingest(name, signature, request.body);
  return new Response(null, { status });
}

async function verifySignature(secret: string, header: string, body: Uint8Array): Promise<boolean> {
  const hexDigest = SIGNATURE.exec(header)?.[1];
  if (!hexDigest) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(hexDigest.match(/../g)!, byte => parseInt(byte, 16));
  return await crypto.subtle.verify("HMAC", key, signature, body);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
