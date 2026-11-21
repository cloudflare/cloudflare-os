// The admin gatekeeper's three hooks: one called for each issue report filed, one for each
// investigation that ends, and one for each write to a report after it was filed. The Workshop's
// issue report store tells the vendor of all three (GatekeeperVendor.issueReportEvents()), as ids
// and labels; the deployment's one IssueReportHookDriver queues each event for the hooks enabled
// for its kind and delivers it from its alarm, retrying a delivery that failed.
//
// A session's subscribe method runs in the connection's facet, which mints a persistent stub to
// itself for delivery and binds an IssueReportHookController carrying that stub in its props. The
// controller is a loopback entrypoint rather than the facet because removing a connection deletes
// the facet in the same turn as it fires the unawaited `disable()`, which therefore only reaches a
// controller living outside the facet.
//
// Nothing here reads a report. The driver holds, for each enabled hook, the Workshop's initiator
// and the facet's delivery stub; a firing is lent no Admin API; and an event carries no text. A
// subscriber reads the report through its own binding.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import {
  HookRegistry, type HookCapabilities, type HookDelivery,
} from "@gadgets/gatekeeper-kit/hook-registry";
import { createLogger } from "@gadgets/observability/logger";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import {
  ISSUE_REPORT_CHANGES, type IssueReportEvent,
} from "@gadgets/workshop-shared/admin-gatekeeper";
import { ISSUE_REPORT_PRIORITIES, ISSUE_REPORT_STATUSES } from "@gadgets/workshop-shared/api";
import type {
  ApprovalQueue, HookController, HookDescription, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_SUBRESOURCE } from "./forward.js";
import { HOOK_CALLBACK_TIMEOUT_MS } from "./surface.js";
import type { InvestigationCompleteHook, IssueReportChangedHook, IssueReportedHook } from "./types";

// Event names and counts only: an event's report id stays in the workspace's activity.
const logger = createLogger<{ vendorId: string; size: number }>({
  component: "gatekeeper.admin.hooks", vendorId: ADMIN_GATEKEEPER_VENDOR_ID,
});

/** The kinds of event this Worker has a hook for. An event of any other kind is dropped. */
const KINDS = ["reported", "investigationComplete", "changed"] as const satisfies
    readonly IssueReportEvent["kind"][];

/** Which hook: the kind of the events it is called with. */
export type IssueReportHookKind = typeof KINDS[number];

/** An event a hook delivers: one of a kind in KINDS. */
export type IssueReportHookEvent = Extract<IssueReportEvent, { kind: IssueReportHookKind }>;

/**
 * An event as the store sends it: ids and labels. Looser than IssueReportEvent on purpose:
 * the store resends a call until every event of it is taken, so an event of a kind, or with
 * a label, that this Worker's build does not know (a store released after it sends one) must
 * pass the argument check and be dropped, never reject the call.
 */
export type SentIssueReportEvent = {
  kind: string; id: string; reportId: string; at: Date; priority?: string; status?: string;
  change?: string;
};

/** A gadget's stored callback for any of the hooks, as types.d.ts declares the three. */
export type IssueReportHookTarget = RpcTarget &
    (IssueReportedHook | InvestigationCompleteHook | IssueReportChangedHook);

/** What a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`. */
export type IssueReportHookParams = { kind: IssueReportHookKind };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export type IssueReportHookDelivery = HookDelivery<IssueReportHookTarget, IssueReportHookEvent>;

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type IssueReportHookProps = IssueReportHookParams & {
  key: string;
  delivery: RpcStub<IssueReportHookDelivery>;
};

/** How the Workshop asks a person to enable each hook. */
const HOOK_DESCRIPTIONS: Record<IssueReportHookKind, HookDescription> = {
  reported: {
    title: "Watch for new issue reports",
    description: "Call this hook once for each issue report filed on this deployment from now " +
      "on, with the report's id, its priority and the time it was filed. It carries ids and " +
      "labels only: nothing of the report's text, its images or who filed it. Each event " +
      "marks this workspace as holding restricted data and keeps it admins-only, as reading " +
      "the report does.",
  },
  investigationComplete: {
    title: "Watch for investigations that end",
    description: "Call this hook each time an admin moves an issue report out of " +
      "\"investigating\", with the report's id, its new status and the time of the change. It " +
      "carries ids and labels only: nothing of the report's text, its thread or who filed it. " +
      "Each event marks this workspace as holding restricted data and keeps it admins-only, " +
      "as reading the report does.",
  },
  changed: {
    title: "Watch for changes to issue reports",
    description: "Call this hook each time an issue report is written to after it was " +
      "filed: its status set, a claim or a release, an entry added to its thread, or its " +
      "links replaced. It carries the report's id, what the write was, the status it set " +
      "if it set one, and the time: nothing of the report's text, its thread or who wrote. " +
      "It fires for changes this workspace's own agents and gadgets made too, which is how " +
      "code learns that an action it queued was applied, so a subscriber that writes to a " +
      "report on each event must not answer its own change. The events of one report can " +
      "arrive in any order, so the status on one may no longer be the report's. Each event " +
      "marks this workspace as holding restricted data and keeps it admins-only, as reading " +
      "the report does.",
  },
};

/** What a firing's queue is asked to observe before a hook is called with an event of each kind. */
const OBSERVED: Record<IssueReportHookKind, string> = {
  reported: "Receive the id, the priority and the filing time of a new issue report.",
  investigationComplete:
    "Receive the id, the new status and the time of an issue report whose investigation ended.",
  changed: "Receive the id of an issue report that was written to, what the write was, the " +
      "status it set if it set one, and the time.",
};

// ── Facet side ──────────────────────────────────────────────────────

/**
 * Binds `hook` on `queue` as a hook of `kind`, for the facet whose state is `ctx`: mints the
 * facet's delivery stub and the controller that carries it. It reads nothing and observes
 * nothing, so subscribing does not mark the workspace; the hook stays disabled until a person
 * enables it.
 */
export async function bindIssueReportHook(
  ctx: DurableObjectState, queue: RpcStub<ApprovalQueue>, kind: IssueReportHookKind,
  hook: RpcStub<IssueReportHookTarget>,
): Promise<void> {
  const params: IssueReportHookParams = { kind };
  using delivery: RpcStub<IssueReportHookDelivery> = await ctx.restore(params);
  const controller = ctx.exports.IssueReportHookController({
    props: { key: crypto.randomUUID(), kind, delivery },
  });
  // @ts-expect-error An RPC stub's generic method loses its type parameter, so Hook is taken as RpcTarget.
  await queue.bindHook(controller, hook, HOOK_DESCRIPTIONS[kind]);
}

/**
 * The target of a hook's delivery stub, which the facet's `[restore]()` returns: it delivers
 * events of one kind and does nothing else. It holds no Admin API and is lent none, since the
 * queue of a hook's firing is a plain approval queue.
 */
@validateRpc()
export class IssueReportHookDeliveryImpl extends RpcTarget implements IssueReportHookDelivery {
  readonly #kind: IssueReportHookKind;

  constructor({ kind }: IssueReportHookParams) {
    super();
    if (!KINDS.includes(kind)) throw new TypeError("No such issue report hook.");
    this.#kind = kind;
  }

  /**
   * Observes the event on the firing's queue, then calls the hook with it. The observation
   * carries the whole binding's subresource and the restricted-data flag, so every event marks
   * the workspace exactly as a read through the binding does, the latch and admins-only for
   * good, before the callback has the event. A refused observation calls no hook, and a throw
   * from either is retried by the driver, as is a callback that has not answered within
   * HOOK_CALLBACK_TIMEOUT_MS: it is not waited for, and whatever it comes to later is not looked
   * at.
   */
  async deliver(
    callback: RpcStub<IssueReportHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
    event: IssueReportHookEvent,
  ): Promise<void> {
    // The driver queues an event only for the hooks of its kind.
    if (event.kind !== this.#kind) return;
    const rendered = buildDescription(OBSERVED[event.kind]);
    rendered.inline("Event", event.kind).inline("Report", event.reportId);
    const { description, fields } = rendered.finish();
    await approvalQueue.authorizeObservation({
      title: "Receive an issue report event",
      description,
      ...(fields ? { fields } : {}),
      subresources: [ADMIN_SUBRESOURCE],
      containsRestrictedData: true,
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.#call(callback, event),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(reject, HOOK_CALLBACK_TIMEOUT_MS,
              new Error("The hook's callback did not answer in time."));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #call(callback: RpcStub<IssueReportHookTarget>, event: IssueReportHookEvent): Promise<void> {
    switch (event.kind) {
      case "reported": {
        const { id: eventId, reportId, priority, at: filedAt } = event;
        await (callback as RpcStub<RpcTarget & IssueReportedHook>)
            .issueReported({ eventId, reportId, priority, filedAt });
        break;
      }
      case "investigationComplete": {
        const { id: eventId, reportId, status, at } = event;
        await (callback as RpcStub<RpcTarget & InvestigationCompleteHook>)
            .investigationComplete({ eventId, reportId, status, at });
        break;
      }
      case "changed": {
        const { id: eventId, reportId, change, status, at } = event;
        await (callback as RpcStub<RpcTarget & IssueReportChangedHook>)
            .issueReportChanged({ eventId, reportId, change, ...(status && { status }), at });
        break;
      }
      default:
        // A kind added to KINDS does not compile until it has a branch here.
        event satisfies never;
    }
  }
}

// ── Controller ──────────────────────────────────────────────────────

/** What the driver chooses a hook's events by. */
type Registration = IssueReportHookParams;

type Capabilities = HookCapabilities<IssueReportHookTarget, IssueReportHookEvent>;

/** The deployment's one driver. */
export const issueReportHookDriver = (exports: Cloudflare.Exports) =>
  exports.IssueReportHookDriver.getByName("");

/**
 * Enables and disables one hook for the Workshop. Who may enable one is not decided here: only a
 * deployment admin holds the account, only a workspace's owner adds the connection, and the
 * Workshop refuses a firing whose workspace owner is no longer an admin.
 */
@validateRpc()
export class IssueReportHookController
  extends WorkerEntrypoint<Cloudflare.Env, IssueReportHookProps>
  implements HookController<IssueReportHookTarget>
{
  /** Registers the hook with the driver, replacing what it was enabled with. */
  async enable(
    initiator: Fetcher<HookInitiator<IssueReportHookTarget>>, _target: HookTargetMetadata,
  ): Promise<void> {
    const { key, kind, delivery } = this.ctx.props;
    await issueReportHookDriver(this.ctx.exports).register(key, { kind }, {
      // @ts-expect-error Worker RPC's mapped types can't relate a stub taking an ApprovalQueue to itself.
      delivery,
      initiator,
    });
  }

  /** Forgets the hook, and ends its queued deliveries. */
  async disable(): Promise<void> {
    await issueReportHookDriver(this.ctx.exports).unregister(this.ctx.props.key);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

/** Whether `label` is one of `known`, the labels of this Worker's build. */
const knows = <Label extends string>(
  known: readonly Label[], label: string | undefined,
): label is Label => known.includes(label as Label);

/**
 * An event's declared fields and no other, or `undefined` for an event to drop: one of a kind
 * this Worker has no hook for, or with a label its build does not know. The vendor's argument
 * check takes any kind and any label, and lets a property the type does not declare through,
 * and the driver stores what it queues: built from this, a stored event is ids and this
 * build's labels whatever its sender added.
 */
function declaredFields(event: SentIssueReportEvent): IssueReportHookEvent | undefined {
  const { kind, id, reportId, at, priority, status, change } = event;
  if (kind === "reported") {
    return knows(ISSUE_REPORT_PRIORITIES, priority) ? { kind, id, reportId, priority, at } : undefined;
  }
  if (kind === "investigationComplete") {
    // No investigation ends as "new" or "investigating".
    return knows(ISSUE_REPORT_STATUSES, status) && status !== "new" && status !== "investigating"
        ? { kind, id, reportId, status, at }
        : undefined;
  }
  if (kind === "changed") {
    if (!knows(ISSUE_REPORT_CHANGES, change)) return undefined;
    // Not every write sets a status: one that names a status must name one this build knows.
    if (status === undefined) return { kind, id, reportId, change, at };
    return knows(ISSUE_REPORT_STATUSES, status) ? { kind, id, reportId, change, status, at } : undefined;
  }
  return undefined;
}

/**
 * The deployment's one driver (see `issueReportHookDriver`). Its storage is the registry's:
 * `reg:` and `caps:` for each enabled hook (its kind; the Workshop's initiator and the facet's
 * delivery stub), and the delivery queue's `msg:` rows and `queue:` indexes, a row being an event
 * until it is delivered and a time afterwards. It holds no capability that reads a report, and
 * no report's text: it keeps an event's declared fields only (see `declaredFields`).
 *
 * Only this Worker's own entrypoints reach it (through `ctx.exports`), with arguments they have
 * validated or made themselves.
 */
export class IssueReportHookDriver extends DurableObject<Cloudflare.Env> {
  readonly #hooks = new HookRegistry<IssueReportHookTarget, IssueReportHookEvent, Registration>(
      this.ctx.storage.kv, () => {
        logger.warn("dropped an issue report event after repeated delivery failures", {
          event: "hooks.delivery.dropped",
        });
      });

  /** Enables hook `key`: both of its records are stored, or neither. */
  async register(key: string, registration: Registration, capabilities: Capabilities): Promise<void> {
    this.ctx.storage.transactionSync(() => this.#hooks.set(key, registration, capabilities));
  }

  /** Disables hook `key`. */
  async unregister(key: string): Promise<void> {
    this.#hooks.remove(key);
  }

  /**
   * Queues each event's declared fields once for each enabled hook of its kind, then brings the
   * alarm forward. Resolving means every event is stored for delivery, or has no subscriber, or
   * is of a kind or with a label this Worker does not know, and is dropped. An event's `id` is
   * its id in the queue too, so one the store sends again is not queued twice while the queue
   * remembers it.
   */
  async ingest(events: SentIssueReportEvent[]): Promise<void> {
    const now = Date.now();
    const hooks = this.#hooks.entries();
    const known = events.flatMap((event) => declaredFields(event) ?? []);
    for (const event of known) {
      for (const [key, { kind }] of hooks) {
        if (kind === event.kind) this.#hooks.enqueue(key, event.id, event, now);
      }
    }
    const size = events.length - known.length;
    if (size > 0) {
      logger.warn("dropped issue report events of a kind or label this Worker does not know", {
        event: "hooks.events.unknown", size,
      });
    }
    await this.#wake();
  }

  /** Delivers what has come due, and comes back for what is retried or is to be forgotten. */
  async alarm(): Promise<void> {
    await this.#hooks.run(Date.now());
    await this.#wake();
  }

  /** Sets the alarm for the queue's next due time, unless it is set for sooner. */
  async #wake(): Promise<void> {
    const due = this.#hooks.nextDue();
    if (due === undefined) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || due < alarm) await this.ctx.storage.setAlarm(due);
  }
}
