// Gadgets are Git-backed, but blueprint archive version 1 intentionally retains its historical
// gzip-compressed Yjs snapshot wire format. Instantiation decodes that snapshot into a Git commit.

import { lstat, readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import * as Y from "yjs";

const MAGIC = 0xec2e2d3a2300e317n;
const VERSION = 1;
const PREFIX_BYTES = 24;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

export function findInterruptedImportBackups(
  entries: Dirent[],
  label: string,
): Map<string, string> {
  const visibleDirectories = new Set(entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
      .map(entry => entry.name));
  const backups = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^\.(.+)\.backup-\d+$/su.exec(entry.name);
    const name = match?.[1];
    if (!name || name.startsWith(".") || visibleDirectories.has(name)) continue;
    const existing = backups.get(name);
    if (existing) {
      invalid(label, `multiple interrupted import backups for ${name}: ${existing}, ${entry.name}`);
    }
    backups.set(name, entry.name);
  }
  return backups;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function invalid(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

export function parseArchive(bytes: Uint8Array, label: string): {
  metadata: Record<string, unknown>;
  content: Uint8Array;
} {
  if (bytes.byteLength < PREFIX_BYTES) invalid(label, "too short to be a .gadget archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getBigUint64(0) !== MAGIC) invalid(label, "not a .gadget archive (bad magic)");
  const version = view.getUint32(8);
  if (version !== VERSION) invalid(label, `unsupported archive version ${version}`);

  const metadataLength = view.getUint32(12);
  const contentLength = Number(view.getBigUint64(16));
  if (metadataLength === 0 || metadataLength > MAX_METADATA_BYTES) {
    invalid(label, "metadata size is out of range");
  }
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_CONTENT_BYTES) {
    invalid(label, "content size is out of range");
  }
  if (PREFIX_BYTES + metadataLength + contentLength !== bytes.byteLength) {
    invalid(label, "lengths in prefix do not match archive size");
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(textDecoder.decode(
        bytes.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength)));
  } catch (err) {
    invalid(label, `metadata is not valid UTF-8 JSON (${errorMessage(err)})`);
  }
  return { metadata, content: bytes.subarray(PREFIX_BYTES + metadataLength) };
}

export function serializeArchive(
  metadata: Record<string, unknown>,
  content: Uint8Array,
  label: string,
): Uint8Array {
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) invalid(label, "metadata is too large");
  if (content.byteLength > MAX_CONTENT_BYTES) invalid(label, "compressed content is too large");

  const out = new Uint8Array(PREFIX_BYTES + metadataBytes.byteLength + content.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, MAGIC);
  view.setUint32(8, VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(content.byteLength));
  out.set(metadataBytes, PREFIX_BYTES);
  out.set(content, PREFIX_BYTES + metadataBytes.byteLength);
  return out;
}

export function extractFiles(content: Uint8Array, label: string): Map<string, string> {
  let update: Uint8Array;
  try {
    update = gunzipSync(content, { maxOutputLength: MAX_SOURCE_BYTES });
  } catch (err) {
    invalid(label, `content is not a valid gzip-compressed blueprint (${errorMessage(err)})`);
  }

  const doc = new Y.Doc();
  try {
    Y.applyUpdateV2(doc, update);
  } catch (err) {
    invalid(label, `content is not a valid Yjs V2 update (${errorMessage(err)})`);
  }

  if ([...doc.share.keys()].some(name => name !== "")) {
    invalid(label, "content contains a non-canonical named Yjs root");
  }
  const root = doc.getMap();
  const entries = [...root];
  validateFilePaths(entries.map(([filename]) => filename), label);
  const files = new Map<string, string>();
  for (const [filename, value] of entries) {
    if (!(value instanceof Y.Text)) invalid(label, `${filename} is not text`);
    files.set(filename, value.toString());
  }
  return files;
}

export function buildContent(files: Map<string, string>, label: string): Uint8Array {
  validateFilePaths(files.keys(), label);
  const doc = new Y.Doc();
  // The generated update is embedded as build output, not committed source. A fixed client ID makes
  // repeated builds byte-identical while preserving the same minimal one-insert-per-file snapshot.
  doc.clientID = 1;
  const root = doc.getMap();
  for (const [filename, source] of [...files].toSorted(([a], [b]) => compareNames(a, b))) {
    const text = new Y.Text();
    root.set(filename, text);
    text.insert(0, source);
  }
  const update = Y.encodeStateAsUpdateV2(doc);
  if (update.byteLength > MAX_SOURCE_BYTES) invalid(label, "source snapshot is too large");
  return gzipSync(update, {level: 9});
}

export async function readSourceFiles(
  filesDir: string,
  label: string,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let totalBytes = 0;
  const root = await lstat(filesDir);
  if (root.isSymbolicLink()) invalid(label, "must not be a symlink");
  if (!root.isDirectory()) invalid(label, "must be a directory");

  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
        .toSorted((a, b) => compareNames(a.name, b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      validateFilePath(path, label);
      if (entry.isSymbolicLink()) invalid(label, `${path} must not be a symlink`);
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), path);
        continue;
      }
      if (!entry.isFile()) invalid(label, `${path} must be a regular file or directory`);
      const bytes = await readFile(join(directory, entry.name));
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SOURCE_BYTES) invalid(label, "source files are too large");
      try {
        files.set(path, textDecoder.decode(bytes));
      } catch (err) {
        invalid(label, `${path} is not valid UTF-8 (${errorMessage(err)})`);
      }
    }
  };

  await visit(filesDir, "");
  validateFilePaths(files.keys(), label);
  return files;
}

function validateFilePaths(paths: Iterable<string>, label: string): void {
  const allPaths = [...paths];
  if (allPaths.length === 0) invalid(label, "blueprint must contain at least one source file");
  validatePortablePaths(allPaths, label);
}

export function validatePortablePaths(paths: Iterable<string>, label: string): void {
  const portablePaths = new Map<string, string>();
  const portableDirectories = new Map<string, string>();
  for (const path of paths) {
    validateFilePath(path, label);
    const portable = portablePath(path);
    const existing = portablePaths.get(portable);
    if (existing) {
      invalid(label, `${path} aliases ${existing} on case-insensitive filesystems`);
    }
    const conflictingDirectory = portableDirectories.get(portable);
    if (conflictingDirectory) {
      invalid(label, `${path} conflicts with directory ${conflictingDirectory} on ` +
          `case-insensitive filesystems`);
    }
    portablePaths.set(portable, path);

    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const directory = segments.slice(0, i).join("/");
      const portableDirectory = portablePath(directory);
      const existingDirectory = portableDirectories.get(portableDirectory);
      if (existingDirectory && existingDirectory !== directory) {
        invalid(label, `${directory} aliases directory ${existingDirectory} on ` +
            `case-insensitive filesystems`);
      }
      const existingFile = portablePaths.get(portableDirectory);
      if (existingFile) {
        invalid(label, `${path} conflicts with file ${existingFile} on ` +
            `case-insensitive filesystems`);
      }
      portableDirectories.set(portableDirectory, directory);
    }
  }

  for (const [portable, path] of portablePaths) {
    let slash = portable.indexOf("/");
    while (slash !== -1) {
      const parent = portablePaths.get(portable.slice(0, slash));
      if (parent) {
        invalid(label, `${path} conflicts with file ${parent}`);
      }
      slash = portable.indexOf("/", slash + 1);
    }
  }
}

function validateFilePath(path: string, label: string): void {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0") ||
      path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    invalid(label, `unsafe blueprint file path ${JSON.stringify(path)}`);
  }
  for (const segment of path.split("/")) {
    if ([...segment].some(char => char.codePointAt(0)! <= 0x1f) || /[<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu
            .test(segment) ||
        /^\.git(?:ignore)?$/iu.test(segment)) {
      invalid(label, `non-portable blueprint file path ${JSON.stringify(path)}`);
    }
  }
}

function portablePath(path: string): string {
  return path.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
