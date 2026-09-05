/** Account-side credential storage and consumer-side RPC access. */

import { createLogger } from "@gadgets/backend-utils/logger";
import { ACCESS_TOKEN_SAFETY_MS, generateNonce } from "./connect-nonce";
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
 * The account's adjudication of a reported credential rejection.
 * - `"expired"` — the grant is gone: provider-confirmed death, or a disconnect discovered during
 *   the adjudication. The account owns announcing a death to the Workshop — a disconnect is a user
 *   action and never notifies — and the verdict never adjudicates that delivery.
 * - `"superseded"` — a live successor replaced the rejected identity: a refresh, a heal inside the
 *   ask, or a reconnect. The failure was stale, so the caller retries or re-enters.
 * - `"unavailable"` — the heal failed for non-credential reasons; nothing was adjudicated, and the
 *   consumer surfaces the caller's original provider error.
 */
export type RejectionVerdict = "expired" | "superseded" | "unavailable";

// Shared storage layout for kit-managed credentials.
const CREDENTIALS_KEY = "credentials";
const IDENTITY_KEY = `${CREDENTIALS_KEY}:identity`;
const MIGRATED_KEY = `${CREDENTIALS_KEY}:migrated`;
const CONNECTION_KEY = `${CREDENTIALS_KEY}:connection`;

const OWNED_KEYS: readonly string[] =
  [CREDENTIALS_KEY, IDENTITY_KEY, MIGRATED_KEY, CONNECTION_KEY];

// Coalesce refreshes across coordinators sharing the same storage object.
const refreshes = perStorage(() => new SingleFlight());

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
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * Owns credential storage, migration, and skew-aware refresh. Concurrent refreshes share one
 * provider request. A crash after provider-side token rotation may still require reconnection.
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
    // the grant is already readable under its new key before the old one goes away.
    this.#commit(upgraded);
    this.#reap();
    return upgraded;
  }

  /** @returns The opaque identity of the current credential value. */
  identity(): string {
    return this.#kv.get<string>(IDENTITY_KEY) ?? "";
  }

  /**
   * Installs credentials from a connect flow.
   * @param credentials New credentials.
   */
  connect(credentials: Creds): void {
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
  #commit(credentials: Creds): void {
    this.#supersede();
    this.#kv.put(CREDENTIALS_KEY, credentials);
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
   * Returns usable credentials, refreshing after the expiry boundary.
   * @param refresh Provider refresh operation.
   * @returns Current or refreshed credentials.
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
   * Refreshes credentials immediately.
   * @param refresh Provider refresh operation.
   * @returns Current or refreshed credentials.
   */
  async rotate(refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    return this.#coalesced(this.#connected(), refresh);
  }

  /** @returns Stored credentials, or throws when disconnected. */
  #connected(): Creds {
    const current = this.stored();
    if (current === undefined) throw new CredentialsExpiredError("This account is not connected.");
    return current;
  }

  /**
   * Coalesces refreshes behind the current identity fence.
   * @param current Credentials being refreshed.
   * @param refresh Provider refresh operation.
   * @returns Current, refreshed, or concurrently replaced credentials.
   */
  #coalesced(current: Creds, refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    // Keyed by the identity fence, so a caller arriving after a reconnect starts its own refresh
    // rather than riding one whose result is already fenced out.
    const fence = this.identity();
    return refreshes(this.#kv).run(fence, () => this.#refresh(current, fence, refresh));
  }

  /**
   * Runs one fenced provider refresh.
   * @param current Credentials being refreshed.
   * @param fence Identity captured before refresh.
   * @param refresh Provider refresh operation.
   * @returns Refreshed credentials unless a newer connection won.
   */
  async #refresh(
    current: Creds,
    fence: string,
    refresh: (current: Creds) => Promise<Creds>,
  ): Promise<Creds> {
    let refreshed: Creds;
    try {
      refreshed = await refresh(current);
    } catch (error) {
      if (!isCredentialsExpired(error) || this.identity() === fence) throw error;
      return this.#overtaken(error);
    }

    if (this.identity() !== fence) return this.#overtaken();
    this.#commit(refreshed);
    return refreshed;
  }

  /**
   * Resolves a refresh overtaken by reconnect or revoke.
   * @param cause Optional expiry error from the stale refresh.
   * @returns Replacement credentials, or throws when disconnected.
   */
  #overtaken(cause?: unknown): Creds {
    const latest = this.stored();
    if (latest !== undefined) return latest;
    throw new CredentialsExpiredError("This account was disconnected while refreshing.", { cause });
  }

  /**
   * Reads the credential triple the account RPC surface serves: current credentials, their
   * identity fence, and their connection generation. The three reads are synchronous after the
   * refresh settles — no await between them — so a `connect()` landing at the await boundary
   * cannot tear the triple apart. That atomicity is why the helper lives on the coordinator; a
   * hand-written `getCredentials` owns it itself.
   * @param refresh Provider refresh operation.
   * @param options `notify` announces confirmed grant death to the Workshop before the rethrow.
   * @returns Current credentials with their identity and connection generation.
   * @throws `CredentialsExpiredError` on confirmed expiry, after awaiting `notify` when the dead
   * grant is still stored — a disconnect is a user action, not grant death, and never notifies.
   * A reconnect landing while `notify` is pending replaces the death: the fresh triple is served.
   * A disconnect landing there reads as not connected, carrying the death as its cause.
   */
  async snapshot(
    refresh: (current: Creds) => Promise<Creds>,
    options: { notify?: () => Promise<void> } = {},
  ): Promise<CredentialsWithIdentity<Creds>> {
    try {
      await this.fresh(refresh);
    } catch (error) {
      if (!isCredentialsExpired(error) || this.stored() === undefined
        || options.notify === undefined) throw error;
      // A reconnect landing mid-notify replaced the dead grant: serve it instead of stale death.
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
   * No durable mint latch guards a dead grant: a repeat report costs one provider call that
   * answers `invalid_grant` again — the same verdict — and Workshop notification is already
   * deduped by `notifyCredentialsExpiredOnce`'s latch. A port that measures mint spam adds a
   * cooldown inside its `refresh` callback.
   * @param identity Credential identity the consumer saw rejected.
   * @param options `refresh` mints past a stale credential (grant-death providers leave it unset);
   * `notify` announces confirmed grant death to the Workshop.
   * @returns The verdict on the rejected identity.
   */
  async adjudicateRejection(
    identity: string,
    options: { refresh?: (current: Creds) => Promise<Creds>; notify: () => Promise<void> },
  ): Promise<RejectionVerdict> {
    // "" — a never-connected read — must not match a never-connected account's own "".
    if (identity === "") return "superseded";
    // Moved-past gate: whatever moved the fence already adjudicated the rejected identity.
    if (identity !== this.identity()) return this.#moved();
    // A grant-death provider has no mint to heal with: the rejection is the grant's death.
    if (options.refresh === undefined) return this.#expired(identity, options.notify);
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
   * Resolves a rejected identity the fence moved past. `"superseded"` promises a live successor;
   * a fence moved by a disconnect left none, so the caller is told to reconnect rather than
   * re-enter into a disconnected account. The disconnect itself never notifies — a user action.
   * @returns `"superseded"` under a live successor, `"expired"` when the account disconnected.
   */
  #moved(): RejectionVerdict {
    return this.stored() === undefined ? "expired" : "superseded";
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
 * capture in an action fence, since a retry runs under a different read than the first attempt
 * and a shared accessor like `authority()` can move mid-operation. A fresh object per attempt,
 * never the source's internal state.
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
   * change may land between the three reads.
   * @returns Current credentials, their identity fence, and their connection generation. The
   * identity is never `""` — that value is reserved for a never-connected read and always
   * adjudicates `"superseded"`, so serving live credentials under it wedges every rejection
   * as retryable.
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
   * so the source surfaces the caller's original provider error. A malformed or lost answer reads
   * as `"expired"`, so a dead grant is never masked as retryable by a broken transport.
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
   * The cache authority for data fetched through this source (`KvTtlCache.partitionedBy`): mirrors
   * the connection generation of the last successful fetch rather than reading the account live, so
   * a reconnect repartitions at the next fetch and a token refresh never does. A shared last-seen
   * value a concurrent fetch can move — action-fence capture must ride the `CredentialRead` handed
   * to its own `run` operation (or the `generation` of its own `getCredentials()` read), never
   * this accessor. Direct callers compose custom authorities for the raw cache constructor.
   * @returns The last-seen connection generation; `undefined` (principal unknown) until a fetch
   * succeeds, and from a reported — or account-refused — expiry until a fetch started after the
   * report adopts an identity neither adjudicated dead nor still under adjudication. A refetch
   * that re-serves the identity a
   * `"superseded"` verdict promised to replace drops it again.
   */
  authority(): string | undefined {
    return this.#generation;
  }

  /**
   * Runs a provider operation, resolving a confirmed credential rejection through the account's
   * verdict on the identity the operation used. The account heals past a rejected-but-current
   * credential inside that ask, so recovery stays invisible here except through the verdict.
   * @param operation Provider call using current credentials. Its second argument is the read the
   * attempt runs under — capture action fences from it, not from `authority()`, which a
   * concurrent fetch can move mid-operation.
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
   * rejection or the account could not adjudicate it (`"unavailable"`). Both named errors match
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
    if (this.#generation !== undefined && read.identity !== this.#identity
      && this.#identity !== undefined && !this.#dead.has(this.#identity)) {
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
    // Nothing adjudicated: the account's heal failed for non-credential reasons (its error lives
    // in the account's logs), so the caller sees the provider rejection it actually got.
    if (verdict === "unavailable") throw cause;
    if (!retry) throw new CredentialsChangedError({ cause });
    return this.#retry(operation, read, cause);
  }

  /**
   * Reports a rejection and takes the account's verdict.
   * @param identity Credential identity used by the failed call.
   * @returns The account's verdict on that identity.
   */
  async #verdict(identity: string): Promise<RejectionVerdict> {
    // Drop at the ask: the rejection already proves this snapshot cannot vouch, whichever way
    // the answer goes — dead, its partition could serve the next principal stale data on a hit;
    // superseded, it no longer vouches for the current principal — so cache-first readers bypass
    // during the round trip instead of serving the rejected partition. Drop again on the answer:
    // the account keeps serving a dead grant until reconnect, so a read landing meanwhile may
    // re-adopt it, and the death mark itself must wait for the account's word.
    this.#supersede();
    // The verdict adjudicates the identity, not the report, so concurrent reporters of one grant
    // share the account round trip — and the account's fence-keyed heal collapses their mints.
    const verdict = await this.#asks.run(identity, () => this.#note(identity));
    this.#supersede(verdict === "expired" ? identity : undefined);
    return verdict;
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
    // Three guards, none subsuming another: the fence blocks fetches started before an expiry
    // report (a straggler can carry any old identity, not just a marked one), the dead set blocks
    // the grants the account keeps serving after their reports, and the pending ask blocks a
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
   * @returns The account's verdict; an unreachable account or a malformed answer reads as
   * expired, so a broken transport cannot mask a dead grant as retryable.
   */
  async #note(identity: string): Promise<RejectionVerdict> {
    let verdict: RejectionVerdict;
    try {
      verdict = await this.#options.account().reportCredentialsRejected(identity);
    } catch (error) {
      this.#logger.error("failed to report credential rejection", {
        event: "credentials.rejection.report.failed",
        error,
      });
      return "expired";
    }
    if (verdict === "superseded" || verdict === "unavailable" || verdict === "expired") {
      return verdict;
    }
    this.#logger.error("malformed credential rejection verdict", {
      event: "credentials.rejection.verdict.malformed",
      error: new Error(`unexpected verdict: ${String(verdict)}`),
    });
    return "expired";
  }
}
