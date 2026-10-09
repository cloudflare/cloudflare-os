// GitHub-specific coverage for git-commits.ts: REST response normalization and the GitHub
// wrapper over the kit's raw-commit synthesis. The provider-neutral helpers (commit-id
// validation, advertising, raw commit parsing) are covered by the kit's git-objects.test.ts.

import { describe, expect, it } from "vitest";
import {
  commitDetailsFromGitObject,
  commitIdsOfPullSummary,
  normalizeBranchSummary,
  normalizeCommitDetails,
  normalizeCommitSummary,
  normalizeTagSummary,
} from "../src/git-commits";
import type { GitHubCommitResponse } from "../src/github-api";

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

describe("commitIdsOfPullSummary", () => {
  it("returns the head and base shas, including empty provisional ones for the caller to skip", () => {
    expect(commitIdsOfPullSummary({ head: { sha: oid(1) }, base: { sha: oid(2) } }))
      .toEqual([oid(1), oid(2)]);
    expect(commitIdsOfPullSummary({ head: { sha: "" }, base: { sha: oid(2) } }))
      .toEqual(["", oid(2)]);
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
