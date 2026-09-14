// Pure normalization: resource-URL parsing (the `/-/` separator, nested namespaces), the
// `diff_refs` inversion, `changes_count` parsing, draft prefixes, diff-file status and counts,
// diff-position targets, and label shapes.

import { describe, expect, it } from "vitest";
import * as fx from "./fixtures/gitlab-docs";
import {
  branchNameMatchesSearch,
  commentTargetFromPosition,
  diffAnchor,
  hasDraftPrefix,
  issuableComparator,
  labelFromResponse,
  normalizeDiffFile,
  normalizeIssueSummary,
  normalizeMergeRequestSummary,
  normalizeTagSummary,
  parseChangesCount,
  parsePatch,
  parseResourceUrl,
  projectRef,
  revisionFromDiffRefs,
  withDraftPrefix,
} from "../src/gitlab-normalize";

const INSTANCE = "https://gitlab.example.com";

describe("parseResourceUrl", () => {
  it("parses a nested project path and its issue or merge request", () => {
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/sub/project`))
      .toEqual({ projectPath: "group/sub/project", kind: "project" });
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/sub/project/`))
      .toEqual({ projectPath: "group/sub/project", kind: "project" });
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/sub/project.git`))
      .toEqual({ projectPath: "group/sub/project", kind: "project" });
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/sub/project/-/issues/42`))
      .toEqual({ projectPath: "group/sub/project", kind: "issue", iid: 42 });
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/sub/project/-/merge_requests/7/diffs?x=1#note_3`))
      .toEqual({ projectPath: "group/sub/project", kind: "mergeRequest", iid: 7 });
    // Something else under /-/ is still the project.
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/project/-/tree/main/src`))
      .toEqual({ projectPath: "group/project", kind: "project" });
  });

  it("rejects other origins, too-short paths, and garbage", () => {
    expect(parseResourceUrl(INSTANCE, "https://gitlab.com/group/project")).toBeNull();
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/user`)).toBeNull();
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/`)).toBeNull();
    expect(parseResourceUrl(INSTANCE, "not a url")).toBeNull();
  });

  it("refuses an issue or merge request route with a malformed number rather than reading it as the project", () => {
    // The URL asked for one item; a project-wide capability is not what it asked for.
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/project/-/issues/abc`)).toBeNull();
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/project/-/merge_requests/7x/diffs`)).toBeNull();
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/project/-/issues/new`)).toBeNull();
    // The list pages name no item, so they are the project, like any other /-/ route.
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/project/-/issues`)).toEqual({ projectPath: "group/project", kind: "project" });
    expect(parseResourceUrl(INSTANCE, `${INSTANCE}/group/project/-/merge_requests?state=opened`))
      .toEqual({ projectPath: "group/project", kind: "project" });
  });

  it("round-trips with projectRef", () => {
    const ref = projectRef(INSTANCE, "group/sub/project");
    expect(ref).toEqual({ path: "group/sub/project", name: "project", namespace: "group/sub", url: `${INSTANCE}/group/sub/project` });
    expect(parseResourceUrl(INSTANCE, ref.url)?.projectPath).toBe(ref.path);
  });
});

describe("revisionFromDiffRefs", () => {
  it("maps start_sha to baseSha and base_sha to mergeBaseSha -- GitLab's names are inverted", () => {
    const refs = { base_sha: "merge-base", start_sha: "target-head", head_sha: "source-head" };
    expect(revisionFromDiffRefs(refs)).toEqual({ baseSha: "target-head", headSha: "source-head", mergeBaseSha: "merge-base" });
    // The documented fixture happens to have base_sha === start_sha (the target had not moved).
    const fromDocs = revisionFromDiffRefs(fx.mergeRequestResponse.data.diff_refs);
    expect(fromDocs.mergeBaseSha).toBe(fx.mergeRequestResponse.data.diff_refs.base_sha);
    expect(fromDocs.headSha).toBe(fx.mergeRequestResponse.data.sha);
  });
});

describe("parseChangesCount", () => {
  it("reads the documented string forms", () => {
    expect(parseChangesCount("12")).toEqual({ changedFiles: 12 });
    expect(parseChangesCount("1000+")).toEqual({ changedFiles: 1000, changedFilesTruncated: true });
    expect(parseChangesCount(null)).toEqual({});
    expect(parseChangesCount("")).toEqual({});
    expect(parseChangesCount("many")).toEqual({});
  });
});

describe("draft prefixes", () => {
  it("recognises GitLab's three prefixes and never double-prefixes", () => {
    expect(hasDraftPrefix("Draft: x")).toBe(true);
    expect(hasDraftPrefix("[Draft] x")).toBe(true);
    expect(hasDraftPrefix("(draft) x")).toBe(true);
    expect(hasDraftPrefix("Drafting x")).toBe(false);
    expect(withDraftPrefix("Fix it")).toBe("Draft: Fix it");
    expect(withDraftPrefix("Draft: Fix it")).toBe("Draft: Fix it");
  });
});

describe("normalizeDiffFile", () => {
  it("derives status from the flags and counts lines from the patch", () => {
    const [readme] = fx.mergeRequestDiffsResponse.data;
    expect(normalizeDiffFile(readme)).toMatchObject({ path: "README", status: "modified", additions: 1, deletions: 1 });
    expect(normalizeDiffFile({ ...readme, new_file: true })).toMatchObject({ status: "added" });
    expect(normalizeDiffFile({ ...readme, deleted_file: true })).toMatchObject({ status: "removed" });
    expect(normalizeDiffFile({ ...readme, renamed_file: true, old_path: "OLD" }))
      .toMatchObject({ status: "renamed", path: "README", previousPath: "OLD" });
  });

  it("marks binary, too_large, and collapsed diffs as omitted", () => {
    const [readme] = fx.mergeRequestDiffsResponse.data;
    expect(normalizeDiffFile({ ...readme, diff: "" })).toMatchObject({ diffOmitted: true, hunks: [], additions: 0 });
    expect(normalizeDiffFile({ ...readme, too_large: true })).toMatchObject({ diffOmitted: true, hunks: [] });
    expect(normalizeDiffFile({ ...readme, collapsed: true })).toMatchObject({ diffOmitted: true });
    expect(normalizeDiffFile(readme)).not.toHaveProperty("diffOmitted");
  });

  it("numbers lines on both sides through parsePatch", () => {
    const hunks = parsePatch(fx.compareResponse.data.diffs[0].diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -24,8 +24,10 @@");
    const removed = hunks[0].lines.filter(l => l.kind === "removed");
    expect(removed.map(l => l.oldLineNumber)).toEqual([27, 28]);
    const added = hunks[0].lines.filter(l => l.kind === "added");
    expect(added.map(l => l.newLineNumber)).toEqual([30, 31, 32, 33]);
  });
});

describe("commentTargetFromPosition", () => {
  it("takes both ends of a multi-line comment from line_range, not the top-level line the note was left on", () => {
    // GitLab's own example: a 10-11 range (new 10 to old 11) under top-level old/new line 27.
    const target = commentTargetFromPosition(fx.diffDiscussionResponse.data.notes[0].position);
    expect(target).toEqual({ path: "package.json", subjectType: "line", line: 11, side: "old", startLine: 10, startSide: "new" });
  });

  it("reads a single-line comment from the top-level pair, and a range that names one line as one", () => {
    const base = fx.diffDiscussionResponse.data.notes[0].position;
    expect(commentTargetFromPosition({ ...base, line_range: null })).toEqual({ path: "package.json", subjectType: "line", line: 27, side: "new" });
    const one = { line_code: "x_3_3", type: "new" as const, old_line: null, new_line: 3 };
    expect(commentTargetFromPosition({ ...base, line_range: { start: one, end: one } }))
      .toEqual({ path: "package.json", subjectType: "line", line: 3, side: "new" });
  });

  it("picks the old side when only old_line is set, and file targets for position_type file", () => {
    const base = fx.diffDiscussionResponse.data.notes[0].position;
    expect(commentTargetFromPosition({ ...base, new_line: null, old_line: 5, line_range: null }))
      .toEqual({ path: "package.json", subjectType: "line", line: 5, side: "old" });
    expect(commentTargetFromPosition({ ...base, position_type: "file" })).toEqual({ path: "package.json", subjectType: "file" });
  });
});

describe("labels, tags, merge request summary", () => {
  it("accepts label names and label objects", () => {
    expect(labelFromResponse("bug")).toEqual({ name: "bug" });
    expect(labelFromResponse(fx.labelDetailsResponse.data)).toEqual({ name: "bug", color: "#d9534f", description: "Bug reported by user" });
  });

  it("uses commit.id for tags (target is the tag object for annotated tags)", () => {
    expect(normalizeTagSummary({ ...fx.tagResponse.data, target: "tagobject" })).toEqual({ name: "v1.0.0", commit: fx.tagResponse.data.commit.id });
  });

  it("builds source/target refs and marks a fork's source project", () => {
    const mr = fx.mergeRequestResponse.data;
    const fork = projectRef(INSTANCE, "someone/fork");
    const summary = normalizeMergeRequestSummary(INSTANCE, "group/project", mr, fork);
    expect(summary.source).toEqual({ branch: "manual-job-rules", sha: mr.sha, project: fork });
    expect(summary.target.project.path).toBe("group/project");
    expect(summary.url).toBe(`${INSTANCE}/group/project/-/merge_requests/133`);
    expect(summary.state).toBe("opened");
  });

  it("carries an issue's upvotes, the key a popularity listing is ordered by", () => {
    expect(normalizeIssueSummary(INSTANCE, "group/project", fx.issueResponse.data).upvotes).toBe(4);
  });
});

describe("issuableComparator", () => {
  const row = (id: string, upvotes: number, createdAt: string) =>
    ({ id, upvotes, createdAt: new Date(createdAt), updatedAt: new Date(createdAt) });
  const older = row("9", 0, "2024-01-01T00:00:00Z");
  const newer = row("10", 0, "2024-06-01T00:00:00Z");
  const voted = row("3", 12, "2023-01-01T00:00:00Z");
  const provisional = row("~1", 0, "2025-01-01T00:00:00Z");

  it("orders a popularity listing by upvotes, not creation, so a fresh zero-vote row sorts among the other zero-vote rows", () => {
    // Descending by default: the voted issue leads however old it is; the provisional one does not.
    expect([older, provisional, voted, newer].toSorted(issuableComparator("popularity", undefined)).map(r => r.id))
      .toEqual(["3", "10", "9", "~1"]);
    expect([voted, older].toSorted(issuableComparator("popularity", "asc")).map(r => r.id)).toEqual(["9", "3"]);
  });

  it("breaks ties by id descending whatever the direction, as GitLab's listings do", () => {
    // Numeric, not textual: 10 before 9.
    expect([older, newer].toSorted(issuableComparator("popularity", "desc")).map(r => r.id)).toEqual(["10", "9"]);
    expect([older, newer].toSorted(issuableComparator("popularity", "asc")).map(r => r.id)).toEqual(["10", "9"]);
    expect([newer, older].toSorted(issuableComparator("created", "asc")).map(r => r.id)).toEqual(["9", "10"]);
    expect([older, newer].toSorted(issuableComparator("created", undefined)).map(r => r.id)).toEqual(["10", "9"]);
  });
});

describe("branchNameMatchesSearch", () => {
  it("matches a plain term anywhere in the name, ignoring case", () => {
    expect(branchNameMatchesSearch("hotfix-release", "release")).toBe(true);
    expect(branchNameMatchesSearch("Release-1", "release")).toBe(true);
    expect(branchNameMatchesSearch("main", "release")).toBe(false);
  });

  it("anchors ^term to the start and term$ to the end, as GitLab does", () => {
    expect(branchNameMatchesSearch("release-1", "^release")).toBe(true);
    expect(branchNameMatchesSearch("hotfix-release", "^release")).toBe(false);
    expect(branchNameMatchesSearch("hotfix-release", "release$")).toBe(true);
    expect(branchNameMatchesSearch("release-next", "release$")).toBe(false);
    expect(branchNameMatchesSearch("release", "^release$")).toBe(true);
    expect(branchNameMatchesSearch("release-1", "^release$")).toBe(false);
  });

  it("treats * as a wildcard and everything else literally", () => {
    expect(branchNameMatchesSearch("release/1.2", "release/1.*")).toBe(true);
    expect(branchNameMatchesSearch("release/12", "release/1.*")).toBe(false);
    expect(branchNameMatchesSearch("feature-(x)", "^feature-(x)")).toBe(true);
  });
});

describe("diffAnchor", () => {
  it("classifies a discussion by its root note, so a reply without a position stays with its diff thread", () => {
    const root = fx.diffDiscussionResponse.data.notes[0];
    const reply = { ...fx.issueNotesResponse.data[1], id: 1129, type: "DiscussionNote" as const, position: undefined };
    expect(diffAnchor({ id: "d", individual_note: false, notes: [root, reply] })).toBe(root.position);
    expect(diffAnchor({ id: "p", individual_note: false, notes: [reply] })).toBeNull();
    expect(diffAnchor({ id: "e", individual_note: false, notes: [] })).toBeNull();
  });
});
