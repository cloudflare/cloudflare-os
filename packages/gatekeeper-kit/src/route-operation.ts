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
  return walk(routes, method, url)?.name;
}

// Where the walk of a request's path stops: the request's name, and the end that the walk stopped
// at, where it stopped at one (see `routeEnds`), as the place of its tree in the routes and the
// keys from that tree's root down to the end.
type Walked = { name: string; end?: { tree: number; keys: readonly string[] } };

// Walks the path of a request down the tree of the first root its URL starts with. Undefined
// where the routes have no name for the request. `routeOperation` and `unreachedRouteEnds` read
// this one walk, so that a request is named and an end is reached by the same rules.
function walk(routes: Routes, method: string, url: URL): Walked | undefined {
  let address = url.origin + url.pathname;
  let tree = routes.findIndex(([prefix]) => address.startsWith(prefix));
  if (tree < 0) return undefined;
  let [root, node] = routes[tree];
  // A `word:verb` segment is two steps, the verb keeping its colon.
  let steps = address.slice(root.length).split("/").flatMap(segment => {
    let colon = segment.indexOf(":");
    return colon < 0 ? segment : [segment.slice(0, colon), segment.slice(colon)];
  }).filter(step => step !== "");

  let resource: string | undefined;
  let verb: string | undefined;
  // Whether the path ends at an item, and not at the resource that holds it.
  let item = false;
  // The tree's keys down to `node`, and those down to the end the walk stopped at where that is
  // not `node`.
  let keys: string[] = [];
  let end: string[] | undefined;
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
      keys.push(step);
    } else if (child === ONE && at === steps.length - 1) {
      resource = step;
      item = true;
      end = [...keys, step];
    } else if (child === method && at === steps.length - 1) {
      // A verb is one under its own method and at the end of the path, and an ID anywhere else.
      verb = step.startsWith(":") ? step.slice(1) : step;
      end = [...keys, step];
    } else if (step.startsWith(":")) {
      return undefined;
    } else if (typeof items === "object") {
      item = true;
      node = items;
      keys.push(ID);
    } else if (Object.hasOwn(node, REST)) {
      item = true;
      end = [...keys, REST];
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
  // A resource or an item is an end where it has nothing under it.
  if (end === undefined && Object.keys(node).length === 0) end = keys;
  return {
    name: resource === undefined ? verb : `${resource}.${verb}`,
    end: end === undefined ? undefined : { tree, keys: end },
  };
}

// `path` with `key` under it. A verb after a colon joins the segment before it, and a root ends
// in its own slash.
function under(path: string, key: string): string {
  return path + (key.startsWith(":") || path.endsWith("/") ? "" : "/") + key;
}

/**
 * Where one path of a tree ends (see {@link routeEnds}). Which requests end there is for
 * `routeOperation`'s walk to say, which is what `unreachedRouteEnds` asks.
 */
export type RouteEnd = {
  /** The root joined with the tree's keys down to the end, an ID as its `{id}` or `{id+}` word. */
  path: string;
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
 * // One end: its path is "https://api.example.com/v1/threads/{id}/modify" and its method "POST".
 * ```
 */
export function routeEnds(routes: Routes): RouteEnd[] {
  return routes.flatMap(([root, tree]) => endsOf(tree, []).map(({ keys, method }): RouteEnd => {
    const path = pathOf(root, keys);
    return method === undefined ? { path } : { path, method };
  }));
}

// An end of a tree, as the keys from the tree's root down to it and, of a verb, its method. The
// keys tell an end from every other of its tree, which its `path` does not: the key `a:x` and the
// key `:x` under `a` spell one path, and the walk of a request goes down the second alone.
type End = { keys: readonly string[]; method?: Method };

// The ends of `tree`, which is `keys` down from the root of its tree.
function endsOf(tree: Tree, keys: readonly string[]): End[] {
  const children = Object.entries(tree);
  if (children.length === 0) return [{ keys }];
  return children.flatMap(([key, child]): End[] => {
    const to = [...keys, key];
    // The rest of a path is an ID whatever it holds, so nothing under `REST` is walked to.
    if (key === REST || child === ONE) return [{ keys: to }];
    return typeof child === "object" ? endsOf(child, to) : [{ keys: to, method: child }];
  });
}

// The `path` of an end: its root joined with its keys.
function pathOf(root: string, keys: readonly string[]): string {
  return keys.reduce(under, root);
}

/**
 * The `path` of every end of `routes` (`routeEnds`) that no row of `requests` reaches. A row
 * reaches the end that `routeOperation`'s own walk of it stops at: the verb or the `ONE` its path
 * ends with, the `REST` ID its path runs into, or the resource or item with nothing under it that
 * its path ends at. The walk decides, and not the look of an address: a row to a verb or to a
 * resource does not reach the end at an item beside it, a verb is reached under its own method
 * alone, and a row may end in a slash, as the walk passes over empty segments.
 *
 * A row that `routeOperation` gives no name reaches nothing: one under a method that has no verb,
 * or one whose URL cannot be parsed. A URL is read under the first root it starts with, so no row
 * reaches an end of a tree whose root comes after another that its URLs start with. Nor does any
 * row reach the end at the root of an empty tree, where nothing has a name, or an end that the
 * walk stops at for no request, as that of a `REST` ID beside an `ID` is, and that of a key
 * that holds a slash, which no segment does. An end is the keys down to it, and not the path
 * they spell: the key `a:x` and the key `:x` under `a` spell one path, and a row to it reaches
 * the second alone. A gatekeeper's test of its request table asserts each row's name, and that
 * the result of this is empty, so that its tree and its table cannot drift apart.
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
  // The ends reached, tree by tree, each as its keys written out so that no two ends are written
  // alike: two trees may hold the same keys, and a URL is read under the first alone.
  const reached = routes.map(() => new Set<string>());
  for (const [method, url] of requests) {
    const parsed = typeof url === "string" ? URL.parse(url) : url;
    const end = parsed ? walk(routes, method, parsed)?.end : undefined;
    if (end) reached[end.tree].add(JSON.stringify(end.keys));
  }
  return routes.flatMap(([root, tree], at) => endsOf(tree, [])
    .filter(({ keys }) => !reached[at].has(JSON.stringify(keys)))
    .map(({ keys }) => pathOf(root, keys)));
}
