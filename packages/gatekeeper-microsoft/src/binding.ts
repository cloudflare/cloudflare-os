// What the three per-binding gatekeepers (sharepoint-, outlook- and calendar-gatekeeper.ts) do
// alike: pin the Entra user a binding's connection belongs to and fence its actions on that user,
// export what their reads recorded for observers before they reported subresources, name what an
// action awaiting approval will create, retire applied actions too old to revert, and tell a
// provider's refusal (to apply or undo) from a failure worth retrying.

import { ActionApplyError, type ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { ObservationGate, ObservationInput } from "@gadgets/gatekeeper-kit/observers";
import { GraphApiError } from "./graph-api";
import type { StoredIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";
import { qualifiedSubresourceId, tenantSubresourceId } from "./subresources";

const logger = obsContext.createLogger({ component: "gatekeeper.microsoft.binding", vendorId: VENDOR_ID });

/** How long an applied action stays revertible. */
export const RETAINED_ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a binding's description is kept before it is read again, so renames show up. */
export const DESCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long the connected identity is trusted in memory before the account is asked again. */
const IDENTITY_MEMO_MS = 60 * 1000;
/** How often housekeeping may run. */
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Storage keys this module owns in each binding's storage.
const PINNED_USER_KEY = "pinnedUser";
const HOUSEKEEPING_KEY = "housekeptAt";

/**
 * Where each binding's legacy observer tracker keeps the access units its reads recorded before
 * they reported subresources, which `addObserver()` still checks every collaborator against.
 */
export const OBSERVED_UNIT_PREFIX = "observedUnit:";

const PROVISIONAL = /^~[1-9][0-9]{0,9}$/;

/** Whether an ID is a temporary `~N`, naming something an action awaiting approval will create. */
export function isProvisional(id: string): boolean {
  return PROVISIONAL.test(id);
}

/** The temporary ID of the `sequence`th thing a binding's actions will create. */
export function provisionalId(sequence: number): string {
  return `~${sequence}`;
}

/**
 * The Entra user a binding's connection belongs to, pinned at the binding's first use. The account
 * already refuses a reconnect as anyone else; the pin keeps a binding from following one regardless.
 */
export class PinnedUser {
  readonly #kv: SyncKvStorage;
  readonly #identity: () => Promise<StoredIdentity>;
  /** What the binding is, for the refusal: "SharePoint", "Outlook", "the calendar". */
  readonly #bound: string;
  #memo?: { value: StoredIdentity; at: number };

  constructor(kv: SyncKvStorage, identity: () => Promise<StoredIdentity>, bound: string) {
    this.#kv = kv;
    this.#identity = identity;
    this.#bound = bound;
  }

  async get(): Promise<StoredIdentity> {
    const now = Date.now();
    if (this.#memo && now - this.#memo.at < IDENTITY_MEMO_MS) return this.#memo.value;
    const identity = await this.#identity();
    const who = userKey(identity);
    const pinned = this.#kv.get<string>(PINNED_USER_KEY);
    if (pinned === undefined) {
      this.#kv.put(PINNED_USER_KEY, who);
    } else if (pinned !== who) {
      throw new Error("This binding was made for a different Microsoft 365 account than its connection now uses. " +
        `Remove it and bind ${this.#bound} again.`);
    }
    this.#memo = { value: identity, at: now };
    return identity;
  }

  /** What every action is submitted and applied under, so one proposed as this user applies only as them. */
  async fence(): Promise<{ generation: string }> {
    return { generation: userKey(await this.get()) };
  }
}

function userKey(identity: StoredIdentity): string {
  return `${identity.tenantId}/${identity.objectId}`;
}

/**
 * Whose binding a session's reads are made through: the owner, whose tenant every reported resource
 * is in, and whether the deployment fixes that tenant (`fixedTenant` in microsoft-env.ts), which IDs
 * then leave out.
 */
export type ReadAuthority = { owner(): Promise<StoredIdentity>; fixesTenant: boolean };

/**
 * Authorizes a read through `gate`, reporting `revealed`, the subresource IDs (subresources.ts) of
 * what it revealed, named relative to the binding's tenant: each is qualified with the tenant unless
 * the deployment fixes it. A read that revealed nothing narrower names the owner's tenant.
 */
export async function authorizeRead(
  gate: ObservationGate, host: ReadAuthority, input: ObservationInput, revealed: readonly string[],
): Promise<void> {
  let ids = revealed;
  if (revealed.length === 0 || !host.fixesTenant) {
    const { tenantId } = await host.owner();
    ids = revealed.length === 0 ? [tenantSubresourceId(tenantId)] : revealed.map(id => qualifiedSubresourceId(id, tenantId));
  }
  await gate.authorize(input, { kind: "subresources", ids });
}

/**
 * A binding's `getHistoricalSubresources()`: each access unit its reads recorded before they
 * reported subresources, as the subresource ID naming it now (qualified with the owner's tenant
 * unless the deployment fixes it), and the owner's tenant, which admission required of every
 * collaborator before any of those reads, the ones that named nothing narrower and so recorded
 * nothing included. Every Graph call pins the user first, so a binding with no pin read nothing and
 * has no history. Reads storage only.
 * @param toSubresource The subresource ID a recorded unit names relative to the binding's tenant,
 * or null for one this version can't read.
 * @throws Error rather than leave out a unit it can't name.
 */
export function legacyHistory(kv: SyncKvStorage, fixesTenant: boolean, toSubresource: (unit: string) => string | null): string[] {
  const pinned = kv.get<string>(PINNED_USER_KEY);
  const recorded = [...kv.list({ prefix: OBSERVED_UNIT_PREFIX })].map(([key]) => key.slice(OBSERVED_UNIT_PREFIX.length));
  if (pinned === undefined && recorded.length === 0) return [];
  if (pinned === undefined) throw new Error("This binding recorded what it read without pinning its user, so its history can't be exported.");
  const tenantId = pinned.slice(0, pinned.indexOf("/"));
  const history = new Set([tenantSubresourceId(tenantId)]);
  for (const unit of recorded) {
    const id = toSubresource(unit);
    if (id === null) throw new Error("This binding recorded an access unit this version can't read, so its history can't be exported.");
    history.add(fixesTenant ? id : qualifiedSubresourceId(id, tenantId));
  }
  return [...history];
}

/**
 * Retires applied actions too old to revert, then runs `more` for a binding's own records. Runs at
 * most every few hours, from apply; a failure is logged and left for the next run.
 */
export async function housekeep<A extends { payload: { appliedAt?: number } }>(
  kv: SyncKvStorage, journal: ActionJournal<A>, actions: { runExclusive(hook: () => void): Promise<void> },
  resource: "sharepoint" | "outlook" | "calendar", more?: (now: number) => void,
): Promise<void> {
  const now = Date.now();
  if (now - (kv.get<number>(HOUSEKEEPING_KEY) ?? 0) < HOUSEKEEPING_INTERVAL_MS) return;
  kv.put(HOUSEKEEPING_KEY, now);
  try {
    await actions.runExclusive(() => {
      let cursor: string | undefined;
      do {
        const page = journal.listRetained({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        for (const { id, action } of page.entries) {
          if ((action.payload.appliedAt ?? 0) < now - RETAINED_ACTION_TTL_MS) journal.retire(id);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    });
    more?.(now);
  } catch (error) {
    logger.warn("gatekeeper housekeeping failed", { event: `${resource}.housekeeping.failed`, error });
  }
}

/**
 * A revert's outcome when the provider refused it: its own refusal is final, while an outage,
 * throttling or an expired credential may pass, so those are thrown for the caller to retry.
 */
export function revertRefused(error: unknown, provider: "SharePoint" | "Outlook" | "Calendar"): { message: string; canRetry: false } {
  if (error instanceof GraphApiError && error.status >= 400 && error.status < 500 && !error.isAuthError && error.status !== 429) {
    return { message: `${provider} refused to undo this action. ${error.message}`, canRetry: false };
  }
  throw error;
}

/** An action's target by its real ID: a temporary one resolved, refused if what made it never applied. */
export function realId(refs: { requireResolved(id: string): string }, id: string, what: string): string {
  const resolved = refs.requireResolved(id);
  if (isProvisional(resolved)) throw new ActionApplyError(`${what} has not been created.`);
  return resolved;
}

/** Maps Exchange's refusals of a mail or calendar change onto terminal failures; anything else is retried. */
export function exchangeRefusal(error: unknown, what: string): never {
  if (error instanceof GraphApiError) {
    if (error.status === 412 || error.code === "ErrorIrresolvableConflict") {
      throw new ActionApplyError(`${what} changed after this was proposed, so it was not applied. Ask the agent to read it again.`);
    }
    if (error.status === 404 || error.code === "ErrorItemNotFound") throw new ActionApplyError(`${what} no longer exists, or you no longer have access to it.`);
    if (error.status === 403) throw new ActionApplyError(`You don't have permission to change ${what.toLowerCase()} in Outlook.`);
    if (error.status === 400 || error.status === 409 || error.status === 413) throw new ActionApplyError(`Outlook refused the change: ${error.message}`);
  }
  throw error;
}

/**
 * What a binding says of anything it doesn't cover, in one wording whether or not the thing exists,
 * so a probe can't tell the two apart.
 */
export class OutsideBindingError extends Error {
  constructor(service: "SharePoint" | "Outlook" | "Calendar", what: string) {
    super(`${what} is outside what this ${service} connection covers, or doesn't exist.`);
    this.name = "OutsideBindingError";
  }
}
