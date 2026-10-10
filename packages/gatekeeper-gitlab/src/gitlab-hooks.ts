// GitLab event hooks: one project webhook per (connected account, project), delivered to
// `POST {WEBHOOK_ORIGIN}{BASE_URL's path}/webhook/{driver id}`. A mirror of gatekeeper-github's
// github-hooks.ts; what differs is GitLab's:
// - deliveries are signed per Standard Webhooks, over the delivery's id and timestamp as well as
//   its body, so a replay is refused by its timestamp and collapsed by its id (GitLab 19.0 and
//   later: earlier versions cannot sign a delivery, and are refused hooks);
// - issues and merge requests are numbered separately, so an event names which one it concerns;
// - webhook payloads are not shaped like REST responses, so the facet reads an issue's or merge
//   request's details through its REST reads at delivery, and takes only comments, reviews and
//   pushes from the payload.
//
// `subscribe()` runs in the connection's facet, which mints a persistent stub to itself for
// delivery (an event's issue and merge request capabilities queue actions in the facet's storage,
// so the facet must build them) and binds a `GitLabHookController` carrying that stub in its props.
// As for Google Chat's and GitHub's hooks, the controller is a loopback entrypoint rather than the
// facet, because removing a connection deletes the facet in the same turn as it fires the
// unawaited `disable()`, which therefore only reaches a controller living outside the facet.
//
// One `GitLabHookDriver` per connected account holds its enabled hooks and its webhooks. It adds a
// webhook to a project when the first hook there is enabled and deletes it with the last, verifies
// each delivery's signature, queues each event once for every hook that watches for it, and
// retries failed deliveries from its alarm. Hourly, it checks each webhook on GitLab, restoring one
// that someone has changed and having GitLab resend what GitLab failed to deliver. Disconnecting
// the account deletes its webhooks.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ZERO_OID } from "@gadgets/gatekeeper-kit/git-transport";
import { HookDeliveryQueue, disposeStubs } from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import type {
  ApprovalQueue, HookController, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import type { EntityKind } from "./gitlab-action-types";
import {
  GitLabApiError, WEBHOOK_TRIGGERS as MANAGED_TRIGGERS,
  type GitLabApi, type GitLabProjectWebhookResponse, type GitLabWebhookEventResponse, type GitLabWebhookTrigger,
} from "./gitlab-api";
import { getBasePath, instanceUrl, webhookOrigin, withAccountApi, type Env } from "./gitlab-env";
import { actorFromUsername } from "./gitlab-normalize";
import { obsContext } from "./observability";
import type {
  GitLabActor, GitLabEventHook, GitLabEventKind, GitLabIssueEvent, GitLabMergeRequestEvent,
  GitLabReviewDecision,
} from "./types";

const logger = obsContext.createLogger({ component: "gatekeeper.gitlab.hooks", vendorId: "gitlab" });

export const HOOKS_NOT_CONFIGURED = "GitLab hooks are not configured on this deployment.";

export type GitLabEventHookTarget = RpcTarget & GitLabEventHook;

/** The issue or merge request an event concerns, or a hook watches. */
export type GitLabEventTarget = { kind: EntityKind; iid: number };

/**
 * Where a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`: everything
 * the binding watches, or (`target`) one issue or merge request in it.
 */
export type GitLabHookParams = { target?: GitLabEventTarget };

/** A project by its numeric id, which survives a rename, with the path its binding names it by. */
export type GitLabProjectPin = { id: number; path: string };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export interface GitLabHookDelivery extends RpcTarget {
  /**
   * Deliver `event` to one firing of the hook, as `HookInitiator.startHook()` returned it, if the
   * binding admits it; otherwise return without calling it.
   */
  deliver(callback: RpcStub<GitLabEventHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
          event: GitLabWebhookEvent): Promise<void>;
}

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type GitLabHookProps = GitLabHookParams & {
  key: string;
  userObjectId: string;
  project: GitLabProjectPin;
  events: GitLabEventKind[];
  /** The connected account's GitLab user id: its own comments and reviews are not delivered. */
  viewerId: number;
  delivery: RpcStub<GitLabHookDelivery>;
};

/**
 * A comment a webhook delivered, in the shape GitLab's REST API gives a note (see
 * `parseWebhookEvent`). Authenticated by the delivery's signature, it crosses RPC unvalidated, and
 * the facet reads it as that REST type.
 */
export type WebhookJson = Record<string, unknown>;

/** One event a webhook delivered, as the driver queues it for each hook and the facet delivers it. */
export type GitLabWebhookEvent = {
  /** The delivery's `webhook-id`, the same for each delivery of one event. */
  id: string;
  projectId: number;
  actor: GitLabActor | null;
} & (
  | { kind: "issue"; action: GitLabIssueEvent["action"]; target: GitLabEventTarget }
  | { kind: "mergeRequest"; action: GitLabMergeRequestEvent["action"]; target: GitLabEventTarget }
  | { kind: "comment"; target: GitLabEventTarget; title: string; note: WebhookJson; discussionId: string }
  | { kind: "review"; target: GitLabEventTarget; title: string; decision: GitLabReviewDecision }
  | { kind: "push"; branch: string; before?: string; after?: string }
  | { kind: "tag"; tag: string; before?: string; after?: string }
);

/** The headers a delivery is verified and routed by. */
export type GitLabDelivery = {
  /** `X-Gitlab-Event`, such as `"Issue Hook"`. */
  event: string;
  /** `webhook-id`, which every retry and resend of the delivery repeats. */
  id: string;
  /** `webhook-timestamp`: seconds since the epoch, when GitLab made this attempt. */
  timestamp: string;
  /** `webhook-signature`: space-separated `v1,{base64}` signatures. */
  signatures: string;
};

@validateRpc()
export class GitLabHookController extends WorkerEntrypoint<Env, GitLabHookProps>
    implements HookController<GitLabEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<GitLabEventHookTarget>>,
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
    return this.ctx.exports.GitLabHookDriver.getByName(this.ctx.props.userObjectId);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** The webhook triggers that report each kind of event a hook can watch for. */
const WEBHOOK_TRIGGERS: Record<GitLabEventKind, GitLabWebhookTrigger[]> = {
  issue: ["issues_events"],
  mergeRequest: ["merge_requests_events"],
  comment: ["note_events"],
  review: ["merge_requests_events"],
  push: ["push_events"],
  tag: ["tag_push_events"],
};

const DISCONNECTED = "This GitLab account has been disconnected.";
const SIGNING_UNSUPPORTED = "GitLab hooks need GitLab 19.0 or later, which signs webhook deliveries.";

const HOUR_MS = 60 * 60 * 1000;
/** How often the driver checks its webhooks on GitLab (see #checkWebhook). */
const CHECK_INTERVAL_MS = HOUR_MS;
/** How far back a check reads a webhook's deliveries: two checks' worth, so none falls between. */
const DELIVERY_LOOKBACK_MS = 2 * CHECK_INTERVAL_MS;
/**
 * How many resends one check may have GitLab make for an account, oldest first, and for one
 * project: GitLab allows a user five a minute on a project. The rest wait for the next check, and
 * are lost if they age out of its lookback first. One that fails again is resent again at the next
 * check, which keeps a failure recoverable through an outage, for this many requests an hour.
 */
const MAX_RESENDS_PER_CHECK = 20;
const MAX_RESENDS_PER_PROJECT = 5;
/**
 * The statuses the worker refuses a delivery with for good (see handleWebhookRequest() and
 * ingest()), which a resend would only repeat.
 */
const FINAL_REFUSALS = new Set([400, 404, 413]);

type Registration = Omit<GitLabHookProps, "key" | "userObjectId" | "delivery">;
type Capabilities = {
  delivery: RpcStub<GitLabHookDelivery>;
  initiator: Fetcher<HookInitiator<GitLabEventHookTarget>>;
};
/** A webhook this driver added to a project. */
type Webhook = { id: number; project: GitLabProjectPin };

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;
const webhookKey = (projectId: number) => `webhook:${projectId}`;

/**
 * One per connected account, named by its `UserAccount` id. Storage: `account` (that id), `secret`
 * (the signing token its webhooks sign deliveries with), `webhook:` per project, `checkAt` (when
 * to next check them on GitLab), `reg:`/`caps:` per hook, the delivery queue's `msg:` rows, and
 * `revoked` once the account is disconnected, which refuses everything for good.
 *
 * Every `await` here opens the input gate, so each storage write after one re-reads what it
 * depends on.
 */
export class GitLabHookDriver extends DurableObject<Env> {
  /**
   * Webhook additions and removals, which run one at a time so that each sees what the last did:
   * a removal still in flight would otherwise delete the webhook an addition just adopted.
   */
  #webhookChanges = new SerialTaskQueue();
  #queue = new HookDeliveryQueue<GitLabWebhookEvent>(this.ctx.storage.kv, () => {
    logger.warn("dropped a GitLab event after repeated delivery failures", { event: "hooks.delivery.dropped" });
  });

  async register(key: string, userObjectId: string, registration: Registration,
                 capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    if (kv.get("revoked")) throw new Error(DISCONNECTED);
    kv.put("account", userObjectId);
    const { project } = registration;
    await this.#webhookChanges.run(async () => {
      // Disconnected while an earlier change ran.
      if (kv.get("revoked")) throw new Error(DISCONNECTED);
      const others = this.#registrations(project).filter(([regKey]) => regKey !== registrationKey(key));
      await this.#ensureWebhook(project, [registration, ...others.map(([, other]) => other)]);
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
    const { project } = registration;
    await this.#webhookChanges.run(async () => {
      const webhook = kv.get<Webhook>(webhookKey(project.id));
      if (!webhook) return;
      const remaining = this.#registrations(project).map(([, other]) => other);
      if (remaining.length > 0) {
        // Narrowed to what the remaining hooks watch. Best effort, since disabling must not fail:
        // until an enable or the hourly check narrows it, deliveries no hook watches are only
        // filtered out here.
        await this.#ensureWebhook(project, remaining).catch((error: unknown) => {
          logger.warn("failed to narrow a GitLab webhook's triggers", { event: "hooks.webhook.narrow.failed", error });
        });
        return;
      }
      // The project's last hook: rather than leave GitLab delivering there, remove the webhook.
      await this.#removeWebhook(kv.get<string>("account")!, webhook);
      kv.delete(webhookKey(project.id));
    });
    await this.#reschedule();
  }

  /**
   * The account is being disconnected, while its token still works: stop delivering for good, and
   * delete its webhooks, which GitLab would otherwise keep delivering to.
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
   * @returns The HTTP status to answer GitLab with.
   */
  async ingest(delivery: GitLabDelivery, delivered: ReadableStream<Uint8Array>): Promise<number> {
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
    if (!await verifySignature(secret, delivery, body)) return 401;
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return 400;
    }
    const projectId = payload?.project?.id ?? payload?.project_id;
    // No longer this driver's webhook: every hook on the project has been disabled.
    if (typeof projectId !== "number" || !kv.get(webhookKey(projectId))) return 404;
    // The signed id names the event, so a retry, a resend, or a replay inside the signature's
    // tolerance collapses into its first delivery.
    const parsed = parseWebhookEvent(delivery.event, delivery.id, projectId, payload, instanceUrl(this.env));
    if (!parsed) return 204;
    const { event, senderId } = parsed;
    const now = Date.now();
    let queued = false;
    for (const [regKey, registration] of this.#registrations({ id: projectId })) {
      if (!watches(registration, event, senderId)) continue;
      this.#queue.enqueue(regKey.slice("reg:".length), delivery.id, event, now);
      queued = true;
    }
    if (queued) await this.#wakeBy(now);
    return 204;
  }

  /**
   * The driver's one alarm, which #wakeBy() and #reschedule() set for the earliest time either of
   * these is due:
   * - checking its webhooks on GitLab, hourly while it has any;
   * - delivering each queued event whose (re)try time has come, and forgetting finished ones.
   */
  async alarm(): Promise<void> {
    if ((this.ctx.storage.kv.get<number>("checkAt") ?? Infinity) <= Date.now()) await this.#checkWebhooks();
    // After the check, so what its resends queued is delivered in this same run.
    await this.#queue.run(Date.now(), (hookKey, event) => this.#deliver(hookKey, event));
    await this.#reschedule();
  }

  async #deliver(hookKey: string, event: GitLabWebhookEvent): Promise<void> {
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

  /** Check each webhook on GitLab (see #checkWebhook), within one budget of resends. */
  async #checkWebhooks(): Promise<void> {
    const kv = this.ctx.storage.kv;
    kv.put("checkAt", Date.now() + CHECK_INTERVAL_MS);
    const account = kv.get<string>("account");
    const url = this.#webhookUrl();
    if (account === undefined || url === undefined) return;
    let budget = MAX_RESENDS_PER_CHECK;
    for (const webhook of this.#webhooks()) {
      try {
        budget -= await this.#checkWebhook(account, url, webhook, Math.min(budget, MAX_RESENDS_PER_PROJECT));
      } catch (error) {
        // Tried again at the next check.
        logger.warn("failed to check a GitLab webhook", { event: "hooks.webhook.check.failed", error });
      }
    }
  }

  /**
   * Bring `webhook` back to what its hooks need if it no longer matches: deleted, disabled for good
   * after repeated failures, pointed elsewhere, given other triggers, or signing with another
   * token, which GitLab never shows but which fails deliveries here with 401. Then have GitLab
   * resend, oldest first and at most `budget`, what it failed to deliver lately, as it never does
   * itself.
   * @returns How many resends it had GitLab make.
   */
  async #checkWebhook(account: string, url: string, { id, project }: Webhook, budget: number): Promise<number> {
    const read = await this.#api(account, async api => {
      try {
        const found = await api.getProjectWebhook(project.id, id);
        const since = Date.now() - DELIVERY_LOOKBACK_MS;
        return { found, events: await api.listProjectWebhookEvents(project.id, id, since) };
      } catch (error) {
        // Deleted, and its delivery log with it.
        if (error instanceof GitLabApiError && error.status === 404) return undefined;
        throw error;
      }
    });
    // What GitLab sent this URL: an attempt from before someone redirected the webhook is not ours.
    const failed = read === undefined ? [] : undelivered(read.events.filter(event => event.url === url));
    const disabled = read?.found.alert_status === "disabled";
    const triggers = webhookTriggers(this.#registrations(project).map(([, registration]) => registration));
    const intact = read !== undefined && !disabled && read.found.url === url && read.found.signing_token_present === true &&
      read.found.enable_ssl_verification !== false && configuredTriggers(read.found).join() === triggers.toSorted().join() &&
      // By each delivery's latest attempt, so a 401 since resent successfully doesn't count.
      !failed.some(event => Number(event.response_status) === 401);
    if (!intact) {
      await this.#webhookChanges.run(async () => {
        // Removed or replaced while this check read it.
        if (this.ctx.storage.kv.get<Webhook>(webhookKey(project.id))?.id !== id) return;
        if (disabled) {
          // Editing a webhook GitLab gave up on does not revive it; a new one starts afresh.
          await this.#removeWebhook(account, { id, project });
          this.ctx.storage.kv.delete(webhookKey(project.id));
        }
        await this.#ensureWebhook(project, this.#registrations(project).map(([, registration]) => registration));
        logger.info("reconfigured a GitLab webhook that no longer matched its hooks", {
          event: "hooks.webhook.reconfigured",
        });
      });
    }
    if (read === undefined) return 0;
    const deliveries = read.events.filter(event => event.url === url);
    if (deliveries.length > 0 && !deliveries.some(delivered)) {
      logger.error("GitLab failed every recent delivery to this deployment", {
        event: "hooks.webhook.deliveries.failing",
        deliveryStatuses: [...new Set(deliveries.map(event => String(event.response_status)))],
      });
    }
    // GitLab sends nothing while it holds a webhook back after failures, and revives it itself.
    if (disabled || read.found.alert_status === "temporarily_disabled") return 0;
    const resends = failed.slice(0, budget);
    if (resends.length > 0) {
      await this.#api(account, async api => {
        for (const event of resends) await api.resendProjectWebhookEvent(project.id, id, event.id);
      });
    }
    return resends.length;
  }

  /**
   * Give `project` this driver's webhook, configured as it must be for `registrations`, the hooks
   * it serves: the recorded one, which a Maintainer may have edited or deleted since; or, as GitLab
   * takes any number of webhooks with one URL, the one an earlier attempt left there unrecorded;
   * or a new one.
   */
  async #ensureWebhook(project: GitLabProjectPin, registrations: Registration[]): Promise<void> {
    const kv = this.ctx.storage.kv;
    const account = kv.get<string>("account")!;
    const url = this.#webhookUrl();
    if (url === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
    let secret = kv.get<string>("secret");
    if (secret === undefined) {
      secret = newSigningToken();
      kv.put("secret", secret);
    }
    const config = { url, signingToken: secret, triggers: webhookTriggers(registrations) };
    const recorded = kv.get<Webhook>(webhookKey(project.id));
    let webhook;
    try {
      webhook = await this.#api(account, async api => {
        if (recorded) {
          try {
            return await api.updateProjectWebhook(project.id, recorded.id, config);
          } catch (error) {
            if (!(error instanceof GitLabApiError && error.status === 404)) throw error;
          }
        }
        const existing = (await api.listProjectWebhooks(project.id)).find(found => found.url === url);
        return existing
          ? await api.updateProjectWebhook(project.id, existing.id, config)
          : await api.createProjectWebhook(project.id, config);
      });
    } catch (error) {
      throw webhookRefusal(project, error);
    }
    if (webhook.signing_token_present !== true) {
      // An instance older than 19.0, which ignores the signing token: nothing it delivered could
      // be verified.
      await this.#removeWebhook(account, { id: webhook.id, project });
      throw new Error(SIGNING_UNSUPPORTED);
    }
    if (kv.get("revoked")) {
      // Disconnected meanwhile, so revoke() could not see this webhook to delete it.
      await this.#removeWebhook(account, { id: webhook.id, project });
      throw new Error(DISCONNECTED);
    }
    kv.put<Webhook>(webhookKey(project.id), { id: webhook.id, project });
  }

  /**
   * Delete a webhook from GitLab, best effort. One left behind, as when the account is no longer
   * a Maintainer of the project, is answered 404 here, and the project's Maintainers can delete it.
   */
  async #removeWebhook(account: string, { id, project }: Webhook): Promise<void> {
    try {
      await this.#api(account, api => api.deleteProjectWebhook(project.id, id));
    } catch (error) {
      logger.warn("failed to delete a GitLab webhook", { event: "hooks.webhook.delete.failed", error });
    }
  }

  #api<T>(account: string, fn: (api: GitLabApi) => Promise<T>): Promise<T> {
    const { UserAccount } = this.ctx.exports;
    return withAccountApi(this.env, UserAccount.get(UserAccount.idFromString(account)), fn);
  }

  /** Where this driver's webhooks deliver, unless this deployment has not configured hooks. */
  #webhookUrl(): string | undefined {
    const origin = webhookOrigin(this.env);
    return origin === undefined ? undefined : `${origin}${getBasePath(this.env)}/webhook/${this.ctx.id}`;
  }

  /** The webhooks this driver has added, one per project. */
  #webhooks(): Webhook[] {
    return [...this.ctx.storage.kv.list<Webhook>({ prefix: "webhook:" })].map(([, webhook]) => webhook);
  }

  /** The enabled hooks on `project`, by their storage key. */
  #registrations(project: Pick<GitLabProjectPin, "id">): [string, Registration][] {
    return [...this.ctx.storage.kv.list<Registration>({ prefix: "reg:" })]
      .filter(([, registration]) => registration.project.id === project.id);
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
 * Whether a hook on the event's project watches for it. The facet re-checks the binding's scope
 * at delivery.
 */
function watches({ target, events, viewerId }: Registration, event: GitLabWebhookEvent,
                 senderId: number | undefined): boolean {
  if (!events.includes(event.kind)) return false;
  if (target !== undefined &&
      !("target" in event && event.target.kind === target.kind && event.target.iid === target.iid)) {
    return false;
  }
  // Never hand the account's own comments and reviews back to it, which a hook would answer.
  return !((event.kind === "comment" || event.kind === "review") && senderId === viewerId);
}

/** The webhook triggers GitLab must deliver for `registrations`. */
function webhookTriggers(registrations: Registration[]): GitLabWebhookTrigger[] {
  return [...new Set(registrations.flatMap(({ events }) => events.flatMap(kind => WEBHOOK_TRIGGERS[kind])))];
}

/** The triggers a webhook has on among those this driver manages, sorted; never a confidential one. */
function configuredTriggers(webhook: GitLabProjectWebhookResponse): string[] {
  if (webhook.confidential_issues_events || webhook.confidential_note_events) return ["confidential"];
  return MANAGED_TRIGGERS.filter(trigger => webhook[trigger] === true).toSorted();
}

/** Whether an attempt was delivered: GitLab counts a redirect as delivered too. */
const delivered = (event: GitLabWebhookEventResponse) =>
  Number(event.response_status) >= 200 && Number(event.response_status) < 400;

/**
 * What to have GitLab resend, oldest first: each delivery whose latest attempt failed, unless the
 * worker refused it for good. `events` are newest first. A resend of something already received
 * is harmless: ingest() collapses it by its `webhook-id`.
 */
function undelivered(events: GitLabWebhookEventResponse[]): GitLabWebhookEventResponse[] {
  const latest = new Map<string, GitLabWebhookEventResponse>();
  for (const event of events) {
    const delivery = event.request_headers?.["webhook-id"] ?? event.request_headers?.["Idempotency-Key"] ?? String(event.id);
    if (!latest.has(delivery)) latest.set(delivery, event);
  }
  return [...latest.values()]
    .filter(event => !delivered(event) && !FINAL_REFUSALS.has(Number(event.response_status)))
    .toReversed();
}

/** Why GitLab refused to add a webhook, in terms the user can act on. */
function webhookRefusal({ path }: GitLabProjectPin, error: unknown): unknown {
  if (!(error instanceof GitLabApiError)) return error;
  if (error.status === 403 || error.status === 404) {
    return new Error(`GitLab refused to add a webhook to ${path}: only its Maintainers and Owners ` +
      "can, and the connected account is not one.", { cause: error });
  }
  return new Error(`GitLab refused to add a webhook to ${path}: ${error.message}`, { cause: error });
}

// ── Webhook deliveries ──────────────────────────────────────────────

/**
 * Far above any event delivered here, a push listing at most 20 commits: anyone who can see a
 * webhook's URL can send a body this large, so a larger one is refused rather than held.
 */
const MAX_DELIVERY_BYTES = 5 * 1024 * 1024;
/**
 * How far a delivery's signed timestamp may stray from now: Standard Webhooks' default. GitLab
 * stamps each attempt as it sends it, so a captured delivery is refused once this has passed, and
 * collapsed by its id until then.
 */
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
const SIGNING_TOKEN_PREFIX = "whsec_";

/**
 * Handle one delivery to `POST {BASE_URL}/webhook/{route}`, as `WEBHOOK_ORIGIN` reaches it, where
 * `route` names the driver whose webhook it is, which reads and verifies the body.
 */
export async function handleWebhookRequest(request: Request, route: string, env: Env,
                                           exports: Cloudflare.Exports): Promise<Response> {
  let driver: DurableObjectId;
  try {
    if (webhookOrigin(env) === undefined) throw new Error(HOOKS_NOT_CONFIGURED);
    driver = exports.GitLabHookDriver.idFromString(route);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  const event = request.headers.get("X-Gitlab-Event");
  if (!event || !request.body) return new Response("Bad Request", { status: 400 });
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signatures = request.headers.get("webhook-signature");
  // Unsigned: a webhook whose signing token someone removed, which the account can restore.
  if (!id || !timestamp || !signatures) return new Response("Unauthorized", { status: 401 });
  // An early refusal, sparing the driver; it enforces the cap itself as it reads.
  if (Number(request.headers.get("Content-Length")) > MAX_DELIVERY_BYTES) {
    return new Response("Payload Too Large", { status: 413 });
  }
  const status = await exports.GitLabHookDriver.get(driver).ingest({ event, id, timestamp, signatures }, request.body);
  return new Response(null, { status });
}

/** A fresh signing token: `whsec_` and the base64 of a random 32-byte key. */
function newSigningToken(): string {
  return SIGNING_TOKEN_PREFIX + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

/** The base64 `encoded` decodes to, or undefined if it isn't base64. */
function fromBase64(encoded: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * Whether one of the delivery's signatures is the HMAC-SHA256, under the signing token's key, of
 * `{id}.{timestamp}.{body}`, and its timestamp is recent (Standard Webhooks).
 */
async function verifySignature(secret: string, { id, timestamp, signatures }: GitLabDelivery,
                               body: Uint8Array): Promise<boolean> {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_MS) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw", fromBase64(secret.slice(SIGNING_TOKEN_PREFIX.length))!, { name: "HMAC", hash: "SHA-256" }, false,
    ["verify"]);
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  for (const signature of signatures.split(" ")) {
    const bytes = signature.startsWith("v1,") ? fromBase64(signature.slice("v1,".length)) : undefined;
    if (bytes && await crypto.subtle.verify("HMAC", key, bytes, signed)) return true;
  }
  return false;
}

/** A user as a webhook names one: in an issue, merge request or note payload's `user`. */
type WebhookUser = { id?: unknown; username?: unknown; name?: unknown; avatar_url?: unknown };

/** What `parseWebhookEvent` reads of a payload. */
type WebhookPayload = {
  object_kind?: unknown;
  project_id?: unknown;
  project?: { id?: unknown } | null;
  user?: WebhookUser | null;
  object_attributes?: Record<string, unknown> | null;
  changes?: {
    draft?: { previous?: unknown; current?: unknown };
    /** The reviewers before and after, with their review states. */
    reviewers?: [Array<WebhookUser & { state?: unknown }>, Array<WebhookUser & { state?: unknown }>];
  } | null;
  issue?: { iid?: unknown; title?: unknown } | null;
  merge_request?: { iid?: unknown; title?: unknown } | null;
  ref?: unknown;
  before?: unknown;
  after?: unknown;
  user_id?: unknown;
  user_username?: unknown;
  user_name?: unknown;
  user_avatar?: unknown;
} | null;

const ISSUE_ACTIONS = new Map<unknown, GitLabIssueEvent["action"]>([
  ["open", "opened"], ["close", "closed"], ["reopen", "reopened"],
]);

const MERGE_REQUEST_ACTIONS = new Map<unknown, GitLabMergeRequestEvent["action"]>([
  ["open", "opened"], ["close", "closed"], ["reopen", "reopened"], ["merge", "merged"],
]);

/** The review decisions a reviewer's new state reports, from GitLab 19.3 (approvals are their own action). */
const REVIEW_STATES = new Map<unknown, GitLabReviewDecision>([
  ["requested_changes", "requestChanges"], ["reviewed", "comment"],
]);

/**
 * The event a delivery reports, if it is one a hook can receive (an issue opened, closed or
 * reopened; a merge request opened, closed, merged, reopened, marked ready or pushed to; a new
 * comment on an issue or merge request; an approval or review; or a branch or tag push), with who
 * caused it.
 */
function parseWebhookEvent(name: string, id: string, projectId: number, payload: WebhookPayload,
                           webUrl: string): { event: GitLabWebhookEvent; senderId?: number } | undefined {
  if (!payload) return undefined;
  const attributes = payload.object_attributes ?? {};
  const senderId = typeof payload.user?.id === "number" ? payload.user.id : undefined;
  const base = { id, projectId, actor: actorOf(webUrl, payload.user) };
  switch (name) {
    case "Issue Hook": {
      const action = ISSUE_ACTIONS.get(attributes.action);
      // `object_kind: "work_item"` is another kind of work item reported under the same name.
      if (payload.object_kind !== "issue" || !action || typeof attributes.iid !== "number") return undefined;
      return { event: { ...base, kind: "issue", action, target: { kind: "issue", iid: attributes.iid } }, senderId };
    }
    case "Merge Request Hook": {
      if (typeof attributes.iid !== "number") return undefined;
      const target = { kind: "mergeRequest", iid: attributes.iid } as const;
      const action = mergeRequestAction(attributes, payload.changes);
      if (action) return { event: { ...base, kind: "mergeRequest", action, target }, senderId };
      const decision = reviewDecision(attributes, payload.changes, senderId);
      if (!decision) return undefined;
      return { event: { ...base, kind: "review", decision, target, title: String(attributes.title ?? "") }, senderId };
    }
    case "Note Hook": {
      // A comment created on an issue or merge request: not one on a commit or snippet, an edit,
      // or GitLab's own activity.
      const kind = attributes.noteable_type === "Issue" ? "issue"
        : attributes.noteable_type === "MergeRequest" ? "mergeRequest" : undefined;
      const noteable = kind === "issue" ? payload.issue : payload.merge_request;
      if (!kind || typeof noteable?.iid !== "number" || attributes.action !== "create") return undefined;
      if (attributes.system === true || attributes.internal === true) return undefined;
      if (typeof attributes.id !== "number" || typeof attributes.discussion_id !== "string") return undefined;
      const { username, name: displayName, avatar_url } = payload.user ?? {};
      const note = {
        id: attributes.id,
        type: attributes.type ?? null,
        body: attributes.note ?? "",
        author: { id: senderId, username, name: displayName, avatar_url },
        created_at: attributes.created_at,
        updated_at: attributes.updated_at,
        system: false,
        ...attributes.position ? { position: attributes.position } : {},
      };
      return {
        event: {
          ...base, kind: "comment", target: { kind, iid: noteable.iid }, title: String(noteable.title ?? ""),
          note, discussionId: attributes.discussion_id,
        },
        senderId,
      };
    }
    case "Push Hook":
    case "Tag Push Hook": {
      const { ref, before, after } = payload;
      if (typeof ref !== "string" || typeof before !== "string" || typeof after !== "string") return undefined;
      const pushed = {
        id, projectId,
        actor: actorOf(webUrl, {
          username: payload.user_username, name: payload.user_name, avatar_url: payload.user_avatar,
        }),
        // Git's all-zero id stands for no object: the push created or deleted the ref.
        ...before === ZERO_OID ? {} : { before },
        ...after === ZERO_OID ? {} : { after },
      };
      if (name === "Push Hook" && ref.startsWith("refs/heads/")) {
        return { event: { ...pushed, kind: "push", branch: ref.slice("refs/heads/".length) } };
      }
      if (name === "Tag Push Hook" && ref.startsWith("refs/tags/")) {
        return { event: { ...pushed, kind: "tag", tag: ref.slice("refs/tags/".length) } };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** What a merge request event's action and changes say happened to the merge request itself. */
function mergeRequestAction(attributes: Record<string, unknown>, changes: NonNullable<WebhookPayload>["changes"]):
    GitLabMergeRequestEvent["action"] | undefined {
  if (attributes.action !== "update") return MERGE_REQUEST_ACTIONS.get(attributes.action);
  // `oldrev` is set only when the update moved the source branch.
  if (typeof attributes.oldrev === "string" && attributes.oldrev !== "") return "pushed";
  if (changes?.draft?.previous === true && changes.draft.current === false) return "readyForReview";
  return undefined;
}

/**
 * The review a merge request event reports by `senderId`: an approval, or a review the sender
 * submitted, which GitLab 19.3 reports as their new reviewer state.
 */
function reviewDecision(attributes: Record<string, unknown>, changes: NonNullable<WebhookPayload>["changes"],
                        senderId: number | undefined): GitLabReviewDecision | undefined {
  // An approval GitLab removes or adds itself, as on a push, is no one's review.
  if (attributes.action === "approval") return attributes.system === true ? undefined : "approve";
  if (attributes.action !== "update" || senderId === undefined || !Array.isArray(changes?.reviewers)) return undefined;
  const [before, after] = changes.reviewers;
  // A re-request moves the reviewer back to `unreviewed`, which is no review.
  const now = after?.find(reviewer => reviewer.id === senderId);
  if (!now || before?.find(reviewer => reviewer.id === senderId)?.state === now.state) return undefined;
  return REVIEW_STATES.get(now.state);
}

/** The actor a webhook's user fields name, if they name one. */
function actorOf(webUrl: string, user: WebhookUser | null | undefined): GitLabActor | null {
  if (typeof user?.username !== "string") return null;
  return {
    ...actorFromUsername(webUrl, user.username),
    ...typeof user.name === "string" ? { displayName: user.name } : {},
    ...typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {},
  };
}
