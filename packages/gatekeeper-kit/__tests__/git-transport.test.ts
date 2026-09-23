// git-transport.ts coverage: pkt-line round-trips, fetch-command composition (the
// hints-to-filter-spec matrix, and that no fetch command ever emits a `have` line -- the
// transport locked decision of plans/worktrees.md), response demultiplexing feeding
// `consumePack()` (against a mock cache; real pack decoding is workshop-backend's test surface),
// the pull driver's requested-oid verification with its filtered-blob carve-out, and the
// send-pack side: ref-update command encoding (branch-name/oid validation included), the
// canonical empty pack, report-status parsing, and the push driver's body composition.

import type { GitOid, GitPullHints } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import {
  DELIM_PKT,
  FLUSH_PKT,
  GitRefUpdateRejectedError,
  MAX_GIT_FETCH_BYTES,
  PktLineParser,
  ZERO_OID,
  buildGitFetchRequest,
  buildRefUpdateRequest,
  demuxGitFetchResponse,
  emptyPackBytes,
  encodePktLine,
  filterSpecForHints,
  parsePktItems,
  parseReceivePackResponse,
  pktText,
  pullGitObjectsIntoCache,
  pushGitRefUpdate,
  validateBranchName,
} from "../src/git-transport";

/** Deterministic fake full oid. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function concatBytes(pieces: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
}

/** The textual lines of a composed request, in order (flush/delim rendered as markers). */
function requestLines(request: Uint8Array): string[] {
  return parsePktItems(request).map(item =>
    item.kind === "data" ? pktText(item.data) : `<${item.kind}>`);
}

/** A sideband frame within the packfile section. */
function sidebandPkt(band: number, payload: Uint8Array): Uint8Array {
  return concatBytes([
    new TextEncoder().encode((payload.byteLength + 5).toString(16).padStart(4, "0")),
    new Uint8Array([band]),
    payload,
  ]);
}

/** Serve `pieces` as a ReadableStream, one chunk each (exercising re-chunked parse). */
function streamOf(pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= pieces.length) controller.close();
      else controller.enqueue(pieces[index++]);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(chunks);
    chunks.push(value);
  }
}

const DEPTH_1: GitPullHints["commitHistory"] = { kind: "depth", depth: 1 };

describe("pkt-line framing", () => {
  it("round-trips textual lines, flush, and delim through the parser", () => {
    const lines = ["command=fetch", `want ${oid(1)}`, "done", ""];
    const encoded = concatBytes([
      encodePktLine(lines[0]),
      DELIM_PKT,
      encodePktLine(lines[1]),
      encodePktLine(lines[2]),
      encodePktLine(lines[3]),
      FLUSH_PKT,
    ]);
    const items = parsePktItems(encoded);
    expect(items.map(item => item.kind))
      .toEqual(["data", "delim", "data", "data", "data", "flush"]);
    expect(items.flatMap(item => (item.kind === "data" ? [pktText(item.data)] : [])))
      .toEqual(lines);
  });

  it("parses identically across arbitrary chunk boundaries", () => {
    const encoded = concatBytes([encodePktLine(`want ${oid(7)}`), FLUSH_PKT, encodePktLine("x")]);
    for (const splitAt of [1, 3, 4, 5, encoded.byteLength - 1]) {
      const parser = new PktLineParser();
      const items = [
        ...parser.push(encoded.subarray(0, splitAt)),
        ...parser.push(encoded.subarray(splitAt)),
      ];
      parser.finish();
      expect(items.map(item => item.kind)).toEqual(["data", "flush", "data"]);
    }
  });

  it("rejects malformed lengths and truncated input", () => {
    expect(() => parsePktItems(new TextEncoder().encode("00zz")))
      .toThrow(/malformed pkt-line length/);
    expect(() => parsePktItems(new TextEncoder().encode("0003")))
      .toThrow(/malformed pkt-line length/);
    expect(() => parsePktItems(encodePktLine("hello").subarray(0, 6)))
      .toThrow(/mid-pkt/);
  });
});

describe("buildGitFetchRequest", () => {
  // Representative hint shapes, covering every filter-mapping branch and all three
  // commitHistory kinds. Used both for per-shape assertions and for the global
  // no-have/single-filter invariants.
  const HINT_MATRIX: { name: string; hints: GitPullHints; filter?: string }[] = [
    { name: "creation pull (blob:limit)",
      hints: { type: "commit", commitHistory: DEPTH_1, filterBlobSize: 65536 },
      filter: "filter blob:limit=65536" },
    { name: "no blobs at all",
      hints: { type: "commit", commitHistory: DEPTH_1, filterBlobSize: 0 },
      filter: "filter blob:none" },
    { name: "exact commit (tree:0)",
      hints: { type: "commit", commitHistory: DEPTH_1, filterTreeDepth: 0 },
      filter: "filter tree:0" },
    { name: "exact tree (tree depth 1 -> tree:0; wants always arrive)",
      hints: { type: "tree", commitHistory: DEPTH_1, filterTreeDepth: 1 },
      filter: "filter tree:0" },
    { name: "deep tree hint (inexpressible depth -> blob:none)",
      hints: { type: "tree", commitHistory: DEPTH_1, filterTreeDepth: 3 },
      filter: "filter blob:none" },
    { name: "both hints, tree depth 0 (tree filter subsumes the blob filter)",
      hints: { type: "commit", commitHistory: DEPTH_1, filterTreeDepth: 0, filterBlobSize: 100 },
      filter: "filter tree:0" },
    { name: "both hints, deep tree (still one filter line)",
      hints: { type: "commit", commitHistory: DEPTH_1, filterTreeDepth: 2, filterBlobSize: 100 },
      filter: "filter blob:none" },
    { name: "blob fault (no filter: filters do not suppress wants)",
      hints: { type: "blob", commitHistory: DEPTH_1, filterBlobSize: 1048577 },
      filter: undefined },
    { name: "no filter hints",
      hints: { type: "commit", commitHistory: DEPTH_1 },
      filter: undefined },
    { name: "full history",
      hints: { type: "commit", commitHistory: { kind: "full" } },
      filter: undefined },
    { name: "since history",
      hints: { type: "commit", commitHistory: { kind: "since", since: new Date(1330000000500) } },
      filter: undefined },
  ];

  it("emits a want per oid (deduplicated) and a done, in a v2 fetch command", () => {
    const lines = requestLines(buildGitFetchRequest([oid(1), oid(2), oid(1)],
        { type: "commit", commitHistory: DEPTH_1 }));
    expect(lines[0]).toBe("command=fetch");
    expect(lines).toContain("object-format=sha1");
    expect(lines).toContain("<delim>");
    expect(lines.filter(line => line.startsWith("want ")))
      .toEqual([`want ${oid(1)}`, `want ${oid(2)}`]);
    expect(lines).toContain("ofs-delta");
    expect(lines).toContain("no-progress");
    expect(lines.at(-2)).toBe("done");
    expect(lines.at(-1)).toBe("<flush>");
  });

  it("never emits a have line, and at most one filter line, for every hint shape", () => {
    for (const { name, hints, filter } of HINT_MATRIX) {
      const lines = requestLines(buildGitFetchRequest([oid(1), oid(2)], hints));
      expect(lines.filter(line => line.startsWith("have")), name).toEqual([]);
      const filters = lines.filter(line => line.startsWith("filter "));
      expect(filters, name).toEqual(filter === undefined ? [] : [filter]);
      expect(lines).toContain("done");
    }
  });

  it("maps commitHistory to deepen / deepen-since / nothing", () => {
    const depth = requestLines(buildGitFetchRequest([oid(1)],
        { type: "commit", commitHistory: { kind: "depth", depth: 2 } }));
    expect(depth).toContain("deepen 2");

    const since = requestLines(buildGitFetchRequest([oid(1)],
        { type: "commit", commitHistory: { kind: "since", since: new Date(1330000000500) } }));
    expect(since).toContain("deepen-since 1330000000");
    expect(since.filter(line => line.startsWith("deepen "))).toEqual([]);

    const full = requestLines(buildGitFetchRequest([oid(1)],
        { type: "commit", commitHistory: { kind: "full" } }));
    expect(full.filter(line => line.startsWith("deepen"))).toEqual([]);
  });

  it("rejects malformed oids and empty requests", () => {
    const hints: GitPullHints = { type: "commit", commitHistory: DEPTH_1 };
    expect(() => buildGitFetchRequest([], hints)).toThrow(/no objects/);
    expect(() => buildGitFetchRequest(["main"], hints)).toThrow(/invalid git oid/);
    expect(() => buildGitFetchRequest(["A".repeat(40)], hints)).toThrow(/invalid git oid/);
    expect(() => buildGitFetchRequest([`${oid(1)}\nhave ${oid(2)}`], hints))
      .toThrow(/invalid git oid/);
  });
});

describe("filterSpecForHints", () => {
  it("maps blob size 0 to blob:none and positive sizes to blob:limit", () => {
    expect(filterSpecForHints({ type: "commit", commitHistory: DEPTH_1, filterBlobSize: 0 }))
      .toBe("blob:none");
    expect(filterSpecForHints({ type: "tree", commitHistory: DEPTH_1, filterBlobSize: 64 * 1024 }))
      .toBe("blob:limit=65536");
  });

  it("prefers the tree filter when both hints are set", () => {
    expect(filterSpecForHints(
        { type: "commit", commitHistory: DEPTH_1, filterTreeDepth: 1, filterBlobSize: 7 }))
      .toBe("tree:0");
  });

  it("sends no filter for blob wants", () => {
    expect(filterSpecForHints({ type: "blob", commitHistory: DEPTH_1, filterBlobSize: 12345 }))
      .toBeUndefined();
  });
});

// A synthetic v2 fetch response: optional leading sections, then a sideband-framed packfile
// section. The "pack" payload is arbitrary bytes -- real pack decoding is consumePack()'s
// (workshop-backend's) test surface, not this one.
const PACK_BYTES = new TextEncoder().encode("PACKnonsense-payload-for-framing-tests");

function packfileResponse(options: { withSections?: boolean; progress?: boolean } = {}): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  if (options.withSections) {
    pieces.push(
      encodePktLine("shallow-info"),
      encodePktLine(`shallow ${oid(1)}`),
      DELIM_PKT,
    );
  }
  pieces.push(encodePktLine("packfile"));
  pieces.push(sidebandPkt(1, PACK_BYTES.subarray(0, 9)));
  if (options.progress) {
    pieces.push(sidebandPkt(2, new TextEncoder().encode("Counting objects: 100%")));
  }
  pieces.push(sidebandPkt(1, PACK_BYTES.subarray(9)));
  pieces.push(FLUSH_PKT);
  return pieces;
}

describe("demuxGitFetchResponse", () => {
  it("yields exactly the band-1 payload bytes", async () => {
    const pack = await collect(
        demuxGitFetchResponse(streamOf(packfileResponse()), MAX_GIT_FETCH_BYTES));
    expect(pack).toEqual(PACK_BYTES);
  });

  it("skips leading sections and progress frames", async () => {
    const pack = await collect(demuxGitFetchResponse(
        streamOf(packfileResponse({ withSections: true, progress: true })), MAX_GIT_FETCH_BYTES));
    expect(pack).toEqual(PACK_BYTES);
  });

  it("parses across arbitrary chunk boundaries", async () => {
    const whole = concatBytes(packfileResponse({ withSections: true, progress: true }));
    const rechunked = [whole.subarray(0, 3), whole.subarray(3, 27), whole.subarray(27)];
    const pack = await collect(demuxGitFetchResponse(streamOf(rechunked), MAX_GIT_FETCH_BYTES));
    expect(pack).toEqual(PACK_BYTES);
  });

  it("fails the stream on an ERR pkt with the server's message", async () => {
    const response = [encodePktLine(`ERR upload-pack: not our ref ${oid(3)}`), FLUSH_PKT];
    await expect(collect(demuxGitFetchResponse(streamOf(response), MAX_GIT_FETCH_BYTES)))
      .rejects.toThrow(`git fetch failed: upload-pack: not our ref ${oid(3)}`);
  });

  it("fails the stream on a band-3 error frame", async () => {
    const response = [
      encodePktLine("packfile"),
      sidebandPkt(1, PACK_BYTES.subarray(0, 4)),
      sidebandPkt(3, new TextEncoder().encode("fatal: the remote end hung up")),
    ];
    await expect(collect(demuxGitFetchResponse(streamOf(response), MAX_GIT_FETCH_BYTES)))
      .rejects.toThrow("git fetch failed: fatal: the remote end hung up");
  });

  it("rejects a response that ends without a flush", async () => {
    const truncated = packfileResponse().slice(0, -1);
    await expect(collect(demuxGitFetchResponse(streamOf(truncated), MAX_GIT_FETCH_BYTES)))
      .rejects.toThrow(/missing final flush/);
  });

  it("rejects a response with no packfile section", async () => {
    const response = [encodePktLine("acknowledgments"), encodePktLine("NAK"), FLUSH_PKT];
    await expect(collect(demuxGitFetchResponse(streamOf(response), MAX_GIT_FETCH_BYTES)))
      .rejects.toThrow(/no packfile section/);
  });

  it("enforces the transfer-size limit on the raw body", async () => {
    const response = packfileResponse();
    const limit = concatBytes(response).byteLength - 1;
    await expect(collect(demuxGitFetchResponse(streamOf(response), limit)))
      .rejects.toThrow(/transfer limit/);
  });
});

describe("pullGitObjectsIntoCache", () => {
  /** A GitCache stand-in that records what it was fed and answers with fixed stored oids. */
  function fakeCache(stored: GitOid[]) {
    const consumed: Uint8Array[] = [];
    return {
      consumed,
      async consumePack(pack: ReadableStream<Uint8Array>): Promise<GitOid[]> {
        consumed.push(await collect(pack));
        return stored;
      },
    };
  }

  function fakeFetch(requests: Uint8Array[], pieces: Uint8Array[]): (body: Uint8Array) => Promise<Response> {
    return async body => {
      requests.push(body);
      return new Response(streamOf(pieces) as unknown as BodyInit);
    };
  }

  const HINTS: GitPullHints = { type: "commit", commitHistory: DEPTH_1, filterBlobSize: 65536 };

  it("streams the demuxed pack into consumePack and verifies the requested oids", async () => {
    const requests: Uint8Array[] = [];
    const cache = fakeCache([oid(1), oid(2), oid(9)]);
    await pullGitObjectsIntoCache(
        fakeFetch(requests, packfileResponse()), [oid(1), oid(2)], HINTS, cache);
    expect(cache.consumed).toEqual([PACK_BYTES]);
    expect(requests).toHaveLength(1);
    expect(requestLines(requests[0])).toContain(`want ${oid(1)}`);
  });

  it("throws when a requested non-blob object is missing from the stored list", async () => {
    const cache = fakeCache([oid(1)]);
    await expect(pullGitObjectsIntoCache(
        fakeFetch([], packfileResponse()), [oid(1), oid(2)], HINTS, cache))
      .rejects.toThrow(`git fetch did not provide the requested object ${oid(2)}`);
  });

  it("tolerates a missing blob when the request was bounded by filterBlobSize", async () => {
    // The gitPull contract's carve-out: consumePack() measures, records, and skips an oversized
    // blob (absent from the stored list); the pull reports success without it and the overseer
    // surfaces the too-large read error.
    const cache = fakeCache([]);
    await expect(pullGitObjectsIntoCache(
        fakeFetch([], packfileResponse()), [oid(1)],
        { type: "blob", commitHistory: DEPTH_1, filterBlobSize: 1048577 }, cache))
      .resolves.toBeUndefined();
  });

  it("still throws for a missing blob when no blob filter bounded the request", async () => {
    const cache = fakeCache([]);
    await expect(pullGitObjectsIntoCache(
        fakeFetch([], packfileResponse()), [oid(1)],
        { type: "blob", commitHistory: DEPTH_1 }, cache))
      .rejects.toThrow(/did not provide/);
  });

  it("fails on a non-OK response", async () => {
    const cache = fakeCache([]);
    await expect(pullGitObjectsIntoCache(
        async () => new Response("nope", { status: 502 }), [oid(1)], HINTS, cache))
      .rejects.toThrow(/HTTP 502/);
    expect(cache.consumed).toEqual([]);
  });
});

describe("validateBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const name of ["main", "feature/foo-bar", "release/v1.2.3", "user/kenton/wip_2",
                        "with.dots", "UPPER"]) {
      expect(validateBranchName(name)).toBe(name);
    }
  });

  it("rejects names that could escape the ref namespace or corrupt pkt-line framing", () => {
    for (const name of ["", "has space", "has\ttab", "has\nnewline", "has\0nul", "a..b",
                        "/leading", "trailing/", "double//slash", "~tilde", "care^t", "colon:",
                        "quest?", "star*", "brack[et", "back\\slash", "at@{brace", "@",
                        ".leading-dot", "trailing-dot.", "inner/.dot", "locked.lock",
                        "locked.lock/sub", "dot./slash", "a".repeat(256)]) {
      expect(() => validateBranchName(name), JSON.stringify(name)).toThrow(/invalid branch name/);
    }
  });
});

describe("buildRefUpdateRequest", () => {
  it("encodes one command pkt with the capability list and a terminating flush", () => {
    const request = buildRefUpdateRequest({ branch: "main", oldSha: oid(1), newSha: oid(2) });
    const items = parsePktItems(request);
    expect(items.map(item => item.kind)).toEqual(["data", "flush"]);
    const command = pktText((items[0] as { data: Uint8Array }).data);
    expect(command).toBe(`${oid(1)} ${oid(2)} refs/heads/main\0report-status agent=cloudflare-gadgets`);
  });

  it("accepts the zero id on either side, but rejects a no-op update", () => {
    expect(() => buildRefUpdateRequest({ branch: "b", oldSha: ZERO_OID, newSha: oid(1) }))
      .not.toThrow();
    expect(() => buildRefUpdateRequest({ branch: "b", oldSha: oid(1), newSha: ZERO_OID }))
      .not.toThrow();
    expect(() => buildRefUpdateRequest({ branch: "b", oldSha: oid(1), newSha: oid(1) }))
      .toThrow(/no-op/);
  });

  it("rejects malformed oids and branch names", () => {
    expect(() => buildRefUpdateRequest({ branch: "b", oldSha: "nope", newSha: oid(1) }))
      .toThrow(/invalid git oid/);
    expect(() => buildRefUpdateRequest({ branch: "bad name", oldSha: ZERO_OID, newSha: oid(1) }))
      .toThrow(/invalid branch name/);
  });
});

describe("emptyPackBytes", () => {
  it("produces the canonical zero-object pack: header plus its SHA-1 trailer", async () => {
    const pack = await emptyPackBytes();
    expect([...pack.subarray(0, 12)]).toEqual([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
    const trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", pack.subarray(0, 12)));
    expect(pack.subarray(12)).toEqual(trailer);
    // git's well-known empty-pack checksum, as a cross-check against an independently wrong
    // header and digest agreeing with each other.
    expect([...pack.subarray(12)].map(b => b.toString(16).padStart(2, "0")).join(""))
      .toBe("029d08823bd8a8eab510ad6ac75c823cfd3ed31e");
  });
});

describe("parseReceivePackResponse", () => {
  function report(...lines: string[]): Uint8Array {
    return concatBytes([...lines.map(encodePktLine), FLUSH_PKT]);
  }

  it("returns normally when the update was applied", () => {
    expect(() => parseReceivePackResponse(
        report("unpack ok", "ok refs/heads/main"), "refs/heads/main")).not.toThrow();
  });

  it("throws the distinguished rejection with the server's reason on ng", () => {
    let caught: unknown;
    try {
      parseReceivePackResponse(
          report("unpack ok", "ng refs/heads/main fetch first"), "refs/heads/main");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitRefUpdateRejectedError);
    expect((caught as GitRefUpdateRejectedError).reason).toBe("fetch first");
  });

  it("throws on unpack failure, a missing ref report, and a malformed response", () => {
    expect(() => parseReceivePackResponse(
        report("unpack index-pack abnormal exit", "ng refs/heads/main unpacker error"),
        "refs/heads/main"))
      .toThrow(/unpack error: index-pack abnormal exit/);
    expect(() => parseReceivePackResponse(
        report("unpack ok", "ok refs/heads/other"), "refs/heads/main"))
      .toThrow(/did not mention refs\/heads\/main/);
    expect(() => parseReceivePackResponse(report(), "refs/heads/main"))
      .toThrow(/no unpack status/);
  });
});

describe("pushGitRefUpdate", () => {
  function okReport(ref: string): Uint8Array {
    return concatBytes([encodePktLine("unpack ok"), encodePktLine(`ok ${ref}`), FLUSH_PKT]);
  }

  function captureFetch(requests: Uint8Array[], response: Uint8Array) {
    return async (body: ReadableStream<Uint8Array>) => {
      requests.push(await collect(body));
      return new Response(response);
    };
  }

  it("sends the command block followed by the pack, and accepts an ok report", async () => {
    const requests: Uint8Array[] = [];
    const pack = new TextEncoder().encode("PACKBYTES");
    await pushGitRefUpdate(
        captureFetch(requests, okReport("refs/heads/main")),
        { branch: "main", oldSha: oid(1), newSha: oid(2) },
        streamOf([pack]));
    expect(requests).toHaveLength(1);
    const expectedHeader = buildRefUpdateRequest({ branch: "main", oldSha: oid(1), newSha: oid(2) });
    expect(requests[0]).toEqual(concatBytes([expectedHeader, pack]));
  });

  it("sends no pack with a deletion, and requires a pack for anything else", async () => {
    const requests: Uint8Array[] = [];
    await pushGitRefUpdate(
        captureFetch(requests, okReport("refs/heads/main")),
        { branch: "main", oldSha: oid(2), newSha: ZERO_OID }, null);
    expect(requests[0]).toEqual(
        buildRefUpdateRequest({ branch: "main", oldSha: oid(2), newSha: ZERO_OID }));

    await expect(pushGitRefUpdate(
        captureFetch([], okReport("refs/heads/main")),
        { branch: "main", oldSha: oid(1), newSha: oid(2) }, null))
      .rejects.toThrow(/requires a pack/);
    await expect(pushGitRefUpdate(
        captureFetch([], okReport("refs/heads/main")),
        { branch: "main", oldSha: oid(2), newSha: ZERO_OID }, streamOf([new Uint8Array(1)])))
      .rejects.toThrow(/must not send a pack/);
  });

  it("propagates a rejection and fails on a non-OK response", async () => {
    const ngReport = concatBytes([
      encodePktLine("unpack ok"),
      encodePktLine("ng refs/heads/main non-fast-forward"),
      FLUSH_PKT,
    ]);
    await expect(pushGitRefUpdate(
        captureFetch([], ngReport),
        { branch: "main", oldSha: oid(1), newSha: oid(2) }, streamOf([new Uint8Array(1)])))
      .rejects.toThrow(GitRefUpdateRejectedError);

    await expect(pushGitRefUpdate(
        async body => { await collect(body); return new Response("nope", { status: 502 }); },
        { branch: "main", oldSha: oid(1), newSha: oid(2) }, streamOf([new Uint8Array(1)])))
      .rejects.toThrow(/HTTP 502/);
  });
});
