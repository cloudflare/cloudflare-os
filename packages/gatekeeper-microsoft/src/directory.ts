// The two directory reads Outlook and Calendar share: who counts as a colleague, and who an
// address names. Both read as the user, with whatever the grant lets them see.

import type { GraphApi } from "./graph-api";

/** The organization's verified domains, lower-cased: whose addresses count as colleagues'. */
export async function organizationDomains(api: GraphApi): Promise<string[]> {
  // The domains are read inside the request, so that an answer that holds no list of organizations is counted as the error it is.
  return await api.get("/organization", { query: { $select: "verifiedDomains" } }, (body: { value?: { verifiedDomains?: { name?: unknown }[] }[] }) =>
    (body.value ?? []).flatMap(org => org.verifiedDomains ?? []).flatMap(domain => typeof domain.name === "string" ? [domain.name.toLowerCase()] : []));
}

/** Someone in the directory, by object ID and primary SMTP address. */
export type DirectoryUser = { id: string; mail: string; displayName?: string };

type UserRow = { id?: unknown; mail?: unknown; displayName?: unknown };
const USER_SELECT = "id,mail,displayName";

/** The directory user a row describes, or undefined for a row with no ID, which names nobody. */
function user(row: UserRow | null, address: string): DirectoryUser | undefined {
  if (typeof row?.id !== "string") return undefined;
  return {
    id: row.id, mail: typeof row.mail === "string" && row.mail !== "" ? row.mail : address,
    ...(typeof row.displayName === "string" && row.displayName !== "" ? { displayName: row.displayName } : {}),
  };
}

/** Whether a lookup was answered a user with no ID: an answer that is not what the lookup was sent for. */
function unidentified(found: DirectoryUser | null | undefined): boolean {
  return found === undefined;
}

/**
 * The directory user whose primary SMTP address this is, or null. Sharing lists and calendar links
 * name people by `mail`, which needn't be their sign-in name, the only thing `/users/{address}`
 * matches. Null too when the grant can't search the directory (no `User.ReadBasic.All`), and for
 * a row Graph answers with no ID, whose request is counted as an error of the API.
 */
export async function findUserByMail(api: GraphApi, address: string): Promise<DirectoryUser | null> {
  // The row is read inside the request: null where the search finds nobody, undefined for a row with no ID.
  const found = await api.find("/users", {
    query: { $filter: `mail eq '${address.replace(/'/g, "''")}'`, $select: USER_SELECT, $top: "1" },
  }, (body: { value?: UserRow[] } | null) => {
    const row = body?.value?.[0];
    return row === undefined ? null : user(row, address);
  }, unidentified);
  return found ?? null;
}

/** The directory user an address names: by sign-in name, which `/users/{address}` matches, else by primary SMTP address. */
export async function findUser(api: GraphApi, address: string): Promise<DirectoryUser | null> {
  // The user is read inside the request: null where Graph finds nobody, undefined for a user with
  // no ID, whose request is counted as an error of the API. Either way the address is searched for.
  const direct = await api.find(`/users/${encodeURIComponent(address)}`, { query: { $select: USER_SELECT } },
    (row: UserRow | null) => row === null ? null : user(row, address), unidentified);
  return direct ?? await findUserByMail(api, address);
}
