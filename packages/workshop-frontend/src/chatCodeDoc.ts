import type { ChatGadgetPin } from '@gadgets/workshop-shared/api'
import { seedClientIdForGadget, seedRootFromFiles, seedUpdateHash }
  from '@gadgets/workshop-shared/yjs-seed'

// Helpers for deriving a chat code doc's per-pin base seeds (see ChatCodeBase in the API). Kept
// apart from the code view component so the derivation is unit-testable without the editor
// stack.

/**
 * Derives one pin's deterministic seed update from its pinned commit's file map, verifying the
 * result against the pin's recorded seed hash. Every participant (server sessions and other
 * browsers) must derive byte-identical seeds for the chat's Yjs updates to compose, so a
 * mismatch -- drifted seed derivation, e.g. from a Yjs upgrade -- fails loudly instead of
 * building a diverged doc that edits would corrupt.
 */
export async function deriveVerifiedPinSeed(
  pin: ChatGadgetPin, files: ReadonlyMap<string, string>,
): Promise<Uint8Array> {
  if (pin.seedHash === undefined) {
    // Legacy (mergedCommit-only) pins have no seed; their chat's doc base is the legacy code
    // log (see ChatCodeBase.legacy), fetched whole rather than derived.
    throw new Error('Cannot derive a seed for a legacy (mergedCommit-only) pin.')
  }
  const seed = seedRootFromFiles(pin.filesRoot, files, seedClientIdForGadget(pin.gadgetId))
  const hash = await seedUpdateHash(seed)
  if (hash !== pin.seedHash) {
    throw new Error(
      `Chat code seed derivation mismatch (derived ${hash}, pin expects ${pin.seedHash})`)
  }
  return seed
}

/**
 * Stable signature of the seed inputs a chat doc's base derives from: the seedCommit-bearing
 * pins, order-insensitively. The seed is a pure function of these, so the signature keys the
 * (async) base derivation -- pins arriving, being reverted away, or the whole set resetting at
 * an epoch boundary each change it, while unrelated metadata churn does not.
 */
export function pinSetSignature(pins: readonly ChatGadgetPin[]): string {
  return pins.filter(pin => pin.seedCommit !== undefined)
    .map(pin => `${pin.gadgetId}:${pin.seedCommit}`).toSorted().join(',')
}
