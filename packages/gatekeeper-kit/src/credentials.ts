/** Account-side credential storage and consumer-side RPC access. */

import { createLogger } from "@gadgets/backend-utils/logger";
import { ACCESS_TOKEN_SAFETY_MS, generateNonce } from "./connect-nonce";
import { clearCredentialExpiryLatch } from "./credential-expiry";
import type { KvMutable } from "./kv";
import { perStorage } from "./per-storage";
import { SingleFlight } from "./single-flight";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.credentials" });

/**
 * Durable Object KV used for credentials. Pass the stable `ctx.storage.kv` object so refreshes
 * coalesce across coordinator instances.
 */
export type CredentialsKv = KvMutable;

/**
 * Base for errors crossing the account RPC boundary. The mark is written to both `name` and a
 * transport-stable `code` (an enumerable own prop), so it survives hops that rebuild the error
 * and strip `name`.
 */
abstract class MarkedError extends Error {
  readonly code: string;

  /**
   * Creates a marked error.
   * @param mark Discriminator written to both `name` and `code`.
   * @param message Display-safe message.
   * @param options Optional error cause.
   */
  constructor(mark: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = mark;
    this.name = mark;
  }
}

/** Provider-confirmed grant expiry. Transport and service failures must use their original errors. */
export class CredentialsExpiredError extends MarkedError {
  /**
   * Creates a confirmed-expiry error.
   * @param message Display-safe expiry message.
   * @param options Optional error cause.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super("CredentialsExpiredError", message, options);
  }
}

/**
 * Credentials replaced while an operation was in flight: the rejection the operation saw was
 * stale, nothing was adjudicated against the account, and the caller retries by re-entering.
 */
export class CredentialsChangedError extends MarkedError {
  /**
   * Creates a retryable mid-operation replacement error.
   * @param options Optional error cause — typically the stale provider rejection.
   */
  constructor(options?: { cause?: unknown }) {
    super("CredentialsChangedError",
      "This account's credentials changed during the operation; retry it.", options);
  }
}

/**
 * A connect completion lost its race: the connection it started under was replaced by a revoke or
 * a newer reconnect while the provider token exchange was in flight, so the mint was **not**
 * stored.
 *
 * The caller owns that orphaned mint and should dispose of it — subject to the same caution as
 * `discardMint`: revoke it only where doing so cannot invalidate the grant the winning connection
 * now uses.
 */
export class ConnectionSupersededError extends MarkedError {
  /**
   * Creates a superseded-connection error.
   * @param options Optional error cause.
   */
  constructor(options?: { cause?: unknown }) {
    super("ConnectionSupersededError",
      "This account was reconnected or disconnected while the connect flow was completing; "
      + "the credentials it produced were discarded. Start the connection again.", options);
  }
}

/** @returns Whether the error carries the mark as its `name` or its transport-surviving `code`. */
function marked(error: unknown, mark: string): boolean {
  return error instanceof Error
    && (error.name === mark || (error as { code?: unknown }).code === mark);
}

/**
 * Matches confirmed expiry by `name` or `code`: the class never survives RPC, and a transport that
 * rebuilds errors (capnweb) keeps enumerable own props but not the name.
 * @param error Caught error.
 * @returns Whether the error is a confirmed credential expiry.
 */
export function isCredentialsExpired(error: unknown): boolean {
  return marked(error, "CredentialsExpiredError");
}

/**
 * Matches a retryable mid-operation credential replacement by `name` or `code`: the class never
 * survives RPC, and a transport that rebuilds errors (capnweb) keeps enumerable own props but not
 * the name.
 * @param error Caught error.
 * @returns Whether the error marks the operation retryable.
 */
export function isCredentialsChanged(error: unknown): boolean {
  return marked(error, "CredentialsChangedError");
}

/**
 * Matches a connect completion that lost its race, by `name` or `code`. The credentials it minted
 * were not stored, so the caller still owns them.
 * @param error Caught error.
 * @returns Whether the connection was replaced mid-completion.
 */
export function isConnectionSuperseded(error: unknown): boolean {
  return marked(error, "ConnectionSupersededError");
}

/**
 * The account's adjudication of a reported credential rejection.
 * - `"expired"` — the grant is gone: provider-confirmed death, or a disconnect discovered during
 *   the adjudication. The account owns announcing a death to the Workshop — a disconnect is a user
 *   action and never notifies — and the verdict never adjudicates that delivery.
 * - `"superseded"` — a live successor replaced the rejected identity: a refresh, a heal inside the
 *   ask, or a reconnect. The failure was stale, so the caller retries or re-enters.
 * - `"unavailable"` — the heal failed for non-credential reasons; nothing was adjudicated, and the
 *   consumer surfaces the caller's original provider error.
 */
export type RejectionVerdict = (typeof REJECTION_VERDICTS)[number];

const REJECTION_VERDICTS = ["expired", "superseded", "unavailable"] as const;

// Shared storage layout for kit-managed credentials.
const CREDENTIALS_KEY = "credentials";
const IDENTITY_KEY = `${CREDENTIALS_KEY}:identity`;
const MIGRATED_KEY = `${CREDENTIALS_KEY}:migrated`;
const CONNECTION_KEY = `${CREDENTIALS_KEY}:connection`;
// One identity: the fence of the grant the provider confirmed dead, or absent for no death.
const EXPIRED_IDENTITY_KEY = `${CREDENTIALS_KEY}:expired`;

const OWNED_KEYS: readonly string[] =
  [CREDENTIALS_KEY, IDENTITY_KEY, MIGRATED_KEY, CONNECTION_KEY, EXPIRED_IDENTITY_KEY];

const EXPIRED_MESSAGE = "This account's credentials have expired.";

// Coalesce refreshes across coordinators sharing the same storage object.
const refreshes = perStorage(() => new SingleFlight());

/**
 * Refreshes credentials at the provider.
 *
 * Must return the **complete** canonical record, not the provider's response. Providers routinely
 * omit values that did not change — an unchanged rotating refresh token, granted scopes, provider
 * metadata — and the coordinator replaces the stored record wholesale, so anything absent is lost
 * and the *next* refresh fails after the first successful rotation. Merge from `current`:
 * `{ ...current, ...response, refreshToken: response.refreshToken ?? current.refreshToken }`.
 *
 * Throw `CredentialsExpiredError` only when the provider proves the grant is dead.
 * @param current The stored grant being refreshed.
 * @returns The complete replacement record.
 */
export type RefreshCredentials<Creds> = (current: Creds) => Promise<Creds>;

/** Provider-specific expiry and migration policy. */
export type CredentialCoordinatorOptions<Creds> = {
  /**
   * Reads a credential expiry.
   * @param credentials Provider credentials.
   * @returns The finite expiry epoch, or `undefined` when non-expiring.
   */
  expiresAt?(credentials: Creds): number | undefined;
  /** How far ahead of `expiresAt` to refresh. Non-negative and finite; 0 refreshes at expiry. */
  refreshSkewMs?: number;
  /** Keys owned by the pre-kit credential layout. */
  legacyKeys?: readonly string[];
  /**
   * Reads credentials from a legacy layout once. The callback must not delete legacy keys; the
   * coordinator removes them only after committing the canonical record.
   * @param kv Read-only access to credential storage.
   * @returns Legacy credentials, or `undefined` when absent.
   */
  upgrade?(kv: Pick<CredentialsKv, "get">): Creds | undefined;
  /**
   * Disposes of a provider mint that lost its identity fence -- a reconnect or revoke won while
   * the refresh was in flight -- and will never be stored. Revoke it provider-side, but only where
   * revoking the discarded mint cannot invalidate the grant the surviving connection uses: RFC 7009
   * lets a provider treat revocation of one refresh token as revocation of the whole authorization
   * grant, so where a reconnect reuses one grant per (user, client) the disposal would kill the
   * connection that just won. For such a provider omit `discardMint` entirely and order refresh
   * against connect and clear in the account itself -- the kit supplies no primitive for that.
   * Errors are logged, never rethrown.
   * @param mint Credentials the coordinator is dropping.
   */
  discardMint?(mint: Creds): void | Promise<void>;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * Owns credential storage, migration, and skew-aware refresh. Concurrent refreshes share one
 * provider request, and a mint a reconnect or revoke overtook goes to `discardMint` for
 * provider-side disposal. A provider-confirmed death is recorded against its identity fence, so
 * every later read refuses that grant until a reconnect replaces it, while `stored()` keeps
 * serving it to account-owned revoke. A crash after provider-side token rotation may still
 * require reconnection.
 */
export class CredentialCoordinator<Creds> {
  readonly #kv: CredentialsKv;
  readonly #options: CredentialCoordinatorOptions<Creds>;
  readonly #logger: typeof logger;

  /**
   * Creates a credential coordinator.
   * @param kv Stable Durable Object credential storage.
   * @param options Provider expiry and migration policy.
   */
  constructor(kv: CredentialsKv, options: CredentialCoordinatorOptions<Creds> = {}) {
    this.#kv = kv;
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
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

  /** @returns Stored credentials, migrating legacy storage on first read. */
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
    // the grant is already readable under its new key before the old one goes away. Publishes
    // rather than commits: moving a grant between layouts replaces nothing, so a death this
    // account already announced must stay latched.
    this.#publish(upgraded);
    this.#reap();
    return upgraded;
  }

  /**
   * @returns The opaque identity of the current credential value, or `""` when never connected.
   * That value is reserved for a never-connected read: it always adjudicates `"superseded"`, so a
   * hand-written `getCredentials` must never serve credentials under it.
   */
  identity(): string {
    return this.#kv.get<string>(IDENTITY_KEY) ?? "";
  }

  /**
   * Installs credentials from a connect flow, rotating the connection generation.
   *
   * Pass `ifGeneration` to fence the asynchronous window a connect flow cannot avoid: `claimOAuth`
   * consumes its nonce *before* the provider token exchange, so a revoke or a newer reconnect can
   * land while that exchange is in flight, and an unfenced write lets the older completion
   * overwrite it. Capture `connectionGeneration()` when the attempt starts — `advanceToOAuth`
   * takes arbitrary metadata for exactly this, and `claimOAuth` hands it back — and this call
   * throws `ConnectionSupersededError` rather than storing a mint the account has moved past.
   *
   * Fencing is opt-in because an account with no such window (a pasted token, a form submission
   * with no round trip) has nothing to fence, and would then have to invent a generation to pass.
   * @param credentials New credentials.
   * @param options `ifGeneration` refuses the write unless the connection is still the one the
   * attempt started under.
   * @throws `ConnectionSupersededError` when `ifGeneration` no longer matches. The credentials are
   * not stored, and disposing of them is the caller's to do.
   */
  connect(credentials: Creds, options: { ifGeneration?: string } = {}): void {
    const { ifGeneration } = options;
    // Read and compare with no await between them and the write, so nothing can land inside.
    if (ifGeneration !== undefined && this.connectionGeneration() !== ifGeneration) {
      throw new ConnectionSupersededError();
    }
    this.#kv.put(CONNECTION_KEY, generateNonce());
    this.#commit(credentials);
  }

  /** @returns The stable identity of the current connection. */
  connectionGeneration(): string {
    const current = this.#kv.get<string>(CONNECTION_KEY);
    if (current !== undefined) return current;
    const minted = generateNonce();
    this.#kv.put(CONNECTION_KEY, minted);
    return minted;
  }

  /**
   * Publishes credentials behind a new identity fence. Fence first: a torn write may only lie
   * toward `"superseded"` (one doomed retry), never leave a stale identity fronting fresh
   * credentials, where the identity match gating `"expired"` would falsely retire a live grant.
   * @param credentials Credentials to store.
   */
  #publish(credentials: Creds): void {
    this.#supersede();
    this.#kv.put(CREDENTIALS_KEY, credentials);
  }

  /**
   * Publishes replacement credentials and re-arms the expiry latch, so the next confirmed death
   * notifies again and a notification still in flight for the credentials this replaces cannot
   * latch these.
   * @param credentials Credentials to store.
   */
  #commit(credentials: Creds): void {
    // Latch first: both puts land in one implicit transaction, and a split fails toward a
    // duplicate notice this way round rather than toward silence.
    clearCredentialExpiryLatch(this.#kv);
    this.#publish(credentials);
  }

  /** Clears credentials and prevents legacy migration from restoring them. */
  clear(): void {
    this.#kv.put(MIGRATED_KEY, true);
    this.#kv.put(CONNECTION_KEY, generateNonce());
    this.#supersede();
    // Before the record goes, so a failed reap leaves the canonical grant rather than only the
    // legacy one a rolled-back reader would still accept. Retries the migration's reap.
    this.#reap();
    this.#kv.delete(CREDENTIALS_KEY);
  }

  /** Removes all configured legacy credential keys. */
  #reap(): void {
    for (const key of this.#options.legacyKeys ?? []) this.#kv.delete(key);
  }

  /** Replaces the current credential identity fence. */
  #supersede(): void {
    this.#kv.put(IDENTITY_KEY, generateNonce());
  }

  /** Ensures stored credentials have a non-empty identity. */
  #identify(): void {
    if (this.#kv.get<string>(IDENTITY_KEY) === undefined) {
      this.#kv.put(IDENTITY_KEY, generateNonce());
    }
  }

  /**
   * @param identity Identity fence to test.
   * @returns Whether the account recorded that grant's confirmed death.
   */
  #isExpired(identity: string): boolean {
    return this.#kv.get<string>(EXPIRED_IDENTITY_KEY) === identity;
  }

  /**
   * Records a confirmed grant death, so later reads -- and every other facet over this storage --
   * refuse the grant instead of rediscovering its death at the provider. One scalar: a fence the
   * account moved makes the old marker inert, and the next death overwrites it.
   * @param identity Fence of the grant the provider confirmed dead; a stale one marks nothing.
   */
  #markExpired(identity: string): void {
    if (identity === this.identity() && !this.#isExpired(identity)) {
      this.#kv.put(EXPIRED_IDENTITY_KEY, identity);
    }
  }

  /**
   * Returns usable credentials, refreshing after the expiry boundary.
   * @param refresh Provider refresh, under the `RefreshCredentials` contract.
   * @returns Current or refreshed credentials.
   */
  async fresh(refresh: RefreshCredentials<Creds>): Promise<Creds> {
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
   * Refreshes credentials immediately.
   * @param refresh Provider refresh, under the `RefreshCredentials` contract.
   * @returns Current or refreshed credentials.
   */
  async rotate(refresh: RefreshCredentials<Creds>): Promise<Creds> {
    return this.#coalesced(this.#connected(), refresh);
  }

  /** @returns Stored credentials, or throws when disconnected or the grant is recorded dead. */
  #connected(): Creds {
    const current = this.stored();
    if (current === undefined) throw new CredentialsExpiredError("This account is not connected.");
    // Death outlives the call that found it, so an access token still inside its own expiry
    // window is refused too. `stored()` stays open, so revoke keeps its material.
    if (this.#isExpired(this.identity())) throw new CredentialsExpiredError(EXPIRED_MESSAGE);
    return current;
  }

  /**
   * Coalesces refreshes behind the current identity fence.
   * @param current Credentials being refreshed.
   * @param refresh Provider refresh, under the `RefreshCredentials` contract.
   * @returns Current, refreshed, or concurrently replaced credentials.
   */
  #coalesced(current: Creds, refresh: RefreshCredentials<Creds>): Promise<Creds> {
    // Keyed by the identity fence, so a caller arriving after a reconnect starts its own refresh
    // rather than riding one whose result is already fenced out.
    const fence = this.identity();
    return refreshes(this.#kv).run(fence, () => this.#refresh(current, fence, refresh));
  }

  /**
   * Runs one fenced provider refresh.
   * @param current Credentials being refreshed.
   * @param fence Identity captured before refresh.
   * @param refresh Provider refresh, under the `RefreshCredentials` contract.
   * @returns Refreshed credentials unless a newer connection won.
   */
  async #refresh(
    current: Creds,
    fence: string,
    refresh: RefreshCredentials<Creds>,
  ): Promise<Creds> {
    let refreshed: Creds;
    try {
      refreshed = await refresh(current);
    } catch (error) {
      if (!isCredentialsExpired(error)) throw error;
      // A stale failure adjudicates nothing; only the fence it ran under may be buried.
      if (this.identity() !== fence) return this.#overtaken(error);
      this.#markExpired(fence);
      throw error;
    }

    // Fenced out, or buried while the mint was in flight: either way it will never be stored, so
    // the provider is told to drop it.
    if (this.identity() !== fence || this.#isExpired(fence)) {
      await this.#discard(refreshed);
      return this.#overtaken();
    }
    this.#commit(refreshed);
    return refreshed;
  }

  /**
   * Resolves a refresh overtaken by reconnect, revoke, or a death recorded while it ran.
   * @param cause Optional expiry error from the stale refresh.
   * @returns Replacement credentials, or throws when disconnected or the successor is dead.
   */
  #overtaken(cause?: unknown): Creds {
    const latest = this.stored();
    if (latest === undefined) {
      throw new CredentialsExpiredError(
        "This account was disconnected while refreshing.", { cause });
    }
    if (this.#isExpired(this.identity())) {
      throw new CredentialsExpiredError(EXPIRED_MESSAGE, { cause });
    }
    return latest;
  }

  /**
   * Hands a fenced-out mint to the provider-side disposal seam.
   * @param mint Credentials that will never be stored.
   */
  async #discard(mint: Creds): Promise<void> {
    try {
      await this.#options.discardMint?.(mint);
    } catch (error) {
      this.#logger.warn("discarded mint handler failed", {
        event: "credentials.mint.discard.failed",
        error,
      });
    }
  }

  /**
   * Reads the credential triple the account RPC surface serves: current credentials, their
   * identity fence, and their connection generation. The three reads are synchronous after the
   * refresh settles — no await between them — so a `connect()` landing at the await boundary
   * cannot tear the triple apart. That atomicity is why the helper lives on the coordinator; a
   * hand-written `getCredentials` owns it itself. The triple carries the stored grant: a surface
   * whose public credentials differ projects `creds` before returning, so refresh material never
   * crosses the RPC boundary.
   * @param refresh Provider refresh, under the `RefreshCredentials` contract.
   * @param options `notify` announces confirmed grant death to the Workshop before the rethrow.
   * @returns Current credentials with their identity and connection generation.
   * @throws `CredentialsExpiredError` on confirmed expiry, after awaiting `notify` when the dead
   * grant is still stored — a disconnect is a user action, not grant death, and never notifies.
   * A reconnect landing while `notify` is pending replaces the death: the fresh triple is served.
   * A disconnect landing there reads as not connected, carrying the death as its cause.
   */
  async snapshot(
    refresh: RefreshCredentials<Creds>,
    options: { notify?: () => Promise<void> } = {},
  ): Promise<CredentialsWithIdentity<Creds>> {
    try {
      await this.fresh(refresh);
    } catch (error) {
      if (!isCredentialsExpired(error) || this.stored() === undefined
        || options.notify === undefined) throw error;
      // This reads the dead grant's own fence: only microtasks separate it from `#refresh`'s
      // `identity() === fence` check, and a `connect()` arrives on an I/O turn. A reconnect
      // landing mid-notify replaced the dead grant: serve it instead of stale death.
      if (await this.#notified(this.identity(), options.notify)) throw error;
      // A disconnect landing there moves the fence too; keep the death's provenance.
      if (this.stored() === undefined) {
        throw new CredentialsExpiredError("This account is not connected.", { cause: error });
      }
    }
    const creds = this.#connected();
    return { creds, identity: this.identity(), generation: this.connectionGeneration() };
  }

  /**
   * Adjudicates a consumer-reported credential rejection, healing past a rejected-but-current
   * credential inside the ask. The verdict adjudicates the identity, never notification delivery,
   * which the account owns end to end. Invariants a hand-written implementation owns instead:
   * the moved-past gate (`""` never matches), the heal fenced on the rejected identity, and
   * honest verdicts — `"superseded"` only under a live successor and `"expired"` for a dead or
   * disconnected grant, the fence re-checked after the notify await since a reconnect landing
   * mid-notification supersedes it.
   *
   * Death is durable and notification is not: the marker retires the identity for every facet at
   * once, while `notifyCredentialsExpiredOnce`'s latch keeps its own retry, so a later read
   * refuses the grant without another mint but can still deliver an announcement that failed.
   * @param identity Credential identity the consumer saw rejected.
   * @param options `refresh` mints past a stale credential under the `RefreshCredentials` contract
   * (grant-death providers leave it unset);
   * `notify` announces confirmed grant death to the Workshop.
   * @returns The verdict on the rejected identity.
   */
  async adjudicateRejection(
    identity: string,
    options: { refresh?: RefreshCredentials<Creds>; notify: () => Promise<void> },
  ): Promise<RejectionVerdict> {
    // "" — a never-connected read — must not match a never-connected account's own "".
    if (identity === "") return "superseded";
    // Moved-past gate: whatever moved the fence already adjudicated the rejected identity.
    if (identity !== this.identity()) return this.#moved();
    // A grant-death provider has no mint to heal with: the rejection is the grant's death.
    if (options.refresh === undefined) {
      this.#markExpired(identity);
      return this.#expired(identity, options.notify);
    }
    try {
      // Fence-keyed, so concurrent heals of one identity collapse onto one provider mint.
      await this.rotate(options.refresh);
      // The commit rotated the fence — or a reconnect overtook the mint. Either way the rejected
      // identity is no longer current.
      return "superseded";
    } catch (error) {
      // A reconnect or disconnect landing while the mint failed wins whatever the mint died of —
      // logged, since this branch is the mint error's only account-side trace.
      if (this.identity() !== identity) {
        this.#logger.warn("credential rejection heal overtaken", {
          event: "credentials.rejection.heal.overtaken",
          error,
        });
        return this.#moved();
      }
      if (isCredentialsExpired(error)) return this.#expired(identity, options.notify);
      // Non-credential mint failure: nothing adjudicated, credentials intact. The consumer
      // surfaces the caller's original provider error; the token endpoint's lives in this log.
      this.#logger.error("credential rejection heal failed", {
        event: "credentials.rejection.heal.failed",
        error,
      });
      return "unavailable";
    }
  }

  /**
   * Resolves a confirmed grant death into its verdict.
   * @param identity The dead grant's identity fence.
   * @param notify Announces the grant death to the Workshop.
   * @returns `"expired"`, or the moved-fence verdict when the fence moved mid-notify.
   */
  async #expired(identity: string, notify: () => Promise<void>): Promise<RejectionVerdict> {
    return await this.#notified(identity, notify) ? "expired" : this.#moved();
  }

  /**
   * Resolves a rejected identity the fence moved past. `"superseded"` promises a *live* successor,
   * so a fence moved by a disconnect, or onto a grant this account has since buried, answers
   * `"expired"` instead: the caller reconnects rather than re-entering into credentials that
   * cannot work. The disconnect itself never notifies — a user action.
   * @returns `"superseded"` under a live successor, `"expired"` otherwise.
   */
  #moved(): RejectionVerdict {
    return this.stored() === undefined || this.#isExpired(this.identity())
      ? "expired"
      : "superseded";
  }

  /**
   * Awaits a Workshop notification, then re-checks the identity fence.
   * @param identity Identity fence captured when the death was decided.
   * @param notify Announces the grant death to the Workshop; a failure is logged, never masking
   * the verdict.
   * @returns Whether `identity` survived the await — a reconnect landing mid-notify moves the
   * fence, so a death decided before the notification no longer stands.
   */
  async #notified(identity: string, notify: () => Promise<void>): Promise<boolean> {
    try {
      await notify();
    } catch (error) {
      this.#logger.warn("failed to notify credential expiry", {
        event: "credentials.expiry.notify.failed",
        error,
      });
    }
    return this.identity() === identity;
  }
}

/** One fetch of credentials, tagged with their identity and connection generation. */
export type CredentialsWithIdentity<Creds> = CredentialRead & { creds: Creds };

/**
 * The identity and generation of the read a `run` operation executes under — the values to
 * capture in an action fence, since a retry runs under a different read than the first attempt and
 * shared source state can move mid-operation. A fresh object per attempt, never the source's
 * internal state. An identity of `""` is reserved for a never-connected read: it always
 * adjudicates `"superseded"`, and no read serving credentials may carry it.
 */
export type CredentialRead = { identity: string; generation: string };

/**
 * Account-side RPC shape. See `CredentialSourceOptions.account` for stub ownership. The contract
 * is this structural interface; the coordinator helpers are the reference implementation, and an
 * account with esoteric needs — per-endpoint connections, custom storage — hand-writes either
 * method in plain TS and owns its invariants instead.
 */
export type AccountCredentialStub<Creds> = {
  /**
   * Reads current credentials, refreshing as needed. `CredentialCoordinator.snapshot` is the
   * reference implementation; a hand-written stub owns the triple's atomicity — no credential
   * change may land between the three reads. Serve the public projection of the stored grant:
   * refresh material never crosses this boundary.
   * @returns Current credentials, their identity fence, and their connection generation. The
   * identity is never `""` — that value is reserved for a never-connected read and always
   * adjudicates `"superseded"` — and the source refuses a read served under it.
   * @throws On confirmed expiry, an error carrying `CredentialsExpiredError` as its `name` or
   * `code` — the transport may strip the class or rebuild the name away, so those marks are the
   * contract the source drops its cache authority on.
   */
  getCredentials(): Promise<CredentialsWithIdentity<Creds>>;
  /**
   * Reports a provider credential rejection and answers with the account's verdict, healing past
   * a rejected-but-current credential inside the ask where the provider allows a mint.
   * `CredentialCoordinator.adjudicateRejection` is the reference implementation; a hand-written
   * stub owns its invariants — the moved-past gate, the heal fenced on the rejected identity, and
   * honest verdicts, with `"expired"` reserved for provider-confirmed grant death.
   * @param identity Credential identity used by the failed call.
   * @returns An adjudication of identity, never of notification delivery, which the account owns
   * end to end. `"superseded"` means a live successor replaced the rejected identity — a refresh,
   * a heal, or a reconnect — so the failure was stale and the source resolves it as retryable;
   * `"expired"` means the grant is dead or the account disconnected, with any Workshop
   * notification the account's own to deliver;
   * `"unavailable"` means the heal failed for non-credential reasons and nothing was adjudicated,
   * so the source surfaces the caller's original provider error. A malformed or lost answer does
   * the same: only the account's own word dead-marks or expires an identity.
   */
  reportCredentialsRejected(identity: string): Promise<RejectionVerdict>;
};

/** `CredentialSource` keeps one flight -- the account's current credentials -- so it needs one key. */
const CREDENTIALS_FLIGHT = "credentials";

/** Configures credentials fetched across the account RPC boundary. */
export type CredentialSourceOptions<Creds> = {
  /** @returns A fresh or caller-owned account credential stub. */
  account(): AccountCredentialStub<Creds>;
  /**
   * Classifies credential rejection — the provider refusing the presented credentials. Per-resource
   * access denials must remain separate so an unauthorized request cannot disconnect a healthy
   * account. The classifier need not tell a stale derived bearer from a dead grant — the
   * provider's signal is the same; the account's heal inside the rejection adjudication
   * disambiguates, and only a rejection the heal cannot move past reads as expiry.
   * @param error Caught provider error.
   * @returns Whether credentials caused the failure.
   */
  isAuthError(error: unknown): boolean;
  /** What the gadget is told when they no longer work. */
  expiredMessage: string;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * Fetches current credentials for provider operations and resolves confirmed credential rejections
 * through the account's verdict. Reads coalesce while in flight but are not cached across
 * operations. The source itself is optional: ports that only want coordinated storage use `get()`
 * or the account stub directly, and callers wanting their own retry policy skip `replayable` and
 * match the named errors (`isCredentialsChanged` / `isCredentialsExpired`) in a plain loop.
 *
 * @example
 * ```ts
 * #creds = new CredentialSource<VendorCreds>({
 *   account: () => this.env.ACCOUNT.get(this.accountId),
 *   isAuthError: error => error instanceof VendorApiError && error.status === 401,
 *   expiredMessage: "Reconnect the vendor account.",
 * });
 *
 * listProjects() {
 *   return this.#creds.run(creds => this.#api.listProjects(creds));
 * }
 * ```
 */
export class CredentialSource<Creds> {
  readonly #options: CredentialSourceOptions<Creds>;
  readonly #logger: typeof logger;
  readonly #fetches = new SingleFlight();
  readonly #asks = new SingleFlight();
  #generation: string | undefined;
  #identity: string | undefined;
  // Bounded by account commits per activation; eviction is unsafe against out-of-order stale reports.
  readonly #dead = new Set<string>();
  #clearFence = 0;

  /**
   * Creates a consumer-side credential source.
   * @param options Account accessor and provider error policy.
   */
  constructor(options: CredentialSourceOptions<Creds>) {
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
  }

  /** @returns Current credentials without provider-error handling. */
  async get(): Promise<Creds> {
    return (await this.#current()).creds;
  }

  /**
   * Fetches the current read's fence data without the credentials — for action-fence capture and
   * comparison outside a `run` operation, such as at action apply.
   * @returns A fresh object carrying the current identity fence and connection generation.
   */
  async read(): Promise<CredentialRead> {
    const { identity, generation } = await this.#current();
    return { identity, generation };
  }

  /**
   * Returns the live connection generation only while this source vouches for the fetched
   * credentials. The account is read on every call, so reconnects are visible before a cache hit;
   * a dead, pending, or fenced-out identity returns `undefined` and therefore bypasses caching.
   * @returns The current cache authority, or `undefined` when this source cannot vouch for one.
   */
  async cacheAuthority(): Promise<string | undefined> {
    const current = await this.#current();
    return this.#generation === current.generation && this.#identity === current.identity
      ? current.generation
      : undefined;
  }

  /**
   * Runs a provider operation, resolving a confirmed credential rejection through the account's
   * verdict on the identity the operation used. The account heals past a rejected-but-current
   * credential inside that ask, so recovery stays invisible here except through the verdict.
   * @param operation Provider call using current credentials. Its second argument is the read the
   * attempt runs under — capture action fences from it, never from state a concurrent fetch can
   * move mid-operation.
   * @param options `replayable` marks the operation safe to execute twice: a `"superseded"`
   * verdict — the rejected credential was already replaced, or the account just healed past it —
   * retries the operation once with freshly fetched credentials, as does a same-generation
   * successor the source already adopted (no ask spent). Without the flag the same verdict
   * throws `CredentialsChangedError` and the caller re-enters. The operation runs at most twice
   * either way.
   * @returns The provider operation result.
   * @throws `CredentialsExpiredError` (carrying the configured `expiredMessage`) on the account's
   * `"expired"` verdict — the credential fetch itself may also throw one, and that carries the
   * account's own message instead; `CredentialsChangedError` when the rejection was stale and re-entering
   * will read live credentials; the original provider error when the failure was not a credential
   * rejection, or the account could not adjudicate it — its heal failed for non-credential
   * reasons, or it could not be reached at all. Both named errors match
   * (`isCredentialsExpired` / `isCredentialsChanged`) across RPC boundaries — their `code`
   * survives the transports that strip `name`.
   */
  async run<T>(
    operation: (credentials: Creds, read: CredentialRead) => Promise<T>,
    options: { replayable?: boolean } = {},
  ): Promise<T> {
    return this.#attempt(operation, await this.#current(), options.replayable === true);
  }

  /**
   * Executes one attempt under one read, resolving a credential rejection by the account's verdict.
   * @param operation Provider call being attempted.
   * @param read The read this attempt runs under.
   * @param retry Whether a superseded rejection may retry — false on the second attempt.
   * @returns The operation result.
   */
  async #attempt<T>(
    operation: (credentials: Creds, read: CredentialRead) => Promise<T>,
    read: CredentialsWithIdentity<Creds>,
    retry: boolean,
  ): Promise<T> {
    try {
      // A fresh object, never the internal triple: the operation may hold or mutate its read.
      return await operation(read.creds, { identity: read.identity, generation: read.generation });
    } catch (error) {
      if (!this.#options.isAuthError(error)) throw error;
      return this.#resolve(operation, read, error, retry);
    }
  }

  /**
   * Resolves a confirmed credential rejection by the account's verdict.
   * @param operation Provider call being resolved.
   * @param read The read whose credentials the provider rejected.
   * @param cause Provider rejection being resolved.
   * @param retry Whether a superseded verdict retries the operation instead of rethrowing.
   * @returns The retried operation result, when a retry resolves it.
   */
  async #resolve<T>(
    operation: (credentials: Creds, read: CredentialRead) => Promise<T>,
    read: CredentialsWithIdentity<Creds>,
    cause: unknown,
    retry: boolean,
  ): Promise<T> {
    // A newer fetch adopted a live grant: this failure is stale, so that grant is neither
    // reported dead nor its cache authority dropped. The shortcut needs evidence the source
    // stands behind — an adopted identity that is itself dead, or one whose authority was
    // dropped, is no successor; then the account adjudicates.
    if (this.#successorTo(read.identity)) {
      // A successor under the read's own generation is a heal of the caller's principal, so a
      // replayable operation retries under it — no ask spent, the account already moved past. A
      // moved generation is a reconnect, and stays a re-entry.
      if (retry && read.generation === this.#generation) return this.#retry(operation, read, cause);
      throw new CredentialsChangedError({ cause });
    }
    const verdict = await this.#verdict(read.identity);
    if (verdict === "expired") {
      throw new CredentialsExpiredError(this.#options.expiredMessage, { cause });
    }
    // Nothing adjudicated: the account's heal failed for non-credential reasons, or the account
    // could not answer at all (either error lives in a log, not in this path), so the caller sees
    // the provider rejection it actually got.
    if (verdict === "unavailable" || verdict === "unadjudicated") throw cause;
    if (!retry) throw new CredentialsChangedError({ cause });
    return this.#retry(operation, read, cause);
  }

  /**
   * Reports a rejection and takes the account's verdict.
   * @param identity Credential identity used by the failed call.
   * @returns The account's verdict on that identity, or `"unadjudicated"` when it could not
   * answer.
   */
  async #verdict(identity: string): Promise<RejectionVerdict | "unadjudicated"> {
    // Drop at the ask: the rejection already proves this snapshot cannot vouch, whichever way
    // the answer goes — dead, its partition could serve the next principal stale data on a hit;
    // superseded, it no longer vouches for the current principal — so cache-first readers bypass
    // during the round trip instead of serving the rejected partition. Drop again on the answer:
    // a hand-written account may keep serving a dead grant until reconnect, so a read landing
    // meanwhile may re-adopt it, and the death mark itself must wait for the account's word.
    this.#supersede();
    // The verdict adjudicates the identity, not the report, so concurrent reporters of one grant
    // share the account round trip — and the account's fence-keyed heal collapses their mints.
    const answer = await this.#asks.run(identity, () => this.#note(identity));
    // A successor adopted while the ask was in flight makes this answer stale: the reported
    // identity is dead-marked, but the live grant keeps the authority it just adopted. Nothing
    // orders the ask's reply against a fetch's — they ride separate account stubs.
    if (this.#successorTo(identity)) {
      if (answer === "expired") this.#dead.add(identity);
      return "superseded";
    }
    // An unadjudicated report never dead-marks: a transient account outage must not retire a
    // possibly-live identity for the rest of the activation, nor invent an expiry the account
    // never confirmed.
    this.#supersede(answer === "expired" ? identity : undefined);
    return answer;
  }

  /**
   * @param identity Identity a failure was reported under.
   * @returns Whether a live successor to it has been adopted — evidence the source stands behind,
   * so an adopted identity that is itself dead, or one whose authority was dropped, is no
   * successor.
   */
  #successorTo(identity: string): boolean {
    return this.#generation !== undefined && this.#identity !== undefined
      && this.#identity !== identity && !this.#dead.has(this.#identity);
  }

  /**
   * Retries a rejected operation once with freshly fetched credentials — after a `"superseded"`
   * verdict, whose fence bump forgot the pre-ask flight so the single-threaded account answers
   * the refetch after its heal's commit, or under a live successor the source already adopted.
   * @param operation Provider call being retried.
   * @param first The read whose rejection resolved as superseded.
   * @param cause Provider rejection being resolved.
   * @returns The retried operation result.
   */
  async #retry<T>(
    operation: (credentials: Creds, read: CredentialRead) => Promise<T>,
    first: CredentialsWithIdentity<Creds>,
    cause: unknown,
  ): Promise<T> {
    const second = await this.#current();
    // A moved generation is a reconnect: never run under a principal the caller didn't start
    // with. The caller re-enters and fetches the new connection deliberately.
    if (second.generation !== first.generation) throw new CredentialsChangedError({ cause });
    // A concurrent resolution already had this successor adjudicated dead — don't run under it.
    // Only when it is the read the source last stood behind: a fenced-out refetch of a dead
    // identity is stale evidence, adjudicating nothing the source stands behind now.
    if (this.#dead.has(second.identity) && this.#identity === second.identity) {
      throw new CredentialsExpiredError(this.#options.expiredMessage, { cause });
    }
    // Retry only under the read the source itself adopted: a fenced-out or since-superseded
    // refetch is stale evidence that can postdate a reconnect the source already adopted, with
    // no adoption of its own to act on — checked before the same-identity supersede below.
    if (this.#generation !== second.generation || this.#identity !== second.identity) {
      throw new CredentialsChangedError({ cause });
    }
    // "Superseded" promised a successor; the same identity back means a lazy account re-served
    // the credentials the provider already rejected. Re-entering is honest — retrying would burn
    // the one retry proving nothing — and the refetch's adoption is undone: a just-rejected
    // credential cannot keep vouching for the cache partition.
    if (second.identity === first.identity) {
      this.#supersede();
      throw new CredentialsChangedError({ cause });
    }
    // At most two attempts: a second rejection is adjudicated but never retried again.
    return this.#attempt(operation, second, false);
  }

  /**
   * Drops the cache authority and fences out account reads started before now — the in-flight one
   * included — so neither can overwrite what this source just learned.
   * @param dead Identity to stop adopting after its confirmed expiry.
   */
  #supersede(dead?: string): void {
    if (dead !== undefined) this.#dead.add(dead);
    this.#generation = undefined;
    this.#clearFence++;
    this.#fetches.forget(CREDENTIALS_FLIGHT);
  }

  /**
   * Runs one coalesced account credential read, adopting its identity and cache authority unless
   * fenced out.
   * @returns The fetched credentials.
   */
  async #current(): Promise<CredentialsWithIdentity<Creds>> {
    const fence = this.#clearFence;
    let current: CredentialsWithIdentity<Creds>;
    try {
      current = await this.#fetches.run(
        CREDENTIALS_FLIGHT, () => this.#options.account().getCredentials());
    } catch (error) {
      // A fetch rejecting with confirmed expiry (a failed refresh) reports the grant as dead as a
      // 401 does. Fenced like adoption: a straggler's stale rejection must not clear a revival.
      if (fence === this.#clearFence && isCredentialsExpired(error)) this.#generation = undefined;
      throw error;
    }
    // "" is reserved for a never-connected read: adopting live credentials under it would wedge
    // every rejection as retryable, since "" always adjudicates superseded.
    if (current.identity === "") {
      // Fail closed, but only over state this read still owns: fenced like adoption and like the
      // rejection above, so a straggler's malformed answer cannot clear a revival that overtook it.
      if (fence === this.#clearFence) this.#supersede();
      throw new Error(
        'The account served credentials under the reserved "" identity; '
        + "getCredentials must fence every read.");
    }
    // Three guards, none subsuming another: the fence blocks fetches started before an expiry
    // report (a straggler can carry any old identity, not just a marked one), the dead set blocks
    // any grant an account keeps serving after its report, and the pending ask blocks a
    // post-report fetch handing the rejected partition back before the verdict — cache-first
    // readers bypass for the whole round trip. The fence holds even against a read resolving a
    // reconnect: generations are opaque and equality-only, so a fenced response cannot prove
    // itself newest — authority stays the last unfenced fetch.
    if (fence === this.#clearFence && !this.#dead.has(current.identity)
      && !this.#asks.pending(current.identity)) {
      this.#generation = current.generation;
      this.#identity = current.identity;
    }
    return current;
  }

  /**
   * Reports a rejection without replacing the provider error.
   * @param identity Credential identity used by the failed call.
   * @returns The account's verdict, or `"unadjudicated"` for an unreachable account or a
   * malformed answer — which the caller surfaces as the provider error it already had, since only
   * the account's own word may dead-mark or expire an identity.
   */
  async #note(identity: string): Promise<RejectionVerdict | "unadjudicated"> {
    let verdict: RejectionVerdict;
    try {
      verdict = await this.#options.account().reportCredentialsRejected(identity);
    } catch (error) {
      this.#logger.error("failed to report credential rejection", {
        event: "credentials.rejection.report.failed",
        error,
      });
      return "unadjudicated";
    }
    if (REJECTION_VERDICTS.includes(verdict)) return verdict;
    this.#logger.error("malformed credential rejection verdict", {
      event: "credentials.rejection.verdict.malformed",
      error: new Error(`unexpected verdict type: ${typeof verdict}`),
    });
    return "unadjudicated";
  }
}
