// The subresources GitLab reads report: the project a binding is pinned to, by the numeric id GitLab
// gives it (see PinnedProject), and, beneath it, each CI job whose log or artifacts a read disclosed.
// The id outlives a rename or a transfer and is never reused, so unlike a project's path, which a
// project created after a deletion or a move can take over, it always names the project the read was
// made in. GitLab is one product, so the ID carries no namespace (see formatSubresourceId).
//
// A job is named, not the role it needs, because GitLab decides per job who may read its log (a
// debug trace needs Developer) or its artifacts (`artifacts:access`), and the reading account
// cannot see either setting; the observer's own account asks GitLab instead (see
// UserAccount.checkSubresourceAccess).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const PROJECT_FRAGMENT = "project";
const JOB_TRACE_FRAGMENT = "jobTrace";
const JOB_ARTIFACTS_FRAGMENT = "jobArtifacts";
/**
 * Earlier releases named the role CI data needed, `project/<id>/role/developer` or
 * `.../role/maintainer`. Recorded IDs read as the project alone.
 */
const LEGACY_ROLE_FRAGMENT = "role";

/** The canonical decimal spelling of a GitLab id: no sign, no leading zero. */
const ID = /^[1-9][0-9]*$/;

/** What a job subresource names beneath its project: the job's log, or its artifacts. */
export type JobData = "trace" | "artifacts";

/** A parsed project subresource: the project, and the job data it names, if any. */
export type ProjectSubresource = { projectId: number; job?: { data: JobData; jobId: number } };

function checkId(id: number, what: string): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${id} is not a GitLab ${what} id.`);
  return String(id);
}

/**
 * The subresource ID of the project with GitLab id `projectId`: `project/<projectId>`.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function projectSubresourceId(projectId: number): string {
  return formatSubresourceId({ fragments: [{ name: PROJECT_FRAGMENT, id: checkId(projectId, "project") }] });
}

/**
 * The subresource ID of job `jobId`'s log (`project/<projectId>/jobTrace/<jobId>`) or artifacts
 * (`project/<projectId>/jobArtifacts/<jobId>`), test reports included.
 * @throws Error when either id is not a positive safe integer.
 */
export function jobSubresourceId(projectId: number, data: JobData, jobId: number): string {
  return formatSubresourceId({
    fragments: [
      { name: PROJECT_FRAGMENT, id: checkId(projectId, "project") },
      { name: data === "trace" ? JOB_TRACE_FRAGMENT : JOB_ARTIFACTS_FRAGMENT, id: checkId(jobId, "job") },
    ],
  });
}

function parseId(id: string): number | undefined {
  return ID.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : undefined;
}

/**
 * What a {@link projectSubresourceId} or {@link jobSubresourceId} ID names. A legacy
 * `project/<id>/role/<role>` ID names the project alone.
 * @throws Error for any other ID, including one spelling an id another way.
 */
export function parseProjectSubresource(subresource: string): ProjectSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [project, child] = fragments;
  const projectId = parseId(project.id);
  if (namespace === undefined && fragments.length <= 2 && project.name === PROJECT_FRAGMENT && projectId !== undefined) {
    if (child === undefined) return { projectId };
    if (child.name === LEGACY_ROLE_FRAGMENT && (child.id === "developer" || child.id === "maintainer")) {
      return { projectId };
    }
    const jobId = parseId(child.id);
    if (jobId !== undefined && child.name === JOB_TRACE_FRAGMENT) return { projectId, job: { data: "trace", jobId } };
    if (jobId !== undefined && child.name === JOB_ARTIFACTS_FRAGMENT) return { projectId, job: { data: "artifacts", jobId } };
  }
  throw new Error("Not a GitLab project subresource.");
}
