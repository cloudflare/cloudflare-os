// The subresources GitLab reads report, each naming what an observer's own account must be able to
// read (see the verifier in gitlab.ts):
//
// - `project/<id>`: the project a binding is pinned to (see PinnedProject), alone or with the role
//   on it (`project/<id>/role/<role>`) that a read's data needs beyond project membership.
// - `repository/<id>`: the project's repository (code) alone: what code-only reads report, which
//   any account GitLab lets download the code may see, member or not.
// - `instance/<host>`: the GitLab instance itself, for what an instance-wide search reveals beyond
//   the repositories on its page: that a term is absent, or that no project has a path.
//
// A project's numeric id outlives a rename or a transfer and is never reused, so unlike a project's
// path, which a project created after a deletion or a move can take over, it always names the
// project the read was made in. GitLab is one product, so the IDs carry no namespace (see
// formatSubresourceId).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { DEVELOPER_ACCESS_LEVEL, MAINTAINER_ACCESS_LEVEL } from "./gitlab-env";

const PROJECT_FRAGMENT = "project";
const ROLE_FRAGMENT = "role";
const REPOSITORY_FRAGMENT = "repository";
const INSTANCE_FRAGMENT = "instance";

/** The roles a read's data can need beyond project membership, with GitLab's access level for each. */
const ROLE_ACCESS_LEVELS = {
  developer: DEVELOPER_ACCESS_LEVEL,
  maintainer: MAINTAINER_ACCESS_LEVEL,
} as const;

/** A role a read's data needs on the project, beyond the membership every read needs. */
export type ProjectRole = keyof typeof ROLE_ACCESS_LEVELS;

/** The canonical decimal spelling of a project id: no sign, no leading zero. */
const PROJECT_ID = /^[1-9][0-9]*$/;

/** @throws Error when `projectId` is not a positive safe integer. */
function requireProjectId(projectId: number): string {
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error(`${projectId} is not a GitLab project id.`);
  }
  return String(projectId);
}

/** The project id `id` spells canonically, or undefined for any other spelling or an unsafe one. */
function parseProjectId(id: string): number | undefined {
  return PROJECT_ID.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : undefined;
}

/** Whether `host` is a host as `URL.host` spells it: lowercase, with a port only when not the default. */
function isCanonicalHost(host: string): boolean {
  return URL.parse(`https://${host}`)?.host === host && host !== "";
}

/**
 * The subresource ID of the project with GitLab id `projectId`: `project/<projectId>`, or with
 * `role`, `project/<projectId>/role/<role>`, for data GitLab shows only to members holding it.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function projectSubresourceId(projectId: number, role?: ProjectRole): string {
  const project = { name: PROJECT_FRAGMENT, id: requireProjectId(projectId) };
  return formatSubresourceId({
    fragments: role === undefined ? [project] : [project, { name: ROLE_FRAGMENT, id: role }],
  });
}

/**
 * The subresource ID of the repository of the project with GitLab id `projectId`:
 * `repository/<projectId>`, which an observer passes when GitLab lets their account download the
 * project's code.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function repositorySubresourceId(projectId: number): string {
  return formatSubresourceId({ fragments: [{ name: REPOSITORY_FRAGMENT, id: requireProjectId(projectId) }] });
}

/**
 * What a read of the metadata of the project with GitLab id `projectId` reports: its repository,
 * like any code-only read, unless the project's repository feature is disabled
 * (`repositoryAccessLevel`, REST's `repository_access_level`, is `"disabled"`). GitLab then lets
 * nobody download the code, so the repository would refuse every collaborator; the metadata is
 * still the project's, so it reports the project, which members pass. A level GitLab did not
 * send reports the repository.
 * @throws Error when `projectId` is not a positive safe integer.
 */
export function metadataSubresourceId(projectId: number, repositoryAccessLevel: string | undefined): string {
  return repositoryAccessLevel === "disabled" ? projectSubresourceId(projectId) : repositorySubresourceId(projectId);
}

/**
 * The subresource ID of the GitLab instance at `host` (`URL.host` of the configured `GITLAB_URL`,
 * port included when not the default): `instance/<host>`, which an observer passes when their
 * account is an active, non-external user of that instance.
 * @throws Error when `host` is not a host as `URL.host` spells it.
 */
export function instanceSubresourceId(host: string): string {
  if (!isCanonicalHost(host)) throw new Error("Not a GitLab instance host.");
  return formatSubresourceId({ fragments: [{ name: INSTANCE_FRAGMENT, id: host }] });
}

/**
 * What a GitLab subresource ID names: a project and the access level it needs there (the named
 * role's, or none beyond membership when `minAccessLevel` is absent), a project's repository, or
 * an instance.
 */
export type GitLabSubresource =
  | { kind: "project"; projectId: number; minAccessLevel?: number }
  | { kind: "repository"; projectId: number }
  | { kind: "instance"; host: string };

/**
 * What an ID {@link projectSubresourceId}, {@link repositorySubresourceId} or
 * {@link instanceSubresourceId} made names.
 * @throws Error for any other ID, including one spelling the id or host another way.
 */
export function parseGitLabSubresource(subresource: string): GitLabSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [first, role] = fragments;
  if (namespace === undefined && fragments.length === 1) {
    if (first.name === REPOSITORY_FRAGMENT) {
      const projectId = parseProjectId(first.id);
      if (projectId !== undefined) return { kind: "repository", projectId };
    }
    if (first.name === INSTANCE_FRAGMENT && isCanonicalHost(first.id)) return { kind: "instance", host: first.id };
  }
  if (namespace === undefined && fragments.length <= 2 && first.name === PROJECT_FRAGMENT) {
    const projectId = parseProjectId(first.id);
    if (projectId !== undefined) {
      if (role === undefined) return { kind: "project", projectId };
      if (role.name === ROLE_FRAGMENT && Object.hasOwn(ROLE_ACCESS_LEVELS, role.id)) {
        return { kind: "project", projectId, minAccessLevel: ROLE_ACCESS_LEVELS[role.id as ProjectRole] };
      }
    }
  }
  throw new Error("Not a GitLab subresource.");
}
