// The watchers of ObservationAuthorizer.watchSession(). Each is held, in memory, until something
// ends the session it watches. A session can end in several ways (its queue is released, its
// connection removed, its execution ends, its hook is disabled), so each watch is filed under
// every one that applies to it, and released by whichever comes first. If the workspace restarts,
// the stubs are dropped with it, and the runtime releases the watchers on the gatekeeper's side.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

/** Something whose end ends the sessions filed under it. */
export type SessionEnd =
    `queue:${number}` | `gatekeeper:${number}` | `execution:${string}` | `hook:${number}`;

/** The watches held for one workspace's sessions. */
export class SessionWatchers {
  #watches = new Map<SessionEnd, Set<() => void>>();
  #nextQueue = 0;

  /** A new key for one authorizer, which ends with it. */
  newQueue(): SessionEnd {
    return `queue:${this.#nextQueue++}`;
  }

  /**
   * `ObservationAuthorizer.watchSession()` for a session that each of `ends` ends, or one already
   * over if `over` is true.
   */
  watch(ends: SessionEnd[], watcher: RpcStub<RpcTarget>, over: boolean): RpcStub<RpcTarget> {
    if (over) {
      watcher[Symbol.dispose]();
      return new RpcStub(new WatchHandle(() => {}));
    }
    let held: RpcStub<RpcTarget> | undefined = watcher.dup();
    let release = () => {
      if (held === undefined) return;
      let released = held;
      held = undefined;
      for (let end of ends) {
        let watches = this.#watches.get(end);
        watches?.delete(release);
        if (watches?.size === 0) this.#watches.delete(end);
      }
      released[Symbol.dispose]();
    };
    for (let end of ends) {
      let watches = this.#watches.get(end) ?? new Set();
      this.#watches.set(end, watches.add(release));
    }
    return new RpcStub(new WatchHandle(release));
  }

  /** Releases the watchers of every session that `end` ends. */
  end(end: SessionEnd): void {
    for (let release of this.#watches.get(end) ?? []) release();
  }
}

/** The handle watchSession() returns: disposing it stops the watch. */
@validateRpc()
class WatchHandle extends RpcTarget {
  #release: () => void;

  constructor(release: () => void) {
    super();
    this.#release = release;
  }

  [Symbol.dispose](): void {
    this.#release();
  }
}
