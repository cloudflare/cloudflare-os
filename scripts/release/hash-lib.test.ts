import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cfAssetHash, collectAssets, collectModules, sha256Hex, stableStringify,
} from "./hash-lib.ts";

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), "testdata");

test("sha256Hex matches node crypto", () => {
  const bytes = Buffer.from("hello gadgets");
  assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"));
});

test("cfAssetHash is truncated sha256 of base64 content plus extension", () => {
  const bytes = Buffer.from("<html></html>");
  const expected = createHash("sha256")
      .update(bytes.toString("base64") + "html", "utf8")
      .digest("hex")
      .slice(0, 32);
  assert.equal(cfAssetHash(bytes, "/some/dir/index.html"), expected);
  assert.equal(expected.length, 32);
  // Same content, different extension -> different key (matches wrangler/dash behavior).
  assert.notEqual(cfAssetHash(bytes, "index.html"), cfAssetHash(bytes, "index.txt"));
  // Extensionless files hash with an empty extension.
  assert.equal(
      cfAssetHash(bytes, "no-extension"),
      createHash("sha256").update(bytes.toString("base64"), "utf8").digest("hex").slice(0, 32));
});

test("collectModules finds the main module and skips maps and READMEs", () => {
  const { mainModule, modules } =
      collectModules(join(TESTDATA, "fixture-bundles", "gatekeeper-google"));
  assert.equal(mainModule, "google.js");
  assert.deepEqual(modules.map((m) => m.name), ["abc123-types.txt", "google.js"]);
  assert.deepEqual(modules.map((m) => m.type), ["text", "esm"]);
  for (const mod of modules) {
    assert.equal(mod.sha256.length, 64);
    assert.ok(mod.size > 0);
    assert.ok(Buffer.isBuffer(mod.bytes));
  }
});

test("collectModules types a WebAssembly module as wasm beside the one ESM module", () => {
  const { mainModule, modules } =
      collectModules(join(TESTDATA, "fixture-bundles", "pdf-renderer"));
  assert.equal(mainModule, "worker.js");
  assert.deepEqual(modules.map((m) => [m.name, m.type]),
      [["abc123-pdfium.wasm", "wasm"], ["worker.js", "esm"]]);
  // Binary contents are hashed as they are on disk.
  const wasm = modules[0];
  assert.deepEqual([...wasm.bytes], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  assert.equal(wasm.sha256, sha256Hex(wasm.bytes));
});

test("collectModules fails on unrecognized file types", () => {
  const out = mkdtempSync(join(tmpdir(), "release-hash-test-"));
  try {
    writeFileSync(join(out, "main.js"), "export default {}\n");
    writeFileSync(join(out, "mystery.dat"), "??\n");
    assert.throws(() => collectModules(out), /unrecognized module file/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("collectModules requires exactly one ESM module", () => {
  const out = mkdtempSync(join(tmpdir(), "release-hash-test-"));
  try {
    writeFileSync(join(out, "a.js"), "export default {}\n");
    writeFileSync(join(out, "b.js"), "export default {}\n");
    assert.throws(() => collectModules(out), /exactly one ESM module/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("collectAssets builds an upload-session-shaped manifest with deduped blobs", () => {
  const access = collectAssets(join(TESTDATA, "fixture-assets", "access"));

  assert.deepEqual(Object.keys(access.manifest).toSorted(),
      ["/assets/app.js", "/assets/print.css", "/assets/shared.css", "/index.html"]);
  for (const entry of Object.values(access.manifest)) {
    assert.equal(entry.hash.length, 32);
    assert.ok(entry.size > 0);
  }
  // shared.css and print.css are byte-identical -> same content key, one shared blob;
  // app.js is its own.
  assert.equal(access.manifest["/assets/shared.css"].hash,
      access.manifest["/assets/print.css"].hash);
  assert.notEqual(access.manifest["/assets/app.js"].hash,
      access.manifest["/assets/shared.css"].hash);
  assert.equal(access.blobs.size, 3);
  assert.ok(access.blobs.has(access.manifest["/index.html"].hash));
});

test("stableStringify sorts object keys but preserves array order", () => {
  const text = stableStringify({ b: 1, a: [{ z: 1, y: 2 }, "second"] }, 0);
  assert.equal(text, '{"a":[{"y":2,"z":1},"second"],"b":1}');
});
