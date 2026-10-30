import type { RpcTarget } from "capnweb";

// Navigation between the Workshop and a sandboxed gatekeeper management app. The Workshop owns the
// browser URL: the app hosted at /gatekeepers/<appId> is addressed by the app-local path after that
// prefix. App-local paths are decoded text: "/" is the app's root; any other path is "/" followed
// by non-empty segments separated by "/". The Workshop percent-encodes each segment in the URL, so
// a segment can hold any character except "/".

/** Options for GatekeeperAppNavigation.navigatePath(). */
export type GatekeeperAppNavigateOptions = {
  /** Replace the current browser-history entry instead of pushing a new one. */
  replace?: boolean;
};

/** A sandboxed gatekeeper app capability that receives its committed app-local path. */
export interface GatekeeperAppPathReceiver extends RpcTarget {
  /**
   * Applies the committed app-local path: the current one when the app subscribes, then each later
   * change, whether the app requested it or the user moved through browser history. The path comes
   * from the address bar, so the app must treat it as untrusted input.
   */
  setPath(path: string): void;
}

/** The Workshop's navigation capability for a sandboxed gatekeeper app. */
export interface GatekeeperAppNavigation extends RpcTarget {
  /**
   * Registers `receiver` in place of any earlier one and delivers the current path to it. Resolves
   * once that first delivery has completed.
   */
  subscribePath(receiver: GatekeeperAppPathReceiver): Promise<void>;

  /**
   * Navigates within this app, pushing a browser-history entry unless `options.replace` is set.
   * Navigating to the current path is a no-op. The subscribed receiver learns the committed path
   * through setPath(). Rejects an invalid path without navigating.
   */
  navigatePath(path: string, options?: GatekeeperAppNavigateOptions): Promise<void>;
}
