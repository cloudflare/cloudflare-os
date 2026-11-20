// The connections on this deployment that hold one Google account's grant.
//
// Google revokes a grant for a whole Google Cloud project at once: revoking any refresh token of a
// Google account ends every token the project's clients hold for that account. A connection that
// revoked its own token when it was disconnected would end every other connection of the same
// Google account with it. So each account object records itself here while it holds credentials,
// and revokes at Google only when it is the last to let go.

import { DurableObject } from "cloudflare:workers";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({
  component: "gatekeeper.google.grants", vendorId: "google",
});

const HOLDER_PREFIX = "holder:";

// How long asking the holders may take in all: a disconnect waits on it, with its lock held, and
// what is left unasked then is asked again later, by the revocation it keeps (see `unsure`).
const HOLDER_SCAN_MS = 20 * 1000;

/** One Google account's grant holders; the object is named by the account's stable subject (`sub`). */
export class GoogleGrantRegistry extends DurableObject<Env> {
  /** Records the `UserAccount` with this id as a holder of the grant. */
  async add(userObjectId: string): Promise<void> {
    // A new value each time, by which remove() tells a holder recorded again while it was asked.
    this.ctx.storage.kv.put<string>(HOLDER_PREFIX + userObjectId, crypto.randomUUID());
  }

  /**
   * Forgets the holder, whether or not it was recorded, asking no other holder anything: for one
   * that lets go without revoking the grant.
   */
  async drop(userObjectId: string): Promise<void> {
    this.ctx.storage.kv.delete(HOLDER_PREFIX + userObjectId);
  }

  /**
   * Forgets the holder, whether or not it was recorded, and says whether no holder is left: only
   * then does revoking the grant at Google end no other connection.
   *
   * A recorded holder is believed only while its account says it still holds the grant. An account
   * whose removal never arrived here, because the call failed or the account's storage was deleted
   * some other way, is dropped when it is asked, so it cannot keep the grant from being revoked.
   * `unsure` says no holder answered that it holds the grant, but one could not be asked, or could
   * not yet say, or was still to be asked when `scanMs` ran out, and so was counted as holding it.
   * The holders are asked from the `startAt`th on, round the list, so that a caller asking again
   * reaches the ones a slow holder before them kept it from.
   */
  async remove(userObjectId: string, scanMs = HOLDER_SCAN_MS, startAt = 0)
      : Promise<{ last: boolean; unsure?: true }> {
    let kv = this.ctx.storage.kv;
    kv.delete(HOLDER_PREFIX + userObjectId);
    let deadline = Date.now() + scanMs;
    // Holders that could not say, each with the record it was asked under: passed over, so that
    // one listed after them can still say it holds the grant.
    let unknown = new Map<string, string | boolean>();
    // Holders can be recorded while one is asked, so the list is read afresh after each answer,
    // and "none left" is answered only straight after a read that found none.
    for (;;) {
      let listed = [...kv.list<string | boolean>({ prefix: HOLDER_PREFIX })];
      let first = listed.length === 0 ? 0 : startAt % listed.length;
      let holder = [...listed.slice(first), ...listed.slice(0, first)]
          .find(([key, recorded]) => unknown.get(key) !== recorded);
      if (holder === undefined) {
        let unsure = [...unknown].some(([key, recorded]) => kv.get<string | boolean>(key) === recorded);
        return unsure ? { last: false, unsure: true } : { last: true };
      }
      let [key, recorded] = holder;
      let holds = await within(this.#stillHolds(key.slice(HOLDER_PREFIX.length)), deadline);
      if (holds === undefined) return { last: false, unsure: true };
      // The answer stands only for the holder as it was recorded when asked. One that let go, or
      // was recorded again, while it was asked is looked at afresh.
      if (kv.get<string | boolean>(key) !== recorded) continue;
      if (holds === "unknown") {
        unknown.set(key, recorded);
        continue;
      }
      if (holds) return { last: false };
      kv.delete(key);
    }
  }

  /**
   * Whether the account with this id says it holds this grant, or `"unknown"` when it cannot be
   * asked or cannot yet say, which counts as holding it: revoking under a connection that is in use
   * is the worse mistake, and it is asked again the next time a holder lets go.
   */
  async #stillHolds(userObjectId: string): Promise<boolean | "unknown"> {
    try {
      let accounts = this.ctx.exports.UserAccount;
      return await accounts.get(accounts.idFromString(userObjectId))
          .holdsGrantIn(this.ctx.id.toString());
    } catch (error) {
      logger.warn("failed to ask a Google grant's holder whether it still holds it", {
        event: "google.grant.holder.check.failed", error,
      });
      return "unknown";
    }
  }
}

/** What `answer` settles to, or undefined once `deadline` has passed first. */
async function within<T>(answer: Promise<T>, deadline: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
