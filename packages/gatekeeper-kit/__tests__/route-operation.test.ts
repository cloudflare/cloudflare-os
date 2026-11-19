import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ID, ONE, REST, routeEnds, routeOperation, type Routes, type Tree, unreachedRouteEnds,
} from "../src/route-operation";

const SHOP = "https://api.shop.example/v2";
const FILES = "https://files.shop.example/store/v1";

// A sample of every shape a tree has: nested resources and items, a verb as a segment and after a
// colon (of a resource and of an item), a verb with no resource, `ONE`, `REST`, and an empty tree
// at an end.
const ROUTES: Routes = [
  [`${SHOP}/`, {
    orders: {
      export: "POST",
      ":search": "GET",
      [ID]: {
        cancel: "POST",
        ":archive": "POST",
        items: { [ID]: { notes: {} } },
      },
    },
    customers: { [ID]: {} },
    settings: ONE,
    ping: "GET",
  }],
  [`${FILES}/`, {
    blobs: { [REST]: {} },
    buckets: { [ID]: { objects: { ":batchDelete": "POST", [ID]: {} } } },
  }],
];

// Each kind of request the sample names: its method, its URL and its name.
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${SHOP}/orders?status=open&limit=20`, "orders.list"],
  ["GET", `${SHOP}/orders/o-1001?expand=lines`, "orders.get"],
  ["POST", `${SHOP}/orders`, "orders.create"],
  ["PUT", `${SHOP}/orders/o-1001`, "orders.update"],
  ["PATCH", `${SHOP}/orders/o-1001`, "orders.patch"],
  ["DELETE", `${SHOP}/orders/o-1001`, "orders.delete"],
  ["POST", `${SHOP}/orders/export?format=csv`, "orders.export"],
  ["GET", `${SHOP}/orders:search?q=late`, "orders.search"],
  ["POST", `${SHOP}/orders/o-1001/cancel`, "orders.cancel"],
  ["POST", `${SHOP}/orders/o-1001:archive`, "orders.archive"],
  ["GET", `${SHOP}/orders/o-1001/items`, "items.list"],
  ["GET", `${SHOP}/orders/o-1001/items/7`, "items.get"],
  ["POST", `${SHOP}/orders/o-1001/items`, "items.create"],
  ["DELETE", `${SHOP}/orders/o-1001/items/7`, "items.delete"],
  ["GET", `${SHOP}/orders/o-1001/items/7/notes?limit=5`, "notes.list"],
  ["POST", `${SHOP}/orders/o-1001/items/7/notes`, "notes.create"],
  ["GET", `${SHOP}/customers?page=2`, "customers.list"],
  ["GET", `${SHOP}/customers/ada%40example.com`, "customers.get"],
  ["PATCH", `${SHOP}/customers/c-7`, "customers.patch"],
  ["GET", `${SHOP}/settings`, "settings.get"],
  ["PATCH", `${SHOP}/settings`, "settings.patch"],
  ["GET", `${SHOP}/ping`, "ping"],
  ["GET", `${FILES}/blobs?prefix=2024`, "blobs.list"],
  ["GET", `${FILES}/blobs/2024/receipts/r-1.pdf?download=1`, "blobs.get"],
  ["PUT", `${FILES}/blobs/2024/receipts/r-1.pdf`, "blobs.update"],
  ["DELETE", `${FILES}/blobs/r-1.pdf`, "blobs.delete"],
  ["GET", `${FILES}/buckets`, "buckets.list"],
  ["GET", `${FILES}/buckets/main`, "buckets.get"],
  ["GET", `${FILES}/buckets/main/objects?limit=100`, "objects.list"],
  ["GET", `${FILES}/buckets/main/objects/obj_1`, "objects.get"],
  ["POST", `${FILES}/buckets/main/objects:batchDelete`, "objects.batchDelete"],
];

// Requests the sample has no name for.
const UNNAMED: [method: string, url: string][] = [
  // A resource that is not in the tree, anywhere in the path.
  ["GET", `${SHOP}/refunds`],
  ["GET", `${SHOP}/orders/o-1001/refunds`],
  ["GET", `${SHOP}/orders/o-1001/refunds/r-1`],
  ["GET", `${FILES}/buckets/main/objects/obj_1/versions`],
  // And as the path's first resource, whatever known word follows it.
  ["GET", `${SHOP}/refunds/orders`],
  ["POST", `${SHOP}/refunds/export`],
  ["GET", `${FILES}/archives/blobs/r-1.pdf`],
  // A path that is not in the tree, though each of its words is.
  ["GET", `${SHOP}/orders/o-1001/notes`],
  ["GET", `${SHOP}/items`],
  ["GET", `${SHOP}/settings/orders`],
  // A verb that is not in the tree.
  ["POST", `${SHOP}/orders/o-1001:refund`],
  ["POST", `${SHOP}/orders:export`],
  ["GET", `${SHOP}/customers:search`],
  ["POST", `${FILES}/buckets/main:batchDelete`],
  // A verb under a method that is not its own, where the path has no ID.
  ["GET", `${SHOP}/orders/o-1001/cancel`],
  ["POST", `${SHOP}/ping`],
  ["POST", `${SHOP}/orders:search`],
  ["GET", `${SHOP}/orders/o-1001:archive`],
  ["GET", `${FILES}/buckets/main/objects:batchDelete`],
  // A verb that is not at the end of the path.
  ["POST", `${SHOP}/orders/o-1001/cancel/again`],
  ["GET", `${SHOP}/ping/pong`],
  ["GET", `${SHOP}/orders:search/o-1001`],
  // A resource with no items that is not at the end of the path.
  ["GET", `${SHOP}/settings/theme`],
  // An ID with a colon in it.
  ["GET", `${SHOP}/orders/o:1001`],
  // A root alone, with and without its slash.
  ["GET", `${SHOP}/`],
  ["POST", `${SHOP}/`],
  ["GET", SHOP],
  ["GET", `${FILES}/?list=1`],
  // A method that does nothing the names have a word for, and one that is not in upper case.
  ["HEAD", `${SHOP}/orders/o-1001`],
  ["HEAD", `${SHOP}/orders`],
  ["OPTIONS", `${SHOP}/orders/export`],
  ["get", `${SHOP}/orders`],
  ["post", `${SHOP}/orders/export`],
  ["", `${SHOP}/orders`],
  // A URL under no root.
  ["GET", "https://api.shop.example/v1/orders"],
  ["GET", "https://api.shop.example/orders"],
  ["GET", "http://api.shop.example/v2/orders"],
  ["GET", "https://api.shop.example:8443/v2/orders"],
  ["GET", "https://api.shop.example.attacker.example/v2/orders"],
  ["GET", "https://attacker.example/https://api.shop.example/v2/orders"],
  ["GET", "https://files.shop.example/v2/orders"],
  // A property every object has, where the path has no ID.
  ["GET", `${SHOP}/constructor`],
  ["GET", `${SHOP}/__proto__`],
  ["POST", `${SHOP}/toString`],
  ["GET", `${SHOP}/hasOwnProperty/valueOf`],
  ["GET", `${SHOP}/orders/o-1001/__proto__`],
  ["GET", `${SHOP}/orders/o-1001/constructor/items`],
  ["GET", `${SHOP}/orders/o-1001:constructor`],
  // The tree's own word for an ID, where the path has no ID.
  ["GET", `${SHOP}/{id}`],
  ["GET", `${SHOP}/orders/o-1001/{id}`],
  ["GET", `${FILES}/{id+}`],
];

function named(method: string, url: string): string | undefined {
  return routeOperation(ROUTES, method, new URL(url));
}

function keysOf(tree: Tree): string[] {
  return Object.entries(tree).flatMap(([key, child]) =>
    [key, ...(typeof child === "object" ? keysOf(child) : [])]);
}

// Every word a name can be made of: the tree's keys and the verbs an HTTP method stands for.
const WORDS = new Set([
  ...ROUTES.flatMap(([, tree]) => keysOf(tree)).filter(key => key !== ID && key !== REST)
    .map(key => key.replace(":", "")),
  "list", "get", "create", "update", "patch", "delete",
]);

describe("routeOperation", () => {
  it.each(REQUESTS)("%s %s is %s", (method, url, name) => {
    expect(named(method, url)).toBe(name);
  });

  it.each(UNNAMED)("has no name for %s %j", (method, url) => {
    expect(named(method, url)).toBeUndefined();
  });

  // An ID is passed over where the path has one, whatever it spells.
  it.each([
    ["GET", `${SHOP}/orders/orders`, "orders.get"],
    ["GET", `${SHOP}/orders/items/items/items`, "items.get"],
    ["GET", `${SHOP}/orders/customers/items/settings/notes`, "notes.list"],
    ["DELETE", `${SHOP}/customers/customers`, "customers.delete"],
    ["GET", `${FILES}/buckets/objects/objects/buckets`, "objects.get"],
    ["GET", `${FILES}/blobs/buckets/main/objects`, "blobs.get"],
    ["GET", `${FILES}/blobs/list/get`, "blobs.get"],
    // An ID that spells a verb is an ID still, where its resource has no such verb.
    ["GET", `${SHOP}/customers/export`, "customers.get"],
    ["GET", `${SHOP}/customers/cancel`, "customers.get"],
    ["GET", `${SHOP}/orders/cancel`, "orders.get"],
    ["GET", `${SHOP}/orders/ping/items/cancel`, "items.get"],
    ["PATCH", `${SHOP}/orders/o-1001/items/export`, "items.patch"],
    // And where it has one, under any method but the verb's own.
    ["GET", `${SHOP}/orders/export`, "orders.get"],
    ["DELETE", `${SHOP}/orders/export`, "orders.delete"],
    ["PATCH", `${SHOP}/orders/export?format=csv`, "orders.patch"],
    // Or under its method anywhere but at the end of the path.
    ["POST", `${SHOP}/orders/export/cancel`, "orders.cancel"],
    ["POST", `${SHOP}/orders/export/items`, "items.create"],
    ["POST", `${SHOP}/orders/export:archive`, "orders.archive"],
    ["GET", `${SHOP}/orders/export/items/7/notes`, "notes.list"],
    // An ID that spells a property every object has, or the tree's own word for an ID.
    ["GET", `${SHOP}/orders/constructor`, "orders.get"],
    ["GET", `${SHOP}/orders/__proto__/items`, "items.list"],
    ["DELETE", `${SHOP}/customers/toString`, "customers.delete"],
    ["GET", `${FILES}/buckets/hasOwnProperty/objects/valueOf`, "objects.get"],
    ["GET", `${FILES}/blobs/__proto__/constructor`, "blobs.get"],
    ["GET", `${SHOP}/orders/{id}`, "orders.get"],
    ["POST", `${SHOP}/orders/{id}/cancel`, "orders.cancel"],
    ["GET", `${FILES}/blobs/{id+}`, "blobs.get"],
  ])("%s %s is %s, with no ID in it", (method, url, name) => {
    expect(named(method, url)).toBe(name);
  });

  it("reads neither the query nor the fragment, and passes over empty segments", () => {
    expect(named("GET", `${SHOP}/orders/o-1001?x=/cancel:archive#/items`)).toBe("orders.get");
    expect(named("POST", `${SHOP}/orders?path=/export`)).toBe("orders.create");
    expect(named("GET", `${SHOP}/orders/`)).toBe("orders.list");
    expect(named("GET", `${SHOP}//orders//o-1001//items/`)).toBe("items.list");
  });

  it("reads a URL under the first root it starts with", () => {
    const routes: Routes = [
      [`${SHOP}/me/`, { orders: { [ID]: {} } }],
      [`${SHOP}/`, { [ID]: { orders: { latest: "GET" } }, me: { profile: ONE } }],
    ];
    const name = (url: string) => routeOperation(routes, "GET", new URL(url));
    expect(name(`${SHOP}/me/orders/latest`)).toBe("orders.get");
    expect(name(`${SHOP}/u-7/orders/latest`)).toBe("orders.latest");
    // The first root's tree has no such path, and the second root's is not read.
    expect(name(`${SHOP}/me/profile`)).toBeUndefined();
    expect(routeOperation([routes[1]], "GET", new URL(`${SHOP}/me/profile`))).toBe("profile.get");
  });

  it("reads a URL under a root it starts with, and not under one it holds further on", () => {
    // Any first segment is an ID here, so that the root alone decides.
    const routes: Routes = [[`${SHOP}/`, { [ID]: { v2: { orders: {} } } }]];
    const name = (url: string) => routeOperation(routes, "GET", new URL(url));
    expect(name(`${SHOP}/acct-1/v2/orders`)).toBe("orders.list");
    // Past the root's length, this address goes on `op.example/v2/orders`, which the tree names.
    const held = `http://x.test/${SHOP}/orders`;
    expect(held.slice(`${SHOP}/`.length)).toBe("op.example/v2/orders");
    expect(name(held)).toBeUndefined();
  });

  it("names a verb at the root by itself, and nothing where there are no routes", () => {
    const routes: Routes = [[`${SHOP}/`, { ":batch": "POST", health: "GET" }]];
    expect(routeOperation(routes, "POST", new URL(`${SHOP}/:batch`))).toBe("batch");
    expect(routeOperation(routes, "GET", new URL(`${SHOP}/health`))).toBe("health");
    expect(routeOperation(routes, "GET", new URL(`${SHOP}/:batch`))).toBeUndefined();
    expect(routeOperation([], "GET", new URL(`${SHOP}/health`))).toBeUndefined();
    expect(routeOperation([[`${SHOP}/`, {}]], "GET", new URL(`${SHOP}/health`))).toBeUndefined();
  });

  it("makes a name of the tree's keys alone, whatever the IDs hold", () => {
    const names = REQUESTS.map(([, , name]) => name);
    // Each ID a path can hold, where a key is looked for and where an ID is.
    const ids = [
      "secret-id", "ada%40example.com", "users%2F123", "a.b", "a:b", "o-1001:archive", "-",
      "Bearer%20abc", "..%2F..", "{id}",
    ];
    let unnamed = 0;
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      for (const id of ids) {
        for (const url of [
          `${SHOP}/orders/${id}`, `${SHOP}/${id}/orders`, `${SHOP}/orders/${id}/${id}`,
          `${SHOP}/orders/${id}/items/${id}/notes/${id}`, `${SHOP}/${id}`,
          `${FILES}/buckets/${id}/objects/${id}`, `${FILES}/blobs/${id}/${id}`, `${FILES}/${id}`,
        ]) {
          const name = named(method, `${url}?token=${id}&q=${id}#${id}`);
          if (name === undefined) unnamed++;
          else names.push(name);
        }
      }
    }
    // Both kinds of answer are in the sample, so neither assertion below is of an empty set.
    expect(unnamed).toBeGreaterThan(100);
    expect(names.length).toBeGreaterThan(REQUESTS.length + 100);
    for (const name of new Set(names)) {
      expect(name.split(".").filter(word => !WORDS.has(word)), name).toEqual([]);
      // The shape of a metric word: a letter or digit, then letters, digits, dots, underscores
      // and hyphens.
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    }
  });

  it("is in a module that imports nothing", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/route-operation.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bfrom\s+["']/m);
  });
});

// The ends of the sample, with an address that ends at each and addresses that do not.
const ENDS: { path: string; method?: string; at: string; notAt: string[] }[] = [
  {
    path: `${SHOP}/orders/export`, method: "POST", at: `${SHOP}/orders/export`,
    notAt: [`${SHOP}/orders/exports`, `${SHOP}/orders/export/`, `${SHOP}/orders/o-1001/export`],
  },
  {
    path: `${SHOP}/orders:search`, method: "GET", at: `${SHOP}/orders:search`,
    notAt: [`${SHOP}/orders/search`, `${SHOP}/orders/:search`, `${SHOP}/orders:searches`],
  },
  {
    path: `${SHOP}/orders/{id}/cancel`, method: "POST", at: `${SHOP}/orders/o-1001/cancel`,
    notAt: [`${SHOP}/orders/cancel`, `${SHOP}/orders/a/b/cancel`, `${SHOP}/orders/o:1001/cancel`,
      `${SHOP}/orders//cancel`],
  },
  {
    path: `${SHOP}/orders/{id}:archive`, method: "POST", at: `${SHOP}/orders/o-1001:archive`,
    notAt: [`${SHOP}/orders:archive`, `${SHOP}/orders/o-1001/archive`, `${SHOP}/orders/a/b:archive`],
  },
  {
    path: `${SHOP}/orders/{id}/items/{id}/notes`, at: `${SHOP}/orders/o-1001/items/7/notes`,
    notAt: [`${SHOP}/orders/o-1001/items/notes`, `${SHOP}/orders/o-1001/items/7`,
      `${SHOP}/orders/o-1001/items/7/notes/n-1`],
  },
  {
    path: `${SHOP}/customers/{id}`, at: `${SHOP}/customers/ada%40example.com`,
    notAt: [`${SHOP}/customers`, `${SHOP}/customers/`, `${SHOP}/customers/c-7/orders`,
      `${SHOP}/customers/c:7`],
  },
  { path: `${SHOP}/settings`, at: `${SHOP}/settings`, notAt: [`${SHOP}/settings/theme`] },
  { path: `${SHOP}/ping`, method: "GET", at: `${SHOP}/ping`, notAt: [`${SHOP}/pingx`] },
  {
    path: `${FILES}/blobs/{id+}`, at: `${FILES}/blobs/2024/receipts/r:1.pdf`,
    notAt: [`${FILES}/blobs`, `${FILES}/blobs/`, `${SHOP}/blobs/r-1.pdf`],
  },
  {
    path: `${FILES}/buckets/{id}/objects:batchDelete`, method: "POST",
    at: `${FILES}/buckets/main/objects:batchDelete`,
    notAt: [`${FILES}/buckets/objects:batchDelete`, `${FILES}/buckets/main/objects/obj_1:batchDelete`],
  },
  {
    path: `${FILES}/buckets/{id}/objects/{id}`, at: `${FILES}/buckets/main/objects/obj_1`,
    notAt: [`${FILES}/buckets/main/objects`, `${FILES}/buckets/main/objects/a/b`],
  },
];

describe("routeEnds", () => {
  it("lists where each path of every tree ends, with the method of a verb", () => {
    expect(routeEnds(ROUTES).map(({ path, method }) => ({ path, method })))
      .toEqual(ENDS.map(({ path, method }) => ({ path, method })));
  });

  it.each(ENDS)("matches the addresses that end at $path, and no other", ({ path, at, notAt }) => {
    const end = routeEnds(ROUTES).find(candidate => candidate.path === path);
    expect(end?.url.test(at)).toBe(true);
    for (const address of notAt) expect(end?.url.test(address), address).toBe(false);
    // A dot of the root is a dot, and the address is matched from its start.
    expect(end?.url.test(at.replace("shop.example", "shopxexample"))).toBe(false);
    expect(end?.url.test(`https://attacker.example/${at}`)).toBe(false);
  });

  it.each(ENDS)("ends $path where routeOperation names a request", ({ path, method, at }) => {
    // The end's own path is an address too, its braces being an ID like any other.
    for (const address of [at, path]) {
      const name = named(method ?? "GET", address);
      expect(name, address).toBeDefined();
      expect(REQUESTS.map(([, , rowName]) => rowName)).toContain(name);
    }
  });

  it("reads a root and a key as they are written", () => {
    const routes: Routes = [
      ["https://api.shop.example/v2.1/(beta)/", { "a+b": { [ID]: {} }, "what?": ONE, $batch: "POST" }],
    ];
    const ends = routeEnds(routes);
    expect(ends.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "https://api.shop.example/v2.1/(beta)/a+b/{id}", method: undefined },
      { path: "https://api.shop.example/v2.1/(beta)/what?", method: undefined },
      { path: "https://api.shop.example/v2.1/(beta)/$batch", method: "POST" },
    ]);
    expect(ends[0].url.test("https://api.shop.example/v2.1/(beta)/a+b/x")).toBe(true);
    expect(ends[0].url.test("https://api.shop.example/v2x1/(beta)/a+b/x")).toBe(false);
    expect(ends[0].url.test("https://api.shop.example/v2.1/beta/a+b/x")).toBe(false);
    expect(ends[0].url.test("https://api.shop.example/v2.1/(beta)/aab/x")).toBe(false);
    expect(ends[1].url.test("https://api.shop.example/v2.1/(beta)/what?")).toBe(true);
    expect(ends[1].url.test("https://api.shop.example/v2.1/(beta)/wha")).toBe(false);
    expect(ends[2].url.test("https://api.shop.example/v2.1/(beta)/$batch")).toBe(true);
  });

  it("joins a verb after a colon to the root, and ends an empty tree at its root", () => {
    const ends = routeEnds([
      [`${SHOP}/`, { ":batch": "POST" }],
      [`${FILES}/`, {}],
    ]);
    expect(ends.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: `${SHOP}/:batch`, method: "POST" },
      { path: `${FILES}/`, method: undefined },
    ]);
    expect(ends[0].url.test(`${SHOP}/:batch`)).toBe(true);
    expect(ends[0].url.test(`${SHOP}:batch`)).toBe(false);
    expect(routeOperation([[`${SHOP}/`, { ":batch": "POST" }]], "POST", new URL(`${SHOP}/:batch`)))
      .toBe("batch");
    expect(ends[1].url.test(`${FILES}/`)).toBe(true);
    expect(ends[1].url.test(`${FILES}/blobs`)).toBe(false);
  });

  it("ends a path at the rest of it, whatever is written under that", () => {
    const routes: Routes = [[`${FILES}/`, { blobs: { [REST]: { versions: { [ID]: {} } } } }]];
    const ends = routeEnds(routes);
    expect(ends.map(({ path, method }) => ({ path, method })))
      .toEqual([{ path: `${FILES}/blobs/{id+}`, method: undefined }]);
    expect(ends[0].url.test(`${FILES}/blobs/a/versions/3`)).toBe(true);
    expect(routeOperation(routes, "GET", new URL(`${FILES}/blobs/a/versions/3`))).toBe("blobs.get");
  });

  it("has no end where there are no routes", () => {
    expect(routeEnds([])).toEqual([]);
  });

  it("lists the ends tree after tree, each tree's in the order its keys are read in", () => {
    const ends = routeEnds([
      [`${SHOP}/`, { b: {}, 2: {}, a: {}, 1: {} }],
      [`${FILES}/`, { c: {} }],
    ]);
    // `Object.entries` gives the keys that are whole numbers first, in ascending order.
    expect(ends.map(({ path }) => path))
      .toEqual([`${SHOP}/1`, `${SHOP}/2`, `${SHOP}/b`, `${SHOP}/a`, `${FILES}/c`]);
  });
});

// The sample's requests but those of one name.
function without(name: string): typeof REQUESTS {
  return REQUESTS.filter(([, , rowName]) => rowName !== name);
}

describe("unreachedRouteEnds", () => {
  it("is empty for a table with a row at each end", () => {
    expect(unreachedRouteEnds(ROUTES, REQUESTS)).toEqual([]);
  });

  it("is every end for a table with no rows", () => {
    expect(unreachedRouteEnds(ROUTES, [])).toEqual(ENDS.map(({ path }) => path));
  });

  it.each(ENDS)("has $path once the rows that reach it are removed", ({ path, method, at }) => {
    const end = routeEnds(ROUTES).find(candidate => candidate.path === path);
    const kept = REQUESTS.filter(([rowMethod, rowUrl]) =>
      !(end?.url.test(rowUrl.split("?")[0]) && (method ?? rowMethod) === rowMethod));
    expect(kept.length).toBeLessThan(REQUESTS.length);
    expect(unreachedRouteEnds(ROUTES, kept)).toEqual([path]);
    // And not once a row to it is back.
    expect(unreachedRouteEnds(ROUTES, [...kept, [method ?? "GET", at]])).toEqual([]);
  });

  it("removing one row leaves its end unreached", () => {
    expect(unreachedRouteEnds(ROUTES, without("orders.export"))).toEqual([`${SHOP}/orders/export`]);
    expect(unreachedRouteEnds(ROUTES, without("settings.get"))).toEqual([]);
    expect(unreachedRouteEnds(ROUTES, without("settings.get").filter(([, , name]) =>
      name !== "settings.patch"))).toEqual([`${SHOP}/settings`]);
    expect(unreachedRouteEnds(ROUTES, without("objects.batchDelete")))
      .toEqual([`${FILES}/buckets/{id}/objects:batchDelete`]);
  });

  it("reaches a verb under its own method alone, and any other end under any", () => {
    const routes: Routes = [[`${SHOP}/`, { orders: { export: "POST" }, customers: { [ID]: {} } }]];
    const verb = `${SHOP}/orders/export`;
    const item = `${SHOP}/customers/{id}`;
    expect(unreachedRouteEnds(routes, [["GET", verb]])).toEqual([verb, item]);
    expect(unreachedRouteEnds(routes, [["post", verb]])).toEqual([verb, item]);
    expect(unreachedRouteEnds(routes, [["POST", verb]])).toEqual([item]);
    expect(unreachedRouteEnds(routes, [["DELETE", `${SHOP}/customers/c-7`]])).toEqual([verb]);
    expect(unreachedRouteEnds(routes, [["HEAD", `${SHOP}/customers/c-7`], ["POST", verb]]))
      .toEqual([]);
  });

  it("reaches the end of an item by a row to a verb beside it, an ID being any segment", () => {
    const routes: Routes = [[`${SHOP}/`, { orders: { export: "POST", [ID]: {} } }]];
    expect(unreachedRouteEnds(routes, [["POST", `${SHOP}/orders/export`]])).toEqual([]);
    expect(unreachedRouteEnds(routes, [["GET", `${SHOP}/orders/export`]]))
      .toEqual([`${SHOP}/orders/export`]);
  });

  it("reaches the end of an item by a row to a resource beside it, and a REST end by any rest", () => {
    const beside: Routes = [[`${SHOP}/`, { orders: { [ID]: {}, drafts: { [ID]: {} } } }]];
    // No row is an item of `orders`: the first is named `drafts.list`.
    const rows: [method: string, url: string][] = [
      ["GET", `${SHOP}/orders/drafts`], ["GET", `${SHOP}/orders/drafts/d-1`],
    ];
    expect(rows.map(([method, url]) => routeOperation(beside, method, new URL(url))))
      .toEqual(["drafts.list", "drafts.get"]);
    expect(unreachedRouteEnds(beside, rows)).toEqual([]);
    expect(unreachedRouteEnds(beside, rows.slice(1))).toEqual([`${SHOP}/orders/{id}`]);

    // The rest of a path that begins with a colon has no name, and reaches the end all the same.
    expect(named("GET", `${FILES}/blobs/:b`)).toBeUndefined();
    expect(unreachedRouteEnds(ROUTES, [...without("blobs.get").filter(([, , name]) =>
      !name.startsWith("blobs.")), ["GET", `${FILES}/blobs/:b`]])).toEqual([]);
  });

  it("reads a row's address without the empty segments under its root, as routeOperation does", () => {
    const routes: Routes = [
      [`${SHOP}/`, { orders: { export: "POST", [ID]: { items: {} } } }],
      [`${FILES}/`, {}],
    ];
    const ends = [`${SHOP}/orders/export`, `${SHOP}/orders/{id}/items`, `${FILES}/`];
    const rows: [method: string, url: string, name: string | undefined][] = [
      ["POST", `${SHOP}/orders/export/?format=csv`, "orders.export"],
      ["GET", `${SHOP}//orders//o-1001/items//`, "items.list"],
      ["GET", `${FILES}//`, undefined],
    ];
    expect(rows.map(([method, url]) => routeOperation(routes, method, new URL(url))))
      .toEqual(rows.map(([, , name]) => name));
    expect(unreachedRouteEnds(routes, rows)).toEqual([]);
    expect(unreachedRouteEnds(routes, rows.slice(1))).toEqual([ends[0]]);
    expect(unreachedRouteEnds(routes, [rows[0], rows[2]])).toEqual([ends[1]]);

    // An empty segment that is not under the root is not passed over: the URL is under no root.
    const before = "https://api.shop.example//v2/orders/export";
    expect(routeOperation(routes, "POST", new URL(before))).toBeUndefined();
    expect(unreachedRouteEnds(routes, [["POST", before]])).toEqual(ends);
  });

  it("reads a row's method and URL alone, the URL as an address", () => {
    const routes: Routes = [[`${SHOP}/`, { orders: { export: "POST" } }]];
    const end = `${SHOP}/orders/export`;
    expect(unreachedRouteEnds(routes, [["POST", `${end}?format=csv#top`]])).toEqual([]);
    expect(unreachedRouteEnds(routes, [["POST", new URL(`${end}?format=csv`)]])).toEqual([]);
    expect(unreachedRouteEnds(routes, [["POST", "HTTPS://API.SHOP.EXAMPLE:443/v2/orders/export"]]))
      .toEqual([]);
    expect(unreachedRouteEnds(routes, [["POST", end, "orders.export", { body: "{}" }, 201]]))
      .toEqual([]);
    // What is not the end's address, in the query or anywhere else, reaches nothing.
    expect(unreachedRouteEnds(routes, [
      ["POST", `${SHOP}/orders?next=${end}`], ["POST", "/v2/orders/export"], ["POST", ""],
      ["POST", `${end}/again`], ["POST", `https://attacker.example/${end}`],
    ])).toEqual([end]);
  });
});
