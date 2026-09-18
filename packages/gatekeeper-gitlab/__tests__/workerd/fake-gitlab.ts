// A GitLab faked at the `fetch` boundary for the workerd suites. Installed with
// `vi.stubGlobal`, which reaches the gatekeeper because the whole workerd suite -- test file,
// TestHooks, and the gatekeeper Durable Object -- runs in one isolate. Routes are registered per
// test and the *last* registered match answers, so a test overrides a helper's default by
// registering after it; anything unrouted is a hard failure so a test cannot silently pass on a
// wrong URL.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import type { GatekeeperProps } from "./worker.js";

export const API = "https://gitlab.example.com";

export type FakeRequest = { method: string; url: URL; headers: Headers; body?: string };
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
    const recorded: FakeRequest = { method: request.method, url, headers: new Headers(request.headers) };
    if (request.body) recorded.body = await request.text();
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
 * Seed a connected account with a live grant that will not need refreshing, and return the props
 * a gatekeeper facet for `projectPath` needs.
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
