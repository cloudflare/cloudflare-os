import { describe, expect, it } from "vitest";
import { type Client, createOpenAPIClient, type ScopedClient, scopeTo } from "../src/http";
import { HttpError } from "../src/http-errors";

type User = { id: string; name: string };

type Api = {
  get: [
    { path: "/users/{id}"; query: { expand?: "teams"; limit?: number }; response: User },
    { path: "/users/me"; response: { me: true } },
    { path: "/users"; query: { labels?: readonly string[] }; response: User[] },
    { path: "/orgs/{org}/users/{id}"; response: User },
    { path: "/orgs/{org}/members"; response: User[] },
    { path: "/orgs/{org}/projects/{project}/issues/{id}"; response: { title: string } },
  ];
  post: [
    { path: "/users"; headers: { From: string }; body: { name?: string }; response: User },
    { path: "/orgs/{org}/members"; body: { name: string }; response: User },
  ];
  patch: [{ path: "/users/{id}"; body: { name: string }; response: User }];
  delete: [{ path: "/users/{id}"; response: undefined }];
};

function harness(reply: () => Response = () => Response.json({ id: "1", name: "Ada" })) {
  const requests: Request[] = [];
  const api = createOpenAPIClient<Api>({
    baseUrl: "https://api.example.com/v2/",
    headers: () => ({ Authorization: "Bearer token", From: "default@example.com" }),
    fetch: async request => {
      requests.push(request);
      return reply();
    },
  });
  return { api, requests };
}

describe("createOpenAPIClient", () => {
  it("fills path placeholders, drops undefined query values, and parses the reply", async () => {
    const { api, requests } = harness();    
    const user = await api.get("/users/{id}", {
      path: { id: "a b/c" }, query: { expand: "teams", limit: undefined },
    });
    expect(user).toEqual({ id: "1", name: "Ada" });
    expect(requests[0].url).toBe("https://api.example.com/v2/users/a%20b%2Fc?expand=teams");
    expect(requests[0].method).toBe("GET");
    expect(requests[0].redirect).toBe("manual");
    expect(requests[0].headers.get("authorization")).toBe("Bearer token");
    expect(requests[0].headers.get("accept")).toBe("application/json");
  });

  it("sends each element of a query array as its own pair", async () => {
    const { api, requests } = harness();
    await api.get("/users", { query: { labels: ["bug", "help wanted"] } });
    expect(requests[0].url).toBe("https://api.example.com/v2/users?labels=bug&labels=help+wanted");
  });

  it("fills every placeholder of a nested path", async () => {
    const { api, requests } = harness();
    await api.get("/orgs/{org}/users/{id}", { path: { org: "acme", id: 7 } });
    expect(requests[0].url).toBe("https://api.example.com/v2/orgs/acme/users/7");
  });

  it("sends a JSON body, and operation headers override shared ones", async () => {
    const { api, requests } = harness();
    await api.post("/users", { headers: { From: "me@example.com" }, body: { name: "Ada" } });
    expect(requests[0].headers.get("content-type")).toBe("application/json");
    expect(requests[0].headers.get("from")).toBe("me@example.com");
    expect(await requests[0].json()).toEqual({ name: "Ada" });
  });

  it("sends the method upper-cased, PATCH included", async () => {
    const { api, requests } = harness();
    await api.patch("/users/{id}", { path: { id: "1" }, body: { name: "Ada" } });
    expect(requests[0].method).toBe("PATCH");
  });

  it("refuses dot and empty path segments before sending", async () => {
    const { api, requests } = harness();
    await expect(api.get("/users/{id}", { path: { id: ".." } })).rejects.toThrow("dot segments");
    await expect(api.get("/users/{id}", { path: { id: "" } })).rejects.toThrow("empty");
    expect(requests).toHaveLength(0);
  });

  it("refuses a missing path parameter", async () => {
    const { api } = harness();
    await expect(api.get("/users/{id}", { path: {} } as never))
      .rejects.toThrow('Missing path parameter "id" for /users/{id}.');
  });

  it("throws HttpError for a non-2xx reply, naming the template rather than the URL", async () => {
    const { api } = harness(() => new Response("secret detail", { status: 404 }));
    const error = await api.get("/users/{id}", { path: { id: "private-id" } }).catch(e => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("GET /users/{id} failed with status 404.");
  });

  it("treats a redirect as a failure", async () => {
    const { api } = harness(() =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }));
    await expect(api.get("/users")).rejects.toMatchObject({ status: 302 });
  });

  it("resolves an empty reply to undefined", async () => {
    const { api } = harness(() => new Response(null, { status: 204 }));
    expect(await api.delete("/users/{id}", { path: { id: "1" } })).toBeUndefined();
  });

  it("refuses a body that is not JSON", async () => {
    const { api } = harness(() => new Response("<html>", { status: 200 }));
    await expect(api.get("/users")).rejects.toThrow("GET /users returned a body that is not JSON.");
  });

  it("refuses a path that would change the base URL's origin", async () => {
    const { api, requests } = harness();
    // The types allow only the schema's paths; code without them must not reach another origin.
    const get = api.get as (path: string) => Promise<unknown>;
    for (const path of [".evil.example/users", ":8443/users", "@evil.example/users", "users"]) {
      await expect(get(path)).rejects.toThrow('must start with "/"');
    }
    expect(requests).toHaveLength(0);
  });

  it("refuses a path with a dot segment, which the URL would resolve to another route", async () => {
    const { api, requests } = harness();
    const get = api.get as (path: string, init?: object) => Promise<unknown>;
    const paths = [
      "/users/../orgs", "/users/{id}/..", "/users/./me", "/users/%2e%2e/orgs", "/users/.%2E/orgs",
      "/users\\..\\orgs", "/users/..?x", "/users/..#x",
      // The URL parser drops these characters, leaving a dot segment behind.
      "/users/.\t./orgs", "/users/..\n", "/users/.. ",
    ];
    for (const path of paths) {
      await expect(get(path, { path: { id: "1" } })).rejects.toThrow('must not have a "." or ".." segment');
    }
    expect(requests).toHaveLength(0);
    // A dot inside a segment, or a value that only looks like one once decoded, is an ordinary path.
    await get("/users/{id}", { path: { id: "%2e%2e" } });
    await get("/users/{id}", { path: { id: "a..b" } });
    expect(requests.map(request => request.url)).toEqual([
      "https://api.example.com/v2/users/%252e%252e", "https://api.example.com/v2/users/a..b",
    ]);
  });

  it("refuses a reply over the byte cap", async () => {
    const api = createOpenAPIClient<Api>({
      baseUrl: "https://api.example.com",
      maxResponseBytes: 4,
      fetch: async () => Response.json([1, 2, 3]),
    });
    await expect(api.get("/users")).rejects.toThrow("exceeded 4 bytes");
  });

  it("calls the headers and fetch of options that are a class's", async () => {
    const requests: Request[] = [];
    class Transport {
      baseUrl = "https://api.example.com/v2//";
      headers() { return { Authorization: "Bearer token" }; }
      async fetch(request: Request) {
        requests.push(request);
        return Response.json([]);
      }
    }
    await createOpenAPIClient<Api>(new Transport()).get("/users");
    expect(requests[0].url).toBe("https://api.example.com/v2/users");
    expect(requests[0].headers.get("Authorization")).toBe("Bearer token");
  });
});

describe("scopeTo", () => {
  it("fills a prefix's parameters, which calls leave out", async () => {
    const { api, requests } = harness();
    const org = scopeTo(api, { "/orgs/{org}": { org: "acme" } });
    await org.get("/orgs/{org}/members");
    await org.get("/orgs/{org}/users/{id}", { path: { id: 7 } });
    await org.post("/orgs/{org}/members", { body: { name: "Ada" } });
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.example.com/v2/orgs/acme/members",
      "GET https://api.example.com/v2/orgs/acme/users/7",
      "POST https://api.example.com/v2/orgs/acme/members",
    ]);
  });

  it("refuses a path outside every prefix", async () => {
    const { api, requests } = harness();
    const org = scopeTo(api, { "/orgs/{org}": { org: "acme" } });
    const get = org.get as (path: string, init?: object) => Promise<unknown>;
    for (const path of ["/users", "/orgs", "/orgs/{org}x/members", "/orgs/{other}/members"]) {
      await expect(get(path, { path: { other: "rival" } })).rejects.toThrow("outside this client's scope");
    }
    // The client refuses the dot segment that would lead back out of the prefix.
    await expect(get("/orgs/{org}/../../users")).rejects.toThrow('must not have a "." or ".." segment');
    expect(requests).toHaveLength(0);
  });

  it("refuses a call that passes another value for a fixed parameter", async () => {
    const { api, requests } = harness();
    const org = scopeTo(api, { "/orgs/{org}": { org: "acme" } });
    const get = org.get as (path: string, init?: object) => Promise<unknown>;
    await expect(get("/orgs/{org}/users/{id}", { path: { org: "rival", id: 7 } }))
      .rejects.toThrow('Path parameter "org" is fixed for this client.');
    expect(requests).toHaveLength(0);
  });

  it("fixes a parameter only under its own prefix", async () => {
    const { api, requests } = harness();
    // Both paths name their parameter "id", and only the user is fixed.
    const scoped = scopeTo(api, { "/users/{id}": { id: "ada" }, "/orgs/{org}": { org: "acme" } });
    await scoped.get("/users/{id}");
    await scoped.get("/orgs/{org}/users/{id}", { path: { id: "grace" } });
    expect(requests.map(request => request.url)).toEqual([
      "https://api.example.com/v2/users/ada", "https://api.example.com/v2/orgs/acme/users/grace",
    ]);
  });

  // An object's own `__proto__`, as `JSON.parse` makes it, is a parameter like any other.
  it("fixes and checks a parameter named __proto__", async () => {
    const { api, requests } = harness();
    const prefix = "/orgs/{__proto__}" as "/orgs/{org}";
    const users = `${prefix}/users/{id}` as "/orgs/{org}/users/{id}";
    const org = scopeTo(api, { [prefix]: JSON.parse('{"__proto__":"acme"}') } as { "/orgs/{org}": { org: string } });
    await org.get(users, { path: { id: 7 } });
    expect(requests[0].url).toBe("https://api.example.com/v2/orgs/acme/users/7");
    await expect(org.get(users, { path: JSON.parse('{"__proto__":"rival","id":7}') }))
      .rejects.toThrow('Path parameter "__proto__" is fixed for this client.');
  });

  it("reads its scope once, and refuses a prefix whose parameter has no usable value", async () => {
    const { api, requests } = harness();
    const values = { org: "acme", id: "unrelated" };
    const org = scopeTo(api, { "/orgs/{org}": values });
    values.org = "rival";
    // A value that names no parameter of the prefix fixes nothing.
    await org.get("/orgs/{org}/users/{id}", { path: { id: 7 } });
    expect(requests[0].url).toBe("https://api.example.com/v2/orgs/acme/users/7");
    expect(() => scopeTo(api, { "/orgs/{org}": { org: ".." } })).toThrow("dot segments");
    expect(() => scopeTo(api, { "/orgs/{org}": { org: "" } })).toThrow("empty");
    expect(() => scopeTo(api, { "/orgs/{org}": {} as { org: string } })).toThrow('"org" of the prefix "/orgs/{org}" needs a value');
    expect(() => scopeTo(api, { "/orgs/{org}": { org: undefined as unknown as string } })).toThrow("needs a value");
  });

  it("narrows further when applied to a scoped client", async () => {
    const { api, requests } = harness();
    const org = scopeTo(api, { "/orgs/{org}": { org: "acme" } });
    const project = scopeTo(org, { "/orgs/{org}/projects/{project}": { org: "acme", project: "web" } });
    await project.get("/orgs/{org}/projects/{project}/issues/{id}", { path: { id: 3 } });
    expect(requests[0].url).toBe("https://api.example.com/v2/orgs/acme/projects/web/issues/3");
    const get = project.get as (path: string) => Promise<unknown>;
    await expect(get("/orgs/{org}/members")).rejects.toThrow("outside this client's scope");
    // The first scope still holds: a narrower one cannot name another organization.
    const rival = scopeTo(org, { "/orgs/{org}/projects/{project}": { org: "rival", project: "web" } });
    await expect(rival.get("/orgs/{org}/projects/{project}/issues/{id}", { path: { id: 3 } }))
      .rejects.toThrow('Path parameter "org" is fixed for this client.');
    expect(requests).toHaveLength(1);
  });

  it("treats a prefix that ends in a slash like one that does not", async () => {
    const requests: string[] = [];
    const api = createOpenAPIClient<{ get: [{ path: "/orgs/{org}/"; response: unknown }, { path: "/orgs/{org}/teams/"; response: unknown }] }>({
      baseUrl: "https://api.example.com",
      fetch: async request => (requests.push(request.url), Response.json({})),
    });
    const org = scopeTo(api, { "/orgs/{org}/": { org: "acme" } });
    await org.get("/orgs/{org}/");
    await org.get("/orgs/{org}/teams/");
    expect(requests).toEqual(["https://api.example.com/orgs/acme/", "https://api.example.com/orgs/acme/teams/"]);
  });
});

// Compile-time checks only; never called.
async function typeChecks(api: ReturnType<typeof createOpenAPIClient<Api>>, id: string) {
  const user: User = await api.get("/users/{id}", { path: { id } });
  const me: { me: true } = await api.get("/users/me");
  const users: User[] = await api.get("/users");
  void [user, me, users];

  // @ts-expect-error the path object is required when the path has placeholders
  await api.get("/users/{id}");
  // @ts-expect-error every placeholder needs a value
  await api.get("/orgs/{org}/users/{id}", { path: { org: "acme" } });
  // @ts-expect-error a path without placeholders takes no path object
  await api.get("/users", { path: { id } });
  // @ts-expect-error paths are verbatim templates, not filled strings
  await api.get(`/users/${id}`);
  // @ts-expect-error a declared body is required, even with no required members
  await api.post("/users", { headers: { From: "me@example.com" } });
  // @ts-expect-error an operation that declares no body takes none
  await api.get("/users", { body: {} });
  // @ts-expect-error the schema declares no put
  void api.put;
  // @ts-expect-error a call names one path: over several, `path` would not be required
  await api.get("/users" as "/users" | "/users/{id}");
}
void typeChecks;

async function scopeTypeChecks(api: Client<Api>, org: string, id: string) {
  const scoped = scopeTo(api, { "/orgs/{org}": { org } });
  const named: ScopedClient<Api, "/orgs/{org}"> = scoped;
  const members: User[] = await scoped.get("/orgs/{org}/members");
  const user: User = await scoped.get("/orgs/{org}/users/{id}", { path: { id } });
  void [named, members, user];

  // @ts-expect-error a fixed parameter is not passed again
  await scoped.get("/orgs/{org}/users/{id}", { path: { org, id } });
  // @ts-expect-error the remaining parameters are still required
  await scoped.get("/orgs/{org}/users/{id}");
  // @ts-expect-error a path outside the prefix is not offered
  await scoped.get("/users");
  // @ts-expect-error a method with no operation under the prefix is not offered
  void scoped.delete;

  // @ts-expect-error a prefix is the start of a schema path
  scopeTo(api, { "/organizations/{org}": { org } });
  // @ts-expect-error a prefix ends where a segment does
  scopeTo(api, { "/orgs/{org}/proj": { org } });
  // @ts-expect-error every parameter in a prefix needs a value
  scopeTo(api, { "/orgs/{org}/projects/{project}": { org } });
  // @ts-expect-error a value needs a parameter in its prefix
  scopeTo(api, { "/orgs/{org}": { org, id } });
  // @ts-expect-error a named scope is checked against the schema too
  void (scoped as ScopedClient<Api, "/organizations/{org}">);

  // A parameter is fixed under its own prefix only, though another path names one the same.
  const mixed = scopeTo(api, { "/users/{id}": { id }, "/orgs/{org}": { org } });
  await mixed.get("/users/{id}");
  await mixed.get("/orgs/{org}/users/{id}", { path: { id } });
  // @ts-expect-error the organization's user is still the caller's to name
  await mixed.get("/orgs/{org}/users/{id}");

  const project = scopeTo(scoped, { "/orgs/{org}/projects/{project}": { org, project: "web" } });
  const issue: { title: string } =
    await project.get("/orgs/{org}/projects/{project}/issues/{id}", { path: { id } });
  void issue;
  // @ts-expect-error the second scope left this path out
  await project.get("/orgs/{org}/members");

  const reads = scopeTo(api as Client<Pick<Api, "get">>, { "/orgs/{org}": { org } });
  await reads.get("/orgs/{org}/members");
  // @ts-expect-error a client that could only read still can only read
  void reads.post;
}
void scopeTypeChecks;
