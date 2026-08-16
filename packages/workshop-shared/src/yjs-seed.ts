// Deterministic Yjs seeding of chat code docs from plain file maps.
//
// A chat's Y.Doc is seeded from a git commit's file map. The seed must be a *pure function* of
// that file map: every participant -- server agent sessions and browser editors alike -- derives
// it independently, and all of the chat's subsequent Yjs updates build on the item IDs it
// establishes. Yjs item IDs are (clientID, sequential clock), and the only nondeterminism in an
// update's encoding is the doc's random clientID -- so a fixed clientID, sorted iteration, and a
// single transaction make the encoded seed byte-stable. A golden-byte unit test (in
// workshop-backend, which runs this module under workerd) pins the exact bytes down against Yjs
// upgrades; if the algorithm ever has to change, gate the new form on a per-chat seed-version
// field (new chats only).
//
// This lives in workshop-shared because both sides of the wire must produce bit-identical seeds;
// the git object store itself is server-only (workshop-backend's git-store.ts).

import * as Y from "yjs";

/**
 * The reserved Yjs clientID under which seed updates are authored.
 *
 * Only `seedDocFromFiles` uses it, and only inside a throwaway doc: live docs *apply* the seed
 * as a remote update, before making any local edits, and never author under this ID themselves.
 * That makes collisions safe by Yjs's own rules (verified in yjs 13.6): a doc whose random
 * clientID happens to equal a *historical* client's simply continues that client's clock
 * sequence, and a doc that collides with a *concurrently applied* remote transaction re-rolls
 * its clientID with a warning. Since the seed is always the first update a chat doc applies,
 * both cases resolve correctly without custom guards.
 *
 * The value is arbitrary: Yjs clientIDs are uniform random uint32s, so no fixed value is a
 * likelier collision target than any other. 1 is chosen because Yjs varint-encodes clientIDs,
 * making small IDs cheaper in the seed and in every later struct that references seed items.
 */
export const SEED_CLIENT_ID = 1;

/**
 * Builds the deterministic seed update for a chat doc: one root `Y.Map<Y.Text>` per entry in
 * `roots` (root name -> file map, matching the per-gadget root layout of workspace docs),
 * returned as a Yjs V2 update.
 *
 * All roots a chat will ever seed must be produced by a *single* call: each call starts the
 * reserved clientID's clock from zero, so two separately built seeds would collide when applied
 * to the same doc.
 */
export function seedDocFromFiles(
    roots: ReadonlyMap<string, ReadonlyMap<string, string>>): Uint8Array {
  let doc = new Y.Doc();
  try {
    doc.clientID = SEED_CLIENT_ID;
    doc.transact(() => {
      for (let rootName of [...roots.keys()].toSorted()) {
        let root = doc.getMap<Y.Text>(rootName);
        let files = roots.get(rootName)!;
        for (let name of [...files.keys()].toSorted()) {
          root.set(name, new Y.Text(files.get(name)!));
        }
      }
    });
    return Y.encodeStateAsUpdateV2(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Hash of a seed update's bytes (SHA-256, 64-hex). Each chat stores the hash of the seed it was
 * created with, so any divergence in seed derivation fails fast and loudly instead of silently
 * corrupting the doc.
 */
export async function seedUpdateHash(seed: Uint8Array): Promise<string> {
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  // Manual hex: Uint8Array.prototype.toHex isn't available across all browsers yet, and this
  // must run in both.
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
