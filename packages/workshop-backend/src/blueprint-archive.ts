// Helpers around managing blueprints and encoding/decoding blueprint downloads (`.gadget` files).
// (What the BLUEPRINTS KV namespace stores is declared in storage-schema/blueprints-kv.ts.)
//
// A blueprint's content lives in the BLUEPRINT_CONTENT bucket, in one of two forms:
// - A release pack (see blueprint-release.ts) under `<blueprintId>/<commitId>`, for metadata
//   that names its release commit. A release never changes, so neither does the object.
// - A snapshot under `<blueprintId>/<version>`, for metadata that names none: the form content
//   took before releases were commits. It is a gzip-compressed Yjs V2 state update of a doc
//   whose unnamed root map is filename -> Y.Text.
//
// `.gadget` archives are streamed as a 24-byte prefix (magic, version, metadata byte length,
// content byte length), followed by UTF-8 JSON metadata and the content exactly as stored. The
// version says which form that is. See docs/blueprints.md for the full format description.

import * as Y from 'yjs';
import { BlueprintMetadata, BlueprintOutput, isOutputIcon } from '@gadgets/workshop-shared/api';
import type { GitOid } from '@gadgets/workshop-shared/gatekeeper';
import {
  buildSnapshotRelease, readReleasePack, validateReleaseObjects, type GitObjectMap,
} from './blueprint-release.js';
import { validateGitOid } from './git-codec.js';
import { reviveBlueprintMetadata } from './storage-schema/blueprints-kv.js';

const BLUEPRINT_ARCHIVE_MAGIC = 0xec2e2d3a2300e317n;
// The archive version whose content is a snapshot, and the one whose content is a release pack.
const SNAPSHOT_ARCHIVE_VERSION = 1;
const RELEASE_ARCHIVE_VERSION = 2;
const BLUEPRINT_ARCHIVE_PREFIX_BYTES = 24;
const MAX_BLUEPRINT_METADATA_BYTES = 64 * 1024;
const MAX_BLUEPRINT_CONTENT_BYTES = 32 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Longest accepted output slug/noun. Display strings shown in tabs and chips, so this keeps the
// UI intact rather than being a safety limit.
const MAX_OUTPUT_STRING_LENGTH = 40;

function outputString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OUTPUT_STRING_LENGTH) return undefined;
  return trimmed;
}

/**
 * Accept a blueprint's declared output format only if it is completely well-formed, otherwise
 * treat the blueprint as declaring nothing (a generic app). Blueprint metadata arrives from
 * uploaded archives, so an unknown icon key or an overlong noun must degrade rather than reach
 * the UI.
 */
export function sanitizeBlueprintOutput(output: unknown): BlueprintOutput | undefined {
  if (!output || typeof output !== "object") return undefined;
  let {id, noun, plural, icon} = output as Partial<BlueprintOutput>;
  let cleanId = outputString(id);
  let cleanNoun = outputString(noun);
  let cleanPlural = outputString(plural);
  if (!cleanId || !cleanNoun || !cleanPlural || !isOutputIcon(icon)) return undefined;
  return {id: cleanId, noun: cleanNoun, plural: cleanPlural, icon};
}

type BlueprintContentEnv = Pick<Cloudflare.Env, 'BLUEPRINT_CONTENT'>;

/** The BLUEPRINT_CONTENT key of the content that `metadata` describes. */
export function blueprintContentKey(blueprintId: string, metadata: BlueprintMetadata): string {
  return `${blueprintId}/${metadata.commitId ?? metadata.version}`;
}

/**
 * Reads the release that `metadata` describes: its release commit and the git objects its
 * content holds, which have passed `validateReleaseObjects()` and so are fit to import into a
 * workspace. A snapshot is read as the snapshot release of its files, so that everyone who
 * reads the same one derives the same commit.
 *
 * The caller supplies the metadata, as it read it from KV, rather than this reading it again:
 * the blueprint may have been republished since, and whatever else the caller takes from the
 * metadata (the bindings to set up, say) has to belong to the same version as the code.
 *
 * Throws if the content is missing or invalid.
 */
export async function readBlueprintRelease(
  env: BlueprintContentEnv,
  blueprintId: string,
  metadata: BlueprintMetadata,
): Promise<{commitId: GitOid, objects: GitObjectMap}> {
  let r2Object = await env.BLUEPRINT_CONTENT.get(blueprintContentKey(blueprintId, metadata));
  if (!r2Object) {
    throw new Error(`The content of blueprint ${blueprintId} is missing.`);
  }

  if (metadata.commitId !== undefined) {
    let pack = new Uint8Array(await r2Object.arrayBuffer());
    return {
      commitId: metadata.commitId,
      objects: await readReleasePack(pack, metadata.commitId),
    };
  }

  let decompressed = r2Object.body.pipeThrough(new DecompressionStream("gzip"));
  let snapshot = new Y.Doc();
  Y.applyUpdateV2(snapshot, new Uint8Array(await new Response(decompressed).arrayBuffer()));
  let files = new Map<string, string>();
  for (let [path, text] of snapshot.getMap<Y.Text>()) {
    files.set(path, text.toString());
  }
  let release = await buildSnapshotRelease(files);
  validateReleaseObjects(release.objects, release.commitId);
  return release;
}

/** Deletes all of a blueprint's content: every version of it, in either form. */
export async function deleteBlueprintContent(
  env: BlueprintContentEnv,
  blueprintId: string,
): Promise<void> {
  let cursor: string | undefined;
  do {
    let listing = await env.BLUEPRINT_CONTENT.list({ prefix: `${blueprintId}/`, cursor });
    if (listing.objects.length > 0) {
      await env.BLUEPRINT_CONTENT.delete(listing.objects.map(object => object.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);
}

export function randomBlueprintId(): string {
  let idBytes = new Uint8Array(16);
  crypto.getRandomValues(idBytes);
  return idBytes.toHex();
}

function encodeBlueprintArchivePrefix(metadata: BlueprintMetadata, contentLength: number): Uint8Array {
  let metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  let result = new Uint8Array(BLUEPRINT_ARCHIVE_PREFIX_BYTES + metadataBytes.byteLength);
  let view = new DataView(result.buffer);
  view.setBigUint64(0, BLUEPRINT_ARCHIVE_MAGIC);
  view.setUint32(8,
      metadata.commitId === undefined ? SNAPSHOT_ARCHIVE_VERSION : RELEASE_ARCHIVE_VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(contentLength));
  result.set(metadataBytes, BLUEPRINT_ARCHIVE_PREFIX_BYTES);
  return result;
}

export function buildBlueprintArchiveStream(
  metadata: BlueprintMetadata,
  content: ReadableStream<Uint8Array>,
  contentLength: number,
): ReadableStream<Uint8Array> {
  let archive = new TransformStream<Uint8Array, Uint8Array>();

  void (async () => {
    try {
      await new Response(encodeBlueprintArchivePrefix(metadata, contentLength)).body!
          .pipeTo(archive.writable, { preventClose: true });
      await content.pipeTo(archive.writable);
    } catch (err) {
      await archive.writable.abort(err);
    }
  })();

  return archive.readable;
}

function makeStreamPrefixReader(stream: ReadableStream<Uint8Array>) {
  let reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let tailTaken = false;

  function consume(length: number): Uint8Array {
    let result = new Uint8Array(length);
    let offset = 0;

    while (offset < length) {
      let chunk = pending[0];
      let take = Math.min(length - offset, chunk.byteLength);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      pendingBytes -= take;

      if (take === chunk.byteLength) {
        pending.shift();
      } else {
        pending[0] = chunk.subarray(take);
      }
    }

    return result;
  }

  async function fill(length: number): Promise<void> {
    while (pendingBytes < length) {
      let { done, value } = await reader.read();
      if (done) {
        throw new Error("Unexpected end of gadget archive.");
      }
      let chunk = value!;
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
    }
  }

  return {
    async readExact(length: number): Promise<Uint8Array> {
      if (tailTaken) throw new Error("Archive content stream already opened.");
      await fill(length);
      return consume(length);
    },

    takeTail(): ReadableStream<Uint8Array> {
      if (tailTaken) throw new Error("Archive content stream already opened.");
      tailTaken = true;

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pending.length > 0) {
            let chunk = pending.shift()!;
            pendingBytes -= chunk.byteLength;
            controller.enqueue(chunk);
            return;
          }

          let { done, value } = await reader.read();
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        },

        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    },
  };
}

export async function parseBlueprintArchive(archive: ReadableStream<Uint8Array>)
    : Promise<{metadata: BlueprintMetadata, contentLength: number, content: ReadableStream<Uint8Array>}> {
  let reader = makeStreamPrefixReader(archive);
  let prefix = await reader.readExact(BLUEPRINT_ARCHIVE_PREFIX_BYTES);
  let view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);

  if (view.getBigUint64(0) !== BLUEPRINT_ARCHIVE_MAGIC) {
    throw new Error("Invalid gadget archive magic number.");
  }

  let version = view.getUint32(8);
  if (version !== SNAPSHOT_ARCHIVE_VERSION && version !== RELEASE_ARCHIVE_VERSION) {
    throw new Error(`Unsupported gadget archive version: ${version}.`);
  }

  let metadataSize = view.getUint32(12);
  if (metadataSize === 0) {
    throw new Error("Gadget archive is missing blueprint metadata.");
  }
  if (metadataSize > MAX_BLUEPRINT_METADATA_BYTES) {
    throw new Error("Gadget archive metadata size is out of range.");
  }

  let contentLength = Number(view.getBigUint64(16));
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error("Gadget archive has an invalid content length.");
  }
  if (contentLength > MAX_BLUEPRINT_CONTENT_BYTES) {
    throw new Error("Gadget archive content is too large.");
  }

  let metadataBytes = await reader.readExact(metadataSize);
  let rawMetadata: BlueprintMetadata;
  try {
    rawMetadata = JSON.parse(textDecoder.decode(metadataBytes));
  } catch {
    throw new Error("Gadget archive metadata is not valid JSON.");
  }

  let metadata = reviveBlueprintMetadata(rawMetadata);

  // The version says which form the content takes, but everything that reads the content back
  // goes by whether the metadata names a release commit. Make the two agree.
  if (version === SNAPSHOT_ARCHIVE_VERSION) {
    delete metadata.commitId;
  } else if (typeof metadata.commitId !== "string") {
    throw new Error("Gadget archive metadata does not name its release commit.");
  } else {
    validateGitOid(metadata.commitId);
  }

  return { metadata, contentLength, content: reader.takeTail() };
}
