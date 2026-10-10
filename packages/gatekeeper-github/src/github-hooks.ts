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
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import {
  DELIVERED_RETENTION_MS, HookDeliveryQueue, disposeStubs,
} from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { actorFromUser } from "./git-commits";
import {
  GitHubApiError, withAccountApi,
  type GitHubApi, type GitHubIssueCommentResponse, type GitHubIssueResponse,
  type GitHubPullRequestResponse, type GitHubPullRequestReviewResponse, type GitHubSimpleUser,
  type GitHubWebhookDeliveryResponse, type PinnedRepo,
} from "./github-api";
import { getBasePath, webhookOrigin, type Env } from "./github-env";
import { obsContext } from "./observability";
import type {
  GitHubActor, GitHubEventHook, GitHubEventKind, GitHubIssueEvent, GitHubPullRequestEvent,
} from "./types";

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
  /** The connected account's GitHub user id: its own comments and reviews are not delivered. */
  viewerId: number;
  delivery: RpcStub<GitHubHookDelivery>;
};

/**
 * GitHub's JSON for an object a webhook delivered, authenticated by the delivery's signature. Its
 * shape is GitHub's, which webhooks spell a little differently from the REST API (`null` for
 * absent values, for one), so it crosses RPC unvalidated, and the facet reads it as the REST type
 * it matches, as it reads REST responses.
 */
export type WebhookJson = Record<string, unknown>;

/** The issue or pull request a comment or review is on. */
type WebhookSubject = { title: string; pullRequest: boolean };

/** One event a webhook delivered, as the driver queues it for each hook and the facet delivers it. */
export type GitHubWebhookEvent = {
  /** A digest of the delivered payload, the same for each delivery of one event. */
  id: string;
  repoId: number;
  actor: GitHubActor | null;
} & (
  | { kind: "issue"; action: GitHubIssueEvent["action"]; number: number; issue: WebhookJson }
  | { kind: "pullRequest"; action: GitHubPullRequestEvent["action"]; number: number; pullRequest: WebhookJson }
  | { kind: "comment"; number: number; subject: WebhookSubject; comment: WebhookJson }
  | { kind: "comment"; number: number; subject: WebhookSubject; diffComment: WebhookJson }
  | { kind: "review"; number: number; subject: WebhookSubject; review: WebhookJson }
  | { kind: "push"; branch: string; before?: string; after?: string; forced: boolean }
  | { kind: "tag"; tag: string; before?: string; after?: string }
);

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
 * How many redeliveries one check may ask GitHub for, oldest first; the rest wait for the next
 * check, and are lost if they age out of its lookback first. One that fails again is asked for
 * again at the next check, until GitHub stops allowing it after three days: that keeps failures
 * recoverable through an outage, for this many requests an hour at most.
 */
const MAX_REDELIVERIES_PER_CHECK = 20;
/**
 * The statuses the worker refuses a delivery with for good (see handleWebhookRequest() and
 * ingest()), which a redelivery would only repeat.
 */
const FINAL_REFUSALS = new Set([400, 404, 413]);

type Registration = Omit<GitHubHookProps, "key" | "userObjectId" | "delivery">;
type Capabilities = {
  delivery: RpcStub<GitHubHookDelivery>;
  initiator: Fetcher<HookInitiator<GitHubEventHookTarget>>;
};
/** A webhook this driver added to a repository. */
type Webhook = { id: number; repo: PinnedRepo };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;
const webhookKey = (repoId: number) => `webhook:${repoId}`;

/**
 * One per connected account, named by its `UserAccount` id. Storage: `account` (that id), `secret`
 * (the HMAC key its webhooks sign deliveries with), `webhook:` per repository, `checkAt` (when to
 * next check them on GitHub), `reg:`/`caps:` per hook, the delivery queue's `msg:` rows, and
 * `revoked` once the account is disconnected, which refuses everything for good.
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
      await this.#removeWebhook(kv.get<string>("account")!, webhook);
      kv.delete(webhookKey(repo.id));
    });
    await this.#reschedule();
  }

  /**
   * The account is being disconnected, while its token still works: stop delivering for good, and
   * delete its webhooks, which GitHub would otherwise keep delivering to.
   */
  async revoke(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const account = kv.get<string>("account");
    // Never used: a hook enabled from now on fails for want of the account's token.
    if (account === undefined) return;
    const webhooks: Webhook[] = [];
    // Listed in full before any is deleted.
    for (const [key, value] of Array.from(kv.list())) {
      if (key.startsWith("webhook:")) webhooks.push(value as Webhook);
      if (key.startsWith("caps:")) disposeStubs(value as Capabilities);
      kv.delete(key);
    }
    kv.put("revoked", true);
    await this.ctx.storage.deleteAlarm();
    // A change in flight finishes first, and an addition then deletes what it added.
    await this.#webhookChanges.run(() =>
      Promise.all(webhooks.map(webhook => this.#removeWebhook(account, webhook))));
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
    let queued = false;
    for (const [regKey, registration] of this.#registrations({ id: repoId })) {
      if (!watches(registration, event, senderId)) continue;
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

  /** Check each webhook on GitHub (see #checkWebhook), within one budget of redeliveries. */
  async #checkWebhooks(): Promise<void> {
    const kv = this.ctx.storage.kv;
    kv.put("checkAt", Date.now() + CHECK_INTERVAL_MS);
    const account = kv.get<string>("account");
    const url = this.#webhookUrl();
    if (account === undefined || url === undefined) return;
    let budget = MAX_REDELIVERIES_PER_CHECK;
    for (const webhook of this.#webhooks()) {
      try {
        budget -= await this.#checkWebhook(account, url, webhook, budget);
      } catch (error) {
        // Tried again at the next check.
        logger.warn("failed to check a GitHub webhook", { event: "hooks.webhook.check.failed", error });
      }
    }
  }

  /**
   * Bring `webhook` back to what its hooks need if it no longer matches: deleted, deactivated,
   * pointed elsewhere, subscribed to other events, or signing with another secret, which GitHub
   * never shows but which fails deliveries here with 401. Then ask GitHub to redeliver, oldest
   * first and at most `budget`, what it failed to deliver lately, as it never does itself.
   * @returns How many redeliveries it asked for.
   */
  async #checkWebhook(account: string, url: string, { id, repo }: Webhook, budget: number): Promise<number> {
    const read = await this.#api(account, repo, async api => {
      try {
        const found = await api.getRepoWebhook(repo.owner, repo.repo, id);
        const since = Date.now() - DELIVERY_LOOKBACK_MS;
        return { found, deliveries: await api.listRepoWebhookDeliveries(repo.owner, repo.repo, id, since) };
      } catch (error) {
        // Deleted, and its deliveries with it.
        if (error instanceof GitHubApiError && error.status === 404) return undefined;
        throw error;
      }
    });
    const failed = read === undefined ? [] : undelivered(read.deliveries);
    const events = webhookEvents(this.#registrations(repo).map(([, registration]) => registration));
    const intact = read !== undefined && read.found.active === true && read.found.config.url === url
      && sameEvents(read.found.events ?? [], events)
      // By each delivery's latest attempt, so a 401 since redelivered successfully doesn't count.
      && !failed.some(({ status_code }) => status_code === 401);
    if (!intact) {
      await this.#webhookChanges.run(async () => {
        // Removed or replaced while this check read it.
        if (this.ctx.storage.kv.get<Webhook>(webhookKey(repo.id))?.id !== id) return;
        await this.#ensureWebhook(repo, this.#registrations(repo).map(([, registration]) => registration));
        logger.info("reconfigured a GitHub webhook that no longer matched its hooks", {
          event: "hooks.webhook.reconfigured",
        });
      });
    }
    if (read === undefined) return 0;
    const { deliveries } = read;
    if (deliveries.length > 0 && !deliveries.some(delivered)) {
      logger.error("GitHub failed every recent delivery to this deployment", {
        event: "hooks.webhook.deliveries.failing",
        deliveryStatuses: [...new Set(deliveries.map(({ status_code }) => status_code))],
      });
    }
    const redeliveries = failed.slice(0, budget);
    if (redeliveries.length > 0) {
      await this.#api(account, repo, async api => {
        for (const { id: deliveryId } of redeliveries) {
          await api.redeliverRepoWebhookDelivery(repo.owner, repo.repo, id, deliveryId);
        }
      });
    }
    return redeliveries.length;
  }

  /**
   * Give `repo` this driver's webhook, configured as it must be for `registrations`, the hooks it
   * serves: the recorded one, which an admin may have edited or deleted since; or a new one; or,
   * as GitHub refuses a second webhook with the same URL, the one an earlier attempt left there
   * unrecorded.
   */
  async #ensureWebhook(repo: PinnedRepo, registrations: Registration[]): Promise<void> {
    const kv = this.ctx.storage.kv;
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
    let id: number;
    try {
      id = await this.#api(account, repo, async api => {
        if (recorded) {
          try {
            return (await api.updateRepoWebhook(repo.owner, repo.repo, recorded.id, config)).id;
          } catch (error) {
            if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
          }
        }
        try {
          return (await api.createRepoWebhook(repo.owner, repo.repo, config)).id;
        } catch (error) {
          if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
          const existing = (await api.listRepoWebhooks(repo.owner, repo.repo))
            .find(webhook => webhook.config.url === url);
          if (!existing) throw error;
          return (await api.updateRepoWebhook(repo.owner, repo.repo, existing.id, config)).id;
        }
      });
    } catch (error) {
      throw webhookRefusal(repo, error);
    }
    if (kv.get("revoked")) {
      // Disconnected meanwhile, so revoke() could not see this webhook to delete it.
      await this.#removeWebhook(account, { id, repo });
      throw new Error(DISCONNECTED);
    }
    kv.put<Webhook>(webhookKey(repo.id), { id, repo });
  }

  /**
   * Delete a webhook from GitHub, best effort. One left behind, as when the account has lost admin
   * rights over the repository, is answered 404 here, and its admins can delete it.
   */
  async #removeWebhook(account: string, { id, repo }: Webhook): Promise<void> {
    try {
      await this.#api(account, repo, api => api.deleteRepoWebhook(repo.owner, repo.repo, id));
    } catch (error) {
      logger.warn("failed to delete a GitHub webhook", { event: "hooks.webhook.delete.failed", error });
    }
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
    if (this.#webhooks().length > 0) {
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
 * Whether a hook on the event's repository watches for it. The facet re-checks the binding's
 * scope at delivery.
 */
function watches({ number, events, viewerId }: Registration, event: GitHubWebhookEvent,
                 senderId: number | undefined): boolean {
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
 * What to ask GitHub to redeliver, oldest first: each delivery whose latest attempt failed, unless
 * the worker refused it for good. `deliveries` are newest first. A redelivery of something already
 * received is harmless: ingest() collapses it.
 */
function undelivered(deliveries: GitHubWebhookDeliveryResponse[]): GitHubWebhookDeliveryResponse[] {
  const latest = new Map<string, GitHubWebhookDeliveryResponse>();
  for (const delivery of deliveries) if (!latest.has(delivery.guid)) latest.set(delivery.guid, delivery);
  return [...latest.values()]
    .filter(delivery => !delivered(delivery) && !FINAL_REFUSALS.has(delivery.status_code))
    .toReversed();
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
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!name || !signature || !request.body) return new Response("Bad Request", { status: 400 });
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

/** What `parseWebhookEvent` reads of a payload, in GitHub's REST shapes. */
type WebhookPayload = {
  action?: unknown;
  repository?: { id?: unknown; pushed_at?: unknown };
  sender?: GitHubSimpleUser | null;
  issue?: GitHubIssueResponse;
  pull_request?: GitHubPullRequestResponse;
  comment?: GitHubIssueCommentResponse;
  review?: GitHubPullRequestReviewResponse;
  ref?: unknown;
  before?: unknown;
  after?: unknown;
  forced?: unknown;
} | null;

const json = (value: object) => value as WebhookJson;

const PULL_REQUEST_ACTIONS = new Map<unknown, GitHubPullRequestEvent["action"]>([
  ["opened", "opened"], ["closed", "closed"], ["reopened", "reopened"],
  ["ready_for_review", "readyForReview"], ["synchronize", "pushed"],
]);

/**
 * The event a delivery reports, if it is one a hook can receive (an issue opened, closed or
 * reopened; a pull request opened, closed, merged, reopened, marked ready or pushed to; a new
 * comment or diff comment; a review with a verdict or a summary; or a branch or tag push), with
 * when it happened and who caused it.
 */
function parseWebhookEvent(name: string, id: string, payload: WebhookPayload):
    { event: GitHubWebhookEvent; at: number; senderId?: number } | undefined {
  const repoId = payload?.repository?.id;
  if (!payload || typeof repoId !== "number") return undefined;
  const { action, issue, pull_request: pull, comment, review, sender } = payload;
  const base = { id, repoId, actor: actorFromUser(sender) };
  const senderId = sender?.id;
  switch (name) {
    case "issues":
      if (!issue || (action !== "opened" && action !== "closed" && action !== "reopened")) return undefined;
      return {
        event: { ...base, kind: "issue", action, number: issue.number, issue: json(issue) },
        at: Date.parse(issue.updated_at), senderId,
      };
    case "pull_request": {
      const mapped = PULL_REQUEST_ACTIONS.get(action);
      if (!pull || !mapped) return undefined;
      // Webhooks list requested teams among the reviewers, where the REST API lists them apart.
      const reviewers = (pull.requested_reviewers ?? []).filter(reviewer => typeof reviewer?.login === "string");
      return {
        event: {
          ...base, kind: "pullRequest", action: mapped === "closed" && pull.merged_at ? "merged" : mapped,
          number: pull.number, pullRequest: json({ ...pull, requested_reviewers: reviewers }),
        },
        at: Date.parse(pull.updated_at), senderId,
      };
    }
    case "issue_comment":
      if (!issue || !comment || action !== "created") return undefined;
      return {
        event: {
          ...base, kind: "comment", number: issue.number,
          subject: { title: issue.title, pullRequest: !!issue.pull_request }, comment: json(comment),
        },
        at: Date.parse(comment.created_at), senderId,
      };
    case "pull_request_review_comment":
      if (!pull || !comment || action !== "created") return undefined;
      return {
        event: {
          ...base, kind: "comment", number: pull.number,
          subject: { title: pull.title, pullRequest: true }, diffComment: json(comment),
        },
        at: Date.parse(comment.created_at), senderId,
      };
    case "pull_request_review":
      // A review that only adds diff comments, such as a reply to a diff thread, is its comments.
      if (!pull || !review || action !== "submitted") return undefined;
      if (review.state.toUpperCase() === "COMMENTED" && !review.body) return undefined;
      return {
        event: {
          ...base, kind: "review", number: pull.number,
          subject: { title: pull.title, pullRequest: true }, review: json(review),
        },
        at: Date.parse(review.submitted_at ?? ""), senderId,
      };
    case "push": {
      const { ref, before, after, forced } = payload;
      if (typeof ref !== "string" || typeof before !== "string" || typeof after !== "string") return undefined;
      // Git's all-zero id stands for no object: the push created or deleted the ref.
      const moved = { ...before === ZERO_OID ? {} : { before }, ...after === ZERO_OID ? {} : { after } };
      // Seconds since the epoch in a push's payload, though the schema also allows a date string.
      const pushedAt = payload.repository?.pushed_at;
      const at = typeof pushedAt === "number" ? pushedAt * 1000
        : typeof pushedAt === "string" ? Date.parse(pushedAt) : NaN;
      if (ref.startsWith("refs/heads/")) {
        const branch = ref.slice("refs/heads/".length);
        return { event: { ...base, kind: "push", branch, forced: forced === true, ...moved }, at, senderId };
      }
      if (ref.startsWith("refs/tags/")) {
        return { event: { ...base, kind: "tag", tag: ref.slice("refs/tags/".length), ...moved }, at, senderId };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
