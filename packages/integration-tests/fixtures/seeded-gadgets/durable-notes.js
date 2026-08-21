// @ts-check

import { DurableObject } from "cloudflare:workers";

/** @typedef {{ id: string; body: string }} Note */

export class Gadget extends DurableObject {
  instance = crypto.randomUUID();
  callsSinceStart = 0;

  /** @param {DurableObjectState} ctx @param {unknown} env */
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  }

  /** @param {Note} input */
  async put(input) {
    this.callsSinceStart++;
    this.ctx.storage.sql.exec(
      "INSERT INTO notes (id, body) VALUES (?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET body = excluded.body",
      input.id, input.body);
    return { ok: true };
  }

  /** @returns {Promise<Note[]>} */
  async all() {
    this.callsSinceStart++;
    return [...this.ctx.storage.sql.exec("SELECT id, body FROM notes ORDER BY id")]
      .map(row => ({ id: String(row.id), body: String(row.body) }));
  }

  async liveness() {
    return { instance: this.instance, callsSinceStart: this.callsSinceStart };
  }
}
