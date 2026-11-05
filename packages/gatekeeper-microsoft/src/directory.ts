// The two directory reads Outlook and Calendar share: who counts as a colleague, and who an
// address names. Both read as the user, with whatever the grant lets them see.

import type { GraphApi } from "./graph-api";

/** The organization's verified domains, lower-cased: whose addresses count as colleagues'. */
export async function organizationDomains(api: GraphApi): Promise<string[]> {
  const body = await api.get<{ value?: { verifiedDomains?: { name?: unknown }[] }[] }>("/organization", { query: { $select: "verifiedDomains" } });
  return (body.value ?? []).flatMap(org => org.verifiedDomains ?? []).flatMap(domain => typeof domain.name === "string" ? [domain.name.toLowerCase()] : []);
}

/** Someone in the directory, by object ID and primary SMTP address. */
export type DirectoryUser = { id: string; mail: string; displayName?: string };

type UserRow = { id?: unknown; mail?: unknown; displayName?: unknown };
const USER_SELECT = "id,mail,displayName";

function user(row: UserRow, address: string): DirectoryUser {
  return {
    id: row.id as string, mail: typeof row.mail === "string" && row.mail !== "" ? row.mail : address,
    ...(typeof row.displayName === "string" && row.displayName !== "" ? { displayName: row.displayName } : {}),
  };
}

/**
 * The directory user whose primary SMTP address this is, or null. Sharing lists and calendar links
 * name people by `mail`, which needn't be their sign-in name, the only thing `/users/{address}`
 * matches. Null too when the grant can't search the directory (no `User.ReadBasic.All`).
 */
export async function findUserByMail(api: GraphApi, address: string): Promise<DirectoryUser | null> {
  const found = await api.find<{ value?: UserRow[] }>("/users", {
    query: { $filter: `mail eq '${address.replace(/'/g, "''")}'`, $select: USER_SELECT, $top: "1" },
  });
  const row = found?.value?.[0];
  return typeof row?.id === "string" ? user(row, address) : null;
}

/** The directory user an address names: by sign-in name, which `/users/{address}` matches, else by primary SMTP address. */
export async function findUser(api: GraphApi, address: string): Promise<DirectoryUser | null> {
  const direct = await api.find<UserRow>(`/users/${encodeURIComponent(address)}`, { query: { $select: USER_SELECT } });
  return typeof direct?.id === "string" ? user(direct, address) : await findUserByMail(api, address);
}
