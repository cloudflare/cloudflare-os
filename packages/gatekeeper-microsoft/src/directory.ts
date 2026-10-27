// The two directory reads Outlook and Calendar share: who counts as a colleague, and who an
// address names. Both read as the user, with whatever the grant lets them see.

import type { GraphApi } from "./graph-api";

/** The organization's verified domains, lower-cased: whose addresses count as colleagues'. */
export async function organizationDomains(api: GraphApi): Promise<string[]> {
  const body = await api.get<{ value?: { verifiedDomains?: { name?: unknown }[] }[] }>("/organization", { query: { $select: "verifiedDomains" } });
  return (body.value ?? []).flatMap(org => org.verifiedDomains ?? []).flatMap(domain => typeof domain.name === "string" ? [domain.name.toLowerCase()] : []);
}

/**
 * The directory user whose primary SMTP address this is, or null. Sharing lists and calendar links
 * name people by `mail`, which needn't be their sign-in name, the only thing `/users/{address}`
 * matches. Null too when the grant can't search the directory (no `User.ReadBasic.All`).
 */
export async function findUserByMail(api: GraphApi, address: string): Promise<{ id: string; mail: string } | null> {
  const found = await api.find<{ value?: { id?: unknown; mail?: unknown }[] }>("/users", {
    query: { $filter: `mail eq '${address.replace(/'/g, "''")}'`, $select: "id,mail", $top: "1" },
  });
  const user = found?.value?.[0];
  return typeof user?.id === "string" ? { id: user.id, mail: typeof user.mail === "string" ? user.mail : address } : null;
}
