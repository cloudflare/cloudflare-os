// Shared helpers for the live contract suite: the test users, signed in as the account Durable Object
// would hold them, and the tenant's seeded layout, named by path so no tenant-specific ID is
// committed. See vitest.contract.config.ts for where the users come from, and
// plans/microsoft-365-gatekeeper.md ("Test tenant") for what each user can open:
//
// - Engineering: a private team site. Phillip owns it, Sarah is a member, Bob is not.
//   `Documents/Specs/{apollo-brief.docx, apollo-budget.xlsx, Deep/notes.txt}`, and the Issue Tracker list.
// - Marketing: a communication site with Sarah and Bob as visitors. `Documents/Launch/{plan.pdf,
//   roster.csv}`, `Documents/Confidential/salaries.csv` with inheritance broken so only Phillip
//   can open it, and the Launch Plan page.
// - Phillip's OneDrive: `GadgetsSpike/Apollo` shared read-only with Sarah, `GadgetsSpike/Private` not.

import { env, runInDurableObject } from "cloudflare:test";
import type { ContractAccount } from "../../vitest.contract.config";
import type { AnyGatekeeperProps, GatekeeperProps, Outcome, Step } from "../workerd/worker";
import type { SharePointScope } from "../../src/sharepoint-scope";

export type Label = "phillip" | "sarah" | "bob";

const accounts: ContractAccount[] = env.CONTRACT_ACCOUNTS ? JSON.parse(env.CONTRACT_ACCOUNTS) : [];

/** Whether the suite has its users; without them every contract test skips. */
export const live = accounts.length > 0;

export function account(label: Label): ContractAccount {
  const found = accounts.find(candidate => candidate.label === label);
  if (!found) throw new Error(`no contract account ${label}`);
  return found;
}

export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

const connected = new Map<Label, string>();

/**
 * The account Durable Object for `label`, holding their live grant as a finished connect leaves it.
 * The identity is stored as stale, so the first read confirms it against `/me` and finds the
 * tenant's SharePoint host, as a day-old connection does.
 */
export async function connect(label: Label): Promise<string> {
  const existing = connected.get(label);
  if (existing) return existing;
  const user = account(label);
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("credentials", {
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
      expiresAt: user.expiresAt,
      scopes: user.scopes,
      requestedScopes: user.scopes,
    });
    state.storage.kv.put("identity", {
      tenantId: user.tenantId, objectId: user.objectId, name: user.name, username: user.username, fetchedAt: 0,
    });
  });
  connected.set(label, id.toString());
  return id.toString();
}

export function unwrap<T = unknown>(result: Outcome<unknown>): T {
  if ("error" in result) throw new Error(`expected success, got: ${result.error}`);
  return result.ok as T;
}

export function failure(result: Outcome<unknown>): string {
  if ("ok" in result) throw new Error(`expected failure, got: ${JSON.stringify(result.ok).slice(0, 500)}`);
  return result.error;
}

/** The tenant's SharePoint origin, e.g. `https://contoso.sharepoint.com`. */
export async function origin(): Promise<string> {
  const id = await connect("phillip");
  const identity = unwrap<{ sharePointTenant?: string }>(await hooks().account(id, "getIdentity"));
  if (!identity.sharePointTenant) throw new Error("phillip has no SharePoint");
  return `https://${identity.sharePointTenant}.sharepoint.com`;
}

/** Phillip's OneDrive origin path, e.g. `https://contoso-my.sharepoint.com/personal/phillip_contoso_com`. */
export async function oneDrive(): Promise<string> {
  const host = (await origin()).replace(".sharepoint.com", "-my.sharepoint.com");
  return `${host}/personal/${account("phillip").username.replace(/[@.]/g, "_")}`;
}

/** The binding props for `url`, resolved as `label` would bind it. */
export async function bind(label: Label, url: string): Promise<GatekeeperProps> {
  const userObjectId = await connect(label);
  const resolved = unwrap<{ scope: SharePointScope }>(await hooks().resolve(userObjectId, url));
  return { userObjectId, scope: resolved.scope };
}

let facets = 0;

/** A fresh facet name, so each scenario starts with empty gatekeeper storage. */
export function facet(prefix: string): string {
  return `${prefix}-${++facets}-${Date.now()}`;
}

/** Runs `steps` on a session of the binding. */
export async function run(name: string, props: AnyGatekeeperProps, steps: Step[], options?: { pages?: number }) {
  return await hooks().run(name, props, steps, options);
}

/** Every entry a cursor returns over at most `pages` pages, flattened. */
export async function walk<T>(name: string, props: AnyGatekeeperProps, steps: Step[], pages = 10): Promise<T[]> {
  return unwrap<T[][]>(await run(name, props, steps, { pages })).flat();
}
