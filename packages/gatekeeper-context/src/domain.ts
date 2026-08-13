/**
 * Namespace all data for one Workshop binding. This prevents accidental mixing between trusted
 * deployments sharing a gatekeeper instance; it is not a boundary against malicious peer configs.
 */
export const DEFAULT_SHARING_DOMAIN = "default";

// NUL never appears in domains, UUID account ids, or hex collection ids.
const SEP = "\u0000";

/** Durable Object name for a domain-scoped entity. */
export function domainName(domain: string, id: string): string {
  return `${domain}${SEP}${id}`;
}
