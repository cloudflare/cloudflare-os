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

type PathField<P extends string> =
  keyof PathParams<P> extends never ? { readonly path?: never } : { readonly path: PathParams<P> };

type Field<O, K extends "query" | "headers" | "body"> =
  K extends keyof O
    ? undefined extends O[K] ? { readonly [_ in K]?: Exclude<O[K], undefined> }
    : K extends "body" ? { readonly [_ in K]: O[K] }
    : {} extends O[K] ? { readonly [_ in K]?: O[K] }
    : { readonly [_ in K]: O[K] }
    : { readonly [_ in K]?: never };

/** The second argument of a call to operation `O`. */
export type OperationInit<O extends Operation> =
  PathField<O["path"]> & Field<O, "query"> & Field<O, "headers"> & Field<O, "body">;

type InitArgs<O extends Operation> =
  {} extends OperationInit<O> ? [init?: OperationInit<O>] : [init: OperationInit<O>];

type OperationAt<Ops extends Operation, P> = Extract<Ops, { readonly path: P }>;

/**
 * A client for schema `S`, with one method per HTTP method `S` declares. Each takes an operation's
 * path, written as in the schema, and its {@link OperationInit}, and resolves to its `response`.
 */
export type Client<S extends Schema> = {
  readonly [M in keyof S as S[M] extends readonly Operation[] ? M : never]:
    S[M] extends readonly (infer Ops extends Operation)[]
      ? <P extends Ops["path"]>(path: P, ...init: InitArgs<OperationAt<Ops, P>>)
          => Promise<OperationAt<Ops, P>["response"]>
      : never;
};

/** Settings for {@link createOpenAPIClient}. */
export type OpenAPIClientOptions = {
  /** Prefix every operation path is appended to, e.g. `https://api.example.com/v2`. */
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
 * value. It leaves out query values that are `undefined`, sends each element of a query array as
 * its own `name=value` pair, and sends a body as JSON. It never
 * follows a redirect, so headers never reach another origin. Any non-2xx reply, including a 3xx,
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
  for (const method of METHODS) {
    client[method] = (path, init) => send(options, method, path, init ?? {});
  }
  return client as Client<S>;
}

async function send(
  options: OpenAPIClientOptions, method: Method, template: string, init: AnyInit,
): Promise<unknown> {
  const url = new URL(options.baseUrl.replace(/\/+$/, "") + fillPath(template, init.path ?? {}));
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
