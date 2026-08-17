// Deterministic Yjs seeding of chat code docs from committed file maps.
//
// A chat's Y.Doc holds its uncommitted changes on top of committed gadget code. Each gadget's
// root map is seeded lazily -- when the gadget's code is first modified in the chat -- from the
// commit pinned at that moment (see ChatCodeBase / the `pins` field of "changes" messages in
// the API). The seed must be a *pure function* of (root name, file map, clientID): every
// participant -- server agent sessions and browser editors alike -- derives it independently,
// and all of the chat's subsequent Yjs updates build on the item IDs it establishes. Yjs item
// IDs are (clientID, sequential clock), and the only nondeterminism in an update's encoding is
// the doc's random clientID -- so a fixed clientID, sorted iteration, and a single transaction
// make the encoded seed byte-stable. Golden-byte unit tests (in workshop-backend, which runs
// this module under workerd) pin the exact bytes down against Yjs upgrades; if the algorithm
// ever has to change, gate the new form on a per-pin seed-version field (new pins only --
// absence permanently means this version).
//
// Because roots seed at different times into the same live doc, each root seeds under its own
// reserved clientID (`seedClientIdForGadget`), drawn from a reserved band. Each root is seeded
// at most once per doc epoch (accepting changes resets the chat to a fresh doc), so starting
// that clientID's clock from zero at each seeding is sound. The band is kept out of live docs
// *by construction*, not probability: a live doc that had randomly authored under a band ID
// before the seed arrived would silently swallow the seed's identically-numbered items as
// already known -- divergence, not the clean re-roll Yjs performs on concurrent collisions. So
// every first-party doc that authors chat updates binds its clientID through
// `bindLiveDocClientId`, and the server rejects any incoming update that authors in the band
// (`updateAuthorsInSeedBand`).
//
// This lives in workshop-shared because both sides of the wire must produce bit-identical
// seeds; the git object store itself is server-only (workshop-backend's git-store.ts).

import * as Y from "yjs";

/**
 * First clientID of the reserved seed band. Small values are deliberate: Yjs varint-encodes
 * clientIDs, so band IDs are cheap in the seed and in every later struct that references seed
 * items. (0 is excluded only so the band never contains a falsy ID.)
 */
export const SEED_CLIENT_ID_BASE = 1;

/**
 * One past the last clientID of the reserved seed band. The band's width bounds gadget IDs
 * (small per-workspace counters in practice; `seedClientIdForGadget` asserts), while leaving
 * all but a 2^-12 sliver of the uint32 clientID space for live docs.
 */
export const SEED_CLIENT_ID_END = SEED_CLIENT_ID_BASE + 2 ** 20;

/** Whether `clientId` lies in the reserved seed band (see `seedClientIdForGadget`). */
export function isSeedClientId(clientId: number): boolean {
  return clientId >= SEED_CLIENT_ID_BASE && clientId < SEED_CLIENT_ID_END;
}

/**
 * The reserved clientID under which the given gadget's root is seeded. One ID per gadget makes
 * seed clientIDs unique per root within a doc, so roots pinned at different times never collide
 * with each other; see the module comment for why the whole band is excluded from live docs.
 */
export function seedClientIdForGadget(gadgetId: number): number {
  if (!Number.isInteger(gadgetId) || gadgetId < 0 ||
      gadgetId >= SEED_CLIENT_ID_END - SEED_CLIENT_ID_BASE) {
    throw new Error(`Gadget ID out of range for seed clientID band: ${gadgetId}`);
  }
  return SEED_CLIENT_ID_BASE + gadgetId;
}

/**
 * Builds the deterministic seed update for one gadget root: a root `Y.Map<Y.Text>` named
 * `rootName` (see WorkpieceSummary.filesRoot) holding `files` (file name -> content), authored
 * under `clientId` (`seedClientIdForGadget(gadgetId)`) in a throwaway doc, returned as a Yjs V2
 * update. Live docs must only ever *apply* the result as a remote update, never author it in
 * place. Each call restarts the clientID's clock from zero, so a given root must be seeded at
 * most once per doc epoch.
 */
export function seedRootFromFiles(
    rootName: string, files: ReadonlyMap<string, string>, clientId: number): Uint8Array {
  let doc = new Y.Doc();
  try {
    doc.clientID = clientId;
    doc.transact(() => {
      let root = doc.getMap<Y.Text>(rootName);
      for (let name of [...files.keys()].toSorted()) {
        root.set(name, new Y.Text(files.get(name)!));
      }
    });
    return Y.encodeStateAsUpdateV2(doc);
  } finally {
    doc.destroy();
  }
}

// A uniformly random uint32 clientID outside the reserved seed band.
function randomLiveClientId(): number {
  let buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (isSeedClientId(buf[0]));
  return buf[0];
}

/**
 * Binds a live doc's clientID outside the reserved seed band, and keeps it there for the doc's
 * lifetime. Every first-party doc that authors chat updates -- browser editor docs, server
 * agent session docs, the server's update-from-mainline merge doc -- must be bound with this
 * before authoring anything.
 *
 * Allocation alone is not enough: Yjs re-rolls `doc.clientID` itself (to an unrestricted random
 * uint32) when it detects that a remote transaction advanced the doc's own clientID, so a doc
 * can land inside the band *after* allocation. The hook runs where Yjs's own re-roll does
 * (`afterTransactionCleanup`, at the end of the offending remote transaction), so an in-band ID
 * is corrected before any local authoring can occur under it.
 */
export function bindLiveDocClientId(doc: Y.Doc): void {
  doc.clientID = randomLiveClientId();
  doc.on("afterTransactionCleanup", () => {
    if (isSeedClientId(doc.clientID)) {
      doc.clientID = randomLiveClientId();
    }
  });
}

/**
 * Whether a Yjs V2 update authors structs under a clientID in the reserved seed band. A doc
 * bound with `bindLiveDocClientId` can never produce such an update, so the server rejects them
 * at ingestion: a nonconforming client fails loudly instead of corrupting its chat's history
 * with items a later seed would collide with. (Deletions of seed items are *not* authorship --
 * they ride the update's delete set, which this deliberately doesn't inspect -- so ordinary
 * edits to seeded files pass.)
 */
export function updateAuthorsInSeedBand(update: Uint8Array): boolean {
  for (let client of Y.parseUpdateMetaV2(update).from.keys()) {
    if (isSeedClientId(client)) return true;
  }
  return false;
}

/**
 * Hash of a seed update's bytes (SHA-256, 64-hex). Each pin records the hash of the seed it was
 * established with, so any divergence in seed derivation -- even for pins whose epoch has long
 * closed -- fails fast and loudly instead of silently corrupting the doc.
 */
export async function seedUpdateHash(seed: Uint8Array): Promise<string> {
  // The cast satisfies DOM's stricter BufferSource typing (it rejects Uint8Array<ArrayBufferLike>
  // because the backing buffer could be a SharedArrayBuffer -- never the case for an encoded Yjs
  // update); workers-types has no such split. This module compiles under both.
  let digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", seed as Uint8Array<ArrayBuffer>));
  // Manual hex: Uint8Array.prototype.toHex isn't available across all browsers yet, and this
  // must run in both.
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
