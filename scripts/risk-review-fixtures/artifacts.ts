// Builders for producer artifacts in the risk-review tests.

import { crc32, deflateRawSync } from "node:zlib";

import type { Json } from "../risk-review-policy.ts";

/** The head and base commits the artifact builders bind to. */
export const HEAD = "a".repeat(40);
export const BASE = "b".repeat(40);

/** Builds a zip archive the way actions/upload-artifact does: deflated entries and a central directory. */
export function zip(entries: Record<string, string>, method: 0 | 8 = 8): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** A well-formed verdict, as review-verdict.yml writes it. */
export function verdictJson(overrides: Record<string, Json | undefined> = {}): string {
  return JSON.stringify({
    schema: 1,
    kind: "verdict",
    name: "bonk",
    head_sha: HEAD,
    base_sha: BASE,
    status: "ok",
    details: { review_text: "[P2] Name the timeout after the platform limit" },
    findings: [{ severity: "P2", title: "Name the timeout after the platform limit", path: "packages/x/src/a.ts", line: 3 }],
    needs_person: [],
    merge_confidence: 8,
    round: 1,
    review_from_sha: null,
    fingerprint: { model: "openai/gpt-6.1-sol", opencode: "1.18.33", review_md: "d".repeat(40), prompt: "e".repeat(64), action: null },
    ...overrides,
  });
}

/** A well-formed proof or evidence artifact. */
export function proofJson(name: string, kind: "proof" | "evidence", holds: boolean, overrides: Record<string, Json | undefined> = {}): string {
  return JSON.stringify({ schema: 1, kind, name, head_sha: HEAD, base_sha: BASE, status: "ok", holds, details: {}, ...overrides });
}
