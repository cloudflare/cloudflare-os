// The one subresource GitHub reads report: the repository a binding is pinned to, by the numeric id
// GitHub gives it (see PinnedRepo). The id outlives a rename or a transfer and is never reused, so
// unlike `owner/name`, which a repository created after a deletion or rename can take over, it
// always names the repository the read was made in. Enterprise IDs include the instance origin;
// GitHub.com keeps its original unqualified IDs for historical compatibility.

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const REPO_FRAGMENT = "repo";

/** The canonical decimal spelling of a repository id: no sign, no leading zero. */
const REPO_ID = /^[1-9][0-9]*$/;

/**
 * The subresource ID of the repository with GitHub id `repoId`, qualified by Enterprise instance.
 * @throws Error when `repoId` is not a positive safe integer.
 */
export function repoSubresourceId(repoId: number, instance = "https://github.com"): string {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new Error(`${repoId} is not a GitHub repository id.`);
  }
  const fragments = instance === "https://github.com" ? [] : [{ name: "instance", id: instance }];
  return formatSubresourceId({ fragments: [...fragments, { name: REPO_FRAGMENT, id: String(repoId) }] });
}

/**
 * The GitHub repository id a {@link repoSubresourceId} ID names.
 * @throws Error for any other ID, including one spelling the id another way.
 */
export function parseRepoSubresource(subresource: string, instance = "https://github.com"): number {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const expectedPrefix = instance === "https://github.com" ? [] : [{ name: "instance", id: instance }];
  const fragment = fragments.at(-1);
  if (namespace === undefined && fragments.length === expectedPrefix.length + 1
      && expectedPrefix.every((part, i) => fragments[i].name === part.name && fragments[i].id === part.id)
      && fragment?.name === REPO_FRAGMENT
      && REPO_ID.test(fragment.id) && Number.isSafeInteger(Number(fragment.id))) {
    return Number(fragment.id);
  }
  throw new Error("Not a GitHub repository subresource.");
}
