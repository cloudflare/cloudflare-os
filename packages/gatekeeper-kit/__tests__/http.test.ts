import { describe, expect, it } from "vitest";
import { createOpenAPIClient } from "../src/http";
import { HttpError } from "../src/http-errors";

type User = { id: string; name: string };

type Api = {
  get: [
    { path: "/users/{id}"; query: { expand?: "teams"; limit?: number }; response: User },
    { path: "/users/me"; response: { me: true } },
    { path: "/users"; query: { labels?: readonly string[] }; response: User[] },
    { path: "/orgs/{org}/users/{id}"; response: User },
  ];
  post: [{ path: "/users"; headers: { From: string }; body: { name?: string }; response: User }];
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

  it("refuses a reply over the byte cap", async () => {
    const api = createOpenAPIClient<Api>({
      baseUrl: "https://api.example.com",
      maxResponseBytes: 4,
      fetch: async () => Response.json([1, 2, 3]),
    });
    await expect(api.get("/users")).rejects.toThrow("exceeded 4 bytes");
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
}
void typeChecks;
