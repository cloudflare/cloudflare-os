import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ChatGadgetPin } from "@gadgets/workshop-shared/api";
import { bindLiveDocClientId, seedClientIdForGadget, seedRootFromFiles, seedUpdateHash }
  from "@gadgets/workshop-shared/yjs-seed";
import { deriveVerifiedPinSeed, pinSetSignature } from "./chatCodeDoc";

const FILES: ReadonlyMap<string, string> = new Map([
  ["index.js", "console.log('hi')\n"],
  ["README.md", "# Hello\n"],
]);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

async function makePin(gadgetId: number, files: ReadonlyMap<string, string>):
    Promise<ChatGadgetPin> {
  const seed = seedRootFromFiles(String(gadgetId), files, seedClientIdForGadget(gadgetId));
  return {
    gadgetId,
    filesRoot: String(gadgetId),
    seedCommit: COMMIT,
    seedHash: await seedUpdateHash(seed),
    mergedCommit: COMMIT,
  };
}

describe("deriveVerifiedPinSeed", () => {
  it("derives the seed whose hash the pin records", async () => {
    const pin = await makePin(7, FILES);
    const seed = await deriveVerifiedPinSeed(pin, FILES);

    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, seed);
    const root = doc.getMap<Y.Text>("7");
    expect(root.get("index.js")?.toString()).toBe("console.log('hi')\n");
    expect(root.get("README.md")?.toString()).toBe("# Hello\n");
  });

  // A derivation that no longer matches the recorded hash means this client would build a doc
  // that diverges from every other participant's; editing it would corrupt the chat, so the
  // derivation must fail instead.
  it("throws when the derived seed does not match the pin's hash", async () => {
    const pin = await makePin(7, FILES);
    const changed = new Map(FILES);
    changed.set("index.js", "console.log('bye')\n");

    await expect(deriveVerifiedPinSeed(pin, changed)).rejects.toThrow(/seed derivation mismatch/);
  });

  it("refuses a legacy (mergedCommit-only) pin", async () => {
    const pin: ChatGadgetPin = { gadgetId: 7, filesRoot: "7", mergedCommit: COMMIT };

    await expect(deriveVerifiedPinSeed(pin, FILES)).rejects.toThrow(/legacy/);
  });
});

describe("pinSetSignature", () => {
  it("is order-insensitive and skips legacy pins", async () => {
    const a = await makePin(1, FILES);
    const b = await makePin(2, FILES);
    const legacy: ChatGadgetPin = { gadgetId: 3, filesRoot: "3", mergedCommit: COMMIT };

    expect(pinSetSignature([b, legacy, a])).toBe(pinSetSignature([a, b]));
    expect(pinSetSignature([])).toBe("");
  });
});

// A peer can receive a chat update referencing a new pin's seed items before it has derived and
// applied that seed (metadata delivery races the draft broadcast). Yjs must park the update as
// pending structs and integrate it once the seed arrives -- the lazy-pinning flow leans on this,
// so verify it rather than assume it.
describe("update-before-seed ordering", () => {
  it("parks an update that references seed items and integrates it when the seed arrives",
      async () => {
    const pin = await makePin(7, FILES);
    const seed = await deriveVerifiedPinSeed(pin, FILES);

    // An editor doc with the seed applied, in which a user edit is made.
    const editorDoc = new Y.Doc();
    bindLiveDocClientId(editorDoc);
    Y.applyUpdateV2(editorDoc, seed);
    let editUpdate: Uint8Array | undefined;
    editorDoc.on("updateV2", update => { editUpdate = update; });
    editorDoc.getMap<Y.Text>("7").get("index.js")!.insert(0, "// edited\n");
    expect(editUpdate).toBeDefined();

    // A peer that sees the edit before the seed: the edit parks, invisible...
    const peerDoc = new Y.Doc();
    bindLiveDocClientId(peerDoc);
    Y.applyUpdateV2(peerDoc, editUpdate!);
    expect(peerDoc.getMap<Y.Text>("7").get("index.js")).toBeUndefined();

    // ...and integrates once the seed lands.
    Y.applyUpdateV2(peerDoc, seed);
    expect(peerDoc.getMap<Y.Text>("7").get("index.js")!.toString())
      .toBe("// edited\nconsole.log('hi')\n");
  });
});
