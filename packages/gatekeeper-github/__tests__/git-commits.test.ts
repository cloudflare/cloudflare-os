import { describe, expect, it } from "vitest";
import {
  CommitAdvertisingCursor,
  advertiseCommits,
  commitDetailsFromGitObject,
  commitIdsOfSummary,
  isCommitOid,
  normalizeBranchSummary,
  normalizeCommitDetails,
  normalizeCommitSummary,
  normalizeTagSummary,
  parseGitCommitPayload,
} from "../src/git-commits";
import type { GitHubCommitResponse } from "../src/github-api";
import type { Cursor } from "../src/types";

/** Deterministic fake full commit id. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function commitResponse(overrides: Partial<GitHubCommitResponse> = {}): GitHubCommitResponse {
  return {
    sha: oid(1),
    html_url: `https://github.com/cloudflare/workerd/commit/${oid(1)}`,
    commit: {
      message: "Fix the frobnicator\n\nLonger explanation.",
      author: { name: "Alice", email: "alice@example.com", date: "2026-08-01T12:00:00Z" },
      committer: { name: "Bob", email: "bob@example.com", date: "2026-08-02T12:00:00Z" },
    },
    author: {
      login: "alice",
      name: "Alice",
      html_url: "https://github.com/alice",
      avatar_url: "https://avatars.example.com/alice",
    },
    parents: [{ sha: oid(2) }, { sha: oid(3) }],
    ...overrides,
  };
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

describe("normalizeCommitSummary", () => {
  it("maps a full commit response", () => {
    const summary = normalizeCommitSummary(commitResponse());
    expect(summary).toEqual({
      id: oid(1),
      message: "Fix the frobnicator\n\nLonger explanation.",
      author: { name: "Alice", email: "alice@example.com", date: new Date("2026-08-01T12:00:00Z") },
      committer: { name: "Bob", email: "bob@example.com", date: new Date("2026-08-02T12:00:00Z") },
      authorAccount: {
        login: "alice",
        displayName: "Alice",
        url: "https://github.com/alice",
        avatarUrl: "https://avatars.example.com/alice",
      },
      parents: [oid(2), oid(3)],
      url: `https://github.com/cloudflare/workerd/commit/${oid(1)}`,
    });
  });

  it("tolerates missing identities and accounts", () => {
    const summary = normalizeCommitSummary(commitResponse({
      commit: { message: "Initial commit", author: null },
      author: null,
      parents: [],
    }));
    expect(summary.author).toEqual({ name: undefined, email: undefined, date: undefined });
    expect(summary.committer).toEqual({ name: undefined, email: undefined, date: undefined });
    expect(summary.authorAccount).toBeNull();
    expect(summary.parents).toEqual([]);
  });
});

describe("normalizeCommitDetails", () => {
  it("includes stats when present and omits them otherwise", () => {
    const withStats = normalizeCommitDetails(commitResponse({
      stats: { additions: 10, deletions: 2, total: 12 },
    }));
    expect(withStats.stats).toEqual({ additions: 10, deletions: 2, total: 12 });

    const withoutStats = normalizeCommitDetails(commitResponse());
    expect(withoutStats.stats).toBeUndefined();
  });
});

describe("branch and tag normalization", () => {
  it("maps branches, defaulting protection to false", () => {
    expect(normalizeBranchSummary({ name: "main", commit: { sha: oid(7) }, protected: true }))
      .toEqual({ name: "main", headCommit: oid(7), protected: true });
    expect(normalizeBranchSummary({ name: "dev", commit: { sha: oid(8) } }))
      .toEqual({ name: "dev", headCommit: oid(8), protected: false });
  });

  it("maps tags", () => {
    expect(normalizeTagSummary({ name: "v1.0.0", commit: { sha: oid(9) } }))
      .toEqual({ name: "v1.0.0", commit: oid(9) });
  });
});

describe("commitIdsOfSummary", () => {
  it("returns the commit id plus its parents", () => {
    const summary = normalizeCommitSummary(commitResponse());
    expect(commitIdsOfSummary(summary)).toEqual([oid(1), oid(2), oid(3)]);
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
  it("synthesizes the details shape from exact bytes, omitting GitHub-only fields", () => {
    const bytes = new TextEncoder().encode([
      `tree ${oid(9)}`,
      `parent ${oid(1)}`,
      "author Ada Lovelace <ada@example.com> 1700000000 +0000",
      "committer Ada Lovelace <ada@example.com> 1700000100 +0000",
      "",
      "feat: pending work",
      "",
    ].join("\n"));
    const details = commitDetailsFromGitObject(oid(7), bytes, "https://github.com/acme/widgets");
    expect(details).toEqual({
      id: oid(7),
      message: "feat: pending work",
      author: { name: "Ada Lovelace", email: "ada@example.com", date: new Date(1700000000000) },
      committer: { name: "Ada Lovelace", email: "ada@example.com", date: new Date(1700000100000) },
      authorAccount: null,
      parents: [oid(1)],
      url: `https://github.com/acme/widgets/commit/${oid(7)}`,
    });
  });
});
