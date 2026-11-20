/** Typed JSON client for a provider API described by a type-only, OpenAPI-shaped schema. */

import { pathSegment } from "./endpoint";
import { HttpError } from "./http-errors";
import { readTextCapped } from "./response-body";

/** HTTP methods a {@link Schema} can declare operations for. Each is also a client method name. */
export type Method = "get" | "post" | "put" | "delete" | "patch";

/**
 * One provider operation, declared as a type only.
 *
 * Write `path` exactly as the OpenAPI document does, with `{name}` placeholders, which the client
 * fills from the call's `path` object. A call takes `query`, `headers` and `body` only when the
 * operation declares them. `query` and `headers` are required when they have required members. A
 * declared `body` is required unless its type includes `undefined`, because sending `{}` differs
 * from sending nothing. `response` is the parsed JSON body of a 2xx reply. The client trusts the
 * schema and validates nothing at runtime.
 *
 * A query array is sent as one `name=value` pair per element, which is OpenAPI's default (exploded)
 * form. Declare a parameter that takes the comma-separated form as a `string`, and join the values
 * yourself.
 *
 * Declare `query` and `headers` as object literal types, not interfaces, because an interface does
 * not satisfy an index signature.
 */
export interface Operation {
  readonly path: `/${string}`;
  readonly query?: { readonly [name: string]: QueryValue | undefined };
  readonly headers?: { readonly [name: string]: string | undefined };
  readonly body?: unknown;
  readonly response: unknown;
}

/** A query parameter's value: a scalar, or an array sent as one pair per element. */
export type QueryValue = string | number | boolean | readonly (string | number | boolean)[];

/** A provider API: the operations each method offers. Leave out methods the API lacks. */
export type Schema = { readonly [M in Method]?: readonly Operation[] };

/**
 * The parameters named by an operation path's `{name}` placeholders.
 * @example `PathParams<"/orgs/{org}/users/{id}">` is `{ org: string | number; id: string | number }`.
 */
export type PathParams<P extends string> =
  P extends `${string}{${infer Name}}${infer Rest}`
    ? { readonly [K in Name | keyof PathParams<Rest>]: string | number }
    : {};

/** The paths at prefix `P`, or below it. */
type Under<P extends string> = P extends `${string}/` ? `${P}${string}` : P | `${P}/${string}`;

/** The parameters of path `P` that the prefixes `Scope` fix: those of each prefix `P` is under. */
type FixedIn<P extends string, Scope extends string> =
  Scope extends unknown ? P extends Under<Scope> ? keyof PathParams<Scope> : never : never;

type PathField<P extends string, Scope extends string> =
  Exclude<keyof PathParams<P>, FixedIn<P, Scope>> extends never
    ? { readonly path?: never }
    : { readonly path: Omit<PathParams<P>, FixedIn<P, Scope>> };

type Field<O, K extends "query" | "headers" | "body"> =
  K extends keyof O
    ? undefined extends O[K] ? { readonly [_ in K]?: Exclude<O[K], undefined> }
    : K extends "body" ? { readonly [_ in K]: O[K] }
    : {} extends O[K] ? { readonly [_ in K]?: O[K] }
    : { readonly [_ in K]: O[K] }
    : { readonly [_ in K]?: never };

/**
 * The second argument of a call to operation `O`. Its `path` leaves out the parameters of the
 * prefixes `Scope` that the operation's path is under, which a client made by {@link scopeTo}
 * fills itself.
 */
export type OperationInit<O extends Operation, Scope extends string = never> =
  PathField<O["path"], Scope> & Field<O, "query"> & Field<O, "headers"> & Field<O, "body">;

type InitArgs<O extends Operation, Scope extends string> =
  {} extends OperationInit<O, Scope> ? [init?: OperationInit<O, Scope>] : [init: OperationInit<O, Scope>];

type OperationAt<Ops extends Operation, P> = Extract<Ops, { readonly path: P }>;

/**
 * `P`, or `never` when it is a union. A call names one operation: over several, an argument only
 * some of them need would no longer be required.
 */
type One<P, All = P> = P extends unknown ? [All] extends [P] ? P : never : never;

/**
 * A client for schema `S`, with one method per HTTP method `S` declares. Each takes an operation's
 * path, written as in the schema, and its {@link OperationInit}, and resolves to its `response`.
 * `Scope` is the path prefixes whose parameters the client fills itself; see {@link scopeTo}.
 */
export type Client<S extends Schema, Scope extends string = never> = {
  readonly [M in keyof S as S[M] extends readonly Operation[] ? M : never]:
    S[M] extends readonly (infer Ops extends Operation)[]
      ? <P extends Ops["path"]>(path: P & One<P>, ...init: InitArgs<OperationAt<Ops, P>, Scope>)
          => Promise<OperationAt<Ops, P>["response"]>
      : never;
};

/** Every path of schema `S`. */
type PathOf<S extends Schema> =
  { [M in keyof S]: S[M] extends readonly (infer Ops extends Operation)[] ? Ops["path"] : never }[keyof S];

/** Path `P` and each of its leading runs of whole segments: `/a/{b}` gives `/a` and `/a/{b}`. */
type Leading<P extends string, Before extends string = ""> =
  P extends `/${infer Segment}/${infer Rest}`
    ? `${Before}/${Segment}` | Leading<`/${Rest}`, `${Before}/${Segment}`>
    : `${Before}${P}`;

/** Schema `S` without the operations outside prefixes `P`, and without a method left with none. */
type Within<S extends Schema, P extends string> = {
  readonly [M in keyof S as S[M] extends readonly { readonly path: infer Path }[]
    ? Extract<Path, Under<P>> extends never ? never : M
    : never]:
      S[M] extends readonly (infer Ops)[] ? readonly Extract<Ops, { readonly path: Under<P> }>[] : never;
};

/**
 * What {@link scopeTo} returns for a client of schema `S` and prefixes `P`: a client for the
 * operations at or below those prefixes, which fills the prefixes' path parameters itself.
 * `Scope` is the prefixes of the client it was made from, if that one was scoped too.
 * @example A field holding one organization's client is `ScopedClient<Api, "/orgs/{org}">`.
 */
export type ScopedClient<S extends Schema, P extends Leading<PathOf<S>>, Scope extends string = never> =
  Client<Within<S, P>, Scope | P>;

/** Settings for {@link createOpenAPIClient}. */
export type OpenAPIClientOptions = {
  /** Prefix every operation path is appended to, e.g. `https://api.example.com/v2`, with no query or fragment. */
  baseUrl: string;
  /**
   * Headers sent with every request, such as `Authorization`. The client calls this before each
   * request, so it can return a refreshed token. An operation's own headers override these.
   */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  /** Sends a request. Defaults to the global `fetch`. */
  fetch?: (request: Request) => Promise<Response>;
  /** Largest response body the client reads, in bytes. Defaults to `readTextCapped`'s limit. */
  maxResponseBytes?: number;
};

/** An {@link OperationInit} as the runtime sees it. */
type AnyInit = {
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, QueryValue | undefined>>;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
};

const METHODS: readonly Method[] = ["get", "post", "put", "delete", "patch"];

/**
 * Creates a typed client for schema `S`, which the caller names explicitly.
 *
 * The client encodes each path placeholder with `pathSegment`, which refuses an empty, `.` or `..`
 * value, and refuses a path that does not start with `/` or that has a `.` or `..` segment or
 * whitespace, any of which the URL parser could turn into another route or origin. It leaves out
 * query values that are `undefined`, sends each element of a query array as its own `name=value`
 * pair, and sends a body as JSON. It never follows a redirect, so headers never reach another origin. Any non-2xx reply, including a 3xx,
 * throws `HttpError` with its status, and the client cancels the body unread. A 2xx body is read up
 * to `maxResponseBytes` and parsed as JSON. An empty body resolves to `undefined`.
 * @param options Base URL, shared headers, transport, and response size limit.
 * @returns The client.
 *
 * @example
 * ```ts
 * type Api = {
 *   get: [
 *     { path: "/users/{id}"; query: { expand?: "teams" }; response: User },
 *     { path: "/users"; response: User[] },
 *   ];
 *   post: [{ path: "/users"; body: { name: string }; response: User }];
 * };
 *
 * const api = createOpenAPIClient<Api>({
 *   baseUrl: "https://api.example.com",
 *   headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
 * });
 * const user = await api.get("/users/{id}", { path: { id }, query: { expand: "teams" } });
 * ```
 */
export function createOpenAPIClient<const S extends Schema>(options: OpenAPIClientOptions): Client<S> {
  const client: Partial<Record<Method, (path: string, init?: AnyInit) => Promise<unknown>>> = {};
  // Trimmed once, and by hand: a regular expression is slow on a long run of slashes.
  let end = options.baseUrl.length;
  while (options.baseUrl[end - 1] === "/") end--;
  const baseUrl = options.baseUrl.slice(0, end);
  for (const method of METHODS) {
    // `options` as it was given: a copy would lose the `headers` and `fetch` of a class.
    client[method] = (path, init) => send(options, baseUrl, method, path, init ?? {});
  }
  return client as Client<S>;
}

/**
 * Narrows a client to the operations at or below the given path prefixes, and fixes each prefix's
 * path parameters. Use it for what a connection is bound to, such as one organization or project,
 * so that code holding the result can neither name another one nor call outside the prefixes.
 *
 * A prefix is the start of a schema path up to the end of a segment, written as in the schema, and
 * comes with a value for each of its parameters. The result's calls leave those parameters out of
 * paths under that prefix; a parameter of the same name in a path under another prefix is the
 * caller's to pass. The types are a convenience and the checks made on each call are the boundary:
 * the result throws for a path outside every prefix, and for a call that passes another value for
 * a fixed parameter. It reads `scope` once, when it is made. Scoping the result again narrows it
 * further.
 *
 * This covers paths only. Where an operation takes the organization or project in its query or
 * body, pass the fixed value there in the gatekeeper's own code.
 * @param client The client to narrow.
 * @param scope The path prefixes to keep, each with a value for each of its path parameters.
 * @returns The narrowed client.
 * @throws If a prefix's parameter has no value, or one `pathSegment` refuses.
 *
 * @example
 * ```ts
 * const project = scopeTo(api, { "/orgs/{org}/projects/{project}": { org, project } });
 * const issue = await project.get("/orgs/{org}/projects/{project}/issues/{id}", { path: { id } });
 * ```
 */
export function scopeTo<S extends Schema, Scope extends string, const P extends Leading<PathOf<S>>>(
  client: Client<S, Scope>,
  scope: { readonly [K in P]: PathParams<K> },
): ScopedClient<S, P, Scope> {
  const prefixes = Object.entries<Readonly<Record<string, unknown>>>(scope).map(([prefix, values]) => {
    // Without a prototype, here and for the merged parameters below, so that a parameter named
    // `__proto__` is kept and checked like any other.
    const fixed: Record<string, string | number> = Object.create(null);
    for (const [, name] of prefix.matchAll(/\{([^{}]+)\}/g)) {
      const value = values[name];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Path parameter "${name}" of the prefix "${prefix}" needs a value.`);
      }
      pathSegment(String(value));
      fixed[name] = value;
    }
    return { prefix, below: prefix.endsWith("/") ? prefix : `${prefix}/`, fixed };
  });
  const inner = client as Partial<Record<Method, (path: string, init?: AnyInit) => Promise<unknown>>>;
  const scoped: typeof inner = {};
  for (const method of METHODS) {
    scoped[method] = async (template, init = {}) => {
      const under = prefixes.filter(({ prefix, below }) => template === prefix || template.startsWith(below));
      if (under.length === 0) throw new Error(`The operation path "${template}" is outside this client's scope.`);
      const path: Record<string, string | number> = Object.assign(Object.create(null), init.path);
      for (const { fixed } of under) {
        for (const [name, value] of Object.entries(fixed)) {
          if (Object.hasOwn(path, name) && String(path[name]) !== String(value)) {
            throw new Error(`Path parameter "${name}" is fixed for this client.`);
          }
          path[name] = value;
        }
      }
      return await inner[method]!(template, { ...init, path });
    };
  }
  return scoped as ScopedClient<S, P, Scope>;
}

async function send(
  options: OpenAPIClientOptions, baseUrl: string, method: Method, template: string, init: AnyInit,
): Promise<unknown> {
  // Appended to the base URL, a path that does not start with "/" would extend its host or port.
  if (!template.startsWith("/")) throw new Error(`The operation path "${template}" must start with "/".`);
  const path = fillPath(template, init.path ?? {});
  // The URL parser resolves "." and ".." segments, which would move the request to another route.
  // It also drops tabs, newlines and surrounding spaces, which could otherwise hide such a segment.
  if (/[\0-\x20]/.test(path) || /(^|[/\\])(\.|%2e){1,2}([/\\?#]|$)/i.test(path)) {
    throw new Error(`The operation path "${template}" must not have a "." or ".." segment or whitespace.`);
  }
  const url = new URL(baseUrl + path);
  for (const [name, value] of Object.entries(init.query ?? {})) {
    if (value === undefined) continue;
    for (const element of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(element));
    }
  }

  const headers = new Headers(await options.headers?.());
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("accept", "application/json");

  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }

  // fetch upper-cases GET, POST, PUT and DELETE itself, but sends `patch` as written.
  const httpMethod = method.toUpperCase();
  const request = new Request(url, { method: httpMethod, headers, body, redirect: "manual" });
  const response = await (options.fetch ?? fetch)(request);

  // Errors name the path template, never the filled path or URL, which carry agent-supplied values.
  const operation = `${httpMethod} ${template}`;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(response.status, `${operation} failed with status ${response.status}.`);
  }
  const text = await readTextCapped(response, options.maxResponseBytes);
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${operation} returned a body that is not JSON.`);
  }
}

function fillPath(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(params, name)) {
      throw new Error(`Missing path parameter "${name}" for ${template}.`);
    }
    return pathSegment(String(params[name]));
  });
}
