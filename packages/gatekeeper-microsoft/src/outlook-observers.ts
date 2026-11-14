// Observers of a workspace that reads Outlook mail. Mail is readable by the mailbox's owner, by
// delegates, and for a shared mailbox by its members; a folder can also be shared on its own. So
// every read reports the access units it revealed (the mailbox, a folder, a message) as subresource
// IDs (subresources.ts), and a collaborator sees the read only if their own Microsoft 365 account
// can open every one of them, probed by immutable ID with their token. For the user's own mailbox
// that is almost always no one. Units recorded before reads reported subresources stay in the
// binding's legacy tracker (`outlookObservers`), spelled `mail:<userId>:<messageId>` and so on,
// which admission still checks.
//
// Exchange answers 403 or 404 for a mailbox or item the caller can't open, and neither says whether
// it exists, so both mean "no access".

import { trackedCollectionObservers, type ObserverKv, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import { OBSERVED_UNIT_PREFIX } from "./binding";
import { GraphApiError, MAX_BATCH_REQUESTS, type BatchRequest, type GraphApi } from "./graph-api";
import { isMailId } from "./outlook-graph";
import type { MicrosoftVerifierApi, StoredIdentity } from "./microsoft-credentials";
import { VENDOR_ID } from "./microsoft-env";
import { AccessProbeError } from "./sharepoint-observers";
import { isObjectId, outlookSubresourceId } from "./subresources";

/** Something a mail read revealed, in the mailbox of the user with object ID `userId`. */
export type MailUnit =
  | { kind: "mailbox"; userId: string }
  | { kind: "mailFolder"; userId: string; folderId: string }
  | { kind: "mail"; userId: string; messageId: string };

// Object IDs are GUIDs; immutable IDs are base64 (`+`, `/`, `=`, `-`, `_`), never a colon.
const SEPARATOR = ":";

/** A unit as the legacy tracker spelled it, or null for one that isn't a mail unit (or is malformed). */
export function decodeMailUnit(id: string): MailUnit | null {
  const [kind, userId, item, ...rest] = id.split(SEPARATOR);
  if (rest.length > 0 || !isObjectId(userId)) return null;
  switch (kind) {
    case "mailbox": return item === undefined ? { kind, userId } : null;
    case "mailFolder": return isMailId(item) ? { kind, userId, folderId: item } : null;
    case "mail": return isMailId(item) ? { kind, userId, messageId: item } : null;
    default: return null;
  }
}

/** Whether a legacy tracker's unit is a mail unit, which `probeMailUnits` checks. */
export function isMailUnit(id: string): boolean {
  return /^(mailbox|mailFolder|mail):/.test(id);
}

/** Subresource IDs of a mailbox's units, by its owner's object ID. */
export function mailUnits(userId: string) {
  return {
    mailbox: () => outlookSubresourceId({ kind: "mailbox", userId }),
    folder: (folderId: string) => outlookSubresourceId({ kind: "mailFolder", userId, folderId }),
    message: (messageId: string) => outlookSubresourceId({ kind: "mail", userId, messageId }),
  };
}

function probePath(unit: MailUnit): string {
  const base = `users/${unit.userId}`;
  switch (unit.kind) {
    // Listing the whole mailbox needs access to all of it: someone shared only a folder, even the
    // Inbox, gets 404 (verified live).
    case "mailbox": return `${base}/messages?$top=1&$select=id`;
    case "mailFolder": return `${base}/mailFolders/${encodeURIComponent(unit.folderId)}?$select=id`;
    case "mail": return `${base}/messages/${encodeURIComponent(unit.messageId)}?$select=id`;
  }
}

/**
 * Whether `api`'s user can open each mail unit, in order. A unit this version could not parse
 * (null) is denied, as is one Graph says is missing or forbidden; a rejected credential, and
 * anything else, throws: the check could not be made.
 */
export async function probeMailUnits(api: GraphApi, units: readonly (MailUnit | null)[]): Promise<boolean[]> {
  const verdicts = Array.from({ length: units.length }, () => false);
  const requests: { index: number; request: BatchRequest }[] = [];
  units.forEach((unit, index) => {
    if (unit !== null) {
      requests.push({ index, request: { id: String(index), method: "GET", url: probePath(unit), headers: { prefer: 'IdType="ImmutableId"' } } });
    }
  });
  for (let start = 0; start < requests.length; start += MAX_BATCH_REQUESTS) {
    const chunk = requests.slice(start, start + MAX_BATCH_REQUESTS);
    const answers = await api.batch(chunk.map(entry => entry.request));
    for (const { index, request } of chunk) {
      const answer = answers.get(request.id);
      if (answer === undefined) throw new AccessProbeError(502);
      // A 401 here is Graph refusing the credential, as in `probeUnits`.
      if (answer.status >= 200 && answer.status < 300) verdicts[index] = true;
      else if (answer.status === 401) throw new GraphApiError(401, "Microsoft 365 did not accept this connection's credentials.");
      else if (![400, 403, 404].includes(answer.status)) throw new AccessProbeError(answer.status);
    }
  }
  return verdicts;
}

/** The most distinct mail objects one binding tracks while staying shareable. */
const MAX_TRACKED_MAIL_UNITS = 2000;

/**
 * The binding's legacy observer strategy, for the units reads recorded before they reported
 * subresources: a collaborator needs a working connection in the owner's own organization, and
 * then must open, as themselves, everything those reads revealed.
 */
export function outlookObservers(kv: ObserverKv, owner: () => Promise<StoredIdentity>): ObserverStrategy {
  return trackedCollectionObservers<MicrosoftVerifierApi>({
    kv,
    collectionPrefix: OBSERVED_UNIT_PREFIX,
    maxTrackedCollections: MAX_TRACKED_MAIL_UNITS,
    verifyBaseline: async verifier => {
      const [observer, me] = await Promise.all([verifier.getIdentity(), owner()]);
      if (observer === null) {
        throw new Error("This collaborator has no working Microsoft 365 connection. They need to connect " +
          "(or reconnect) Microsoft 365 before they can observe this workspace.");
      }
      if (observer.tenantId !== me.tenantId) {
        throw new Error("This collaborator's Microsoft 365 account is in a different organization than the " +
          "mailbox this workspace read, so they can't observe it.");
      }
    },
    hasCollectionAccess: (verifier, ids) => verifier.canAccess([...ids]),
    denyMessage: () => "This workspace has read mail this collaborator can't open in Outlook, so they can't observe it.",
    vendorId: VENDOR_ID,
  });
}
