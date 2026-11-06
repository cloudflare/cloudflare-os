// The schedule capability: what a schedule binding holds, and what an account or team capability
// opens. Reads report the schedule; overrides are staged as actions, none reaching PagerDuty before
// approval.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { Query } from "./pagerduty-api";
import { isProvisional } from "./pagerduty-actions";
import { toOverride, toScheduleDetails, toShift, type WireOverride, type WireSchedule } from "./pagerduty-normalize";
import { overlayOverrides, overlayShifts } from "./pagerduty-simulation";
import { countOf, requireTeam, text, time, usersNamed, windowOf, type SessionContext } from "./pagerduty-session-shared";
import { OBJECT_ID } from "./pagerduty-urls";
import type { PagerDutyOverride, PagerDutySchedule, PagerDutyScheduleDetails, PagerDutyShift, PagerDutyTimeWindow } from "./types";

/** The longest schedule window PagerDuty renders shifts for. */
const MAX_SHIFT_DAYS = 90;

@validateRpc()
export class PagerDutyScheduleImpl extends RpcTarget implements PagerDutySchedule {
  readonly #ctx: SessionContext;
  readonly #id: string;
  readonly #teamId?: string;

  /** @param within The team the schedule was opened from, which it must still belong to. */
  constructor(ctx: SessionContext, id: string, within: { teamId?: string }) {
    super();
    this.#ctx = ctx;
    this.#id = id;
    this.#teamId = within.teamId;
  }

  async #read(query: Query = {}): Promise<WireSchedule> {
    const { schedule: wire } = await this.#ctx.host.read(api =>
      api.get<{ schedule: WireSchedule }>(`/schedules/${this.#id}`, query));
    requireTeam(wire, this.#teamId, "schedule");
    return wire;
  }

  async getDetails(): Promise<PagerDutyScheduleDetails> {
    const wire = await this.#read();
    await this.#ctx.authorize({ title: "Read a PagerDuty schedule", description: "Read the schedule's details." },
      { filter: [], result: [] });
    return toScheduleDetails(wire);
  }

  async listShifts(window?: PagerDutyTimeWindow): Promise<PagerDutyShift[]> {
    const span = windowOf(window, 7, MAX_SHIFT_DAYS);
    const wire = await this.#read(span);
    const { host } = this.#ctx;
    const shifts = overlayShifts((wire.final_schedule?.rendered_schedule_entries ?? []).map(toShift), this.#id, span,
      host.pending(), id => host.resolve(id));
    await this.#ctx.authorize({ title: "Read who is on call on a PagerDuty schedule", description: `Read ${countOf(shifts.length, "shift")}.` },
      { filter: [], result: [] });
    return shifts;
  }

  async listOverrides(window?: PagerDutyTimeWindow): Promise<PagerDutyOverride[]> {
    const span = windowOf(window, 30);
    const { host } = this.#ctx;
    if (this.#teamId) await this.#read();
    const rows = await host.read(api =>
      api.get<{ overrides: WireOverride[] }>(`/schedules/${this.#id}/overrides`, span));
    const overrides = overlayOverrides(rows.overrides.map(toOverride), this.#id, span, host.pending(), id => host.resolve(id));
    await this.#ctx.authorize({ title: "Read a PagerDuty schedule's overrides", description: `Read ${countOf(overrides.length, "override")}.` },
      { filter: [], result: [] });
    return overrides;
  }

  async createOverride(user: string, start: string, end: string): Promise<string> {
    const from = time(text(start, "start"), "start")!;
    const until = time(text(end, "end"), "end")!;
    if (Date.parse(until) <= Date.parse(from)) throw new Error("end must be after start.");
    if (this.#teamId) await this.#read();
    const [target] = await usersNamed(this.#ctx, [user], "user");
    const me = await this.#ctx.host.me();
    const ref = this.#ctx.host.allocate("override");
    await this.#ctx.host.submit(this.#ctx.queue, target.id === me.userId ? "createOverride" : "createOverrideForOthers",
      { ref, scheduleId: this.#id, user: target, start: from, end: until });
    return ref;
  }

  async deleteOverride(id: string): Promise<void> {
    if (typeof id !== "string" || (!OBJECT_ID.test(id) && !isProvisional(id))) {
      throw new Error('id must be an override ID, such as "Q3X6MJ1LUKD6QW".');
    }
    const { host } = this.#ctx;
    // A temporary ID names an override a pending action adds; it must be adding it to this schedule.
    if (isProvisional(host.resolve(id)) && !host.pending().some(({ action }) =>
      (action.kind === "createOverride" || action.kind === "createOverrideForOthers")
        && action.payload.ref === id && action.payload.scheduleId === this.#id)) {
      throw new Error("That override isn't one this gadget is adding to this schedule.");
    }
    if (this.#teamId) await this.#read();
    await host.submit(this.#ctx.queue, "deleteOverride",
      { scheduleId: this.#id, overrideId: id, stagedAt: new Date().toISOString() });
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}
