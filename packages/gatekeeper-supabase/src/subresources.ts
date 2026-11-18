// The subresources Supabase reads report: the organization a binding is pinned to, by its slug, and
// each project whose data a read reveals, by its ref under the organization it was read through
// (see SupabaseSessionContext.authorizeRead). Supabase is one product, so the IDs carry no
// namespace (see formatSubresourceId).
//
// The organization in a project ID is that project's identity as the read saw it, not a further
// requirement: a project ID asks only whether the observer can reach the project, since a project
// can move between organizations. Organization membership is asked by the organization's own ID.

import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";

const ORGANIZATION_FRAGMENT = "organization";
const PROJECT_FRAGMENT = "project";

/** A resource a Supabase subresource ID names (see {@link parseSupabaseSubresource}). */
export type SupabaseSubresource =
  | { kind: "organization"; slug: string }
  | { kind: "project"; slug: string; ref: string };

/**
 * The subresource ID of the Supabase organization with slug `slug`: `organization/<slug>`.
 * @throws Error when `slug` is empty or not well-formed Unicode.
 */
export function organizationSubresourceId(slug: string): string {
  return formatSubresourceId({ fragments: [{ name: ORGANIZATION_FRAGMENT, id: slug }] });
}

/**
 * The subresource ID of the Supabase project with ref `ref`, read as part of the organization with
 * slug `slug`: `organization/<slug>/project/<ref>`.
 * @throws Error when either is empty or not well-formed Unicode.
 */
export function projectSubresourceId(slug: string, ref: string): string {
  return formatSubresourceId({
    fragments: [{ name: ORGANIZATION_FRAGMENT, id: slug }, { name: PROJECT_FRAGMENT, id: ref }],
  });
}

/**
 * The resource an {@link organizationSubresourceId} or {@link projectSubresourceId} ID names.
 * @throws Error for any other ID, including one in another spelling or with a namespace.
 */
export function parseSupabaseSubresource(subresource: string): SupabaseSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const [organization, project] = fragments;
  if (namespace === undefined && organization.name === ORGANIZATION_FRAGMENT) {
    if (fragments.length === 1) return { kind: "organization", slug: organization.id };
    if (fragments.length === 2 && project.name === PROJECT_FRAGMENT) {
      return { kind: "project", slug: organization.id, ref: project.id };
    }
  }
  throw new Error("Not a Supabase subresource.");
}
