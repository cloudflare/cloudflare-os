// The subresources GitLab reads report: the project a binding is pinned to, by the numeric id GitLab
// gives it (see PinnedProject), alone or with the role on it that a read's data needs beyond project
// membership. The id outlives a rename or a transfer and is never reused, so unlike a project's
// path, which a project created after a deletion or a move can take over, it always names the
// project the read was made in. GitLab is one product, so the ID carries no namespace (see
// formatSubresourceId).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { DEVELOPER_ACCESS_LEVEL, MAINTAINER_ACCESS_LEVEL } from "./gitlab-env";

const PROJECT_FRAGMENT = "project";
const ROLE_FRAGMENT = "role";

/** The roles a read's data can need beyond project membership, with GitLab's access level for each. */
const ROLE_ACCESS_LEVELS = {
  developer: DEVELOPER_ACCESS_LEVEL,
  maintainer: MAINTAINER_ACCESS_LEVEL,
} as const;

/** A role a read's data needs on the project, beyond the membership every read needs. */
export type ProjectRole = keyof typeof ROLE_ACCESS_LEVELS;

/** The canonical decimal spelling of a project id: no sign, no leading zero. */
const PROJECT_ID = /^[1-9][0-9]*$/;

/**
 * The subresource ID of the project with GitLab id `projectId`: `project/<projectId>`, or with
 * `role`, `project/<projectId>/role/<role>`, for data GitLab shows only to members holding it.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function projectSubresourceId(projectId: number, role?: ProjectRole): string {
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error(`${projectId} is not a GitLab project id.`);
  }
  const project = { name: PROJECT_FRAGMENT, id: String(projectId) };
  return formatSubresourceId({
    fragments: role === undefined ? [project] : [project, { name: ROLE_FRAGMENT, id: role }],
  });
}

/**
 * The project a {@link projectSubresourceId} ID names, and the access level it needs there: the
 * named role's, or none beyond membership (`undefined`).
 * @throws Error for any other ID, including one spelling the id another way.
 */
export function parseProjectSubresource(subresource: string): { projectId: number; minAccessLevel?: number } {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [project, role] = fragments;
  if (namespace === undefined && fragments.length <= 2 && project.name === PROJECT_FRAGMENT
      && PROJECT_ID.test(project.id) && Number.isSafeInteger(Number(project.id))) {
    const projectId = Number(project.id);
    if (role === undefined) return { projectId };
    if (role.name === ROLE_FRAGMENT && Object.hasOwn(ROLE_ACCESS_LEVELS, role.id)) {
      return { projectId, minAccessLevel: ROLE_ACCESS_LEVELS[role.id as ProjectRole] };
    }
  }
  throw new Error("Not a GitLab project subresource.");
}
