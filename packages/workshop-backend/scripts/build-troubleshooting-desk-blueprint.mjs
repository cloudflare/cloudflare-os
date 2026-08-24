// Build the reviewed Troubleshooting Desk source into the ordinary .gadget archive format.
// Run from packages/workshop-backend with `node scripts/build-troubleshooting-desk-blueprint.mjs`.

import { gzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";

const backendRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(backendRoot, "..", "..", "..");
const sourceRoot = join(repoRoot, "packages", "troubleshooting-desk-blueprint", "src");
const target = join(backendRoot, "..", "format-blueprints", "troubleshooting-desk.gadget");
const files = ["server.js", "desk.js", "client.js", "../README.md"];

const doc = new Y.Doc();
// Blueprint archives use the unnamed root map (filename -> Y.Text), which is the format the
// Workshop copies into a Gadget on instantiation.
const root = doc.getMap();
for (const file of files) {
  const source = file.startsWith("../")
    ? join(repoRoot, "packages", "troubleshooting-desk-blueprint", file.slice(3))
    : join(sourceRoot, file);
  root.set(file.endsWith("README.md") ? "README.md" : file, new Y.Text(await readFile(source, "utf8")));
}

const content = gzipSync(Y.encodeStateAsUpdateV2(doc));
const metadata = new TextEncoder().encode(JSON.stringify({
  title: "Troubleshooting Desk",
  description: "Open scoped AVA investigations and follow the read-only daily-grid evidence ladder.",
  author: { type: "user", name: "AVA", id: "ava@local" },
  created: "2026-08-24T00:00:00.000Z",
  version: 1,
  lastUpdated: "2026-08-24T00:00:00.000Z",
  bindings: {},
}));
const prefix = new Uint8Array(24);
const view = new DataView(prefix.buffer);
view.setBigUint64(0, 0xec2e2d3a2300e317n);
view.setUint32(8, 1);
view.setUint32(12, metadata.byteLength);
view.setBigUint64(16, BigInt(content.byteLength));
const archive = new Uint8Array(prefix.byteLength + metadata.byteLength + content.byteLength);
archive.set(prefix);
archive.set(metadata, prefix.byteLength);
archive.set(content, prefix.byteLength + metadata.byteLength);
await writeFile(target, archive);
console.log(`Wrote ${target} (${archive.byteLength} bytes, ${content.byteLength} compressed content bytes).`);
