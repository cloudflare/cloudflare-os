// Microsoft Graph and Entra ID's token endpoint, faked at the `fetch` boundary for the workerd
// suites. Installed with `vi.stubGlobal`, which reaches the account and gatekeeper Durable Objects
// because the test file, TestHooks and every Durable Object run in one isolate. Tokens name users,
// and each user sees the seeded Engineering site minus whatever `hide()` took from them, so a probe
// with a collaborator's token answers for that collaborator. A test injects a failure with `on()`,
// whose routes answer before the built-in ones, latest first. Anything unrouted, or sent anywhere
// but Graph and Entra, fails the test.

import { env, runInDurableObject } from "cloudflare:test";
import { vi } from "vitest";
import { generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import type { StoredIdentity } from "../../src/microsoft-credentials";
import { SHAREPOINT_RESOURCE, getRedirectUri, scopesFor, type Env } from "../../src/microsoft-env";
import type { SharePointScope } from "../../src/sharepoint-scope";
import type { GatekeeperProps } from "./worker";

export const GRAPH = "https://graph.microsoft.com";
export const LOGIN = "https://login.microsoftonline.com";
export const TENANT = "11111111-1111-1111-1111-111111111111";
export const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
export const CLIENT_ID = "00000000-0000-0000-0000-00000000c1d0";
export const ORIGIN = "https://contoso.sharepoint.com";

export type FakeUser = { tid: string; oid: string; name: string; upn: string };

export const PHILLIP: FakeUser = { tid: TENANT, oid: "aaaaaaaa-0000-0000-0000-000000000001", name: "Phillip", upn: "phillip@contoso.com" };
export const SARAH: FakeUser = { tid: TENANT, oid: "aaaaaaaa-0000-0000-0000-000000000002", name: "Sarah", upn: "sarah@contoso.com" };
export const MALLORY: FakeUser = { tid: OTHER_TENANT, oid: "bbbbbbbb-0000-0000-0000-000000000003", name: "Mallory", upn: "mallory@fabrikam.com" };

/** What Entra grants a write connection, as its token endpoint spells the scopes. */
export const WRITE_SCOPES = [
  "https://graph.microsoft.com/Files.ReadWrite.All", "https://graph.microsoft.com/Sites.ReadWrite.All",
  "https://graph.microsoft.com/User.Read", "openid", "profile", "email",
];
export const READ_SCOPES = [
  "https://graph.microsoft.com/Files.Read.All", "https://graph.microsoft.com/Sites.Read.All",
  "https://graph.microsoft.com/User.Read", "openid", "profile", "email",
];

// The seeded layout: the Engineering site's Documents library.
//
//   Documents/
//     Specs/          <- the folder bindings are for
//       Deep/notes.txt
//       Empty/
//       brief.docx
//     Other/other.txt
const SITE_COLLECTION = "c0c0c0c0-0000-0000-0000-000000000001";
const WEB = "e0e0e0e0-0000-0000-0000-000000000001";
export const SITE_ID = `contoso.sharepoint.com,${SITE_COLLECTION},${WEB}`;
const ROOT_SITE_ID = "contoso.sharepoint.com,c0c0c0c0-0000-0000-0000-000000000000,e0e0e0e0-0000-0000-0000-000000000000";
export const DRIVE = "b!EngineeringDocumentsLibrary0001";
export const ROOT = "01ROOT00000000000000000000000000";
export const SPECS = "01SPECS0000000000000000000000000";
export const DEEP = "01DEEP00000000000000000000000000";
export const NOTES = "01NOTES0000000000000000000000000";
export const EMPTY = "01EMPTY0000000000000000000000000";
export const BRIEF = "01BRIEF0000000000000000000000000";
export const OTHER = "01OTHER0000000000000000000000000";
export const OTHER_FILE = "01OTHERFILE000000000000000000000";

/** The agent-facing reference for an item of the seeded library. */
export const ref = (itemId: string) => `${DRIVE}/${itemId}`;

export type FakeRequest = { method: string; url: URL; headers: Headers; body?: string; user?: FakeUser };
type Answer = { status: number; body?: unknown };
type Handler = (request: FakeRequest) => Response | undefined | Promise<Response | undefined>;

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200, ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

const notFound: Answer = { status: 404, body: { error: { code: "itemNotFound", message: "The resource could not be found." } } };

const base64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An unsigned ID token, as the token endpoint returns one over TLS. */
export function idToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims)}.`;
}

type WireItem = Record<string, unknown> & { id: string; name: string; parentId?: string; folder?: unknown };

export class FakeGraph {
  readonly requests: FakeRequest[] = [];
  /** Each `$batch` sub-request, with the user whose token sent it. */
  readonly batched: Array<{ user: string; url: string }> = [];
  /** Which user each access or refresh token belongs to. */
  readonly tokens = new Map<string, FakeUser>();
  /** What each authorization code authorizes, with any claims the ID token should say instead. */
  readonly codes = new Map<string, { user: FakeUser; claims?: Record<string, unknown> }>();
  readonly items = new Map<string, WireItem>();
  /** Item IDs each user (by object ID) can't open: SharePoint's broken inheritance. */
  readonly hidden = new Map<string, Set<string>>();
  /** The scopes the token endpoint reports granting. */
  grantedScopes = WRITE_SCOPES;
  #nextGrant = 1;
  #routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  constructor() {
    const folder = (id: string, name: string, parentId: string, path: string, childCount: number): WireItem =>
      this.#item(id, name, parentId, path, { folder: { childCount } });
    const file = (id: string, name: string, parentId: string, path: string, mimeType: string): WireItem =>
      this.#item(id, name, parentId, path, { file: { mimeType }, size: 1234 });
    for (const item of [
      { ...this.#item(ROOT, "root", undefined, "", { folder: { childCount: 2 } }), root: {} },
      folder(SPECS, "Specs", ROOT, "", 3),
      folder(DEEP, "Deep", SPECS, "Specs", 1),
      file(NOTES, "notes.txt", DEEP, "Specs/Deep", "text/plain"),
      folder(EMPTY, "Empty", SPECS, "Specs", 0),
      file(BRIEF, "brief.docx", SPECS, "Specs", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      folder(OTHER, "Other", ROOT, "", 1),
      file(OTHER_FILE, "other.txt", OTHER, "Other", "text/plain"),
    ]) this.items.set(item.id, item);
  }

  install(): this {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => this.#handle(input, init));
    return this;
  }

  /** Answers before the built-in routes; return `undefined` to fall through to them. */
  on(method: string, pattern: RegExp, handler: Handler): this {
    this.#routes.unshift({ method, pattern, handler });
    return this;
  }

  /** How many recorded requests match, by origin-relative path and query. */
  count(method: string, pattern: RegExp): number {
    return this.requests.filter(r => r.method === method && pattern.test(r.url.pathname + r.url.search)).length;
  }

  /** Requests to the token endpoint, as their form bodies. */
  tokenRequests(): URLSearchParams[] {
    return this.requests.filter(r => r.url.origin === LOGIN).map(r => new URLSearchParams(r.body));
  }

  /** Mints a token pair for `user`, as a code exchange or refresh would. */
  grant(user: FakeUser): { access_token: string; refresh_token: string } {
    const n = this.#nextGrant++;
    const pair = { access_token: `access-${user.name}-${n}`, refresh_token: `refresh-${user.name}-${n}` };
    this.tokens.set(pair.access_token, user);
    this.tokens.set(pair.refresh_token, user);
    return pair;
  }

  hide(user: FakeUser, ...itemIds: string[]): void {
    const set = this.hidden.get(user.oid) ?? new Set();
    for (const id of itemIds) set.add(id);
    this.hidden.set(user.oid, set);
  }

  /** The item IDs `user`'s `$batch` probes named, in order. */
  probedItems(user: FakeUser): string[] {
    return this.batched.filter(entry => entry.user === user.oid)
      .map(entry => /^drives\/[^/]+\/items\/([^?/]+)/.exec(entry.url)?.[1] ?? entry.url);
  }

  #item(id: string, name: string, parentId: string | undefined, parentPath: string, extra: Record<string, unknown>): WireItem {
    const path = parentPath === "" ? "Shared%20Documents" : `Shared%20Documents/${parentPath.split("/").map(encodeURIComponent).join("/")}`;
    return {
      id, name, ...(parentId ? { parentId } : {}),
      webUrl: id === ROOT ? `${ORIGIN}/sites/Engineering/Shared%20Documents` : `${ORIGIN}/sites/Engineering/${path}/${encodeURIComponent(name)}`,
      eTag: `"{${id}},1"`, cTag: `"c:{${id}},1"`,
      parentReference: {
        driveId: DRIVE, driveType: "documentLibrary",
        ...(parentId ? { id: parentId, path: `/drives/${DRIVE}/root:${parentPath ? `/${parentPath}` : ""}` } : {}),
      },
      sharepointIds: { siteId: SITE_COLLECTION, webId: WEB, siteUrl: `${ORIGIN}/sites/Engineering` },
      lastModifiedDateTime: "2026-10-01T12:00:00Z",
      lastModifiedBy: { user: { displayName: "Phillip" } },
      ...extra,
    };
  }

  async #handle(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.origin !== GRAPH && url.origin !== LOGIN) throw new Error(`fake Graph: ${request.method} ${url} is not Graph or Entra`);
    if (request.redirect !== "manual") throw new Error(`fake Graph: ${request.method} ${url} would follow redirects`);
    const recorded: FakeRequest = { method: request.method, url, headers: new Headers(request.headers) };
    if (request.body) recorded.body = new TextDecoder().decode(await request.arrayBuffer());
    const user = this.tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (user) recorded.user = user;
    this.requests.push(recorded);
    for (const route of this.#routes) {
      if (route.method === request.method && route.pattern.test(url.pathname + url.search)) {
        const answer = await route.handler(recorded);
        if (answer) return answer;
      }
    }
    if (url.origin === LOGIN) return this.#token(recorded);
    if (user === undefined) return json({ error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } }, { status: 401 });
    if (request.method === "POST" && url.pathname === "/v1.0/$batch") {
      const { requests } = JSON.parse(recorded.body ?? "{}") as { requests: Array<{ id: string; method: string; url: string }> };
      return json({
        responses: requests.map(sub => {
          this.batched.push({ user: user.oid, url: sub.url });
          return { id: sub.id, ...this.#route(sub.method, new URL(`${GRAPH}/v1.0/${sub.url}`), user) };
        }),
      });
    }
    const answer = this.#route(request.method, url, user);
    return answer.status === 204 ? new Response(null, { status: 204 }) : json(answer.body ?? null, { status: answer.status });
  }

  #token(request: FakeRequest): Response {
    const tenant = request.url.pathname.split("/")[1];
    if (request.method !== "POST" || request.url.pathname !== `/${tenant}/oauth2/v2.0/token`) {
      throw new Error(`fake Entra: ${request.method} ${request.url} is not the token endpoint`);
    }
    const form = new URLSearchParams(request.body);
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== "test-client-secret") {
      return json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret." }, { status: 401 });
    }
    let user: FakeUser | undefined;
    let claims: Record<string, unknown> | undefined;
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      if (code === undefined || !form.get("code_verifier")) {
        return json({ error: "invalid_grant", error_description: "AADSTS70008: The authorization code has expired." }, { status: 400 });
      }
      this.codes.delete(form.get("code")!);
      ({ user, claims } = code);
    } else if (form.get("grant_type") === "refresh_token") {
      user = this.tokens.get(form.get("refresh_token") ?? "");
      if (user === undefined) {
        return json({ error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired." }, { status: 400 });
      }
    } else {
      return json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    return json({
      token_type: "Bearer", expires_in: 3600, scope: this.grantedScopes.join(" "), ...this.grant(user),
      id_token: idToken({ aud: CLIENT_ID, tid: user.tid, oid: user.oid, name: user.name, preferred_username: user.upn, ...claims }),
    });
  }

  #visible(user: FakeUser, itemId: string): boolean {
    return this.items.has(itemId) && !this.hidden.get(user.oid)?.has(itemId);
  }

  #wire(item: WireItem): Record<string, unknown> {
    const { parentId: _parentId, ...wire } = item;
    return wire;
  }

  #route(method: string, url: URL, user: FakeUser): Answer {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    let match: RegExpMatchArray | null;
    if (method !== "GET") return { status: 405, body: { error: { code: "notSupported", message: `fake Graph: ${method} ${path}` } } };
    if (path === "/me") {
      return { status: 200, body: { id: user.oid, displayName: user.name, userPrincipalName: user.upn, mail: user.upn } };
    }
    if (path === "/sites/root") {
      return { status: 200, body: { id: ROOT_SITE_ID, displayName: "Communication site", webUrl: ORIGIN, root: {} } };
    }
    if (path === `/sites/${SITE_ID}`) {
      return { status: 200, body: { id: SITE_ID, name: "Engineering", displayName: "Engineering", webUrl: `${ORIGIN}/sites/Engineering` } };
    }
    if (path === `/drives/${DRIVE}`) {
      return {
        status: 200, body: {
          id: DRIVE, name: "Documents", webUrl: `${ORIGIN}/sites/Engineering/Shared%20Documents`, driveType: "documentLibrary",
          sharePointIds: { siteId: SITE_COLLECTION, webId: WEB, siteUrl: `${ORIGIN}/sites/Engineering` },
        },
      };
    }
    if (path === `/drives/${DRIVE}/root`) return { status: 200, body: this.#wire(this.items.get(ROOT)!) };
    if ((match = path.match(/^\/drives\/([^/]+)\/root:\/(.+)$/))) {
      // An item addressed by path (`root:/Specs/Deep`), walked from the root by name.
      const [, driveId, itemPath] = match;
      if (driveId !== DRIVE) return notFound;
      let current: WireItem | undefined = this.items.get(ROOT);
      for (const segment of itemPath.split("/")) {
        current = [...this.items.values()].find(child => child.parentId === current?.id && child.name === segment);
      }
      return current && this.#visible(user, current.id) ? { status: 200, body: this.#wire(current) } : notFound;
    }
    if ((match = path.match(/^\/drives\/([^/]+)\/items\/([^/:]+)(.*)$/))) {
      const [, driveId, itemId, rest] = match;
      if (driveId !== DRIVE || !this.#visible(user, itemId)) return notFound;
      const item = this.items.get(itemId)!;
      if (rest === "") return { status: 200, body: this.#wire(item) };
      if (rest === "/children") {
        const children = [...this.items.values()].filter(child => child.parentId === itemId && this.#visible(user, child.id));
        return { status: 200, body: { value: children.map(child => this.#wire(child)) } };
      }
      if ((match = rest.match(/^:\/([^/:]+)$/))) {
        const child = [...this.items.values()].find(candidate => candidate.parentId === itemId && candidate.name === match![1]);
        return child && this.#visible(user, child.id) ? { status: 200, body: this.#wire(child) } : notFound;
      }
    }
    throw new Error(`fake Graph: unrouted ${method} ${path}`);
  }
}

export function accountStub(userObjectId: string) {
  return env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(userObjectId));
}

export function identityOf(user: FakeUser, extra: Partial<StoredIdentity> = {}): StoredIdentity {
  return {
    tenantId: user.tid, objectId: user.oid, name: user.name, username: user.upn, email: user.upn,
    sharePointTenant: "contoso", fetchedAt: Date.now(), ...extra,
  };
}

/**
 * Seeds a connected account for `user` whose token the fake accepts and that needs no refresh, the
 * way a completed connect leaves one. Returns the account id.
 */
export async function seedAccount(graph: FakeGraph, user: FakeUser = PHILLIP, options: {
  expiresInMs?: number; scopes?: string[]; requestedScopes?: string[]; identity?: Partial<StoredIdentity>;
} = {}): Promise<string> {
  const grant = graph.grant(user);
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("credentials", {
      accessToken: grant.access_token,
      refreshToken: grant.refresh_token,
      expiresAt: Date.now() + (options.expiresInMs ?? 60 * 60 * 1000),
      scopes: options.scopes ?? WRITE_SCOPES,
      requestedScopes: options.requestedScopes ?? scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]),
    });
    state.storage.kv.put("identity", identityOf(user, options.identity));
  });
  return accountId.toString();
}

/** The stored grant, refresh token and all. */
export async function storedGrant(userObjectId: string) {
  return await runInDurableObject(accountStub(userObjectId), async (_instance, state) =>
    state.storage.kv.get<{ accessToken: string; refreshToken?: string; scopes: string[]; requestedScopes: string[] }>("credentials"));
}

/**
 * Runs a reconnect inside the account, Entra authorizing `user`, up to the callback: a handoff
 * naming the stage to commit, or a refusal. The account needs a Workshop callback (`installCallback`).
 */
export async function reconnectAs(graph: FakeGraph, userObjectId: string, user: FakeUser) {
  const initiation = generateNonce();
  return await runInDurableObject(accountStub(userObjectId), async instance => {
    await instance.prepareReconnect(initiation, scopesFor({} as Env, [SHAREPOINT_RESOURCE.urlPattern]));
    const flow = await instance.beginOAuthFlow(initiation, getRedirectUri(env as Env));
    if (!flow) throw new Error("the reconnect did not start");
    const code = `code-${crypto.randomUUID()}`;
    graph.codes.set(code, { user });
    return await instance.acceptAuthCode(code, flow.oauthNonce);
  });
}

export function hooks() {
  return env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
}

/** A forwarded call's result, rethrown here when it failed. */
export function unwrap<T = unknown>(outcome: { ok: unknown } | { error: string }): T {
  if ("error" in outcome) throw new Error(outcome.error);
  return outcome.ok as T;
}

/** A forwarded call's failure message, failing the test when it succeeded. */
export function failure(outcome: { ok: unknown } | { error: string }): string {
  if (!("error" in outcome)) throw new Error(`expected a failure, got ${JSON.stringify(outcome.ok)}`);
  return outcome.error;
}

let facets = 0;

/** A fresh facet name, so each scenario starts with empty gatekeeper storage. */
export function facet(prefix: string): string {
  return `${prefix}-${++facets}`;
}

/** Binding props for the seeded library's `itemId` folder (Specs by default), or any other scope. */
export function folderProps(userObjectId: string, itemId = SPECS): GatekeeperProps {
  return { userObjectId, scope: { kind: "folder", siteId: SITE_ID, driveId: DRIVE, itemId } };
}

export function props(userObjectId: string, scope: SharePointScope): GatekeeperProps {
  return { userObjectId, scope };
}
