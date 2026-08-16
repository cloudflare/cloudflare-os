import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { seedDocFromFiles, seedUpdateHash } from "@gadgets/workshop-shared/yjs-seed";

// The module under test lives in workshop-shared (browsers must derive bit-identical seeds), but
// the golden-byte tests run here so they execute under workerd like the rest of the git-backed
// code flow.

describe("seedDocFromFiles", () => {
  const roots = new Map([
    ["7", new Map([
      ["client.js", 'console.log("hello");\n'],
      ["README.md", "# Test Gadget\n"],
    ])],
    ["12", new Map([["main.js", "export default 42;\n"]])],
  ]);

  // Golden bytes: the seed encoding is part of each chat's implicit contract for its whole
  // lifetime (later updates build on the item IDs it establishes), so any drift -- from a Yjs
  // upgrade, refactor, or iteration-order change -- must fail loudly here, not corrupt docs.
  const GOLDEN_SEED_BASE64 =
      "AAACQQIDACgeAAsnAAQAJwAEACcABF5UMTJtYWluLmpzZXhwb3J0IGRlZmF1bHQgNDI7CjdSRUFETUUubWQjIFRl" +
      "c3QgR2FkZ2V0CjdjbGllbnQuanNjb25zb2xlLmxvZygiaGVsbG8iKTsKAgcTAQkOAQkWCwEAAAABAAAAAQAAAkIB" +
      "AAEGAAA=";
  const GOLDEN_SEED_SHA256 = "4b48bfdf4e543e38654c5adb45576e484221554f7db89023c204e739850b2abd";

  it("produces byte-identical golden output", async () => {
    let seed = seedDocFromFiles(roots);
    expect(seed.toBase64()).toBe(GOLDEN_SEED_BASE64);
    expect(await seedUpdateHash(seed)).toBe(GOLDEN_SEED_SHA256);
  });

  it("is insensitive to input iteration order", () => {
    let reversed = new Map([...roots].toReversed().map(
        ([rootName, files]) => [rootName, new Map([...files].toReversed())] as const));
    expect(seedDocFromFiles(reversed).toBase64()).toBe(GOLDEN_SEED_BASE64);
  });

  it("seeds docs that converge under subsequent edits", () => {
    let seed = seedDocFromFiles(roots);

    let doc1 = new Y.Doc();
    let doc2 = new Y.Doc();
    Y.applyUpdateV2(doc1, seed);
    Y.applyUpdateV2(doc2, seed);
    expect(doc1.getMap<Y.Text>("7").get("client.js")!.toString())
        .toBe('console.log("hello");\n');
    expect(Y.encodeStateVector(doc1)).toEqual(Y.encodeStateVector(doc2));

    // An edit made on one seeded doc applies cleanly to the other.
    let update: Uint8Array | undefined;
    doc1.on("updateV2", u => { update = u; });
    doc1.getMap<Y.Text>("7").get("client.js")!.insert(0, "// edited\n");
    Y.applyUpdateV2(doc2, update!);
    expect(doc2.getMap<Y.Text>("7").get("client.js")!.toString())
        .toBe('// edited\nconsole.log("hello");\n');
  });
});
