// The schedule capability: what a schedule binding holds, and what an account or team capability
// opens. Reads report the schedule, layer-based or shift-based alike; overrides are staged as
// actions, none reaching PagerDuty before approval, and only on a layer-based schedule: a
// shift-based one's override replaces one rotation's member rather than whoever the schedule has.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { schedulePath, type Query } from "./pagerduty-api";
import { isProvisional, overrideKind } from "./pagerduty-actions";
import {
  toOverrides, toScheduleDetails, toShifts, type Schedule, type WireOverride, type WireShift, type WireShiftOverride,
} from "./pagerduty-normalize";
import { overlayOverrides, overlayShifts } from "./pagerduty-simulation";
import {
  countOf, readSchedule, requireTeam, text, time, usersNamed, windowOf, type ScheduleQuery, type SessionContext,
} from "./pagerduty-session-shared";
import { OBJECT_ID } from "./pagerduty-urls";
import type { PagerDutyOverride, PagerDutySchedule, PagerDutyScheduleDetails, PagerDutyShift, PagerDutyTimeWindow } from "./types";

/** The longest schedule window PagerDuty renders shifts for. */
const MAX_SHIFT_DAYS = 90;
/** How far ahead an override to remove is looked for; PagerDuty documents no longest window for overrides. */
const REMOVABLE_DAYS = 10 * 365;

@validateRpc()
export class PagerDutyScheduleImpl extends RpcTarget implements PagerDutySchedule {
  readonly #ctx: SessionContext;
  readonly #id: string;

  /** @param ctx Scoped to the schedule, and to the team it was opened from, which it must still belong to. */
  constructor(ctx: SessionContext, id: string) {
    super();
    this.#ctx = ctx;
    this.#id = id;
  }

  async #read(query?: ScheduleQuery): Promise<Schedule> {
    const schedule = await readSchedule(this.#ctx, this.#id, query);
    requireTeam(schedule, this.#ctx.within.teamId, "schedule");
    return schedule;
  }

  /**
   * The schedule, which is layer-based.
   * @throws Error for a shift-based schedule, whose overrides this can't add or remove.
   */
  async #requireLayerBased(): Promise<Schedule> {
    const schedule = await this.#read();
    if (schedule.shiftBased) throw new Error("Adding or removing overrides is not supported for shift-based schedules yet.");
    return schedule;
  }

  async getDetails(): Promise<PagerDutyScheduleDetails> {
    const schedule = await this.#read();
    await this.#ctx.authorize({ title: "Read a PagerDuty schedule", description: "Read the schedule's details." });
    return toScheduleDetails(schedule);
  }

  async listShifts(window?: PagerDutyTimeWindow): Promise<PagerDutyShift[]> {
    const span = windowOf(window, 7, MAX_SHIFT_DAYS);
    const { host } = this.#ctx;
    const shifts = overlayShifts(toShifts(await this.#read({ window: span, users: true })), this.#id, span,
      host.pending(), host.resolve);
    await this.#ctx.authorize({ title: "Read who is on call on a PagerDuty schedule", description: `Read ${countOf(shifts.length, "shift")}.` });
    return shifts;
  }

  async listOverrides(window?: PagerDutyTimeWindow): Promise<PagerDutyOverride[]> {
    const overrides = await this.#overrides(windowOf(window, 30));
    await this.#ctx.authorize({ title: "Read a PagerDuty schedule's overrides", description: `Read ${countOf(overrides.length, "override")}.` });
    return overrides;
  }

  /** The schedule's overrides in `span`, as pending actions leave them; `schedule` is the schedule, if already read. */
  async #overrides(span: { since: string; until: string }, schedule?: Schedule): Promise<PagerDutyOverride[]> {
    const { host } = this.#ctx;
    // Which API keeps its overrides, and on a shift-based schedule, its users' names.
    schedule ??= await this.#read({ users: true });
    const path = `${schedulePath(this.#id, schedule.shiftBased)}/overrides`;
    const read = async <W>(query: Query) => (await host.read(api => api.get<{ overrides: W[] }>(path, query))).overrides;
    const [rows, editable] = await Promise.all([
      read<WireShift | WireShiftOverride>(span), schedule.shiftBased ? [] : read<WireOverride>({ ...span, editable: true }),
    ]);
    return overlayOverrides(toOverrides(schedule, rows, editable), this.#id, span, host.pending(), host.resolve);
  }

  async createOverride(user: string, start: string, end: string): Promise<string> {
    const from = time(text(start, "start"), "start")!;
    const until = time(text(end, "end"), "end")!;
    if (Date.parse(until) <= Date.parse(from)) throw new Error("end must be after start.");
    const [, [target], me] = await Promise.all([
      this.#requireLayerBased(), usersNamed(this.#ctx, [user], "user"), this.#ctx.host.me(),
    ]);
    const ref = this.#ctx.host.allocate(overrideKind(this.#id));
    await this.#ctx.host.submit(this.#ctx.queue, target.id === me.userId ? "createOverride" : "createOverrideForOthers",
      { ref, scheduleId: this.#id, user: target, start: from, end: until, within: this.#ctx.within });
    return ref;
  }

  async deleteOverride(id: string): Promise<void> {
    if (!OBJECT_ID.test(id) && !isProvisional(id)) {
      throw new Error('id must be an override ID, such as "Q3X6MJ1LUKD6QW".');
    }
    const { host } = this.#ctx;
    // A temporary ID names an override this gadget is adding, or added, to this schedule.
    if (isProvisional(id) && host.kindOf(id) !== overrideKind(this.#id)) {
      throw new Error("That override isn't one this gadget added to this schedule.");
    }
    const schedule = await this.#requireLayerBased();
    // Only an override PagerDuty still lets anyone remove, as pending actions leave them, is
    // staged: apply takes one PagerDuty no longer has for one already removed.
    const override = (await this.#overrides(windowOf(undefined, REMOVABLE_DAYS), schedule))
      .find(listed => listed.id === host.resolve(id));
    if (!override) {
      throw new Error("This schedule has no override with that id that can still be removed; listOverrides() lists them.");
    }
    const { user, start, end } = override;
    await host.submit(this.#ctx.queue, "deleteOverride", {
      scheduleId: this.#id, overrideId: id, override: { user, start, end }, stagedAt: new Date().toISOString(),
      within: this.#ctx.within,
    });
  }

  [Symbol.dispose](): void {
    this.#ctx[Symbol.dispose]();
  }
}
