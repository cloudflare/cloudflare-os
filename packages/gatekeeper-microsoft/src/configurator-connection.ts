// What the Outlook and Calendar configurator frames share: how they reach the connection, and the
// short-lived cache that saves a frame asking Graph the same thing twice while it is open.

import { GraphApi } from "./graph-api";
import { accountSource, type StoredIdentity } from "./microsoft-credentials";

/** How a configurator reaches the connection: the account Durable Object, or a token in tests. */
export interface ConfiguratorConnection {
  identity(): Promise<StoredIdentity>;
  grantedScopes(): Promise<string[]>;
  read<T>(op: (api: GraphApi) => Promise<T>): Promise<T>;
}

/** The connection held by the user's account Durable Object. */
export function accountConnection(exports: Cloudflare.Exports, userObjectId: string): ConfiguratorConnection {
  const creds = accountSource(exports, userObjectId);
  const account = () => exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId));
  return {
    identity: async () => await account().getIdentity(),
    grantedScopes: async () => await account().getGrantedScopes(),
    read: async op => await creds.run(credentials => op(new GraphApi(credentials.accessToken)), { replayable: true }),
  };
}

const ADDRESS = /^[^\s@<>()",;:/\\]+@[^\s@<>()",;:/\\]+\.[^\s@<>()",;:/\\]+$/;

/** Whether this is shaped like an email address a binding could store. */
export function isAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address);
}

/** An address as a binding stores it, or an error saying what's wrong with it. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!isAddress(trimmed)) throw new Error(`"${address.trim().slice(0, 80)}" isn't an email address.`);
  return trimmed;
}

/** The connected identity and grant, with the address the user signed in as. */
export type Connected = { identity: StoredIdentity; scopes: string[]; me: string };

/** A cache entry: what was loaded, and when. */
export type Cached<T> = { at: number; value: Promise<T> };

/** How long the identity, grant and what the frame has opened are reused while it is open. */
const CACHE_TTL_MS = 60 * 1000;
/** Entries a keyed cache holds before it starts over: a frame opens a handful of things, not hundreds. */
const MAX_ENTRIES = 50;

/** What a frame has learned through its connection, reused briefly. A failure isn't kept, so the next request asks again. */
export class ConnectionCache {
  readonly #connection: ConfiguratorConnection;
  readonly #now: () => number;
  #state?: Cached<Connected>;

  constructor(connection: ConfiguratorConnection, now: () => number = Date.now) {
    this.#connection = connection;
    this.#now = now;
  }

  /** The connected identity and grant. */
  connected(): Promise<Connected> {
    return this.#fresh(() => this.#state, entry => (this.#state = entry), () => Promise.all([this.#connection.identity(), this.#connection.grantedScopes()])
      .then(([identity, scopes]) => ({ identity, scopes, me: (identity.email ?? identity.username ?? "").toLowerCase() })));
  }

  /** Forgets the identity and grant, so the next `connected` asks again: after a consent pop-up. */
  forget(): void {
    this.#state = undefined;
  }

  /** The entry `map` holds for `key` while it is fresh, or a new one from `load`. */
  cached<T>(map: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
    if (map.size >= MAX_ENTRIES && !map.has(key)) map.clear();
    return this.#fresh(() => map.get(key), entry => {
      if (entry !== undefined) map.set(key, entry);
      else map.delete(key);
    }, load);
  }

  #fresh<T>(get: () => Cached<T> | undefined, set: (entry: Cached<T> | undefined) => void, load: () => Promise<T>): Promise<T> {
    const now = this.#now();
    const entry = get();
    if (entry !== undefined && now - entry.at < CACHE_TTL_MS) return entry.value;
    const fresh: Cached<T> = { at: now, value: load() };
    set(fresh);
    fresh.value.catch(() => {
      if (get() === fresh) set(undefined);
    });
    return fresh.value;
  }
}
