/**
 * Hand-written Gadget sources for tests that need a known implementation rather than whatever an
 * agent produced. Kept as strings because that is exactly what `AgentSession.seedGadget()` writes
 * into the workspace's Yjs document.
 */

/**
 * Stores notes in SQL and deliberately also keeps state in memory, so a test can tell a restart
 * apart from a no-op: `rows` must survive one and `instance`/`callsSinceStart` must not.
 */
export const DURABLE_NOTES_SERVER = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    // Memory, which a restart must discard.
    this.instance = crypto.randomUUID();
    this.callsSinceStart = 0;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  }

  async put(input) {
    this.callsSinceStart++;
    this.ctx.storage.sql.exec(
      "INSERT INTO notes (id, body) VALUES (?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      input.id, input.body);
    return { ok: true };
  }

  async all() {
    this.callsSinceStart++;
    return [...this.ctx.storage.sql.exec("SELECT id, body FROM notes ORDER BY id")]
        .map(row => ({ id: row.id, body: row.body }));
  }

  async liveness() {
    return { instance: this.instance, callsSinceStart: this.callsSinceStart };
  }
}
`;

/**
 * A booking gadget written the obvious wrong way: it reads the count, checks capacity, then awaits
 * before inserting. Exists to prove that concurrent RPC calls really do interleave here, which is
 * the premise the eval suite's overselling check depends on.
 */
export const OVERSELLING_DESK_SERVER = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS slots (slotId TEXT PRIMARY KEY, capacity INTEGER NOT NULL)");
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS bookings (bookingId TEXT PRIMARY KEY, slotId TEXT NOT NULL)");
  }

  async defineSlot(input) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO slots (slotId, capacity) VALUES (?, ?)", input.slotId, input.capacity);
    return { ok: true };
  }

  async book(input) {
    const slot = [...this.ctx.storage.sql.exec(
      "SELECT capacity FROM slots WHERE slotId = ?", input.slotId)].at(0);
    if (slot === undefined) return { ok: false, error: "UNKNOWN_SLOT" };
    const booked = [...this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM bookings WHERE slotId = ?", input.slotId)].at(0).n;
    if (booked >= slot.capacity) return { ok: false, error: "SLOT_FULL" };

    // The bug under test: yielding between the check and the write lets every other queued call
    // pass the same capacity check before any of them has inserted.
    await scheduler.wait(1);

    this.ctx.storage.sql.exec(
      "INSERT INTO bookings (bookingId, slotId) VALUES (?, ?)", input.bookingId, input.slotId);
    return { ok: true };
  }

  async bookedCount(input) {
    return [...this.ctx.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM bookings WHERE slotId = ?", input.slotId)].at(0).n;
  }
}
`;

/** A server that loads and answers, paired with a `client.js` that cannot parse. */
export const VALID_SERVER_ONLY = `
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  async ping() { return "ok"; }
}
`;
