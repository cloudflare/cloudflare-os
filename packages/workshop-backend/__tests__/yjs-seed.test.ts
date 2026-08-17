import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  SEED_CLIENT_ID_BASE,
  SEED_CLIENT_ID_END,
  bindLiveDocClientId,
  isSeedClientId,
  seedClientIdForGadget,
  seedRootFromFiles,
  seedUpdateHash,
  updateAuthorsInSeedBand,
} from "@gadgets/workshop-shared/yjs-seed";

// The module under test lives in workshop-shared (browsers must derive bit-identical seeds), but
// the golden-byte tests run here so they execute under workerd like the rest of the git-backed
// code flow.

const FILES = new Map([
  ["client.js", 'console.log("hello");\n'],
  ["README.md", "# Test Gadget\n"],
]);

describe("seedRootFromFiles", () => {
  // Golden bytes: the seed encoding is part of each pin's implicit contract for its epoch's
  // whole lifetime (later updates build on the item IDs it establishes), so any drift -- from a
  // Yjs upgrade, refactor, or iteration-order change -- must fail loudly here, not corrupt docs.
  const GOLDEN_SEED_BASE64 =
      "AAACSAECAB4ABycABAAnAAQ/ODdSRUFETUUubWQjIFRlc3QgR2FkZ2V0CjdjbGllbnQuanNjb25zb2xlLmxvZygi" +
      "aGVsbG8iKTsKAQkOAQkWBwEAAAABAAACQgAAAQQAAA==";
  const GOLDEN_SEED_SHA256 = "e24d6467e4627e08eafb05ee6a7a3dc8b48dffa152fb51ee299373bada2cc221";

  it("produces byte-identical golden output", async () => {
    let seed = seedRootFromFiles("7", FILES, seedClientIdForGadget(7));
    expect(seed.toBase64()).toBe(GOLDEN_SEED_BASE64);
    expect(await seedUpdateHash(seed)).toBe(GOLDEN_SEED_SHA256);
  });

  it("is insensitive to input iteration order", () => {
    let reversed = new Map([...FILES].toReversed());
    expect(seedRootFromFiles("7", reversed, seedClientIdForGadget(7)).toBase64())
        .toBe(GOLDEN_SEED_BASE64);
  });

  it("composes seeds for different gadgets into one doc, in any order", () => {
    // Lazy pinning seeds roots at different times: each root gets its own reserved clientID, so
    // separately derived seeds must compose into the same doc regardless of arrival order.
    let seed7 = seedRootFromFiles("7", FILES, seedClientIdForGadget(7));
    let seed12 = seedRootFromFiles(
        "12", new Map([["main.js", "export default 42;\n"]]), seedClientIdForGadget(12));

    let doc1 = new Y.Doc();
    Y.applyUpdateV2(doc1, seed7);
    Y.applyUpdateV2(doc1, seed12);
    let doc2 = new Y.Doc();
    Y.applyUpdateV2(doc2, seed12);
    Y.applyUpdateV2(doc2, seed7);

    expect(Y.encodeStateVector(doc1)).toEqual(Y.encodeStateVector(doc2));
    expect(doc1.getMap<Y.Text>("7").get("client.js")!.toString())
        .toBe('console.log("hello");\n');
    expect(doc1.getMap<Y.Text>("12").get("main.js")!.toString()).toBe("export default 42;\n");

    // An edit made on one seeded doc applies cleanly to the other.
    let update: Uint8Array | undefined;
    doc1.on("updateV2", u => { update = u; });
    bindLiveDocClientId(doc1);
    doc1.getMap<Y.Text>("7").get("client.js")!.insert(0, "// edited\n");
    Y.applyUpdateV2(doc2, update!);
    expect(doc2.getMap<Y.Text>("7").get("client.js")!.toString())
        .toBe('// edited\nconsole.log("hello");\n');
  });
});

describe("seedClientIdForGadget", () => {
  it("maps gadget IDs into the reserved band", () => {
    expect(seedClientIdForGadget(0)).toBe(SEED_CLIENT_ID_BASE);
    expect(isSeedClientId(seedClientIdForGadget(0))).toBe(true);
    expect(isSeedClientId(seedClientIdForGadget(999))).toBe(true);
    expect(isSeedClientId(SEED_CLIENT_ID_END)).toBe(false);
    expect(isSeedClientId(SEED_CLIENT_ID_BASE - 1)).toBe(false);
  });

  it("rejects gadget IDs outside the band's width", () => {
    expect(() => seedClientIdForGadget(-1)).toThrow(/out of range/);
    expect(() => seedClientIdForGadget(1.5)).toThrow(/out of range/);
    expect(() => seedClientIdForGadget(SEED_CLIENT_ID_END - SEED_CLIENT_ID_BASE))
        .toThrow(/out of range/);
  });
});

describe("bindLiveDocClientId", () => {
  it("allocates outside the reserved band", () => {
    let doc = new Y.Doc();
    bindLiveDocClientId(doc);
    expect(isSeedClientId(doc.clientID)).toBe(false);
  });

  it("re-rolls out of band when a later re-roll lands inside it", () => {
    // Yjs re-rolls doc.clientID itself (to an unrestricted uint32) when a remote transaction
    // advances the doc's own clientID, so a bound doc can land in the band *after* allocation.
    // The binding must correct that before any local authoring; simulate the re-roll landing
    // in-band, then deliver any remote transaction.
    let doc = new Y.Doc();
    bindLiveDocClientId(doc);
    doc.clientID = seedClientIdForGadget(3);
    Y.applyUpdateV2(doc, seedRootFromFiles("7", FILES, seedClientIdForGadget(7)));
    expect(isSeedClientId(doc.clientID)).toBe(false);
  });
});

describe("updateAuthorsInSeedBand", () => {
  it("detects seed updates and in-band authorship", () => {
    expect(updateAuthorsInSeedBand(
        seedRootFromFiles("7", FILES, seedClientIdForGadget(7)))).toBe(true);

    let rogue = new Y.Doc();
    rogue.clientID = seedClientIdForGadget(9);
    let captured: Uint8Array | undefined;
    rogue.on("updateV2", u => { captured = u; });
    rogue.getMap<Y.Text>("9").set("a.js", new Y.Text("x"));
    expect(updateAuthorsInSeedBand(captured!)).toBe(true);
  });

  it("passes a bound doc's edits, including deletions of seeded content", () => {
    let doc = new Y.Doc();
    bindLiveDocClientId(doc);
    Y.applyUpdateV2(doc, seedRootFromFiles("7", FILES, seedClientIdForGadget(7)));

    let updates: Uint8Array[] = [];
    doc.on("updateV2", u => updates.push(u));
    // Deleting seed items rides the delete set, not authorship; both edits must pass.
    doc.getMap<Y.Text>("7").get("client.js")!.delete(0, 8);
    doc.getMap<Y.Text>("7").get("client.js")!.insert(0, "replaced");
    expect(updateAuthorsInSeedBand(Y.mergeUpdatesV2(updates))).toBe(false);
  });
});
