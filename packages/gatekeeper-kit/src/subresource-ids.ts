/** The global instance-access requirement and canonical, structured resource IDs. */

const SEPARATOR = "/";

/**
 * Instance-wide access requirement for the one service instance fixed by the deployed Worker's
 * configuration. `verifyObserverAccess()` checks the observer's own live instance-access
 * entitlement. Report it alone only when that entitlement covers the whole disclosure; otherwise
 * combine it with resource, field, or private-account IDs. Every reported requirement must pass:
 * this sentinel is not a wildcard or grant and never replaces those independent checks.
 * When accounts choose their instance, report a structured instance ID instead. Report the
 * requirement on every disclosure depending on instance access; `[]` adds no requirement.
 * Compare it directly before {@link parseSubresourceId}, which rejects it.
 */
export const GLOBAL_SUBRESOURCE_ID = "global";

/**
 * One resource on the path to a subresource: its kind and the provider's identifier for it, both
 * non-empty.
 *
 * A fragment always names a resource, never a predicate or a policy. What access the resource needs
 * (a folder an observer must be able to list, an inbox no collaborator may ever see) is decided by
 * the gatekeeper's `verifyObserverAccess()` when it reads the ID back, and many resources may map to
 * one check. Nesting implies no access inheritance either way.
 *
 * Cloud IDs, workspace URLs, and similar provider-instance identifiers are tenant identities.
 * Include a tenant fragment unless the deployed Worker's configuration permanently fixes the
 * tenant; an account, binding, URL, or shared OAuth app does not. An implicit tenant must stay fixed
 * while recorded requirements exist, and omitting its fragment does not omit membership checks.
 * Recorded IDs must retain their meaning across accounts, renames, and reconnects.
 */
export type SubresourceFragment = {
  /** The resource's kind, such as `file` or `inbox`. */
  name: string;
  /** The provider's identifier for the resource. */
  id: string;
};

/** A structured resource ID before encoding (see {@link formatSubresourceId}). */
export type SubresourceId = {
  /**
   * The product family the resource belongs to, for a gatekeeper exposing several that each have
   * their own resources, such as Google's `gmail`, `drive` and `bigquery`. A gatekeeper with one
   * product omits it rather than repeating the service's name. Never the empty string.
   */
  namespace?: string;
  /** The resources naming the subresource, outermost first; at least one. */
  fragments: readonly SubresourceFragment[];
};

/**
 * Encodes a subresource ID for `ObservationDescription.subresources`: the namespace, then each
 * fragment's name and id, every component `encodeURIComponent`-escaped and joined by `/`. Escaping
 * keeps `/` out of every component, and each fragment contributes two, so an odd count marks a
 * leading namespace. Each value has exactly one spelling, and the Workshop deduplicates and indexes
 * requirements by string, so describe one resource with the same fragments in the same order
 * everywhere it is reported.
 *
 * The Workshop refuses an observation carrying an ID over 2048 UTF-16 code units (every bound is in
 * `ObservationDescription.subresources`), and escaping can lengthen a component up to ninefold (a
 * three-byte UTF-8 character becomes nine), so a resource whose provider id approaches that needs a
 * shorter identity.
 * @param value Namespace and fragments.
 * @returns The encoded ID.
 * @throws Error when the namespace is empty, there are no fragments, a fragment's name or id is
 * empty, or a component is not well-formed Unicode.
 * @example
 * ```ts
 * formatSubresourceId({ namespace: "gmail", fragments: [{ name: "inbox", id: "mpeterson@cloudflare.com" }] });
 * // "gmail/inbox/mpeterson%40cloudflare.com"
 * formatSubresourceId({ fragments: [{ name: "space", id: "ENG" }, { name: "page", id: "123" }] });
 * // "space/ENG/page/123"
 * ```
 */
export function formatSubresourceId(value: SubresourceId): string {
  const { namespace, fragments } = value;
  if (namespace === "") {
    throw new Error("A subresource ID's namespace must not be empty; omit it instead.");
  }
  if (fragments.length === 0) throw new Error("A subresource ID must have at least one fragment.");
  const components = namespace === undefined ? [] : [namespace];
  for (const { name, id } of fragments) {
    if (name === "" || id === "") {
      throw new Error("A subresource ID's fragment names and ids must not be empty.");
    }
    components.push(name, id);
  }
  // encodeURIComponent would throw a bare URIError on a lone surrogate; name the rule instead.
  if (!components.every(component => component.isWellFormed())) {
    throw new Error("A subresource ID's components must be well-formed Unicode.");
  }
  return components.map(encodeURIComponent).join(SEPARATOR);
}

/**
 * Decodes an ID {@link formatSubresourceId} produced, as `verifyObserverAccess()` receives it. Only
 * the canonical spelling parses: any other (a lowercase or needless escape, a raw character the
 * encoder would escape, an empty component, a namespace with no fragments) is not an ID this module
 * made, and is refused rather than read as some nearby resource.
 * Rejects {@link GLOBAL_SUBRESOURCE_ID}; compare that sentinel directly before parsing.
 * @param id Encoded subresource ID.
 * @returns Its namespace, when it has one, and its fragments.
 * @throws Error when `id` is not a subresource ID in canonical form.
 */
export function parseSubresourceId(id: string): SubresourceId {
  let value: SubresourceId;
  let canonical: string;
  try {
    const components = id.split(SEPARATOR).map(decodeURIComponent);
    const namespace = components.length % 2 === 1 ? components.shift() : undefined;
    const fragments: SubresourceFragment[] = [];
    for (let index = 0; index < components.length; index += 2) {
      fragments.push({ name: components[index], id: components[index + 1] });
    }
    value = namespace === undefined ? { fragments } : { namespace, fragments };
    // Re-encoding applies every rule formatSubresourceId does, and yields the one spelling to match.
    canonical = formatSubresourceId(value);
  } catch {
    throw new Error("Not a subresource ID in canonical form.");
  }
  if (canonical !== id) throw new Error("Not a subresource ID in canonical form.");
  return value;
}
