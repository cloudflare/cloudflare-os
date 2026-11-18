// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the pinned identity and the subresource naming it, the read reservation, and a credential source
// over one account. Kept apart from x.ts so the facet and configurator modules can use them without
// an import cycle.

import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { obsContext } from "./observability";
import { XTransportError, billableResources, isXAuthError, type XEnvelope } from "./x-api";
import { VENDOR_ID } from "./x-env";
import { SNOWFLAKE } from "./x-urls";

const logger = obsContext.createLogger({ component: "gatekeeper.x", vendorId: VENDOR_ID });

/** What the gadget is told when the connection no longer works. */
export const RECONNECT_MESSAGE = "The X connection has expired or was revoked. Reconnect the X account.";

/** What a facet sees of the grant: refresh material never crosses the account boundary. */
export type PublicGrant = { accessToken: string; expiresAt?: number; scopes: string[] };

/** The X user a connection is pinned to, as the account last read them. */
export type StoredIdentity = {
  id: string;
  username: string;
  name: string;
  profileImageUrl?: string;
  protected: boolean;
  verified: boolean;
  /** X Premium tier: `Basic`, `Premium`, `PremiumPlus`, or `None`. Decides the text limit. */
  subscriptionType?: string;
  fetchedAt: number;
};

/** A read reservation's answer: allowed, or refused with the limit and when it resets. */
export type ReadReservation =
  /** `day` is the UTC day the reads were reserved against, absent when reads are unlimited. */
  | { ok: true; day?: string }
  | { ok: false; limit: number; resetsAt: number };

/** The X gatekeeper's own methods on its verifier, which the overseer hands back only to us. */
export interface XVerifierApi extends GatekeeperUserVerifier {
  /**
   * The X user the observer's connection is pinned to, read from the account without asking X, or
   * null once the connection can no longer vouch for anyone: a grant X refused for good, or a
   * disconnect. Any other failure throws, since it says nothing about who the observer is.
   */
  getXUserId(): Promise<string | null>;
}

const USER_FRAGMENT = "user";

/**
 * The subresource ID a read private to the account reports: `user/<id>`, the X user the connection
 * is pinned to, named by the numeric ID X assigned them, which never changes, rather than a handle,
 * which can. Only an observer connected as that same X user may see such a read.
 * @throws Error when `userId` is not a numeric X user ID.
 */
export function xUserSubresourceId(userId: string): string {
  if (!SNOWFLAKE.test(userId)) throw new Error("Expected a numeric X user ID.");
  return formatSubresourceId({ fragments: [{ name: USER_FRAGMENT, id: userId }] });
}

/**
 * The X user ID an {@link xUserSubresourceId} ID names.
 * @throws Error for any other ID, or a spelling other than the canonical one.
 */
export function parseXUserSubresource(id: string): string {
  const { namespace, fragments: [user, ...rest] } = parseSubresourceId(id);
  if (namespace !== undefined || rest.length > 0 || user?.name !== USER_FRAGMENT || !SNOWFLAKE.test(user.id)) {
    throw new Error("Not an X user subresource ID.");
  }
  return user.id;
}

/** Credentials for the account behind `userObjectId`, as a facet or entrypoint reads them. */
export function accountSource(exports: Cloudflare.Exports, userObjectId: string): CredentialSource<PublicGrant> {
  return new CredentialSource<PublicGrant>({
    // A fresh stub per read: a source can outlive the request that made it.
    account: () => exports.UserAccount.get(exports.UserAccount.idFromString(userObjectId)),
    isAuthError: isXAuthError,
    expiredMessage: RECONNECT_MESSAGE,
    vendorId: VENDOR_ID,
  });
}

/**
 * The display-safe refusal of a read the connection's daily limit no longer allows.
 * @param whose Whose connection it is, as the sentence's subject.
 */
export function readLimitMessage(reservation: { limit: number; resetsAt: number },
                                 whose = "This X connection"): string {
  const resets = new Date(reservation.resetsAt).toISOString().slice(11, 16);
  return `${whose} has used today's ${reservation.limit.toLocaleString("en-US")} reads; ` +
    `the limit resets at ${resets} UTC.`;
}

/** The account's daily read budget, which every binding and picker of a connection draws on. */
export type ReadBudget = {
  reserveReads(count: number): Promise<ReadReservation>;
  settleReads(reserved: number, actual: number, day: string): Promise<void>;
};

/**
 * Runs a read within the connection's daily limit: reserves `reserve` billable reads first, then
 * settles with what X returned, which is what X bills. The last read before the limit may overshoot
 * it by the rows X added beyond the reservation. A read whose answer was lost or couldn't be read
 * keeps its reservation, since X may have billed rows nobody saw; any other failure returned none.
 * @param whose Whose connection a refusal names.
 */
export async function withinReadLimit<T>(budget: ReadBudget, reserve: number,
                                         read: () => Promise<XEnvelope<T>>, whose?: string): Promise<XEnvelope<T>> {
  const reservation = await budget.reserveReads(reserve);
  if (!reservation.ok) throw new Error(readLimitMessage(reservation, whose));
  let billed = 0;
  try {
    const envelope = await read();
    billed = billableResources(envelope);
    return envelope;
  } catch (error) {
    if (error instanceof XTransportError) billed = reserve;
    throw error;
  } finally {
    try {
      if (reservation.day !== undefined) await budget.settleReads(reserve, billed, reservation.day);
    } catch (error) {
      logger.warn("failed to settle X reads", { event: "x.reads.settle.failed", error });
    }
  }
}
