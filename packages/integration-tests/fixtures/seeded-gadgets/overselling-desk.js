// @ts-check

import { DurableObject } from "cloudflare:workers";

/** @typedef {{ slotId: string; capacity: number }} DefineSlotInput */
/** @typedef {{ bookingId: string; slotId: string }} BookInput */

export class Gadget extends DurableObject {
  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS slots (slotId TEXT PRIMARY KEY, capacity INTEGER NOT NULL)");
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS bookings (bookingId TEXT PRIMARY KEY, slotId TEXT NOT NULL)");
  }

  /** @param {DefineSlotInput} input */
  async defineSlot(input) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO slots (slotId, capacity) VALUES (?, ?)", input.slotId, input.capacity);
    return { ok: true };
  }

  /** @param {BookInput} input */
  async book(input) {
    const slot = [...this.ctx.storage.sql.exec(
      "SELECT capacity FROM slots WHERE slotId = ?", input.slotId)].at(0);
    if (slot === undefined) return { ok: false, error: "UNKNOWN_SLOT" };
    const count = [...this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM bookings WHERE slotId = ?", input.slotId)].at(0);
    if (count === undefined) throw new Error("COUNT query returned no row");
    if (Number(count.n) >= Number(slot.capacity)) return { ok: false, error: "SLOT_FULL" };

    // Yielding between the check and write lets queued calls pass the same capacity check.
    await scheduler.wait(1);

    this.ctx.storage.sql.exec(
      "INSERT INTO bookings (bookingId, slotId) VALUES (?, ?)", input.bookingId, input.slotId);
    return { ok: true };
  }

  /** @param {{ slotId: string }} input */
  async bookedCount(input) {
    const count = [...this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM bookings WHERE slotId = ?", input.slotId)].at(0);
    if (count === undefined) throw new Error("COUNT query returned no row");
    return Number(count.n);
  }
}
