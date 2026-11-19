/**
 * Names a request by its HTTP method and URL, from a tree of the paths a gatekeeper calls, and
 * lists where the paths of such a tree end so that a test can prove each is requested. Pure: it
 * imports nothing and loads in Node as in a Worker.
 */

/** An item's ID, which is never read. */
export const ID = "{id}";
/** An ID that is the rest of the path, slashes included. */
export const REST = "{id+}";
/** A resource that has no items: a GET of it is a `get`. */
export const ONE = "one";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The paths under one root, as a tree whose keys are path segments. An object is a resource, its
 * `ID` key the tree under one of its items, and its `REST` key an item whose ID is the rest of the
 * path. A method is a verb the path spells out, as a segment (`modify` in `/threads/{id}/modify`)
 * or after a colon (the key `":search"` in `/spaces:search`), with the HTTP method that calls it.
 * `ONE` is a resource that has no items. An empty object is a resource, or an item, with nothing
 * named under it.
 */
export type Tree = { readonly [segment: string]: Tree | Method | typeof ONE };

/**
 * The paths a gatekeeper calls, as a `Tree` under each API's root, from which a request is named
 * (`routeOperation`). A root is the start of an address (a URL's origin and pathname), ending in
 * `/` so that it ends on a whole segment. A URL is read under the first root it starts with, so a
 * root that another starts with comes after it. A request to a path that is not here has no name:
 * add the path to name it.
 *
 * @example
 * ```ts
 * const ROUTES: Routes = [
 *   ["https://api.example.com/v1/", {
 *     threads: { [ID]: { modify: "POST", messages: { [ID]: {} } } },
 *     spaces: { ":search": "GET", [ID]: {} },
 *     profile: ONE,
 *     media: { [REST]: {} },
 *   }],
 * ];
 * ```
 */
export type Routes = readonly (readonly [prefix: string, tree: Tree])[];

// What a method does to a resource whose path has no verb of its own. A GET lists a resource and
// gets an item.
const METHOD_VERBS = new Map([
  ["POST", "create"], ["PUT", "update"], ["PATCH", "patch"], ["DELETE", "delete"],
]);

/**
 * The name `routes` give a request: the last resource in its path and what is done to it, as
 * `threads.modify` or `files.get`. What is done is the path's own verb where it has one, and the
 * method's otherwise: `list` for a GET of a resource and `get` of an item, `create`, `update`,
 * `patch` and `delete`. A verb is one under its own method and at the end of the path, and an ID
 * anywhere else. Undefined for a path that is not in `routes` and for a method with no such verb.
 * A name is put together from the trees' keys alone, so nothing a URL holds reaches one.
 * @param routes The trees to read the URL under.
 * @param method The request's HTTP method, in upper case.
 * @param url The request's URL; its query is not read.
 * @returns The request's name, or undefined where `routes` have none for it.
 *
 * @example
 * ```ts
 * routeOperation(ROUTES, "POST", new URL("https://api.example.com/v1/threads/18c2/modify"));
 * // "threads.modify"
 * routeOperation(ROUTES, "GET", new URL("https://api.example.com/v1/threads/18c2/messages?q=a"));
 * // "messages.list"
 * routeOperation(ROUTES, "GET", new URL("https://api.example.com/v1/labels")); // undefined
 * ```
 */
export function routeOperation(routes: Routes, method: string, url: URL): string | undefined {
  let address = url.origin + url.pathname;
  let route = routes.find(([prefix]) => address.startsWith(prefix));
  if (!route) return undefined;
  // A `word:verb` segment is two steps, the verb keeping its colon.
  let steps = address.slice(route[0].length).split("/").flatMap(segment => {
    let colon = segment.indexOf(":");
    return colon < 0 ? segment : [segment.slice(0, colon), segment.slice(colon)];
  }).filter(step => step !== "");

  let node = route[1];
  let resource: string | undefined;
  let verb: string | undefined;
  // Whether the path ends at an item, and not at the resource that holds it.
  let item = false;
  for (let at = 0; at < steps.length; at++) {
    let step = steps[at];
    // An own property only, so that an ID spelling `constructor` finds no child. The keys in
    // braces are found by no step: a URL's path holds its braces percent-encoded.
    let child = Object.hasOwn(node, step) ? node[step] : undefined;
    let items = node[ID];
    if (typeof child === "object") {
      resource = step;
      item = false;
      node = child;
    } else if (child === ONE && at === steps.length - 1) {
      resource = step;
      item = true;
    } else if (child === method && at === steps.length - 1) {
      // A verb is one under its own method and at the end of the path, and an ID anywhere else.
      verb = step.startsWith(":") ? step.slice(1) : step;
    } else if (step.startsWith(":")) {
      return undefined;
    } else if (typeof items === "object") {
      item = true;
      node = items;
    } else if (Object.hasOwn(node, REST)) {
      item = true;
      break;
    } else {
      return undefined;
    }
  }

  if (verb === undefined) {
    // A method does what it does to a resource, and the path of a root alone has none.
    if (resource === undefined) return undefined;
    verb = method === "GET" ? (item ? "get" : "list") : METHOD_VERBS.get(method);
    if (verb === undefined) return undefined;
  }
  return resource === undefined ? verb : `${resource}.${verb}`;
}

/** Where one path of a tree ends (see {@link routeEnds}). */
export type RouteEnd = {
  /** The root joined with the tree's keys down to the end, an ID as its `{id}` or `{id+}` word. */
  path: string;
  /**
   * Matches exactly the address (origin and pathname) of a request that ends there, written with
   * no empty segment: an `ID` is one path segment with no `:` in it, and a `REST` ID one or more
   * characters. `routeOperation` passes over the empty segments that a doubled or a closing slash
   * makes, and this does not: it matches no address that has one.
   */
  url: RegExp;
  /** The HTTP method that calls the verb the path ends at; absent where it ends at no verb. */
  method?: string;
};

/**
 * Where each path of every tree in `routes` ends: at an empty object, at a verb, at `ONE` and at a
 * `REST` ID. A resource or an item that has something under it is not an end, though requests to
 * it are named.
 * @param routes The trees to walk.
 * @returns The ends, tree after tree, each tree's in the order `Object.entries` gives its keys.
 *
 * @example
 * ```ts
 * routeEnds([["https://api.example.com/v1/", { threads: { [ID]: { modify: "POST" } } }]]);
 * // One end: its path is "https://api.example.com/v1/threads/{id}/modify", its method "POST", and
 * // its url matches "https://api.example.com/v1/threads/18c2/modify".
 * ```
 */
export function routeEnds(routes: Routes): RouteEnd[] {
  return routes.flatMap(([root, tree]) => endsOf(tree, root, literal(root)));
}

// The ends of `tree`, which is at `path`, whose addresses `pattern` matches.
function endsOf(tree: Tree, path: string, pattern: string): RouteEnd[] {
  const children = Object.entries(tree);
  if (children.length === 0) return [{ path, url: new RegExp(`^${pattern}$`) }];
  return children.flatMap(([key, child]): RouteEnd[] => {
    // A verb after a colon joins the segment before it, and a root ends in its own slash.
    const joint = key.startsWith(":") || path.endsWith("/") ? "" : "/";
    const to = path + joint + key;
    const segment = key === ID ? "[^/:]+" : key === REST ? ".+" : literal(key);
    const toPattern = pattern + joint + segment;
    const url = new RegExp(`^${toPattern}$`);
    // The rest of a path is an ID whatever it holds, so nothing under `REST` is walked to.
    if (key === REST || child === ONE) return [{ path: to, url }];
    return typeof child === "object" ? endsOf(child, to, toPattern) : [{ path: to, url, method: child }];
  });
}

// `text` as the source of a pattern that matches it alone.
function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * The `path` of every end of `routes` (`routeEnds`) that no row of `requests` reaches. A row
 * reaches an end when its URL's address (origin and pathname, so without the query) matches the
 * end's `url` and, where the end has a method, the row's method is that method. The address is
 * matched without the empty segments under its root, which `routeOperation` passes over, so a
 * row may end in a slash. A row whose URL cannot be parsed reaches none.
 *
 * An ID is whatever a segment spells, so a row can reach an end that `routeOperation` does not
 * end its path at: a row to a verb, or to a resource, reaches the end at an item beside it as
 * well, and a row reaches a `REST` end though the rest of its path begins with a colon, which
 * has no name. A gatekeeper's test of its request table asserts each row's name, and that the
 * result of this is empty, so that its tree and its table cannot drift apart.
 * @param routes The trees whose ends are to be reached.
 * @param requests Rows of an HTTP method in upper case, a URL, and anything further, which is not
 *   read.
 * @returns The unreached ends' paths, in the order of `routeEnds`.
 *
 * @example
 * ```ts
 * const REQUESTS: [method: string, url: string, name: string][] = [
 *   ["POST", "https://api.example.com/v1/threads/18c2/modify", "threads.modify"],
 * ];
 * expect(unreachedRouteEnds(ROUTES, REQUESTS)).toEqual([]);
 * ```
 */
export function unreachedRouteEnds(
  routes: Routes,
  requests: readonly (readonly [method: string, url: string | URL, ...rest: unknown[]])[],
): string[] {
  const sent = requests.flatMap(([method, url]) => {
    const parsed = typeof url === "string" ? URL.parse(url) : url;
    if (!parsed) return [];
    return [{ method, address: withoutEmptySegments(routes, parsed.origin + parsed.pathname) }];
  });
  return routeEnds(routes)
      .filter(end => !sent.some(({ method, address }) =>
        (end.method === undefined || end.method === method) && end.url.test(address)))
      .map(end => end.path);
}

// `address` without the empty segments under the root it is read under, which a doubled or a
// closing slash makes. An address under no root is left as it is.
function withoutEmptySegments(routes: Routes, address: string): string {
  const root = routes.find(([prefix]) => address.startsWith(prefix))?.[0];
  if (root === undefined) return address;
  return root + address.slice(root.length).split("/").filter(segment => segment !== "").join("/");
}
