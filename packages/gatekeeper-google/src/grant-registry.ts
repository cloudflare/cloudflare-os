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
   */
  async remove(userObjectId: string): Promise<{ last: boolean }> {
    let kv = this.ctx.storage.kv;
    kv.delete(HOLDER_PREFIX + userObjectId);
    // Holders can be recorded while one is asked, so the list is read afresh after each answer,
    // and "none left" is answered only straight after a read that found none.
    for (;;) {
      let [holder] = kv.list<string | boolean>({ prefix: HOLDER_PREFIX, limit: 1 });
      if (holder === undefined) return { last: true };
      let [key, recorded] = holder;
      let holds = await this.#stillHolds(key.slice(HOLDER_PREFIX.length));
      // The answer stands only for the holder as it was recorded when asked. One that let go, or
      // was recorded again, while it was asked is looked at afresh.
      if (kv.get<string | boolean>(key) !== recorded) continue;
      if (holds) return { last: false };
      kv.delete(key);
    }
  }

  /**
   * Whether the account with this id says it holds this grant. An account that cannot be asked
   * counts as holding it: revoking under a connection that is in use is the worse mistake, and it
   * is asked again the next time a holder lets go.
   */
  async #stillHolds(userObjectId: string): Promise<boolean> {
    try {
      let accounts = this.ctx.exports.UserAccount;
      return await accounts.get(accounts.idFromString(userObjectId))
          .holdsGrantIn(this.ctx.id.toString());
    } catch (error) {
      logger.warn("failed to ask a Google grant's holder whether it still holds it", {
        event: "google.grant.holder.check.failed", error,
      });
      return true;
    }
  }
}
