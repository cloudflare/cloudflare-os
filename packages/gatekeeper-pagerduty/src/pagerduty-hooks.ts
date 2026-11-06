// PagerDuty event hooks. An admin creates one account-wide Generic Webhook (v3) subscription by
// hand, delivering to `POST {BASE_URL}/webhook` and signing with `PAGERDUTY_WEBHOOK_SECRET`; until
// that secret is set, subscribing is refused and the route is inert.
//
// `subscribe()` runs in the binding's facet, which mints a persistent stub to itself for delivery
// (an event's incident capability queues actions in the facet's storage, so the facet must build
// it) and binds a `PagerDutyHookController` carrying that stub in its props. The controller is a
// loopback entrypoint rather than the facet, since removing a connection deletes the facet in the
// same turn as it fires the unawaited `disable()`.
//
// The webhook route verifies each delivery and hands its event to the account's
// `PagerDutyHookDriver`, named by the account's web host, which queues it once for every enabled
// hook that may watch it and delivers from its alarm, retrying failures. The facet then re-reads
// the incident as the hook's owner, drops what they can't see or what lies outside the binding,
// and only then starts a firing.

import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  DELIVERED_RETENTION_MS, HookDeliveryQueue, disposeStubs,
} from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { ResponseTooLargeError, readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import type { HookController, HookDescription, HookInitiator, HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import { isDenial } from "./pagerduty-api";
import { VENDOR_ID, webOrigin, type Env, type Tenant } from "./pagerduty-env";
import { toIncidentSummary, type WireIncident, type WireRef } from "./pagerduty-normalize";
import {
  PagerDutyIncidentImpl, SessionContext, outsideOf, type HookScope, type SessionHost,
} from "./pagerduty-sessions";
import { overlayIncident } from "./pagerduty-simulation";
import { OBJECT_ID, parseResourceUrl } from "./pagerduty-urls";
import { obsContext } from "./observability";
import type { PagerDutyEvent, PagerDutyEventHook, PagerDutyEventKind, PagerDutySubscribeOptions } from "./types";

const logger = obsContext.createLogger({ component: "gatekeeper.pagerduty.hooks", vendorId: VENDOR_ID });

export const HOOKS_NOT_CONFIGURED = "PagerDuty hooks are not configured on this deployment.";

/** Whether this deployment receives PagerDuty's webhook. */
export const hooksConfigured = (env: Env): boolean => Boolean(env.PAGERDUTY_WEBHOOK_SECRET);

export type PagerDutyEventHookTarget = RpcTarget & PagerDutyEventHook;

/** Each webhook event type a hook can watch for, by the kind it delivers as. */
export const EVENT_TYPES: ReadonlyMap<string, PagerDutyEventKind> = new Map([
  ["incident.triggered", "triggered"],
  ["incident.acknowledged", "acknowledged"],
  ["incident.unacknowledged", "unacknowledged"],
  ["incident.resolved", "resolved"],
  ["incident.reopened", "reopened"],
  ["incident.reassigned", "reassigned"],
  ["incident.escalated", "escalated"],
  ["incident.delegated", "delegated"],
  ["incident.priority_updated", "priorityUpdated"],
  ["incident.annotated", "noteAdded"],
  ["incident.responder.added", "responderAdded"],
  ["incident.status_update_published", "statusUpdatePublished"],
]);

const KINDS = [...EVENT_TYPES.values()];

/** An event as the driver queues it: what the webhook said, before any hook's owner re-reads it. */
export type StoredEvent = {
  id: string;
  kind: PagerDutyEventKind;
  occurredAt: string;
  incidentId: string;
  /** The incident's service, when the payload names it. */
  serviceId?: string;
  agent: { id: string; name: string } | null;
  note?: string;
  statusUpdate?: string;
};

/** The driver of an account's hooks, by the account's web host, e.g. `acme.eu.pagerduty.com`. */
export const driverName = (tenant: Tenant): string => new URL(webOrigin(tenant)).host;

/** The kinds `options` asks for, by default all. */
export function watchedKinds(options: PagerDutySubscribeOptions | undefined): PagerDutyEventKind[] {
  const kinds = [...new Set(options?.events ?? KINDS)];
  if (kinds.length === 0 || kinds.some(kind => !KINDS.includes(kind))) {
    throw new TypeError(`events must name at least one of ${KINDS.join(", ")}.`);
  }
  return kinds;
}

/** How the Workshop asks the user to approve a hook; by object IDs only, as descriptions are public. */
export function hookDescription(tenant: Tenant, { within, incidentId }: HookScope, kinds: PagerDutyEventKind[]): HookDescription {
  const on = incidentId ? `incident ${incidentId}` : within.serviceId ? `service ${within.serviceId}`
    : within.teamId ? `team ${within.teamId}` : driverName(tenant);
  const which = kinds.length === KINDS.length ? "every incident event" : `each ${kinds.join(", ")} event`;
  return {
    title: `Watch PagerDuty incidents on ${on}`,
    description: `Call this hook with ${which} on ${on} that the connected user can see, letting it read ` +
      "the incident and queue changes to it for approval.",
  };
}

// ── Facet side ──────────────────────────────────────────────────────

/** What a hook's delivery stub reaches: the binding's facet, narrowed to delivering. */
export interface PagerDutyHookDelivery extends RpcTarget {
  /**
   * Deliver `event` through one firing of the hook, started from `initiator` only if the hook's
   * owner can see the incident and it lies within the capability the hook subscribed through.
   */
  deliver(initiator: Fetcher<HookInitiator<PagerDutyEventHookTarget>>, event: StoredEvent): Promise<void>;
}

@validateRpc()
export class PagerDutyHookDeliveryImpl extends RpcTarget implements PagerDutyHookDelivery {
  readonly #host: SessionHost;
  readonly #scope: HookScope;

  constructor(host: SessionHost, scope: HookScope) {
    super();
    this.#host = host;
    this.#scope = scope;
  }

  async deliver(initiator: Fetcher<HookInitiator<PagerDutyEventHookTarget>>, event: StoredEvent): Promise<void> {
    const host = this.#host;
    const { scope, within, incidentId } = this.#scope;
    if (incidentId !== undefined && event.incidentId !== incidentId) return;
    let wire: WireIncident;
    try {
      // The webhook sees the whole account, so each event is re-read as the hook's owner.
      ({ incident: wire } = await host.read(api => api.get<{ incident: WireIncident }>(`/incidents/${event.incidentId}`)));
      if (await outsideOf({ host }, wire.service.id, within)) return;
    } catch (error) {
      if (!isDenial(error)) throw error;
      return;
    }
    const me = await host.me();
    using firing = await initiator.startHook();
    // @ts-expect-error Worker RPC's mapped types can't relate an ApprovalQueue stub to itself.
    const ctx = new SessionContext(host, firing.approvalQueue.dup(), scope);
    // Owns `ctx`. Released when receiveEvent() returns, or here if it is never called.
    const incident = new PagerDutyIncidentImpl(ctx, wire.id, within);
    const { note, statusUpdate } = event;
    try {
      const extra = note !== undefined ? " and the note" : statusUpdate !== undefined ? " and the status update" : "";
      await ctx.authorize(
        { title: "Received a PagerDuty incident event", description: `Received an incident's ${event.kind} event with its summary${extra}.` },
        { filter: [], result: [{ kind: "incident", id: wire.id }, { kind: "service", id: wire.service.id }] });
    } catch (error) {
      incident[Symbol.dispose]();
      throw error;
    }
    await firing.callback.receiveEvent({
      id: event.id, kind: event.kind, occurredAt: event.occurredAt,
      actor: event.agent && { ...event.agent, isYou: event.agent.id === me.userId },
      info: overlayIncident(toIncidentSummary(wire), host.pending(), id => host.resolve(id), { id: me.userId, name: me.name }),
      incident,
      ...(note !== undefined ? { note } : {}),
      ...(statusUpdate !== undefined ? { statusUpdate } : {}),
    } satisfies PagerDutyEvent);
  }
}

// ── Controller ──────────────────────────────────────────────────────

/** What the driver filters a hook's events by: cheap checks that spare firings, which the facet repeats. */
type Registration = { events: PagerDutyEventKind[]; incidentId?: string; serviceId?: string };

type Capabilities = {
  delivery: RpcStub<PagerDutyHookDelivery>;
  initiator: Fetcher<HookInitiator<PagerDutyEventHookTarget>>;
};

/** Everything a hook needs once enabled, captured when the facet binds it. */
export type PagerDutyHookProps = Registration & {
  key: string;
  /** The account's driver (see `driverName`). */
  account: string;
  delivery: RpcStub<PagerDutyHookDelivery>;
};

@validateRpc()
export class PagerDutyHookController extends WorkerEntrypoint<Env, PagerDutyHookProps>
    implements HookController<PagerDutyEventHookTarget> {
  async enable(initiator: Fetcher<HookInitiator<PagerDutyEventHookTarget>>, _target: HookTargetMetadata): Promise<void> {
    if (!hooksConfigured(this.env)) throw new Error(HOOKS_NOT_CONFIGURED);
    const { key, account, delivery, ...registration } = this.ctx.props;
    await this.ctx.exports.PagerDutyHookDriver.getByName(account).register(key, registration, { delivery, initiator });
  }

  async disable(): Promise<void> {
    const { key, account } = this.ctx.props;
    await this.ctx.exports.PagerDutyHookDriver.getByName(account).unregister(key);
  }
}

// ── Driver ──────────────────────────────────────────────────────────

const registrationKey = (key: string) => `reg:${key}`;
const capabilitiesKey = (key: string) => `caps:${key}`;

/**
 * One per PagerDuty account, named by its web host (see `driverName`). Storage: `reg:`/`caps:` per
 * enabled hook, and the delivery queue's `msg:` rows and `queue:` indexes.
 */
export class PagerDutyHookDriver extends DurableObject<Env> {
  #queue = new HookDeliveryQueue<StoredEvent>(this.ctx.storage.kv, () => {
    logger.warn("dropped a PagerDuty event after repeated delivery failures", { event: "hooks.delivery.dropped" });
  });

  async register(key: string, registration: Registration, capabilities: Capabilities): Promise<void> {
    const kv = this.ctx.storage.kv;
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.put(registrationKey(key), registration);
    kv.put(capabilitiesKey(key), capabilities);
  }

  async unregister(key: string): Promise<void> {
    const kv = this.ctx.storage.kv;
    disposeStubs(kv.get<Capabilities>(capabilitiesKey(key)));
    kv.delete(registrationKey(key));
    kv.delete(capabilitiesKey(key));
    this.#queue.cancel(key);
    await this.#reschedule();
  }

  /** Queue `event` once for each enabled hook that may watch it. */
  async ingest(event: StoredEvent): Promise<void> {
    const now = Date.now();
    // Listed in full first, as the queue lists storage too.
    for (const [regKey, registration] of Array.from(this.ctx.storage.kv.list<Registration>({ prefix: "reg:" }))) {
      if (watches(registration, event)) this.#queue.enqueue(regKey.slice("reg:".length), event.id, event, now);
    }
    await this.#reschedule();
  }

  async alarm(): Promise<void> {
    await this.#queue.run(Date.now(), (key, event) => this.#deliver(key, event));
    await this.#reschedule();
  }

  async #deliver(key: string, event: StoredEvent): Promise<void> {
    // An unregistered hook's rows are finished, and it gets no new ones.
    const capabilities = this.ctx.storage.kv.get<Capabilities>(capabilitiesKey(key));
    if (!capabilities) return;
    try {
      // A failure is retried with backoff; disabling the hook ends the retries.
      await capabilities.delivery.deliver(capabilities.initiator, event);
    } finally {
      disposeStubs(capabilities);
    }
  }

  async #reschedule(): Promise<void> {
    const due = this.#queue.nextDue();
    if (due === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }
}

/** Whether a hook may watch `event`; the facet decides, as the hook's owner sees the incident now. */
function watches({ events, incidentId, serviceId }: Registration, event: StoredEvent): boolean {
  return events.includes(event.kind) && (incidentId === undefined || incidentId === event.incidentId)
    && (serviceId === undefined || event.serviceId === undefined || serviceId === event.serviceId);
}

// ── Webhook deliveries ──────────────────────────────────────────────

/** PagerDuty drops payloads above this itself, so nothing larger is one of its deliveries. */
const MAX_DELIVERY_BYTES = 256 * 1024;
const SIGNATURE = /^v1=([0-9a-f]{64})$/i;

/**
 * Handle one delivery to `POST {BASE_URL}/webhook`: verify it, and hand its event to the account's
 * driver. Answered at once, as PagerDuty allows five seconds and disables the subscription for a
 * day after three failures in a row.
 */
export async function handleWebhook(request: Request, env: Env, exports: Cloudflare.Exports): Promise<Response> {
  const secret = env.PAGERDUTY_WEBHOOK_SECRET;
  if (!secret) return new Response("Not Found", { status: 404 });
  const signatures = request.headers.get("X-PagerDuty-Signature");
  if (!signatures) return new Response("Unauthorized", { status: 401 });
  let body: Uint8Array;
  try {
    body = await readBytesCapped(request, MAX_DELIVERY_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) return new Response("Payload Too Large", { status: 413 });
    throw error;
  }
  if (!await signed(secret, signatures, body)) return new Response("Unauthorized", { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const parsed = parseDelivery(payload);
  // A ping, an event no hook watches for, or one older than the queue remembers, which only a
  // replay delivers: signatures carry no time, and the event's own id dedupes only that long.
  if (parsed && Date.parse(parsed.event.occurredAt) >= Date.now() - DELIVERED_RETENTION_MS) {
    await exports.PagerDutyHookDriver.getByName(parsed.account).ingest(parsed.event);
  }
  return new Response(null, { status: 204 });
}

/** Whether any `v1=` signature in `header` is the body's HMAC-SHA256 under `secret`, in constant time. */
async function signed(secret: string, header: string, body: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  // Several while the secret is rotated.
  return header.split(",").some(value => {
    const hex = SIGNATURE.exec(value.trim())?.[1];
    return hex !== undefined && crypto.subtle.timingSafeEqual(expected, Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)));
  });
}

type WebhookPayload = {
  event?: {
    id?: unknown;
    event_type?: unknown;
    occurred_at?: unknown;
    agent?: (WireRef & { type?: string }) | null;
    data?: WireRef & { service?: WireRef; incident?: WireRef; content?: unknown; message?: unknown };
  };
};

/**
 * The account and event a webhook payload reports, or undefined for one no hook watches for. The
 * incident is `data` itself for incident events, and `data.incident` for notes, responders and
 * status updates; its link names the account.
 */
function parseDelivery(payload: unknown): { account: string; event: StoredEvent } | undefined {
  const { id, event_type, occurred_at, agent, data } = (payload as WebhookPayload | null)?.event ?? {};
  const kind = typeof event_type === "string" ? EVENT_TYPES.get(event_type) : undefined;
  if (kind === undefined) return undefined;
  const incident = data?.type === "incident" ? data : data?.incident;
  const link = typeof incident?.html_url === "string" ? parseResourceUrl(incident.html_url) : null;
  if (typeof id !== "string" || typeof occurred_at !== "string" || !OBJECT_ID.test(incident?.id ?? "") || !link) {
    logger.warn("ignored a PagerDuty event it could not read", { event: "hooks.delivery.unreadable" });
    return undefined;
  }
  const serviceId = data?.type === "incident" ? data.service?.id : undefined;
  const note = kind === "noteAdded" && typeof data?.content === "string" ? data.content : undefined;
  const statusUpdate = kind === "statusUpdatePublished" && typeof data?.message === "string" ? data.message : undefined;
  return {
    account: driverName(link),
    event: {
      id, kind, occurredAt: occurred_at, incidentId: incident!.id,
      ...(serviceId && OBJECT_ID.test(serviceId) ? { serviceId } : {}),
      agent: agent?.type === "user_reference" && OBJECT_ID.test(agent.id)
        ? { id: agent.id, name: agent.summary ?? agent.name ?? agent.id } : null,
      ...(note !== undefined ? { note } : {}),
      ...(statusUpdate !== undefined ? { statusUpdate } : {}),
    },
  };
}
