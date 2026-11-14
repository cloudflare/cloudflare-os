// Writes `.gadget` archives for tests of the code that reads them. Nothing in `src/` writes one:
// the build emits a blueprint's files, and the archives the importer reads come from a Workshop.
// Shared with the backend scripts' suite (`scripts/build-bundled-blueprints.test.ts`).

import { gzipSync } from "node:zlib";
import * as Y from "yjs";

const MAGIC = 0xec2e2d3a2300e317n;
const PREFIX_BYTES = 24;

/** A `.gadget` archive of the given version, holding `metadata` and `content` as they are. */
export function serializeArchive(
  version: number,
  metadata: Record<string, unknown>,
  content: Uint8Array,
): Uint8Array {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const out = new Uint8Array(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, MAGIC);
  view.setUint32(8, version);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  out.set(metadataBytes, PREFIX_BYTES);
  out.set(content, PREFIX_BYTES + metadataBytes.byteLength);
  return out;
}

/** The content of a version 1 archive: a gzip-compressed Yjs snapshot of `files`. */
export function buildSnapshotContent(files: ReadonlyMap<string, string>): Uint8Array {
  const doc = new Y.Doc();
  const root = doc.getMap();
  for (const [filename, source] of files) {
    const text = new Y.Text();
    root.set(filename, text);
    text.insert(0, source);
  }
  return gzipSync(Y.encodeStateAsUpdateV2(doc));
}
