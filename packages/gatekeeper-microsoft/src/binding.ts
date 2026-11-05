// What the three per-binding gatekeepers (sharepoint-, outlook- and calendar-gatekeeper.ts) do
// alike: pin the Entra user a binding's connection belongs to and fence its actions on that user,
// name what an action awaiting approval will create, retire applied actions too old to revert, and
// tell a provider's refusal (to apply or undo) from a failure worth retrying.

import { ActionApplyError, type ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { GraphApiError } from "./graph-api";
import type { StoredIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import { obsContext } from "./observability";

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
