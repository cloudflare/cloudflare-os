// Pure-logic coverage for git-objects.ts: commit-id validation, the advertising helpers and
// page hook, and raw commit-object parsing.

import { describe, expect, it } from "vitest";
import {
  advertiseCommits,
  advertisePages,
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
  #failures = new Set<string>();

  /** Make the next advertisement of `commitId` fail. */
  failOnce(commitId: string): void {
    this.#failures.add(commitId);
  }

  async advertiseCommit(commitId: string): Promise<void> {
    if (this.#failures.delete(commitId)) throw new Error(`advertising ${commitId} failed`);
    this.calls.push(commitId);
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

  it("skips the ids `withhold` names", async () => {
    const advertiser = new RecordingAdvertiser();
    await advertiseCommits(advertiser, [oid(1), oid(2)], { withhold: id => id === oid(1) });
    expect(advertiser.calls).toEqual([oid(2)]);
  });
});

type Item = { id: string; parents: string[] };

function extract(item: Item): string[] {
  return [item.id, ...item.parents];
}

describe("advertisePages", () => {
  it("advertises every commit id on the pages it is given", async () => {
    const advertiser = new RecordingAdvertiser();
    const beforePage = advertisePages<Item>(advertiser, extract);

    await beforePage([{ id: oid(1), parents: [oid(2)] }]);
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2)]);
    await beforePage([{ id: oid(3), parents: [] }]);
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("advertises nothing for a page bearing no commit ids", async () => {
    const advertiser = new RecordingAdvertiser();
    await advertisePages<Item>(advertiser, extract)([]);
    expect(advertiser.calls).toEqual([]);
  });

  it("does not re-advertise ids an earlier page advertised", async () => {
    const advertiser = new RecordingAdvertiser();
    const beforePage = advertisePages<Item>(advertiser, extract);
    // Consecutive history pages overlap heavily: each commit's parent is usually the next
    // commit in the list.
    await beforePage([{ id: oid(1), parents: [oid(2)] }]);
    await beforePage([{ id: oid(2), parents: [oid(3)] }]);
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2), oid(3)]);
  });

  it("skips values that are not full commit ids, and ids `withhold` names", async () => {
    const advertiser = new RecordingAdvertiser();
    const withheld = new Set([oid(2)]);
    const beforePage = advertisePages<Item>(advertiser, extract, { withhold: id => withheld.has(id) });

    await beforePage([{ id: oid(1), parents: ["", oid(2)] }]);
    expect(advertiser.calls).toEqual([oid(1)]);
    // Consulted per page: an id no longer withheld advertises when a later page carries it.
    withheld.clear();
    await beforePage([{ id: oid(2), parents: [] }]);
    expect(advertiser.calls).toEqual([oid(1), oid(2)]);
  });

  it("advertises a failed page's ids in full when it is offered again", async () => {
    const advertiser = new RecordingAdvertiser();
    const beforePage = advertisePages<Item>(advertiser, extract);
    const page = [{ id: oid(1), parents: [oid(2)] }];
    advertiser.failOnce(oid(2));

    await expect(beforePage(page)).rejects.toThrow(/advertising/);
    // The id whose advertisement failed is not remembered as advertised, so the retry sends it.
    await beforePage(page);
    expect(advertiser.calls.toSorted()).toEqual([oid(1), oid(2)]);
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
