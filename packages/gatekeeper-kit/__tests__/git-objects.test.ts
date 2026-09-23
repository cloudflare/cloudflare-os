// Pure-logic coverage for git-objects.ts: commit-id validation, the advertising helpers and
// cursor wrapper, and raw commit-object parsing.

import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import {
  CommitAdvertisingCursor,
  advertiseCommits,
  commitDetailsFromGitObject,
  commitIdsOfSummary,
  isCommitOid,
  parseGitCommitPayload,
} from "../src/git-objects";

/** Deterministic fake full commit id. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

class RecordingAdvertiser {
  calls: string[] = [];

  async advertiseCommit(commitId: string): Promise<void> {
    this.calls.push(commitId);
  }
}

/** Cursor over pre-baked pages, tracking how many were fetched. */
class PagesCursor<T> implements Cursor<T> {
  #pages: T[][];
  #index = 0;

  constructor(pages: T[][]) {
    this.#pages = pages;
  }

  async next(): Promise<T[] | null> {
    if (this.#index >= this.#pages.length) return null;
    return this.#pages[this.#index++];
  }
}

describe("commitIdsOfSummary", () => {
  it("returns the commit id plus its parents", () => {
    expect(commitIdsOfSummary({ id: oid(1), parents: [oid(2), oid(3)] }))
      .toEqual([oid(1), oid(2), oid(3)]);
    expect(commitIdsOfSummary({ id: oid(1), parents: [] })).toEqual([oid(1)]);
  });
});

describe("isCommitOid", () => {
  it("accepts exactly full lowercase hex commit ids", () => {
    expect(isCommitOid(oid(1))).toBe(true);
    expect(isCommitOid("")).toBe(false);
    expect(isCommitOid("abc1234")).toBe(false); // truncated
    expect(isCommitOid("a".repeat(40))).toBe(true);
    expect(isCommitOid("A".repeat(40))).toBe(false); // uppercase
    expect(isCommitOid(`${oid(1)}0`)).toBe(false); // too long
    expect(isCommitOid("g".repeat(40))).toBe(false); // non-hex
  });
});

describe("advertiseCommits", () => {
  it("deduplicates and skips non-oid values", async () => {
    const advertiser = new RecordingAdvertiser();
    await advertiseCommits(advertiser, [oid(1), oid(2), oid(1), "", "pending"]);
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2)]);
  });

  it("skips and records ids in the alreadyAdvertised set", async () => {
    const advertiser = new RecordingAdvertiser();
    const seen = new Set([oid(1)]);
    await advertiseCommits(advertiser, [oid(1), oid(2)], seen);
    expect(advertiser.calls).toEqual([oid(2)]);
    expect(seen).toEqual(new Set([oid(1), oid(2)]));
  });
});

type Item = { id: string; parents: string[] };

function extract(item: Item): string[] {
  return [item.id, ...item.parents];
}

describe("CommitAdvertisingCursor", () => {
  it("advertises every commit id on each fetched page, and nothing from unfetched pages", async () => {
    const advertiser = new RecordingAdvertiser();
    const cursor = new CommitAdvertisingCursor<Item>(
      new PagesCursor([
        [{ id: oid(1), parents: [oid(2)] }],
        [{ id: oid(3), parents: [] }],
      ]),
      advertiser,
      extract,
    );

    const page1 = await cursor.next();
    expect(page1).toEqual([{ id: oid(1), parents: [oid(2)] }]);
    // Only the first page's ids so far: the second page was never fetched, so oid(3) must not
    // have been advertised.
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2)]);

    const page2 = await cursor.next();
    expect(page2).toEqual([{ id: oid(3), parents: [] }]);
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("advertises nothing for a page bearing no commit ids, and nothing at exhaustion", async () => {
    const advertiser = new RecordingAdvertiser();
    const cursor = new CommitAdvertisingCursor<Item>(
      new PagesCursor<Item>([[]]),
      advertiser,
      extract,
    );

    expect(await cursor.next()).toEqual([]);
    expect(await cursor.next()).toBeNull();
    expect(advertiser.calls).toEqual([]);
  });

  it("does not re-advertise ids already advertised by an earlier page", async () => {
    const advertiser = new RecordingAdvertiser();
    // Consecutive history pages overlap heavily: each commit's parent is usually the next
    // commit in the list.
    const cursor = new CommitAdvertisingCursor<Item>(
      new PagesCursor([
        [{ id: oid(1), parents: [oid(2)] }],
        [{ id: oid(2), parents: [oid(3)] }],
      ]),
      advertiser,
      extract,
    );

    await cursor.next();
    await cursor.next();
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("skips values that are not full commit ids", async () => {
    const advertiser = new RecordingAdvertiser();
    const cursor = new CommitAdvertisingCursor<Item>(
      new PagesCursor([[{ id: oid(1), parents: [""] }]]),
      advertiser,
      extract,
    );

    await cursor.next();
    expect(advertiser.calls).toEqual([oid(1)]);
  });
});

describe("parseGitCommitPayload", () => {
  function payload(lines: string[]): Uint8Array {
    return new TextEncoder().encode(lines.join("\n"));
  }

  it("parses tree, parents, identities, and the message", () => {
    const parsed = parseGitCommitPayload(payload([
      `tree ${oid(9)}`,
      `parent ${oid(1)}`,
      `parent ${oid(2)}`,
      "author Ada Lovelace <ada@example.com> 1700000000 +0130",
      "committer Charles Babbage <charles@example.com> 1700000100 -0500",
      "",
      "Add the engine",
      "",
      "With details.",
    ]), oid(7));
    expect(parsed.tree).toBe(oid(9));
    expect(parsed.parents).toEqual([oid(1), oid(2)]);
    expect(parsed.author).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      date: new Date(1700000000 * 1000),
    });
    expect(parsed.committer.name).toBe("Charles Babbage");
    expect(parsed.message).toBe("Add the engine\n\nWith details.");
  });

  it("tolerates unknown and multi-line headers (gpgsig continuation lines)", () => {
    const parsed = parseGitCommitPayload(payload([
      `tree ${oid(9)}`,
      "author A <a@example.com> 1700000000 +0000",
      "committer A <a@example.com> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " lineone",
      " -----END PGP SIGNATURE-----",
      "",
      "signed commit",
    ]), oid(7));
    expect(parsed.parents).toEqual([]);
    expect(parsed.message).toBe("signed commit");
  });

  it("is best-effort on partial or malformed identities rather than failing the read", () => {
    const parsed = parseGitCommitPayload(payload([
      `tree ${oid(9)}`,
      "author <ada@example.com>",
      "committer garbage",
      "",
      "m",
    ]), oid(7));
    expect(parsed.author).toEqual({ email: "ada@example.com" });
    expect(parsed.committer).toEqual({});
  });

  it("rejects payloads that are not well-formed commits", () => {
    expect(() => parseGitCommitPayload(payload(["not a commit"]), oid(7)))
      .toThrow(/not a well-formed commit/);
    expect(() => parseGitCommitPayload(payload([`parent ${oid(1)}`, "", "no tree"]), oid(7)))
      .toThrow(/not a well-formed commit/);
    expect(() => parseGitCommitPayload(payload([`tree ${oid(9)}`, "parent nope", "", "m"]), oid(7)))
      .toThrow(/not a well-formed commit/);
  });
});

describe("commitDetailsFromGitObject", () => {
  it("synthesizes the provider-neutral details shape from exact bytes", () => {
    const bytes = new TextEncoder().encode([
      `tree ${oid(9)}`,
      `parent ${oid(1)}`,
      "author Ada Lovelace <ada@example.com> 1700000000 +0000",
      "committer Ada Lovelace <ada@example.com> 1700000100 +0000",
      "",
      "feat: pending work",
      "",
    ].join("\n"));
    const details = commitDetailsFromGitObject(
      oid(7), bytes, id => `https://gitlab.example.com/acme/widgets/-/commit/${id}`);
    expect(details).toEqual({
      id: oid(7),
      message: "feat: pending work",
      author: { name: "Ada Lovelace", email: "ada@example.com", date: new Date(1700000000000) },
      committer: { name: "Ada Lovelace", email: "ada@example.com", date: new Date(1700000100000) },
      parents: [oid(1)],
      url: `https://gitlab.example.com/acme/widgets/-/commit/${oid(7)}`,
    });
  });
});
