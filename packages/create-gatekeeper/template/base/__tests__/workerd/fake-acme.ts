// Acme Service, faked at `fetch` for the workerd suites. `vi.stubGlobal` reaches the gatekeeper
// because a whole suite, its test file and the Durable Objects alike, runs in one isolate.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { seedCredentials } from "@gadgets/gatekeeper-kit/test-support";
import type { Grant } from "../../src/acme-account";
import type { WireItem, WireUser } from "../../src/acme-api";
import { identityOf } from "../../src/acme-credentials";
import { API_ORIGIN } from "../../src/acme-env";

/** The user every account here is connected as, and the token that names them. */
export const ALICE: WireUser = { id: "u-alice", name: "Alice" };
const TOKEN = "token-alice";
// Checked against whichever grant the account stores: a pasted key has no scopes, and ignores them.
const GRANT = { accessToken: TOKEN, scopes: [] };

/**
 * Installs the provider, which opens each of `items` to Alice and answers 404 for anything else.
 * @returns Every request made of it, as its method and path.
 */
export function fakeAcme(items: WireItem[] = []): string[] {
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const { origin, pathname } = new URL(request.url);
    requests.push(`${request.method} ${pathname}`);
    if (request.headers.get("Authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
    const item = origin === API_ORIGIN && request.method === "GET" && items.find(({ id }) => pathname === `/items/${id}`);
    return item ? Response.json(item) : new Response(null, { status: 404 });
  });
  return requests;
}

/** A `UserAccount` connected as Alice, as a finished connect flow leaves one. */
export async function connected(): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_account, state) => {
    seedCredentials<Grant>(state.storage.kv, GRANT);
    state.storage.kv.put("identity", identityOf(ALICE));
  });
  return id.toString();
}
