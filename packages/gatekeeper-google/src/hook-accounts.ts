// The accounts whose hooks a hook driver holds. Disconnecting a Google account (UserAccount.revoke())
// must reach every driver holding hooks of it, so each driver tells the account that it holds them
// (UserAccount.trackHookDriver()) before registering one, and asks again daily: an account that
// answers no was disconnected without reaching the driver, whose hooks of it are then dropped.

/**
 * A hook driver holding some of an account's hooks, which the account tells to drop them when it
 * is disconnected: Gmail's per mailbox, Chat's per space, Calendar's per connection and calendar.
 */
export type HookDriverRef = { kind: "gmail" | "chat" | "calendar"; name: string };

/**
 * How often each account with hooks in a driver is asked again whether it knows of the driver:
 * hooks its disconnect failed to drop stay until then, when it answers no.
 */
const RECHECK_MS = 24 * 60 * 60_000;

/** When the account last confirmed it knows the driver holds hooks of its. */
const trackedKey = (userObjectId: string) => `tracked:${userObjectId}`;
/** Set when a disconnected account's hooks are dropped, so that an enable it was making is refused. */
const forgottenKey = (userObjectId: string) => `forgotten:${userObjectId}`;

const DISCONNECTED = "This Google account has been disconnected.";

/**
 * Keeps one hook driver known to the accounts whose hooks it holds, under `tracked:` and
 * `forgotten:` keys per account in the driver's storage.
 */
export class HookDriverAccounts {
  /**
   * @param ctx The driver's state.
   * @param kind Which kind of driver this is, as the account records it.
   * @param onRecheckFailed Logs a daily recheck that failed, which the next alarm retries.
   */
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly kind: HookDriverRef["kind"],
    private readonly onRecheckFailed: (error: unknown) => void,
  ) {}

  /**
   * Tell the account that this driver, named `name`, holds hooks of its, so that disconnecting it
   * reaches them. Refuses an account disconnected already, or meanwhile: its hooks were dropped then.
   */
  async track(userObjectId: string, name: string): Promise<void> {
    const tracked = await this.#account(userObjectId).trackHookDriver({ kind: this.kind, name });
    if (!tracked) throw new Error(DISCONNECTED);
    this.assertConnected(userObjectId);
    this.ctx.storage.kv.put(trackedKey(userObjectId), Date.now());
  }

  /** Refuse an enable whose account was disconnected while it awaited, when its hooks were dropped. */
  assertConnected(userObjectId: string): void {
    if (this.ctx.storage.kv.get(forgottenKey(userObjectId)) !== undefined) throw new Error(DISCONNECTED);
  }

  /** Note that the account is disconnected, as its hooks are dropped. */
  forget(userObjectId: string): void {
    this.ctx.storage.kv.put(forgottenKey(userObjectId), Date.now());
    this.ctx.storage.kv.delete(trackedKey(userObjectId));
  }

  /**
   * Tell each account with hooks here that this driver, named as `holders` says, holds them, as
   * track() does, again each RECHECK_MS. A hook registered before accounts kept track has no record
   * of it, which disconnecting its account needs to reach it; failing, it is told at the next alarm.
   * An account disconnected without dropping its hooks here, before it could be told or by a
   * disconnect that couldn't reach this driver, has them dropped now by `forgetAccount`.
   */
  async recheck(holders: Iterable<{ userObjectId: string; name: string }>,
                forgetAccount: (userObjectId: string) => Promise<void>): Promise<void> {
    const kv = this.ctx.storage.kv;
    const due = new Map<string, string>();
    for (const { userObjectId, name } of holders) {
      if ((kv.get<number>(trackedKey(userObjectId)) ?? 0) <= Date.now() - RECHECK_MS) due.set(userObjectId, name);
    }
    for (const [userObjectId, name] of due) {
      try {
        if (await this.#account(userObjectId).trackHookDriver({ kind: this.kind, name })) {
          kv.put(trackedKey(userObjectId), Date.now());
        } else {
          await forgetAccount(userObjectId);
        }
      } catch (error) {
        this.onRecheckFailed(error);
      }
    }
  }

  #account(userObjectId: string) {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(userObjectId));
  }
}
