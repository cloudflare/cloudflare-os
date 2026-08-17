// Hashing and bundle-collection helpers for release publishing.
//
// Two distinct hash schemes coexist on purpose:
//  - Worker modules are content-addressed by full SHA-256 (hex) — our own scheme, used for R2
//    dedupe and for auditing that a deployed bundle matches what CI built.
//  - Static assets use the Workers assets-upload API's content key: SHA-256 of
//    (base64(contents) + extension), hex, truncated to 32 chars. The dash computes exactly this
//    (stratus workers-and-pages/utils/assets.ts); the API treats it as an opaque per-file key, so
//    CI and the deploy service must agree on it byte for byte.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, sep } from "node:path";

/** A worker module as collected from a dry-run bundle, before the manifest strips `bytes`. */
export interface CollectedModule {
  /** Module path relative to the bundle directory, POSIX-separated. */
  name: string;
  /** Module type the script-upload API understands (`esm`, `text`, `wasm`, `data`). */
  type: ModuleType;
  /** Full SHA-256 of the contents, hex — the module's content address. */
  sha256: string;
  /** Byte length. */
  size: number;
  /** The contents. Stripped before the module reaches the manifest. */
  bytes: Buffer;
}

/** One static asset's entry in the assets-upload-session manifest. */
export interface AssetManifestEntry {
  /** The Workers static-asset content key (see {@link cfAssetHash}). */
  hash: string;
  /** Byte length. */
  size: number;
}

/** A built static-asset directory: the upload-session manifest plus deduped blobs. */
export interface CollectedAssets {
  /** `{ "/path": { hash, size } }`, in the exact shape the assets-upload-session API takes. */
  manifest: Record<string, AssetManifestEntry>;
  /** Deduped contents, keyed by content hash, for content-addressed storage. */
  blobs: Map<string, { bytes: Buffer; size: number }>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The Workers static-asset content key (see header comment). */
export function cfAssetHash(bytes: Uint8Array, filePath: string): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const extension = extname(filePath).slice(1);
  return createHash("sha256").update(base64 + extension, "utf8").digest("hex").slice(0, 32);
}

// Module types understood by the script-upload API, keyed by file extension. The manifest
// records the type; the deploy service maps it to the multipart part's MIME type.
const MODULE_TYPE_BY_EXTENSION = {
  ".js": "esm",
  ".mjs": "esm",
  ".txt": "text",
  ".svg": "text",
  ".wasm": "wasm",
  ".bin": "data",
} as const satisfies Record<string, string>;

/** Module type recorded in the manifest, as understood by the script-upload API. */
export type ModuleType = (typeof MODULE_TYPE_BY_EXTENSION)[keyof typeof MODULE_TYPE_BY_EXTENSION];

// Files `wrangler deploy --dry-run --outdir` writes that are not uploadable modules.
function isNonModuleFile(name: string): boolean {
  return name.endsWith(".map") || name === "README.md";
}

/**
 * Reads a `wrangler deploy --dry-run --outdir` output directory and returns
 * `{ mainModule, modules }` where modules is sorted by name and each entry is
 * `{ name, type, sha256, size, bytes }`. Fails closed: an extension we don't recognize means a
 * bundle shape this pipeline has never seen, and needs an explicit decision rather than a guess.
 */
export function collectModules(outDir: string): {
  mainModule: string;
  modules: CollectedModule[];
} {
  const unsorted: CollectedModule[] = [];
  for (const file of walkFiles(outDir)) {
    const name = relative(outDir, file).split(sep).join("/");
    if (isNonModuleFile(name)) continue;
    const type: ModuleType | undefined =
        MODULE_TYPE_BY_EXTENSION[extname(name) as keyof typeof MODULE_TYPE_BY_EXTENSION];
    if (!type) {
      throw new Error(`unrecognized module file in dry-run output: ${name} (${outDir})`);
    }
    const bytes = readFileSync(file);
    unsorted.push({ name, type, sha256: sha256Hex(bytes), size: bytes.length, bytes });
  }
  const modules = unsorted.toSorted((a, b) => (a.name < b.name ? -1 : 1));

  const esmModules = modules.filter((m) => m.type === "esm");
  if (esmModules.length !== 1) {
    throw new Error(
        `expected exactly one ESM module in ${outDir}, found: ` +
        `${esmModules.map((m) => m.name).join(", ") || "(none)"}`);
  }
  return { mainModule: esmModules[0].name, modules };
}

/**
 * Reads a built static-asset directory and returns `{ manifest, blobs }`:
 *  - manifest: { "/path": { hash, size } } in the exact shape the assets-upload-session API takes
 *  - blobs: Map<hash, { bytes, size }> for content-addressed storage
 */
export function collectAssets(distDir: string): CollectedAssets {
  const manifest: Record<string, AssetManifestEntry> = {};
  const blobs = new Map<string, { bytes: Buffer; size: number }>();
  for (const file of walkFiles(distDir)) {
    const path = "/" + relative(distDir, file).split(sep).join("/");
    const bytes = readFileSync(file);
    const hash = cfAssetHash(bytes, file);
    manifest[path] = { hash, size: bytes.length };
    if (!blobs.has(hash)) blobs.set(hash, { bytes, size: bytes.length });
  }
  return { manifest, blobs };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walkFiles(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/**
 * JSON.stringify with all object keys sorted, so manifests diff cleanly and the golden-manifest
 * test is byte-stable. Arrays keep their order (migration history is ordered!).
 */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
