import { createLogger } from "@gadgets/backend-utils/logger";
import { ACCESS_TOKEN_SAFETY_MS, generateNonce } from "./connect-nonce";
import type { KvMutable } from "./kv";
import { perStorage } from "./per-storage";
import { SingleFlight } from "./single-flight";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.credentials" });

/** The Durable Object KV surface used to hold credentials. Pass `ctx.storage.kv` itself, never a
 *  per-call wrapper: refresh coalescing keys on this object's identity, and a fresh wrapper per
 *  call would give each concurrent rotate its own flight -- two flights each spend the single-use
 *  refresh token, and the loser reads as grant death. */
export type CredentialsKv = KvMutable;

/**
 * Provider-proven death of the grant itself: the user must reconnect. Everything else -- 5xx, WAF
 * pages, redirects, network failures -- is infrastructure, and must propagate unchanged so stored
 * credentials survive it.
 */
export class CredentialsExpiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialsExpiredError";
  }
}

/**
 * The canonical record, plus the two keys beside it. Fixed rather than configurable: one layout
 * for every gatekeeper on the kit is what lets `identity()` and the migration marker mean the same
 * thing everywhere, and a foreign layout is adopted through `upgrade()` rather than by pointing the
 * coordinator somewhere else -- with the one exception `upgrade()` documents.
 */
const CREDENTIALS_KEY = "credentials";
const IDENTITY_KEY = `${CREDENTIALS_KEY}:identity`;
const MIGRATED_KEY = `${CREDENTIALS_KEY}:migrated`;
const CONNECTION_KEY = `${CREDENTIALS_KEY}:connection`;

/** The keys above, which a legacy layout may not name. */
const OWNED_KEYS: readonly string[] =
  [CREDENTIALS_KEY, IDENTITY_KEY, MIGRATED_KEY, CONNECTION_KEY];

/** Refresh flights, shared per storage object rather than per coordinator instance: a coordinator
 *  constructed per call still coalesces, so concurrent rotates cannot each spend one single-use
 *  refresh token and read the loser's invalid_grant as grant death. */
const refreshes = perStorage(() => new SingleFlight());

/** The provider policy the coordinator needs: when a grant goes stale, and where it came from. */
export type CredentialCoordinatorOptions<Creds> = {
  /**
   * When the credentials stop working, if they expire at all. A finite epoch or `undefined`; a
   * provider `expires_in` of `1e400` parses to `Infinity`, which would read as never-expiring and
   * silently retire the refresh. Non-expiring is what `undefined` is for.
   */
  expiresAt?(credentials: Creds): number | undefined;
  /** How far ahead of `expiresAt` to refresh. Non-negative and finite; 0 refreshes at expiry. */
  refreshSkewMs?: number;
  /**
   * Every key the pre-kit layout owns. Declared rather than reported by `upgrade`, so the reap is
   * idempotent and a failed delete is retried by the next migration or `clear()`.
   */
  legacyKeys?: readonly string[];
  /**
   * One-shot migration off those keys, reassembling the grant they hold. Runs only while no
   * canonical record exists, so it can never see or rewrite one the coordinator wrote.
   *
   * Its limit: it migrates a layout stored *beside* `"credentials"`, never one stored *at* it.
   * `stored()` returns whatever sits under the canonical key before consulting this hook, so a port
   * whose pre-kit grant already occupies it hands that shape to its callers as current. Such a port
   * needs an out-of-band rewrite; there is no in-band path.
   *
   * Reads only -- the coordinator reaps, after the canonical record exists. An implicit Durable
   * Object transaction is atomic against machine failure but is NOT rolled back by a throw
   * (verified on workerd), so a callback that deleted its own keys and then threw on a malformed
   * record would leave the account with no grant at all and nothing left to retry from.
   */
  upgrade?(kv: Pick<CredentialsKv, "get">): Creds | undefined;
};

/**
 * Owns the credential record inside the account Durable Object: reads, commits, and skew-aware
 * refresh with concurrent callers coalesced onto one provider round-trip.
 *
 * Refresh is NOT transactional against provider-side rotation: a crash between the provider
 * rotating the token and the commit loses it, and the user reconnects.
 */
export class CredentialCoordinator<Creds> {
  readonly #kv: CredentialsKv;
  readonly #options: CredentialCoordinatorOptions<Creds>;

  constructor(kv: CredentialsKv, options: CredentialCoordinatorOptions<Creds> = {}) {
    this.#kv = kv;
    this.#options = options;
    for (const key of options.legacyKeys ?? []) {
      if (OWNED_KEYS.includes(key)) {
        throw new Error(`Legacy key "${key}" is one the coordinator owns.`);
      }
    }
    const { refreshSkewMs } = options;
    // A negative skew reads a dead token as live; a non-finite one disables the comparison. Both
    // fail open, so they are refused here rather than at the first expiry check.
    if (refreshSkewMs !== undefined && (!Number.isFinite(refreshSkewMs) || refreshSkewMs < 0)) {
      throw new Error(`refreshSkewMs must be a non-negative finite number, got ${refreshSkewMs}.`);
    }
  }

  /** The stored credentials, migrating legacy keys on first read. */
  stored(): Creds | undefined {
    const current = this.#kv.get<Creds>(CREDENTIALS_KEY);
    if (current !== undefined) {
      this.#identify();
      return current;
    }

    const { upgrade } = this.#options;
    // The marker is durable, not per-instance: a `clear()` followed by a restart would otherwise
    // re-run the migration and resurrect a grant that has since been superseded.
    if (upgrade === undefined || this.#kv.get<boolean>(MIGRATED_KEY)) return undefined;

    const upgraded = upgrade(this.#kv);
    // Found nothing: mark it here, since there is no record to write and nothing found today will
    // not be found later either. A found grant is marked by the `clear()` that drops it again.
    if (upgraded === undefined) {
      this.#kv.put(MIGRATED_KEY, true);
      return undefined;
    }

    // Canonical record first, legacy keys second. Both land in one implicit transaction, so a
    // machine failure takes neither; the order is what makes a throw between them survivable, since
    // the grant is already readable under its new key before the old one goes away.
    this.#commit(upgraded);
    this.#reap();
    return upgraded;
  }

  /**
   * Which credentials are current, as an opaque value. Compare for equality only: it is random per
   * write, never ordered, because a counter is reset by the `deleteAll()` that `revoke()` and the
   * self-destruct alarm perform — after which a reissued "1" would match a fence from the revoked
   * grant and let its refresh commit over the replacement.
   *
   * `""` means no credentials have ever been surfaced, and is the one value that is never a fence:
   * anything a caller can fence against has an identity by construction (see `#identify`).
   */
  identity(): string {
    return this.#kv.get<string>(IDENTITY_KEY) ?? "";
  }

  /**
   * Install the credentials a (re)connect obtained. The one write path besides refresh, which
   * stays internal to `fresh`/`rotate`: a connect may change the principal, so it also rotates
   * `connectionGeneration()` -- generation first, so a failure between the writes over-invalidates
   * consumers rather than serving the new principal under the old generation.
   */
  connect(credentials: Creds): void {
    this.#kv.put(CONNECTION_KEY, generateNonce());
    this.#commit(credentials);
  }

  /**
   * Which connection the credentials belong to: rotated by `connect()` and `clear()`, preserved
   * across refresh. The authority a metadata cache partitions by (`./cache`) and the account half
   * of the pending-action fence (§4.8) -- roles `identity()` cannot serve, since every refresh
   * supersedes it. Minted on first read, so it is never `""`.
   */
  connectionGeneration(): string {
    const current = this.#kv.get<string>(CONNECTION_KEY);
    if (current !== undefined) return current;
    const minted = generateNonce();
    this.#kv.put(CONNECTION_KEY, minted);
    return minted;
  }

  /**
   * Fence first, record second. An implicit Durable Object transaction is atomic against machine
   * failure but is NOT rolled back by a throw (see `upgrade`), so the order decides what an
   * unusually placed storage failure leaves behind: rotating first can only lose the new record,
   * with every in-flight refresh already fenced out, whereas publishing first could leave the new
   * record readable under the old fence and let a stale refresh commit straight over it.
   */
  #commit(credentials: Creds): void {
    this.#supersede();
    this.#kv.put(CREDENTIALS_KEY, credentials);
  }

  /**
   * Drops the credentials, and marks the migration done -- here and nowhere else. While a canonical
   * record exists `stored()` never consults the migration path, so the marker only has to be durable
   * once that record is gone, and `clear()` is the only kit path that removes it. (The `deleteAll()`
   * behind `revoke()` wipes the legacy keys too, so an upgrade re-run after one finds nothing and
   * re-marks.) Keeping it off the commit path saves a KV write per successful refresh.
   *
   * Written whether or not an `upgrade` is configured today. Conditioning it on the option saved one
   * write on a path taken once per disconnect, and cost this: a deployment that adds `upgrade` in a
   * later release would find no marker and re-run the migration against whatever legacy keys a
   * disconnect left behind, resurrecting a grant the user revoked.
   *
   * Ordered so that the record is the last thing to go, for the reason `#commit()` gives: both
   * earlier writes are what stop a grant coming back. A throw before the rotation leaves the
   * account connected with the marker set, which nothing reads while a record exists; the two
   * orders that drop the record first can resurrect it, either from an in-flight refresh whose
   * fence still matches or from an `upgrade()` re-run that the missing marker permits.
   */
  clear(): void {
    this.#kv.put(MIGRATED_KEY, true);
    this.#kv.put(CONNECTION_KEY, generateNonce());
    this.#supersede();
    // Before the record goes, so a failed reap leaves the canonical grant rather than only the
    // legacy one a rolled-back reader would still accept. Retries the migration's reap.
    this.#reap();
    this.#kv.delete(CREDENTIALS_KEY);
  }

  #reap(): void {
    for (const key of this.#options.legacyKeys ?? []) this.#kv.delete(key);
  }

  /**
   * Whatever this account held is gone: a new identity, so an in-flight refresh's fence can never
   * match again. `clear()` rotates rather than deletes for the same reason a counter is unusable --
   * an absent identity reads as `""` for every caller that asks.
   */
  #supersede(): void {
    this.#kv.put(IDENTITY_KEY, generateNonce());
  }

  /**
   * Credentials and an identity are surfaced together, always: a record written before this account
   * had identities would otherwise carry `""`, which still compares equal to itself after a wipe.
   */
  #identify(): void {
    if (this.#kv.get<string>(IDENTITY_KEY) === undefined) {
      this.#kv.put(IDENTITY_KEY, generateNonce());
    }
  }

  /**
   * Credentials that will still work for a moment, refreshing them first if not.
   *
   * Expiry-only: a provider that rejected an unexpired credential needs `rotate` instead.
   */
  async fresh(refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    const current = this.#connected();
    const expiresAt = this.#options.expiresAt?.(current);
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) {
      throw new Error(`expiresAt must be finite or undefined, got ${expiresAt}.`);
    }
    const skew = this.#options.refreshSkewMs ?? ACCESS_TOKEN_SAFETY_MS;
    if (expiresAt === undefined || Date.now() < expiresAt - skew) return current;
    return this.#coalesced(current, refresh);
  }

  /**
   * Refreshes now, whatever the recorded expiry says: the credential the provider just rejected is
   * stale by the only authority that matters. Three shipped gatekeepers refresh unconditionally on
   * a 401 (notion `notion.ts:434-455`, confluence, google), which `fresh` cannot express.
   *
   * Coalesced, so a burst of 401s across concurrent callers costs one token exchange.
   */
  async rotate(refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    return this.#coalesced(this.#connected(), refresh);
  }

  #connected(): Creds {
    const current = this.stored();
    if (current === undefined) throw new CredentialsExpiredError("This account is not connected.");
    return current;
  }

  /**
   * Fenced on the identity the refresh started from: a success commits only if nothing overtook it,
   * and a `CredentialsExpiredError` propagates only if nothing overtook it either -- so grant A's
   * stale death can never expire grant B. Any other failure propagates untouched.
   */
  #coalesced(current: Creds, refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    // Keyed by the identity fence, so a caller arriving after a reconnect starts its own refresh
    // rather than riding one whose result is already fenced out.
    const fence = this.identity();
    return refreshes(this.#kv).run(fence, () => this.#refresh(current, fence, refresh));
  }

  async #refresh(
    current: Creds,
    fence: string,
    refresh: (current: Creds) => Promise<Creds>,
  ): Promise<Creds> {
    let refreshed: Creds;
    try {
      refreshed = await refresh(current);
    } catch (error) {
      if (!(error instanceof CredentialsExpiredError) || this.identity() === fence) throw error;
      return this.#overtaken(error);
    }

    if (this.identity() !== fence) return this.#overtaken();
    this.#commit(refreshed);
    return refreshed;
  }

  /** A reconnect or revoke landed mid-refresh: its credentials win, or there are none left. */
  #overtaken(cause?: unknown): Creds {
    const latest = this.stored();
    if (latest !== undefined) return latest;
    throw new CredentialsExpiredError("This account was disconnected while refreshing.", { cause });
  }
}

/** One fetch of credentials, tagged with the identity they belong to. */
export type CredentialsWithIdentity<Creds> = { creds: Creds; identity: string };

/** Account-side RPC shape. See `CredentialSourceOptions.account` for stub ownership. */
export type AccountCredentialStub<Creds> = {
  getCredentials(): Promise<CredentialsWithIdentity<Creds>>;
  /** No-ops unless `identity` is still the account's, i.e. no reconnect overtook the caller. */
  noteCredentialsExpired(identity: string): Promise<void>;
};

/** `CredentialSource` keeps one flight -- the account's current credentials -- so it needs one key. */
const CREDENTIALS_FLIGHT = "credentials";

/**
 * Wiring for the consumer side. The `Creds` here cross the account RPC boundary into a facet the
 * agent can reach, so a gatekeeper whose stored grant carries refresh material should project it
 * away and instantiate this with the narrower record -- the coordinator's `Creds` and this one need
 * not be the same type.
 */
export type CredentialSourceOptions<Creds> = {
  /**
   * Called per operation. `CredentialSource` retains only the resolved value, never this stub. MUST
   * return either a fresh Durable Object stub, which needs no disposal, or a stub whose disposal the
   * caller owns. A property-derived `RpcStub` returned here would leak one server-side reference per
   * credential resolution.
   */
  account(): AccountCredentialStub<Creds>;
  /**
   * Classifies a provider API failure as "these credentials no longer work". Only that: this
   * verdict reports the grant expired and prompts the user to reconnect, and the agent chooses
   * which operations run, so a classifier matching bare 401/403 lets it retire a healthy
   * connection by asking for one resource the grant does not cover. Per-resource denials are
   * `isNoAccessError`'s job (`./http-errors`); this one wants the provider's credential-invalid
   * signal -- for OAuth, RFC 6749 §5.2's `invalid_token`/`invalid_grant`, the same doctrine
   * `CredentialsExpiredError` documents for refresh.
   */
  isAuthError(error: unknown): boolean;
  /** What the gadget is told when they no longer work. */
  expiredMessage: string;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * The consumer side, held by a facet or verifier: every operation reads the account's current
 * `{ creds, identity }`, with concurrent reads coalesced into one account round-trip. It is also the
 * one place a provider auth failure turns into an expiry notification. A provider whose 401 can
 * mean a stale derived bearer rather than a dead grant composes the two --
 * `run(creds => withAuthRetry(options, call))`, `./auth-retry` -- so only a twice-rejected
 * credential reaches this catch, fenced on the identity captured before the attempt.
 */
export class CredentialSource<Creds> {
  readonly #options: CredentialSourceOptions<Creds>;
  readonly #logger: typeof logger;
  readonly #fetches = new SingleFlight();

  constructor(options: CredentialSourceOptions<Creds>) {
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
  }

  /**
   * The credentials to use now, read from the account with concurrent reads coalesced. For a
   * provider call prefer `run`, which adds the auth-failure handling this method has none of.
   */
  async get(): Promise<Creds> {
    return (await this.#current()).creds;
  }

  /**
   * Runs a provider call against the credentials it should use. The identity is captured before
   * the call, not read back after it: a concurrent refetch would otherwise expire the newer grant.
   *
   * Concurrent reads coalesce but nothing is memoized: each settled read costs another account
   * round trip, i.e. another Worker invocation. Caching is unsafe here -- a reconnect replaces the
   * grant with no signal this side sees -- so put a series of provider calls inside one `run`.
   */
  async run<T>(operation: (credentials: Creds) => Promise<T>): Promise<T> {
    const { creds, identity } = await this.#current();
    try {
      return await operation(creds);
    } catch (error) {
      if (!this.#options.isAuthError(error)) throw error;
      // Drop the in-flight fetch: it was started against the credentials just reported dead, and
      // leaving it would hand them to the next caller anyway.
      this.#fetches.forget(CREDENTIALS_FLIGHT);
      await this.#note(identity);
      throw new Error(this.#options.expiredMessage, { cause: error });
    }
  }

  async #current(): Promise<CredentialsWithIdentity<Creds>> {
    return this.#fetches.run(CREDENTIALS_FLIGHT, () => this.#options.account().getCredentials());
  }

  async #note(identity: string): Promise<void> {
    try {
      await this.#options.account().noteCredentialsExpired(identity);
    } catch (error) {
      this.#logger.error("failed to report credential expiry", {
        event: "credentials.expiry.report.failed",
        error,
      });
    }
  }
}
