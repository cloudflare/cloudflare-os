// The one subresource GitHub reads report: the repository a binding is pinned to, by the numeric id
// GitHub gives it (see PinnedRepo). The id outlives a rename or a transfer and is never reused, so
// unlike `owner/name`, which a repository created after a deletion or rename can take over, it
// always names the repository the read was made in. GitHub is one product, so the ID carries no
// namespace (see formatSubresourceId).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const REPO_FRAGMENT = "repo";

/** The canonical decimal spelling of a repository id: no sign, no leading zero. */
const REPO_ID = /^[1-9][0-9]*$/;

/**
 * The subresource ID of the repository with GitHub id `repoId`: `repo/<repoId>`.
 * @throws Error when `repoId` is not a positive safe integer.
 */
export function repoSubresourceId(repoId: number): string {
  if (!Number.isSafeInteger(repoId) || repoId < 1) {
    throw new Error(`${repoId} is not a GitHub repository id.`);
  }
  return formatSubresourceId({ fragments: [{ name: REPO_FRAGMENT, id: String(repoId) }] });
}

/**
 * The GitHub repository id a {@link repoSubresourceId} ID names.
 * @throws Error for any other ID, including one spelling the id another way.
 */
export function parseRepoSubresource(subresource: string): number {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [fragment] = fragments;
  if (namespace === undefined && fragments.length === 1 && fragment.name === REPO_FRAGMENT
      && REPO_ID.test(fragment.id) && Number.isSafeInteger(Number(fragment.id))) {
    return Number(fragment.id);
  }
  throw new Error("Not a GitHub repository subresource.");
}
