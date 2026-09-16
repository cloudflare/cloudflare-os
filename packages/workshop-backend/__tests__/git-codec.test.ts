import { describe, expect, it } from "vitest";
import { deflate } from "pako";
import {
  applyGitDelta,
  buildPackBytes,
  concatBytes,
  decodeLooseObject,
  decodePackBytes,
  encodeLooseObject,
  gitObjectOid,
  parseGitCommitRefs,
  parseGitTree,
  scanGitTree,
  validateGitOid,
  type PackableObject,
} from "../src/git-codec";
import {
  BAD_NAME_TREE,
  COMMIT_1,
  COMMIT_2,
  COMMIT_3,
  FIXTURE_OBJECTS,
  GITLINK_TARGET,
  GPGSIG_COMMIT,
  PACKED_OIDS,
  PACK_NO_DELTA,
  PACK_OFS_DELTA,
  PACK_REF_DELTA,
  TREE_1,
  b64Bytes,
} from "./git-cache-fixtures";

function fixture(oid: string): PackableObject {
  let object = FIXTURE_OBJECTS.find(o => o.oid === oid);
  if (!object) throw new Error(`no fixture object ${oid}`);
  return { type: object.type, payload: b64Bytes(object.payload) };
}

describe("loose object codec", () => {
  it("computes the same oids as real git for every fixture object", async () => {
    for (let object of FIXTURE_OBJECTS) {
      expect(await gitObjectOid(object.type, b64Bytes(object.payload))).toBe(object.oid);
    }
  });

  it("computes the well-known oid of a canonical blob", async () => {
    // `echo 'hello world' | git hash-object --stdin`
    expect(await gitObjectOid("blob", new TextEncoder().encode("hello world\n")))
        .toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });

  it("round-trips every fixture object through encode/decode", () => {
    for (let object of FIXTURE_OBJECTS) {
      let payload = b64Bytes(object.payload);
      let decoded = decodeLooseObject(encodeLooseObject(object.type, payload));
      expect(decoded.type).toBe(object.type);
      expect(decoded.payload).toStrictEqual(payload);
    }
  });

  it("rejects garbage bytes", () => {
    expect(() => decodeLooseObject(new Uint8Array([1, 2, 3, 4])))
        .toThrow(/corrupt loose git object/);
  });

  it("rejects a header whose size disagrees with the payload", () => {
    // Deflate the lying bytes directly (encodeLooseObject would write a correct header).
    expect(() => decodeLooseObject(deflate(new TextEncoder().encode("blob 5\0abc"))))
        .toThrow(/header size does not match payload/);
  });
});

describe("tree parser", () => {
  it("parses all five entry modes from the real-git fixture tree", () => {
    let entries = parseGitTree(fixture(TREE_1).payload, TREE_1);
    expect(entries.map(e => [e.name, e.mode])).toStrictEqual([
      ["README.md", "100644"],
      ["docs", "40000"],
      ["link.md", "120000"],
      ["run.sh", "100755"],
      ["src", "40000"],
      ["vendored", "160000"],
    ]);
    expect(entries.find(e => e.name === "vendored")!.oid).toBe(GITLINK_TARGET);
  });

  it("decodes a non-ASCII UTF-8 entry name byte-identically", () => {
    let docs = parseGitTree(fixture(TREE_1).payload, TREE_1).find(e => e.name === "docs")!;
    let entries = parseGitTree(fixture(docs.oid).payload, docs.oid);
    expect(entries.map(e => e.name)).toStrictEqual(["naïve.md"]);
  });

  it("scans a tree with a non-UTF-8 entry name structurally", () => {
    let entries = scanGitTree(fixture(BAD_NAME_TREE).payload, BAD_NAME_TREE);
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe("100644");
    expect(Array.from(entries[0].nameBytes)).toStrictEqual([0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]);
  });

  it("fails a strict parse of a non-UTF-8 entry name, naming the tree and the bytes", () => {
    expect(() => parseGitTree(fixture(BAD_NAME_TREE).payload, BAD_NAME_TREE))
        .toThrow(new RegExp(`${BAD_NAME_TREE}.*not valid UTF-8.*fffe2e747874`));
  });

  it("rejects an unsupported entry mode rather than misreading it", () => {
    // A hand-built tree entry with the ancient group-writable mode 100664.
    let oidBytes = new Uint8Array(20).fill(0xab);
    let payload = concatBytes([new TextEncoder().encode("100664 f\0"), oidBytes]);
    expect(() => scanGitTree(payload, "0".repeat(40))).toThrow(/unsupported entry mode 100664/);
  });
});

describe("commit parser", () => {
  it("extracts tree and parents from real-git commits", () => {
    expect(parseGitCommitRefs(fixture(COMMIT_1).payload, COMMIT_1)).toStrictEqual({
      tree: TREE_1,
      parents: [],
    });
    expect(parseGitCommitRefs(fixture(COMMIT_3).payload, COMMIT_3).parents)
        .toStrictEqual([COMMIT_2]);
  });

  it("skips multi-line gpgsig continuation lines", () => {
    expect(parseGitCommitRefs(fixture(GPGSIG_COMMIT).payload, GPGSIG_COMMIT)).toStrictEqual({
      tree: TREE_1,
      parents: [COMMIT_1],
    });
  });

  it("rejects a commit without a tree header", () => {
    let payload = new TextEncoder().encode("author A <a@b> 1 +0000\n\nmessage\n");
    expect(() => parseGitCommitRefs(payload, "0".repeat(40))).toThrow(/missing tree header/);
  });
});

describe("pack decoding", () => {
  const PACKS: [string, string][] = [
    ["no-delta", PACK_NO_DELTA],
    ["ofs-delta", PACK_OFS_DELTA],
    ["ref-delta", PACK_REF_DELTA],
  ];

  for (let [name, packB64] of PACKS) {
    it(`decodes the real \`git pack-objects\` ${name} pack to the exact objects`, async () => {
      let objects = await decodePackBytes(b64Bytes(packB64), { maxObjectSize: 1 << 26 });
      expect(objects).toHaveLength(PACKED_OIDS.length);
      let byOid = new Map<string, PackableObject>();
      for (let object of objects) {
        byOid.set(await gitObjectOid(object.type, object.payload), object);
      }
      expect([...byOid.keys()].toSorted()).toStrictEqual(PACKED_OIDS.toSorted());
      for (let oid of PACKED_OIDS) {
        let expected = fixture(oid);
        expect(byOid.get(oid)!.type).toBe(expected.type);
        expect(byOid.get(oid)!.payload).toStrictEqual(expected.payload);
      }
    });
  }

  it("rejects bad magic", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    pack[0] = 0x51;
    await expect(decodePackBytes(pack, { maxObjectSize: 1 << 26 })).rejects.toThrow(/bad magic/);
  });

  it("rejects a truncated pack", async () => {
    let pack = b64Bytes(PACK_NO_DELTA);
    await expect(decodePackBytes(pack.subarray(0, pack.length - 40), { maxObjectSize: 1 << 26 }))
        .rejects.toThrow(/invalid packfile/);
  });

  it("rejects a corrupted trailer", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    pack[pack.length - 1] ^= 0xff;
    await expect(decodePackBytes(pack, { maxObjectSize: 1 << 26 }))
        .rejects.toThrow(/trailer SHA-1 mismatch/);
  });

  it("rejects a pack declaring fewer objects than it carries (trailing garbage)", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    new DataView(pack.buffer).setUint32(8, PACKED_OIDS.length - 1);
    await expect(decodePackBytes(pack, { maxObjectSize: 1 << 26 }))
        .rejects.toThrow(/trailing garbage/);
  });

  it("rejects a pack declaring more objects than it carries", async () => {
    let pack = b64Bytes(PACK_NO_DELTA).slice();
    new DataView(pack.buffer).setUint32(8, PACKED_OIDS.length + 1);
    await expect(decodePackBytes(pack, { maxObjectSize: 1 << 26 }))
        .rejects.toThrow(/invalid packfile/);
  });

  it("enforces the object size cap while decoding", async () => {
    await expect(decodePackBytes(b64Bytes(PACK_NO_DELTA), { maxObjectSize: 64 }))
        .rejects.toThrow(/exceeds the 64-byte limit/);
  });

  it("fails a ref-delta whose base is nowhere, and resolves it via resolveBase", async () => {
    // Hand-build a one-entry thin pack: a ref-delta against an external base.
    let base = new TextEncoder().encode("hello base content");
    let baseOid = await gitObjectOid("blob", base);
    // Delta: baseSize, targetSize, then one copy op (offset byte + size byte) over the base.
    let delta = new Uint8Array([base.length, base.length, 0x91, 0, base.length]);
    let entryHeader = new Uint8Array([(7 << 4) | (delta.length & 0x0f)]);
    expect(delta.length).toBeLessThan(16);  // single-byte size header
    let oidBytes = Uint8Array.from(baseOid.match(/../g)!.map(h => parseInt(h, 16)));
    let header = new Uint8Array(12);
    header.set(new TextEncoder().encode("PACK"));
    new DataView(header.buffer).setUint32(4, 2);
    new DataView(header.buffer).setUint32(8, 1);
    let body = concatBytes([header, entryHeader, oidBytes, deflate(delta)]);
    let trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
    let pack = concatBytes([body, trailer]);

    await expect(decodePackBytes(pack, { maxObjectSize: 1 << 20 }))
        .rejects.toThrow(new RegExp(`delta base ${baseOid} is unavailable`));

    let objects = await decodePackBytes(pack, {
      maxObjectSize: 1 << 20,
      resolveBase: oid => oid === baseOid ? { type: "blob", payload: base } : undefined,
    });
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("blob");
    expect(objects[0].payload).toStrictEqual(base);
  });
});

describe("pack encoding", () => {
  it("round-trips all fixture objects through buildPackBytes/decodePackBytes", async () => {
    let objects = PACKED_OIDS.map(fixture);
    let pack = concatBytes(await buildPackBytes(objects));
    let decoded = await decodePackBytes(pack, { maxObjectSize: 1 << 26 });
    expect(decoded).toHaveLength(objects.length);
    for (let i = 0; i < objects.length; i++) {
      expect(decoded[i].type).toBe(objects[i].type);
      expect(decoded[i].payload).toStrictEqual(objects[i].payload);
    }
  });

  it("round-trips an empty pack", async () => {
    let pack = concatBytes(await buildPackBytes([]));
    expect(pack.byteLength).toBe(12 + 20);
    expect(await decodePackBytes(pack, { maxObjectSize: 1 })).toStrictEqual([]);
  });
});

describe("applyGitDelta", () => {
  const BASE = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");

  it("applies copy and insert ops", () => {
    // target = base[4..9] ("quick") + " red " + base[10..15] ("brown")
    let delta = new Uint8Array([
      BASE.length,        // base size
      15,                 // target size
      0x90 | 0x01, 4, 5,  // copy offset=4 size=5
      5, 0x20, 0x72, 0x65, 0x64, 0x20,  // insert " red "
      0x90 | 0x01, 10, 5, // copy offset=10 size=5
    ]);
    expect(new TextDecoder().decode(applyGitDelta(delta, BASE, 1024))).toBe("quick red brown");
  });

  it("rejects a base size mismatch", () => {
    let delta = new Uint8Array([1, 0]);
    expect(() => applyGitDelta(delta, BASE, 1024)).toThrow(/base size mismatch/);
  });

  it("rejects out-of-range copies", () => {
    let delta = new Uint8Array([BASE.length, 10, 0x90 | 0x01, 40, 10]);
    expect(() => applyGitDelta(delta, BASE, 1024)).toThrow(/copy out of range/);
  });

  it("rejects a result over the cap before allocating it", () => {
    let delta = new Uint8Array([BASE.length, 100, 0x90, 0]);
    expect(() => applyGitDelta(delta, BASE, 10)).toThrow(/exceeds the 10-byte limit/);
  });

  it("rejects the reserved zero op", () => {
    let delta = new Uint8Array([BASE.length, 1, 0]);
    expect(() => applyGitDelta(delta, BASE, 1024)).toThrow(/reserved zero op/);
  });
});

describe("validateGitOid", () => {
  it("accepts 40-hex and rejects everything else", () => {
    expect(validateGitOid(COMMIT_1)).toBe(COMMIT_1);
    expect(() => validateGitOid(COMMIT_1.slice(0, 39))).toThrow(/Invalid git object id/);
    expect(() => validateGitOid(COMMIT_1.toUpperCase())).toThrow(/Invalid git object id/);
    expect(() => validateGitOid("")).toThrow(/Invalid git object id/);
  });
});
