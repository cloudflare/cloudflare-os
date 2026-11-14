// A GitLab faked at the `fetch` boundary for the workerd suites. Installed with
// `vi.stubGlobal`, which reaches the gatekeeper because the whole workerd suite -- test file,
// TestHooks, and the gatekeeper Durable Object -- runs in one isolate. Routes are registered per
// test and the *last* registered match answers, so a test overrides a helper's default by
// registering after it; anything unrouted is a hard failure so a test cannot silently pass on a
// wrong URL.
//
// The fake stands where vitest.worker.config.ts puts GitLab: behind Cloudflare Access, at an API
// origin of its own. A request anywhere else, or without the service token, fails -- so every
// suite also checks that the user's token goes only to GITLAB_API_URL, and that the Access
// headers ride on every kind of request (REST, OAuth, git).

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { getRedirectUri } from "../../src/gitlab-env.js";
import type { UserAccount } from "../../src/gitlab.js";
import type { GatekeeperProps } from "./worker.js";

/** The instance users visit (`GITLAB_URL`): links in results are built from it. */
export const WEB = "https://gitlab.example.com";
/** Where the Worker sends requests (`GITLAB_API_URL`), and the only origin the fake answers at. */
export const API = "https://gitlab-api.example.com";
/** The Access service token (`CF_ACCESS_CLIENT_ID`/`_SECRET`) every request must carry. */
export const ACCESS = { id: "test-access-id", secret: "test-access-secret" };

export type FakeRequest = {
  method: string;
  url: URL;
  headers: Headers;
  /** The body byte for byte, for a binary one (a git pack). */
  bytes?: Uint8Array;
  /** The body decoded as UTF-8, for the JSON and form bodies most routes read. */
  body?: string;
};
type Handler = (request: FakeRequest) => Response | Promise<Response>;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

export class FakeGitLab {
  readonly requests: FakeRequest[] = [];
  #routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  install(): void {
    vi.stubGlobal("fetch", this.#handle.bind(this));
  }

  /** Route by method and a regex over the URL's path + search. A later registration wins. */
  on(method: string, pattern: RegExp, handler: Handler): this {
    this.#routes.unshift({ method, pattern, handler });
    return this;
  }

  /** How many recorded requests match. */
  count(method: string, pattern: RegExp): number {
    return this.requests.filter(r => r.method === method && pattern.test(r.url.pathname + r.url.search)).length;
  }

  async #handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== API) {
      throw new Error(`fake GitLab: ${request.method} ${url} was sent to ${url.origin}, not GITLAB_API_URL`);
    }
    if (request.headers.get("cf-access-client-id") !== ACCESS.id ||
        request.headers.get("cf-access-client-secret") !== ACCESS.secret) {
      throw new Error(`fake GitLab: ${request.method} ${url} lacks the Access service token`);
    }
    const recorded: FakeRequest = { method: request.method, url, headers: new Headers(request.headers) };
    if (request.body) {
      recorded.bytes = new Uint8Array(await request.arrayBuffer());
      recorded.body = new TextDecoder().decode(recorded.bytes);
    }
    this.requests.push(recorded);
    for (const route of this.#routes) {
      if (route.method === request.method && route.pattern.test(url.pathname + url.search)) {
        return await route.handler(recorded);
      }
    }
    throw new Error(`fake GitLab: unrouted ${request.method} ${url}`);
  }
}

/**
 * Seed a connected account with a live grant that will not need refreshing, in the layout this
 * package (and the internal stub, which wrote no `scopes`) stored before the kit: the account
 * migrates it on first read, as it does a deployed account's. Returns the account id.
 */
export async function seedAccount(options: {
  accessToken?: string;
  refreshToken?: string;
  expiresInMs?: number;
  scopes?: string[] | null;
} = {}): Promise<string> {
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", options.accessToken ?? "test-token");
    state.storage.kv.put("refreshToken", options.refreshToken ?? "test-refresh");
    state.storage.kv.put("accessTokenExpiresAt", Date.now() + (options.expiresInMs ?? 60 * 60 * 1000));
    if (options.scopes !== null) state.storage.kv.put("scopes", options.scopes ?? ["api", "write_repository"]);
  });
  return accountId.toString();
}

/** GitLab's token response for grant `n`: `access-n` / `refresh-n`, two hours. */
export function tokenResponse(n: number) {
  return { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 7200, token_type: "bearer" };
}

/**
 * Run a reconnect inside the account up to the stage it leaves, GitLab answering authorization
 * code `code`; returns the stage id its handoff names (see TestCallback), which `commitReconnect`
 * takes. The flow authorizes under the Worker's own callback, as production does. The account
 * needs a Workshop callback (`hooks().installCallback`).
 */
export async function stageReconnect(account: UserAccount, code: string): Promise<string> {
  await account.prepareReconnect(`initiation-${code}`);
  const flow = await account.beginOAuthFlow(`initiation-${code}`, getRedirectUri(env));
  const handoff = await account.acceptAuthCode(code, flow!.oauthNonce);
  return handoff!.ticket;
}

export function projectProps(userObjectId: string, projectPath = "group/sub/project"): GatekeeperProps {
  return { userObjectId, resourceKind: "project", projectPath };
}

/** The single TestHooks instance the suites forward through. */
export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

export async function unwrap<T>(outcome: { ok: T } | { error: string }): Promise<T> {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok;
}
