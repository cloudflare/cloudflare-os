import type { GitOid } from "./gatekeeper";

/** Identity and length of an immutable whole-file payload; possession alone grants no authority. */
export interface BytesRef {
  /** Git blob object ID computed from the complete payload. */
  oid: GitOid;
  /** Exact payload length in bytes. */
  byteLength: number;
}

/** Opaque binary file content. Binary mutations replace the entire payload, never splice it. */
export interface ByteValue {
  /** Immutable whole-file payload. */
  base: BytesRef;
}

/** Validate byte-reference metadata without granting access to the named payload. */
export function validateBytesRef(ref: BytesRef): void {
  if (typeof ref !== "object" || ref === null || Object.keys(ref).length !== 2 ||
      !("oid" in ref) || !("byteLength" in ref) || !/^[0-9a-f]{40}$/.test(ref.oid) ||
      !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new Error("Invalid immutable byte reference.");
  }
}
