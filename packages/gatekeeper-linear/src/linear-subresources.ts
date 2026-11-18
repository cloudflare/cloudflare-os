// The subresources Linear reads report, each naming its workspace by the url key a binding was made
// for (the first path segment of linear.app URLs), then the resource inside it:
//   - workspace/<urlKey>                       the workspace itself, which a workspace binding's
//                                              every read reports: its members may see its metadata
//                                              and member directory.
//   - workspace/<urlKey>/team/<teamKeyOrId>    a team: the one a team binding names, spelled as its
//                                              URL did, or on a workspace binding each team whose
//                                              data a read revealed, by its UUID.
//   - workspace/<urlKey>/issue/<issueRef>      the issue an issue binding names, spelled as its URL
//                                              did.
// The workspace is the resource's identity, not a further requirement: a team or issue is checked
// exactly as it was before reads reported it. Linear is one product, so the IDs carry no namespace
// (see formatSubresourceId).

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const WORKSPACE_FRAGMENT = "workspace";
const TEAM_FRAGMENT = "team";
const ISSUE_FRAGMENT = "issue";

/** A resource a {@link parseLinearSubresource} ID names. */
export type LinearSubresource =
  | { kind: "workspace"; workspaceUrlKey: string }
  | { kind: "team"; workspaceUrlKey: string; teamKeyOrId: string }
  | { kind: "issue"; workspaceUrlKey: string; issueRef: string };

/**
 * The subresource ID of the workspace with url key `workspaceUrlKey`: `workspace/<urlKey>`.
 * @throws Error when `workspaceUrlKey` is empty.
 */
export function workspaceSubresourceId(workspaceUrlKey: string): string {
  return formatSubresourceId({ fragments: [{ name: WORKSPACE_FRAGMENT, id: workspaceUrlKey }] });
}

/**
 * The subresource ID of team `teamKeyOrId` in workspace `workspaceUrlKey`:
 * `workspace/<urlKey>/team/<teamKeyOrId>`.
 * @throws Error when either is empty.
 */
export function teamSubresourceId(workspaceUrlKey: string, teamKeyOrId: string): string {
  return formatSubresourceId({ fragments: [
    { name: WORKSPACE_FRAGMENT, id: workspaceUrlKey }, { name: TEAM_FRAGMENT, id: teamKeyOrId },
  ] });
}

/**
 * The subresource ID of issue `issueRef` in workspace `workspaceUrlKey`:
 * `workspace/<urlKey>/issue/<issueRef>`.
 * @throws Error when either is empty.
 */
export function issueSubresourceId(workspaceUrlKey: string, issueRef: string): string {
  return formatSubresourceId({ fragments: [
    { name: WORKSPACE_FRAGMENT, id: workspaceUrlKey }, { name: ISSUE_FRAGMENT, id: issueRef },
  ] });
}

/**
 * The resource an ID made by {@link workspaceSubresourceId}, {@link teamSubresourceId} or
 * {@link issueSubresourceId} names.
 * @throws Error for any other ID, including one not in canonical form.
 */
export function parseLinearSubresource(subresource: string): LinearSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [workspace, inner] = fragments;
  if (namespace === undefined && workspace.name === WORKSPACE_FRAGMENT) {
    const workspaceUrlKey = workspace.id;
    if (fragments.length === 1) return { kind: "workspace", workspaceUrlKey };
    if (fragments.length === 2 && inner.name === TEAM_FRAGMENT) {
      return { kind: "team", workspaceUrlKey, teamKeyOrId: inner.id };
    }
    if (fragments.length === 2 && inner.name === ISSUE_FRAGMENT) {
      return { kind: "issue", workspaceUrlKey, issueRef: inner.id };
    }
  }
  throw new Error("Not a Linear subresource.");
}
