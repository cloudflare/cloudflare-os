// The admin gatekeeper's two hooks: one called for each issue report filed, one for each
// investigation that ends. The Workshop's issue report store tells the vendor of both
// (GatekeeperVendor.issueReportEvents()), as ids and labels; the deployment's one
// IssueReportHookDriver queues each event for the hooks enabled for its kind and delivers it from
// its alarm, retrying a delivery that failed.
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
import type { IssueReportEvent } from "@gadgets/workshop-shared/admin-gatekeeper";
import type {
  ApprovalQueue, HookController, HookDescription, HookInitiator, HookTargetMetadata,
} from "@gadgets/workshop-shared/gatekeeper";
import { ADMIN_SUBRESOURCE } from "./forward.js";
import type { InvestigationCompleteHook, IssueReportedHook } from "./types";

// Event names only: an event's report id stays in the workspace's activity.
const logger = createLogger<{ vendorId: string }>({
  component: "gatekeeper.instanceadmin.hooks", vendorId: ADMIN_GATEKEEPER_VENDOR_ID,
});

/** Which of the two hooks: the kind of the events it is called with. */
export type IssueReportHookKind = IssueReportEvent["kind"];

const KINDS: readonly IssueReportHookKind[] = ["reported", "investigationComplete"];

/** A gadget's stored callback for either hook, as types.d.ts declares the two. */
export type IssueReportHookTarget = RpcTarget & (IssueReportedHook | InvestigationCompleteHook);

/** What a hook delivers, sealed into its delivery stub by the facet's `ctx.restore()`. */
export type IssueReportHookParams = { kind: IssueReportHookKind };

/** What a hook's delivery stub reaches: the connection's facet, narrowed to delivering. */
export type IssueReportHookDelivery = HookDelivery<IssueReportHookTarget, IssueReportEvent>;

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
      "labels only: nothing of the report's text, its images or who filed it.",
  },
  investigationComplete: {
    title: "Watch for investigations that end",
    description: "Call this hook each time an admin moves an issue report out of " +
      "\"investigating\", with the report's id, its new status and the time of the change. It " +
      "carries ids and labels only: nothing of the report's text, its thread or who filed it.",
  },
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
   * carries the whole binding's subresource and no restricted-data flag: an event is an id and a
   * label, so a workspace that only receives events keeps its rules. A refused observation calls
   * no hook, and a throw from either is retried by the driver.
   */
  async deliver(
    callback: RpcStub<IssueReportHookTarget>, approvalQueue: RpcStub<ApprovalQueue>,
    event: IssueReportEvent,
  ): Promise<void> {
    // The driver queues an event only for the hooks of its kind.
    if (event.kind !== this.#kind) return;
    const rendered = buildDescription(event.kind === "reported"
        ? "Receive the id, the priority and the filing time of a new issue report."
        : "Receive the id, the new status and the time of an issue report whose investigation ended.");
    rendered.inline("Event", event.kind).inline("Report", event.reportId);
    const { description, fields } = rendered.finish();
    await approvalQueue.authorizeObservation({
      title: "Receive an issue report event",
      description,
      ...(fields ? { fields } : {}),
      subresources: [ADMIN_SUBRESOURCE],
    });
    if (event.kind === "reported") {
      const { reportId, priority, at: filedAt } = event;
      await (callback as RpcStub<RpcTarget & IssueReportedHook>)
          .issueReported({ reportId, priority, filedAt });
    } else {
      const { reportId, status, at } = event;
      await (callback as RpcStub<RpcTarget & InvestigationCompleteHook>)
          .investigationComplete({ reportId, status, at });
    }
  }
}

// ── Controller ──────────────────────────────────────────────────────

/** What the driver chooses a hook's events by. */
type Registration = IssueReportHookParams;

type Capabilities = HookCapabilities<IssueReportHookTarget, IssueReportEvent>;

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

/**
 * An event's declared fields and no other. The vendor's argument check lets a property the type
 * does not declare through, and the driver stores what it queues: built from this, a stored event
 * is ids and labels whatever its sender added.
 */
function declaredFields(event: IssueReportEvent): IssueReportEvent {
  const { seq, reportId, at } = event;
  return event.kind === "reported"
      ? { kind: event.kind, seq, reportId, priority: event.priority, at }
      : { kind: event.kind, seq, reportId, status: event.status, at };
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
  readonly #hooks = new HookRegistry<IssueReportHookTarget, IssueReportEvent, Registration>(
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
   * alarm forward. Resolving means every event is stored for delivery, or has no subscriber and
   * is dropped. An event's `seq` is its id in the queue, so one the store sends again is not
   * queued twice while the queue remembers it.
   */
  async ingest(events: IssueReportEvent[]): Promise<void> {
    const now = Date.now();
    const hooks = this.#hooks.entries();
    for (const event of events.map(declaredFields)) {
      for (const [key, { kind }] of hooks) {
        if (kind === event.kind) this.#hooks.enqueue(key, String(event.seq), event, now);
      }
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
