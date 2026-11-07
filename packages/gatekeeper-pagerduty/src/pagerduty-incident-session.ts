// The incident capability: what an incident binding holds, and what a broader capability or a
// hook's event hands out for one incident. Reads report the incident and its service; every change
// validates, then stages an action, and none reaches PagerDuty before approval.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ArrayCursor } from "@gadgets/gatekeeper-kit/cursors";
import type { ObservationInput } from "@gadgets/gatekeeper-kit/observers";
import { listing, type Query } from "./pagerduty-api";
import { isProvisional, type IncidentTarget, type NewIncident, type PagerDutyActions } from "./pagerduty-actions";
import {
  toAlert, toIncidentDetails, toIncidentSummary, toNote, toTimelineEntry,
  type WireAlert, type WireIncident, type WireNote,
} from "./pagerduty-normalize";
import { overlayIncident, pendingIncident, pendingNotes } from "./pagerduty-simulation";
import {
  MAX_NOTE_LENGTH, countOf, currentIncident, ids, incident, listed, offsetCursor, outsideOf, pageSizeOf, priorityNamed,
  service, subscribed, text, usersNamed, youRef, type ObjectRef, type SessionContext, type Within,
} from "./pagerduty-session-shared";
import { OBJECT_ID, objectId } from "./pagerduty-urls";
import type { PagerDutyEventHookTarget } from "./pagerduty-hooks";
import type {
  Cursor, PagerDutyAlert, PagerDutyIncident, PagerDutyIncidentDetails, PagerDutyIncidentSummary, PagerDutyNote,
  PagerDutyPageOptions, PagerDutyResponderRequest, PagerDutySubscribeOptions, PagerDutyTimelineEntry, PagerDutyUrgency,
} from "./types";

/** PagerDuty's longest snooze. */
const MAX_SNOOZE_SECONDS = 604_800;

/** An incident as one read found it: PagerDuty's, or one a pending action opens. */
type Loaded = { wire: WireIncident; pending?: never } | { wire?: never; pending: NewIncident };

const INCIDENT_INCLUDES = ["acknowledgers", "assignees", "conference_bridge", "priorities", "body"];

/** The kinds of action that act on one incident. */
type IncidentActionKind = { [K in keyof PagerDutyActions]: PagerDutyActions[K] extends { incident: IncidentTarget } ? K : never }[keyof PagerDutyActions];

/**
 * The incident `id` names now, checked against `within`: PagerDuty's ID, or the `~N` of one a
 * pending action opens.
 */
async function load(ctx: SessionContext, id: string, within: Within, includes: readonly string[] = []): Promise<Loaded> {
  const { host } = ctx;
  const resolved = host.resolve(id);
  if (!isProvisional(resolved)) {
    const { wire, outside } = await currentIncident(ctx, resolved, within, includes);
    if (outside) throw new Error(outside);
    return { wire };
  }
  const created = host.pending().find(({ action }) => action.kind === "createIncident" && action.payload.ref === resolved);
  if (created?.action.kind !== "createIncident") {
    throw new Error("This incident was never opened: opening it was rejected or failed.");
  }
  const why = await outsideOf(ctx, created.action.payload.service.id, within);
  if (why) throw new Error(why);
  return { pending: created.action.payload };
}

@validateRpc()
export class PagerDutyIncidentImpl extends RpcTarget implements PagerDutyIncident {
  readonly #ctx: SessionContext;
  readonly #id: string;
  readonly #within: Within;

  /**
   * @param id PagerDuty's ID, or the `~N` of an incident a pending action opens.
   * @param within The team or service the incident was opened from, which it must still belong to.
   */
  constructor(ctx: SessionContext, id: string, within: Within) {
    super();
    this.#ctx = ctx;
    this.#id = id;
    this.#within = within;
  }

  /** Opens an incident by ID or number, refusing one outside `within`. */
  static async open(ctx: SessionContext, idOrNumber: string, within: Within): Promise<PagerDutyIncidentImpl> {
    if (!OBJECT_ID.test(idOrNumber) && !isProvisional(idOrNumber)) {
      throw new Error('idOrNumber must be an incident ID, such as "Q2W3E4R5T6Y7U8", or its number.');
    }
    const loaded = await load(ctx, idOrNumber, within);
    return new PagerDutyIncidentImpl(ctx.dup(), loaded.wire?.id ?? idOrNumber, within);
  }

  /** The incident now, checked against the capability's scope. */
  #load(includes: readonly string[] = []): Promise<Loaded> {
    return load(this.#ctx, this.#id, this.#within, includes);
  }

  /** What this incident's reads depend on: itself, once PagerDuty has it, and its service. */
  #result(loaded: Loaded): ObjectRef[] {
    return loaded.wire ? [incident(loaded.wire.id), service(loaded.wire.service.id)] : [service(loaded.pending.service.id)];
  }

  async #you() {
    return youRef(await this.#ctx.host.me());
  }

  async getDetails(): Promise<PagerDutyIncidentDetails> {
    const { host } = this.#ctx;
    const loaded = await this.#load(INCIDENT_INCLUDES);
    const you = await this.#you();
    let details: PagerDutyIncidentDetails;
    if (loaded.wire) {
      const id = loaded.wire.id;
      const { alerts } = await host.read(api => api.get<{ alerts: WireAlert[] }>(`/incidents/${id}/alerts`,
        { limit: 1, sort_by: "created_at:asc" }));
      details = toIncidentDetails(loaded.wire, alerts[0] ?? null);
    } else {
      details = pendingIncident(loaded.pending, you);
    }
    await this.#ctx.authorize({ title: "Read a PagerDuty incident", description: "Read the incident's details." },
      { filter: [], result: this.#result(loaded) });
    return overlayIncident(details, host.pending(), host.resolve, you);
  }

  async getTimeline(options?: PagerDutyPageOptions): Promise<Cursor<PagerDutyTimelineEntry>> {
    // PagerDuty lists an incident's log oldest first: its first entry is the trigger (see
    // https://docs.pagerduty.com/developer/retrieve-incident-details).
    return await this.#listing(options, listed("Read a PagerDuty incident's log", "log entry"), "log_entries", {},
      toTimelineEntry);
  }

  async listNotes(): Promise<PagerDutyNote[]> {
    const { host } = this.#ctx;
    const loaded = await this.#load();
    const rows = loaded.wire
      ? (await host.read(api => api.get<{ notes: WireNote[] }>(`/incidents/${loaded.wire.id}/notes`))).notes.map(toNote)
      : [];
    const id = loaded.wire ? loaded.wire.id : loaded.pending.ref;
    const notes = [...rows, ...pendingNotes(id, host.pending(), host.resolve, await this.#you())]
      .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    await this.#ctx.authorize({ title: "Read a PagerDuty incident's notes", description: `Read ${countOf(notes.length, "note")}.` },
      { filter: [], result: this.#result(loaded) });
    return notes;
  }

  async listAlerts(options?: PagerDutyPageOptions): Promise<Cursor<PagerDutyAlert>> {
    return await this.#listing<WireAlert, PagerDutyAlert>(options, listed("Listed a PagerDuty incident's alerts", "alert"),
      "alerts", { sort_by: "created_at:desc" }, toAlert);
  }

  /**
   * One of the incident's listings, `GET /incidents/{id}/{key}`, walked by offset, each page
   * authorized with the incident's dependencies.
   */
  async #listing<W, T>(options: PagerDutyPageOptions | undefined,
                       describe: (rows: readonly T[], terminal: boolean) => ObservationInput, key: string, query: Query,
                       convert: (row: W) => T): Promise<Cursor<T>> {
    const pageSize = pageSizeOf(options);
    const loaded = await this.#load();
    // An incident still waiting to be opened has none.
    if (!loaded.wire) {
      await this.#ctx.authorize(describe([], true), { filter: [], result: this.#result(loaded) });
      return new ArrayCursor<T>([], pageSize);
    }
    const { id } = loaded.wire;
    return offsetCursor(this.#ctx, {
      pageSize,
      sources: [listing(`/incidents/${id}/${key}`, key, query, convert)],
      describe,
      filter: [],
      // The incident can move to another service while the walk is open, so each page reads it
      // again: refused once it has left the capability's scope, and reporting the service it is on.
      result: async () => this.#result(await this.#load()),
    });
  }

  /** The incident an action stages against, checked against the capability's scope. */
  async #target(): Promise<{ target: IncidentTarget; status: PagerDutyIncidentSummary["status"] }> {
    const { host } = this.#ctx;
    const loaded = await this.#load();
    const you = await this.#you();
    const summary = loaded.wire ? toIncidentSummary(loaded.wire) : pendingIncident(loaded.pending, you);
    const { status } = overlayIncident(summary, host.pending(), host.resolve, you);
    if (!loaded.wire) return { target: { id: this.#id }, status };
    // PagerDuty's ID and number reach the approval text, so they are held to PagerDuty's grammar.
    const { id, incident_number: number } = loaded.wire;
    if (!OBJECT_ID.test(id) || !Number.isSafeInteger(number)) throw new Error("PagerDuty described the incident in an unexpected form.");
    return { target: { id, number }, status };
  }

  /** Stages `kind` against this incident, once `check` passes for its status as pending actions leave it. */
  async #stage<K extends IncidentActionKind>(kind: K, fields: Omit<PagerDutyActions[K], "incident">,
                                             check?: (status: PagerDutyIncidentSummary["status"]) => void): Promise<void> {
    const { target, status } = await this.#target();
    check?.(status);
    await this.#ctx.host.submit(this.#ctx.queue, kind, { incident: target, ...fields } as PagerDutyActions[K]);
  }

  async acknowledge(): Promise<void> {
    await this.#stage("acknowledge", {}, status => {
      // PagerDuty reopens a resolved incident it is asked to acknowledge.
      if (status === "resolved") throw new Error("A resolved incident can't be acknowledged.");
    });
  }

  async resolve(resolution?: string): Promise<void> {
    const note = resolution === undefined ? undefined : text(resolution, "resolution", MAX_NOTE_LENGTH);
    await this.#stage("resolve", note !== undefined ? { resolution: note } : {});
  }

  async snooze(seconds: number): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SNOOZE_SECONDS) {
      throw new Error(`seconds must be a whole number from 1 to ${MAX_SNOOZE_SECONDS}.`);
    }
    await this.#stage("snooze", { seconds }, status => {
      if (status !== "acknowledged") throw new Error("Only an acknowledged incident can be snoozed.");
    });
  }

  async addNote(content: string): Promise<void> {
    text(content, "content", MAX_NOTE_LENGTH);
    const ref = this.#ctx.host.allocate("note");
    await this.#stage("addNote", { ref, content, stagedAt: new Date().toISOString() });
  }

  async reassign(to: { users: string[] } | { escalationPolicyId: string }): Promise<void> {
    const assignee = "users" in to
      ? { users: await usersNamed(this.#ctx, to.users, "users") }
      : { escalationPolicyId: objectId(to.escalationPolicyId, "escalationPolicyId") };
    await this.#stage("reassign", { to: assignee });
  }

  async escalate(level: number): Promise<void> {
    if (!Number.isInteger(level) || level < 1) throw new Error("level must be a whole number from 1.");
    await this.#stage("escalate", { level });
  }

  async requestResponders(options: PagerDutyResponderRequest): Promise<void> {
    const message = text(options.message, "message", MAX_NOTE_LENGTH);
    const users = options.users?.length ? await usersNamed(this.#ctx, options.users, "users") : [];
    const escalationPolicyIds = ids(options.escalationPolicyIds, "escalationPolicyIds") ?? [];
    if (users.length + escalationPolicyIds.length === 0) throw new Error("Name at least one user or escalation policy.");
    await this.#stage("requestResponders", { message, users, escalationPolicyIds });
  }

  async setPriority(priority: string | null): Promise<void> {
    const chosen = priority === null ? null : await priorityNamed(this.#ctx, priority);
    await this.#stage("setPriority", { priority: chosen });
  }

  async setUrgency(value: PagerDutyUrgency): Promise<void> {
    await this.#stage(value === "high" ? "raiseUrgency" : "lowerUrgency", {});
  }

  async setTitle(title: string): Promise<void> {
    text(title, "title", 1024);
    await this.#stage("setTitle", { title });
  }

  async postStatusUpdate(message: string): Promise<void> {
    text(message, "message", MAX_NOTE_LENGTH);
    await this.#stage("postStatusUpdate", { message });
  }

  async subscribe(hook: RpcStub<PagerDutyEventHookTarget>, options?: PagerDutySubscribeOptions): Promise<void> {
    const loaded = await this.#load();
    if (!loaded.wire) throw new Error("This incident can't be watched until PagerDuty has opened it.");
    await subscribed(this.#ctx, hook, options, this.#within, loaded.wire.id);
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}
