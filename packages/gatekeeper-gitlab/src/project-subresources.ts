// The subresources GitLab reads report: the project a binding is pinned to, by the numeric id GitLab
// gives it (see PinnedProject), each of its project features a read returned data from, and what
// GitLab guards item by item: each CI job whose log or artifacts a read disclosed, each
// confidential issue, and each internal note. The id outlives a rename or a transfer and is never
// reused, so unlike a project's path, which a project created after a deletion or a move can take
// over, it always names the project the read was made in. An issue's iid and a note's id are never
// reused either. GitLab is one product, so the ID carries no namespace (see formatSubresourceId).
//
// `project/<id>` stands for the project itself -- its name, path, description and visibility --
// which an observer may see when GitLab shows them the project, member or not. Every read reports
// it. Beneath it, `project/<id>/feature/<feature>` stands for the data of one project feature, the
// switches GitLab's "Visibility, project features, permissions" settings hold and its API calls
// `<feature>_access_level`: an observer may see it when their own account can list that feature's
// data. A read reports only the features its data came from, so a feature the project has turned
// off, which nothing can be read from, never blocks anyone. An item is named, not the role it
// needs, because GitLab decides per item who may read it -- a confidential issue (its author,
// assignees and Planners up), an internal note (Planners up), a job's log (a debug trace needs
// Developer) or its artifacts (`artifacts:access`) -- and the observer's own account asks GitLab
// for that item, once it may see the project and the item's feature (see
// UserAccount.checkSubresourceAccess).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const PROJECT_FRAGMENT = "project";
const JOB_TRACE_FRAGMENT = "jobTrace";
const JOB_ARTIFACTS_FRAGMENT = "jobArtifacts";
const ISSUE_FRAGMENT = "issue";
const MERGE_REQUEST_FRAGMENT = "mergeRequest";
const NOTE_FRAGMENT = "note";
const FEATURE_FRAGMENT = "feature";
/**
 * Earlier releases named the role CI data needed, `project/<id>/role/developer` or
 * `.../role/maintainer`. Recorded IDs read as the project alone.
 */
const LEGACY_ROLE_FRAGMENT = "role";

/** The canonical decimal spelling of a GitLab id: no sign, no leading zero. */
const ID = /^[1-9][0-9]*$/;

/** What a job subresource names beneath its project: the job's log, or its artifacts. */
export type JobData = "trace" | "artifacts";

/** What a note belongs to: an issue or a merge request. */
export type Noteable = "issue" | "mergeRequest";

/**
 * The project features GitLab reads return data from, named for their API fields
 * (`repository_access_level`, `issues_access_level`, `merge_requests_access_level`,
 * `builds_access_level`, which the UI calls Repository, Work items, Merge requests and CI/CD).
 */
export type ProjectFeature = "repository" | "issues" | "mergeRequests" | "builds";

const PROJECT_FEATURES: Record<string, true> = { repository: true, issues: true, mergeRequests: true, builds: true } satisfies Record<ProjectFeature, true>;

/** What a project subresource names beneath its project, if anything. */
export type ProjectItem =
  | { kind: "feature"; feature: ProjectFeature }
  | { kind: "job"; data: JobData; jobId: number }
  | { kind: "issue"; iid: number }
  | { kind: "note"; noteable: Noteable; iid: number; noteId: number };

/** A parsed project subresource: the project, and the item beneath it it names, if any. */
export type ProjectSubresource = { projectId: number; item?: ProjectItem };

function checkId(id: number, what: string): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${id} is not a GitLab ${what} id.`);
  return String(id);
}

function projectFragment(projectId: number) {
  return { name: PROJECT_FRAGMENT, id: checkId(projectId, "project") };
}

/**
 * The subresource ID of the project with GitLab id `projectId` itself: `project/<projectId>`.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function projectSubresourceId(projectId: number): string {
  return formatSubresourceId({ fragments: [projectFragment(projectId)] });
}

/**
 * The subresource ID of project feature `feature`'s data: `project/<projectId>/feature/<feature>`.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function featureSubresourceId(projectId: number, feature: ProjectFeature): string {
  return formatSubresourceId({ fragments: [projectFragment(projectId), { name: FEATURE_FRAGMENT, id: feature }] });
}

/**
 * The subresource ID of job `jobId`'s log (`project/<projectId>/jobTrace/<jobId>`) or artifacts
 * (`project/<projectId>/jobArtifacts/<jobId>`), test reports included.
 * @throws Error when either id is not a positive safe integer.
 */
export function jobSubresourceId(projectId: number, data: JobData, jobId: number): string {
  return formatSubresourceId({
    fragments: [
      projectFragment(projectId),
      { name: data === "trace" ? JOB_TRACE_FRAGMENT : JOB_ARTIFACTS_FRAGMENT, id: checkId(jobId, "job") },
    ],
  });
}

/**
 * The subresource ID of confidential issue `iid`: `project/<projectId>/issue/<iid>`.
 * @throws Error when either id is not a positive safe integer.
 */
export function issueSubresourceId(projectId: number, iid: number): string {
  return formatSubresourceId({
    fragments: [projectFragment(projectId), { name: ISSUE_FRAGMENT, id: checkId(iid, "issue") }],
  });
}

/**
 * The subresource ID of internal note `noteId` on issue or merge request `iid`:
 * `project/<projectId>/issue/<iid>/note/<noteId>` or `project/<projectId>/mergeRequest/<iid>/note/<noteId>`.
 * @throws Error when any id is not a positive safe integer.
 */
export function noteSubresourceId(projectId: number, noteable: Noteable, iid: number, noteId: number): string {
  return formatSubresourceId({
    fragments: [
      projectFragment(projectId),
      { name: noteable === "issue" ? ISSUE_FRAGMENT : MERGE_REQUEST_FRAGMENT, id: checkId(iid, noteable) },
      { name: NOTE_FRAGMENT, id: checkId(noteId, "note") },
    ],
  });
}

function parseId(id: string): number | undefined {
  return ID.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : undefined;
}

function parseItem(fragments: { name: string; id: string }[]): ProjectItem | null | undefined {
  const [child, grandchild] = fragments;
  if (child === undefined) return undefined;
  if (grandchild === undefined && child.name === LEGACY_ROLE_FRAGMENT) {
    return child.id === "developer" || child.id === "maintainer" ? undefined : null;
  }
  if (grandchild === undefined && child.name === FEATURE_FRAGMENT) {
    return Object.hasOwn(PROJECT_FEATURES, child.id) ? { kind: "feature", feature: child.id as ProjectFeature } : null;
  }
  const id = parseId(child.id);
  if (id === undefined) return null;
  if (grandchild === undefined) {
    if (child.name === JOB_TRACE_FRAGMENT) return { kind: "job", data: "trace", jobId: id };
    if (child.name === JOB_ARTIFACTS_FRAGMENT) return { kind: "job", data: "artifacts", jobId: id };
    if (child.name === ISSUE_FRAGMENT) return { kind: "issue", iid: id };
    return null;
  }
  const noteId = parseId(grandchild.id);
  if (fragments.length !== 2 || grandchild.name !== NOTE_FRAGMENT || noteId === undefined) return null;
  if (child.name === ISSUE_FRAGMENT) return { kind: "note", noteable: "issue", iid: id, noteId };
  if (child.name === MERGE_REQUEST_FRAGMENT) return { kind: "note", noteable: "mergeRequest", iid: id, noteId };
  return null;
}

/**
 * What an ID this module makes names. A legacy `project/<id>/role/<role>` ID names the project alone.
 * @throws Error for any other ID, including one spelling an id another way.
 */
export function parseProjectSubresource(subresource: string): ProjectSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [project, ...rest] = fragments;
  const projectId = parseId(project.id);
  if (namespace === undefined && project.name === PROJECT_FRAGMENT && projectId !== undefined) {
    const item = parseItem(rest);
    if (item === undefined) return { projectId };
    if (item !== null) return { projectId, item };
  }
  throw new Error("Not a GitLab project subresource.");
}
