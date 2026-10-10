// What the account Durable Object shares with the rest of the Worker: the public view of a grant,
// the pinned identity, the read reservation, and a credential source over one account. Kept apart
// from x.ts so the facet and configurator modules can use them without an import cycle.

import { CredentialSource } from "@gadgets/gatekeeper-kit/credentials";
import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { obsContext } from "./observability";
import { billableResources, isXAuthError, type XEnvelope } from "./x-api";
import { VENDOR_ID } from "./x-env";

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
  /** The X user the observer's connection belongs to, or null when it is unusable. */
  getXUserId(): Promise<string | null>;
  /** Whether the observer's X account can see a post. */
  canViewPost(postId: string): Promise<boolean>;
  /** Whether the observer's X account can see a List. */
  canViewList(listId: string): Promise<boolean>;
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
 * it by the rows X added beyond the reservation.
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
  } finally {
    try {
      if (reservation.day !== undefined) await budget.settleReads(reserve, billed, reservation.day);
    } catch (error) {
      logger.warn("failed to settle X reads", { event: "x.reads.settle.failed", error });
    }
  }
}
