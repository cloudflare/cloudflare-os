import {describe, expect, it} from "vitest";
import {formatGrep, matchBlob, matchLines, scanWorkpieceForGrep, type GrepScan} from "../src/grep";
import {BlobReader, BlobWriter, CHUNK_MAX_SIZE, type ChunkStore} from "../src/git-chunked-blob";
import {encodeLooseObject} from "../src/git-codec";
import type {GitObjectRecord} from "../src/storage-schema/overseer-storage";

// Opens `content` as a stored blob: chunked iff over CHUNK_MAX_SIZE, as the git store does.
function openBlob(content: string | Uint8Array): {reader: BlobReader, chunks: number} {
  let bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let rows = new Map<string, GitObjectRecord>();
  let store: ChunkStore = {get: oid => rows.get(oid), put: record => rows.set(record.oid, record)};
  let writer = new BlobWriter(store, bytes.length);
  writer.write(bytes);
  let pending = writer.finish();
  let record: GitObjectRecord = pending.record ??
      {oid: pending.oid, data: encodeLooseObject("blob", pending.payload)};
  return {reader: BlobReader.open(store, record), chunks: pending.record?.chunks.length ?? 1};
}

describe("grep", () => {
  it("anchors on the line, not its CRLF ending", () => {
    expect(matchLines("alpha\r\nneedle\r\nneedle too\r\n", /needle$/))
        .toEqual([{line: 2, text: "needle"}]);
  });

  it("keeps whole lines under the cap, notes included, and says how many were dropped", () => {
    let scan: GrepScan = {
      matches: Array.from({length: 100}, (_, i) => ({file: "a.txt", line: i + 1, text: `hit ${i}`})),
      errors: Array.from({length: 50}, (_, i) => ({file: `b${i}`, error: `b${i} is binary`})),
      single: false,
    };
    let full = formatGrep(scan, Infinity).split("\n");
    expect(full).toHaveLength(150);

    // Parses a cut result into its kept lines and the two counts its notes report.
    let parse = (text: string) => {
      let lines = text.split("\n");
      let more = (re: RegExp) => Number(lines.find(l => re.test(l))?.match(/\d+/)?.[0] ?? 0);
      return {
        lines,
        matches: lines.filter(l => l.startsWith("a.txt:")),
        skipped: lines.filter(l => l.startsWith("(skipped:")),
        moreMatches: more(/^\(\d+ more matches/),
        moreSkipped: more(/^\(\d+ more files skipped\)$/),
      };
    };

    // Tight: every kept line is a whole leading line of its group, both counts add up, and
    // the whole stays under the cap even with both notes present.
    for (let cap of [120, 200, 600, 1500]) {
      let cut = parse(formatGrep(scan, cap));
      expect(cut.lines.join("\n").length).toBeLessThanOrEqual(cap);
      expect(cut.matches).toEqual(full.slice(0, cut.matches.length));
      expect(cut.matches.length + cut.moreMatches).toBe(100);
      expect(cut.skipped.length + cut.moreSkipped).toBe(50);
    }
    // Wide enough for everything: no notes at all.
    let whole = parse(formatGrep(scan, 10_000));
    expect(whole.lines).toEqual(full);
  });

  it("reports no matches, not an error, for an empty workpiece", async () => {
    // No base commit, so nothing in the cache is ever consulted except the (empty) blob batch.
    let unreached = () => { throw new Error("not reached"); };
    let cache = {
      pathEntryAtCommit: unreached, listCommitTreePaths: unreached, openBlob: unreached,
      ensureBlobs: async () => {},
    };
    let turn = {getOverlayFiles: () => new Map<string, string>(), getRemovedPaths: () => new Set<string>()};
    let scan = await scanWorkpieceForGrep(cache, turn, 1, undefined, undefined, /x/);
    expect(formatGrep(scan, Infinity)).toBe("(no matches)");
    await expect(scanWorkpieceForGrep(cache, turn, 1, undefined, "src", /x/))
        .rejects.toThrow("src: no such file or directory");
  });

  it("streams a large blob's lines, matching across chunk boundaries as matchLines does", () => {
    // ~3 MiB of lines, CRLF and LF mixed, with a needle on every 997th line.
    let lines = Array.from({length: 40_000}, (_, i) =>
        (i % 997 === 0 ? `needle ${i} ` : `line ${i} `) + "é".repeat(i % 37) + (i % 3 ? "\r" : ""));
    let text = lines.join("\n") + "\nlast needle";
    let {reader, chunks} = openBlob(text);
    expect(chunks).toBeGreaterThan(2);
    let pattern = /needle.*$/g;
    expect(matchBlob(reader, pattern, "big.txt")).toEqual(matchLines(text, pattern));
    expect(matchBlob(reader, pattern, "big.txt").length).toBe(Math.ceil(40_000 / 997) + 1);
  });

  it("skips a large blob holding a NUL byte as binary, and a small one too", () => {
    let big = new TextEncoder().encode("text\n".repeat(CHUNK_MAX_SIZE / 2));
    big[big.length - 3] = 0;
    expect(() => matchBlob(openBlob(big).reader, /text/, "big.bin"))
        .toThrow("big.bin is not a text file");
    expect(() => matchBlob(openBlob("a\0b").reader, /a/, "small.bin"))
        .toThrow("small.bin is not a text file");
  });
});
