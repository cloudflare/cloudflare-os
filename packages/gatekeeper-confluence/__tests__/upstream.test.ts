// The requests this gatekeeper sends to Atlassian, the name each is counted under, and what the
// gatekeeper decides about a call that the client cannot know: which requests are sent once, how
// a 401 is answered, which redirect is acted on, and which operations are counted summed. These
// drive the real client against a stubbed fetch and read the points it writes.

import { env } from "cloudflare:workers";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { routeEnds, unreachedRouteEnds } from "@gadgets/gatekeeper-kit/route-operation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS } from "../../observability/src/metrics-schema";
import {
  ConfluenceApi, ConfluenceApiError, ConfluenceUnnamedCreationError, MAX_HELD_ERROR_BYTES, exchangeAuthCode,
  getAccessibleResources,
  getAtlassianIdentity, refreshAccessToken, type AccessibleResource,
} from "../src/confluence-api";
import { ConfluenceConfiguratorUI } from "../src/confluence-configurator";
import { ConfluenceAccessChecker } from "../src/confluence-observers";
import { checkConfluenceSubresourceAccess } from "../src/confluence-subresources";
import { CONFLUENCE_OPERATIONS, CONFLUENCE_ROUTES, confluenceUpstream } from "../src/confluence-upstream";

const CLOUD = "7f3a0000-0000-4000-8000-000000000001";
const GATEWAY = `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki`;
const V2 = `${GATEWAY}/api/v2`;
const V1 = `${GATEWAY}/rest/api`;
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const MEDIA_URL = "https://api.media.atlassian.com/file/41/image?token=signed";

// The parents whose content tree Confluence lists.
const TREE_PARENTS = ["pages", "folders", "whiteboards", "databases", "embeds"] as const;

/** Every kind of request the gatekeeper makes that its path names, with the name it is counted under. */
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", "https://api.atlassian.com/oauth/token/accessible-resources", "accessible-resources.list"],
  ["GET", "https://api.atlassian.com/me", "me.get"],
  ["GET", `${V2}/spaces?keys=ENG&limit=1&include-icon=true`, "spaces.list"],
  ["GET", `${V2}/spaces/10`, "spaces.get"],
  ["GET", `${V2}/spaces/10/pages?depth=root`, "pages.list"],
  ["GET", `${V2}/pages?id=1&limit=250`, "pages.list"],
  ["GET", `${V2}/pages/1?body-format=storage`, "pages.get"],
  ["POST", `${V2}/pages`, "pages.create"],
  ["PUT", `${V2}/pages/1`, "pages.update"],
  ["DELETE", `${V2}/pages/1`, "pages.delete"],
  ["GET", `${V2}/pages/1/children`, "children.list"],
  ["GET", `${V2}/pages/1/footer-comments?body-format=storage`, "footer-comments.list"],
  ["GET", `${V2}/pages/1/labels?limit=250`, "labels.list"],
  ["GET", `${V2}/pages/1/attachments`, "attachments.list"],
  ["GET", `${V2}/blogposts?space-id=10`, "blogposts.list"],
  ["GET", `${V2}/blogposts/2?body-format=storage`, "blogposts.get"],
  ["POST", `${V2}/blogposts`, "blogposts.create"],
  ["PUT", `${V2}/blogposts/2`, "blogposts.update"],
  ["DELETE", `${V2}/blogposts/2`, "blogposts.delete"],
  ["GET", `${V2}/blogposts/2/footer-comments?body-format=storage`, "footer-comments.list"],
  ["GET", `${V2}/blogposts/2/labels?limit=250`, "labels.list"],
  ["GET", `${V2}/blogposts/2/attachments`, "attachments.list"],
  ...TREE_PARENTS.flatMap((parent): [string, string, string][] => [
    ["GET", `${V2}/${parent}/1/direct-children`, "direct-children.list"],
    ["GET", `${V2}/${parent}/1/descendants?depth=2`, "descendants.list"],
  ]),
  ["POST", `${V2}/footer-comments`, "footer-comments.create"],
  ["DELETE", `${V2}/footer-comments/7`, "footer-comments.delete"],
  ["GET", `${V2}/attachments/9`, "attachments.get"],
  ["DELETE", `${V2}/attachments/9`, "attachments.delete"],
  ["GET", `${V1}/search?cql=type+%3D+page&start=0&limit=25`, "search.list"],
  ["PUT", `${V1}/content/1?status=trashed`, "content.update"],
  ["POST", `${V1}/content/1/label`, "label.create"],
  ["DELETE", `${V1}/content/1/label?name=draft`, "label.delete"],
  ["POST", `${V1}/content/1/child/attachment`, "attachment.create"],
];

describe("the names of Confluence's requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(confluenceUpstream.operationOf(method, url)).toBe(name);
  });

  it("reaches every end of the route tree", () => {
    expect(routeEnds(CONFLUENCE_ROUTES)).toHaveLength(25);
    expect(unreachedRouteEnds(CONFLUENCE_ROUTES, REQUESTS)).toEqual([]);
  });

  it("names a path the tree does not hold, and another host, by the method alone", () => {
    expect(confluenceUpstream.operationOf("GET", `${V2}/tasks/1`)).toBe("GET");
    expect(confluenceUpstream.operationOf("DELETE", `${V1}/content/1/property/draft`)).toBe("DELETE");
    expect(confluenceUpstream.operationOf("POST", TOKEN_URL)).toBe("POST");
    expect(confluenceUpstream.operationOf("GET", MEDIA_URL)).toBe("GET");
  });

  it("builds no name from a site's cloud ID or from what a path holds in place of an ID", () => {
    const words = new Set(REQUESTS.map(([, , name]) => name));
    for (const cloudId of ["0d6e5c1a-0000-4000-8000-000000000000", "search", "pages"]) {
      const name = confluenceUpstream.operationOf("GET", `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/1`);
      expect(name).toBe("pages.get");
    }
    expect(words.has(confluenceUpstream.operationOf("GET", `${V2}/spaces/Secret-Space/pages`))).toBe(true);
    expect(confluenceUpstream.operationOf("GET", `${V2}/pages/1/Secret-Title`)).toBe("GET");
  });
});

type Point = { blobs?: unknown[]; doubles?: unknown[] };

const ambient = env as { METRICS?: { writeDataPoint(point: Point): void }; SUBSERVICE_METRICS?: string };
let points: Point[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => void points.push(point) };
  ambient.SUBSERVICE_METRICS = "true";
  // No wait between the sends of a request that is sent again.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A written point's value in one column.
function column(point: Point, slot: string) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its operation, outcome, reason and HTTP status.
function counted() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// Each point written, as its operation and how many calls it stands for, in the operations' order.
function summed() {
  return points.map(point => [column(point, SUBSERVICE_V1_SLOTS.operation), column(point, SUBSERVICE_V1_SLOTS.calls)])
    .toSorted(([a], [b]) => String(a).localeCompare(String(b)));
}

// One request the stubbed fetch was handed.
type Sent = { method: string; url: URL; init: RequestInit };

// A global fetch that answers every request with what `answerOf` gives, and the requests sent.
function answering(answerOf: (sent: Sent, sends: number) => Response | Promise<Response>): Sent[] {
  const requests: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const sent = { method: init.method ?? "GET", url: new URL(String(input)), init };
    requests.push(sent);
    return answerOf(sent, requests.length);
  });
  return requests;
}

// The method and the URL without its query of a request, as the rows of `REQUESTS` are compared.
const rowOf = (method: string, url: string | URL) => {
  const { origin, pathname } = new URL(url);
  return `${method} ${origin}${pathname}`;
};

const bearer = (sent: Sent) => new Headers(sent.init.headers).get("Authorization");

const unauthorized = () => Response.json({ message: "Unauthorized" }, { status: 401 });

// A global fetch whose first answer is a 401 with a body that gives its first bytes when it is
// read and never ends, and whose later answers are `anything`'s. `pulls` is how many times the
// body was asked for bytes, and `cancelled` is called when the body is let go.
function unauthorizedWithOpenBody() {
  let pulled = 0;
  const cancelled = vi.fn();
  const open = () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled++ === 0) controller.enqueue(new TextEncoder().encode('{"message":"'));
    },
    cancel: () => void cancelled(),
  }, { highWaterMark: 0 }), { status: 401 });
  const requests = answering((_sent, sends) => sends === 1 ? open() : anything());
  return { requests, pulls: () => pulled, cancelled };
}

// A turn of the event loop, as a request that crosses the network takes at least.
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// A global fetch whose first answer is a 401 whose body can be read until `expire` is called and
// fails from then on, as the runtime fails what is read of an answer, a copy of it included, once
// the timeout of its attempt has fired. Its later answers are `later`'s.
function unauthorizedUntilExpired(later: () => Promise<Response>) {
  let expired = false;
  const first = () => {
    const chunks = [new TextEncoder().encode('{"message":"Unauthorized"}')];
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (expired) return controller.error(new DOMException("The operation timed out.", "TimeoutError"));
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }, { highWaterMark: 0 }), { status: 401 });
  };
  const requests = answering((_sent, sends) => sends === 1 ? first() : later());
  return { requests, expire: () => { expired = true; } };
}

// The bytes of each piece a streamed body gives when it is read.
const PIECE = 1024;

// A global fetch whose first answer is a 401 whose body is `bytes` bytes of JSON that holds a
// message, given a piece at a time as it is read, and whose later answers are `later`'s.
// `declared` has the answer name its length. `pulled` is how many bytes the body gave, and
// `cancelled` is called when the body is let go.
function unauthorizedWithBodyOf(bytes: number, later: () => Promise<Response>, declared = false) {
  const head = new TextEncoder().encode('{"message":"The token has expired.","padding":"');
  const tail = new TextEncoder().encode('"}');
  function* pieces() {
    yield head;
    for (let left = bytes - head.byteLength - tail.byteLength; left > 0; left -= PIECE) {
      yield new Uint8Array(Math.min(left, PIECE)).fill(0x61);
    }
    yield tail;
  }
  let pulled = 0;
  const cancelled = vi.fn();
  const first = () => {
    const body = pieces();
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = body.next();
        if (next.done) return controller.close();
        pulled += next.value.byteLength;
        controller.enqueue(next.value);
      },
      cancel: () => void cancelled(),
    }, { highWaterMark: 0 }), {
      status: 401, statusText: "Unauthorized", headers: declared ? { "Content-Length": String(bytes) } : {},
    });
  };
  const requests = answering((_sent, sends) => sends === 1 ? first() : later());
  return { requests, pulled: () => pulled, cancelled };
}

// A refresh and an answer that each take a turn of the event loop, in which a body that is read
// without a bound is read whole.
const slowRefresh = async () => {
  await turn();
  return "token-2";
};
const slowAnswer = async () => {
  await turn();
  return anything();
};
// A send that gets no answer.
const noAnswer = async (): Promise<Response> => { throw new TypeError("network connection lost"); };

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { Location: location } });

const image = (bytes = 4) =>
  new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Content-Length": String(bytes) } });

// An answer every method of the client reads: one item, and a listing of it.
const ITEM = { id: "1", key: "ENG", title: "Page", name: "draft" };
const anything = () => Response.json({ ...ITEM, results: [ITEM] });

// Answers of a success: one that holds a JSON `null`, one of no content, and one that holds `body`.
const none = () => Response.json(null);
const noContent = () => new Response(null, { status: 204 });
const holding = (body: unknown) => () => Response.json(body);

function api(options: { refresh?: () => Promise<string> } = {}) {
  return new ConfluenceApi({ cloudId: CLOUD, webBase: "https://acme.atlassian.net/wiki", getToken: async () => "token-1", ...options });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("the requests the client sends", () => {
  it("sends each request of the table and no other, each counted under its name", async () => {
    const requests = answering(({ url }) => url.pathname.endsWith("/accessible-resources") ? Response.json([]) : anything());
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const client = api();

    await getAccessibleResources("token-1");
    await getAtlassianIdentity("token-1");
    await client.listSpaces({});
    await client.getSpaceByKey("ENG");
    await client.getSpaceById("10");
    await client.getContentById("1");
    await client.getBlogPost("2");
    await client.listPagesInSpace({ spaceId: "10" });
    await client.listBlogPostsInSpace({ spaceId: "10" });
    await client.listPagesById(["1"]);
    await client.listChildPages("1", {});
    for (const parent of TREE_PARENTS) {
      await client.listDirectChildren(parent, "1", {});
      await client.listDescendants(parent, "1", { depth: 2 });
    }
    await client.searchWithContext("type = page", {});
    await client.search("type = page", {});
    await client.createPage({ title: "Page", storageValue: "<p/>", status: "current", spaceId: "10" });
    await client.createBlogPost({ title: "Post", storageValue: "<p/>", status: "current", spaceId: "10" });
    for (const [id, type] of [["1", "page"], ["2", "blogpost"]] as const) {
      await client.updateContent({ id, type, title: "Page", version: 2, storageValue: "<p/>" });
      await client.trashContent(id, type);
      await client.listComments(id, type, {});
      await client.getLabels(id, type);
      await client.listAttachments(id, type, {});
    }
    await client.restoreContent("1");
    await client.addComment("1", "<p/>", "page");
    await client.deleteComment("7");
    await client.addLabel("1", "draft");
    await client.removeLabel("1", "draft");
    await client.getAttachmentInfo("9");
    await client.deleteAttachment("9");
    await client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(1) });

    const sent = new Set(requests.map(({ method, url }) => rowOf(method, url)));
    expect(sent).toEqual(new Set(REQUESTS.map(([method, url]) => rowOf(method, url))));
    const names = requests.map(({ method, url }) => confluenceUpstream.operationOf(method, url));
    expect(counted().map(([operation]) => operation)).toEqual(names);
    expect(names.filter(name => /^[A-Z]+$/.test(name))).toEqual([]);
    // No request follows a redirect, and each has 30 seconds for its one attempt and the token.
    expect(requests.map(({ init }) => init.redirect)).toEqual(requests.map(() => "manual"));
    expect(requests.every(({ init }) => init.signal instanceof AbortSignal)).toBe(true);
    expect(timeouts.mock.calls).toEqual(requests.map(() => [30_000]));
    expect(requests.map(bearer)).toEqual(requests.map(() => "Bearer token-1"));
  });

  it("counts each request no path names under a literal, and uses every one of them", async () => {
    const requests = answering(({ url }) => {
      if (url.href === TOKEN_URL) return Response.json({ access_token: "token-2", expires_in: 3600 });
      if (url.pathname.endsWith("/rest/api/space/ENG/icon")) return redirectTo(MEDIA_URL);
      return image();
    });
    const timeouts = vi.spyOn(AbortSignal, "timeout");

    await exchangeAuthCode("code", "client", "secret", "https://gadgets.example/oauth");
    await refreshAccessToken("refresh-1", "client", "secret");
    await api().downloadAttachment("/download/attachments/1/a.png?version=1");
    await api().downloadSpaceIcon("/wiki/rest/api/space/ENG/icon", 16);

    expect(counted()).toEqual([
      ["token.exchange", "success", "", 200],
      ["token.refresh", "success", "", 200],
      ["attachments.download", "success", "", 200],
      ["icons.get", "success", "", 302],
      ["icons.download", "success", "", 200],
    ]);
    expect(new Set(counted().map(([operation]) => operation))).toEqual(new Set(CONFLUENCE_OPERATIONS));
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${GATEWAY}/download/attachments/1/a.png?version=1`,
      `GET ${GATEWAY}/rest/api/space/ENG/icon`,
      `GET ${MEDIA_URL}`,
    ]);
    expect(timeouts.mock.calls).toEqual(requests.map(() => [30_000]));
  });

  it("follows the redirect of an attachment's download, and of no other request", async () => {
    const requests = answering(({ url }) => url.href === TOKEN_URL ? Response.json({ access_token: "t" }) : image());

    await refreshAccessToken("refresh-1", "client", "secret");
    await api().downloadAttachment("/download/attachments/1/a.png");
    await api().downloadSpaceIcon("/rest/api/space/ENG/icon", 16);

    expect(requests.map(({ init }) => init.redirect)).toEqual(["manual", "follow", "manual"]);
  });
});

describe("the points of Confluence's requests", () => {
  it("counts a read and a write under the vendor's source and service", async () => {
    answering(anything);
    await api().getPage("1");
    await api().addLabel("1", "draft");

    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
    ].map(slot => column(point, slot)))).toEqual([
      ["gatekeeper.confluence.api", "confluence", "pages.get", "success"],
      ["gatekeeper.confluence.api", "confluence", "label.create", "success"],
    ]);
  });

  it("counts a token request that a success grants nothing for as an error of the call", async () => {
    answering(() => Response.json({ error: "invalid_grant", error_description: "The code is spent." }));
    expect(await failure(exchangeAuthCode("code", "client", "secret", "https://gadgets.example/oauth")))
      .toMatchObject({ status: 200, message: "invalid_grant: The code is spent." });
    answering(() => Response.json({ error: "invalid_grant" }, { status: 403 }));
    expect(await failure(refreshAccessToken("refresh-1", "client", "secret"))).toMatchObject({ status: 403 });

    expect(counted()).toEqual([
      ["token.exchange", "error", "api", 200],
      ["token.refresh", "error", "http", 403],
    ]);
  });

  it("sends a token request once, whatever fails it", async () => {
    const unavailable = answering(() => new Response("unavailable", { status: 503 }));
    expect(await failure(refreshAccessToken("refresh-1", "client", "secret"))).toBeInstanceOf(ConfluenceApiError);
    const lost = answering(() => { throw new TypeError("network connection lost"); });
    expect(await failure(exchangeAuthCode("code", "client", "secret", "https://gadgets.example/oauth")))
      .toBeInstanceOf(TypeError);

    expect([unavailable.length, lost.length]).toEqual([1, 1]);
    expect(counted()).toEqual([
      ["token.refresh", "error", "http", 503],
      ["token.exchange", "error", "network", 0],
    ]);
  });

  it("sends a read again after a transient failure, and a write once", async () => {
    const read = answering((_sent, sends) => sends === 1 ? new Response("unavailable", { status: 503 }) : anything());
    await api().getPage("1");
    const limited = answering((_sent, sends) => sends === 1 ? new Response("slow down", { status: 429 }) : Response.json([]));
    await getAccessibleResources("token-1");
    const lost = answering((_sent, sends) => {
      if (sends < 3) throw new TypeError("network connection lost");
      return anything();
    });
    await api().getSpaceById("10");
    const write = answering(() => new Response("unavailable", { status: 503 }));
    expect(await failure(api().createPage({ title: "Page", storageValue: "<p/>", status: "current", spaceId: "10" })))
      .toMatchObject({ status: 503 });

    expect([read.length, limited.length, lost.length, write.length]).toEqual([2, 2, 3, 1]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 503],
      ["pages.get", "success", "", 200],
      ["accessible-resources.list", "refused", "rate", 429],
      ["accessible-resources.list", "success", "", 200],
      ["spaces.get", "error", "network", 0],
      ["spaces.get", "error", "network", 0],
      ["spaces.get", "success", "", 200],
      ["pages.create", "error", "http", 503],
    ]);
  });

  it("answers a 401 with one refresh and a second send, each send counted", async () => {
    const requests = answering(sent => bearer(sent) === "Bearer token-2"
      ? anything() : unauthorized());
    const refresh = vi.fn(async () => "token-2");

    expect(await api({ refresh }).getPage("1")).toMatchObject({ id: "1", type: "page" });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests.map(bearer)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([["pages.get", "error", "http", 401], ["pages.get", "success", "", 200]]);
  });

  it("fails with a 401 where the refresh fails, the fresh token is refused, or no second answer comes", async () => {
    const unrefreshed = answering(unauthorized);
    expect(await failure(api({ refresh: async () => { throw new Error("no grant"); } }).getPage("1")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized" });
    const refused = answering(unauthorized);
    expect(await failure(api({ refresh: async () => "token-2" }).getPage("1")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401 });
    const unanswered = answering((_sent, sends) => {
      if (sends > 1) throw new TypeError("network connection lost");
      return unauthorized();
    });
    expect(await failure(api({ refresh: async () => "token-2" }).trashContent("1", "page")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized" });

    expect([unrefreshed.length, refused.length, unanswered.length]).toEqual([1, 2, 2]);
  });

  it("fails with a 401 where no send of a read with the fresh token gets an answer", async () => {
    const requests = answering((_sent, sends) => sends === 1 ? unauthorized() : noAnswer());
    const refresh = vi.fn(async () => "token-2");

    expect(await failure(api({ refresh }).getPage("1")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized", isAuthError: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests.map(bearer)).toEqual(["Bearer token-1", ...Array.from({ length: 3 }, () => "Bearer token-2")]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 401],
      ...Array.from({ length: 3 }, () => ["pages.get", "error", "network", 0]),
    ]);
  });

  it("fails with a 401 where Confluence answered a send with the first token alone, and none with the fresh one", async () => {
    const requests = answering((_sent, sends) => {
      if (sends === 1) return new Response("unavailable", { status: 503 });
      return sends === 2 ? unauthorized() : noAnswer();
    });

    expect(await failure(api({ refresh: async () => "token-2" }).getPage("1")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized" });
    expect(requests.map(bearer)).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2", "Bearer token-2"]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 503], ["pages.get", "error", "http", 401],
      ["pages.get", "error", "network", 0], ["pages.get", "error", "network", 0],
    ]);
  });

  it.each([
    ["an outage", 503, ["error", "http", 503]],
    ["a rate limit", 429, ["refused", "rate", 429]],
  ])("fails with the network's failure, not the 401, where the fresh token is answered %s and the sends after it get no answer", async (_name, status, outcome) => {
    const lost = new TypeError("network connection lost");
    const requests = answering((_sent, sends) => {
      if (sends === 1) return unauthorized();
      if (sends === 2) return new Response("unavailable", { status });
      throw lost;
    });
    const refresh = vi.fn(async () => "token-2");

    expect(await failure(api({ refresh }).getPage("1"))).toBe(lost);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests.map(bearer)).toEqual(["Bearer token-1", ...Array.from({ length: 3 }, () => "Bearer token-2")]);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 401], ["pages.get", ...outcome],
      ["pages.get", "error", "network", 0], ["pages.get", "error", "network", 0],
    ]);
  });

  it("fails an observer's check, and denies nobody, where the fresh token is answered an outage and the sends after it get no answer", async () => {
    const checker = new ConfluenceAccessChecker(async () => "token-1", () => api({ refresh: async () => "token-2" }));
    // A fresh token that Confluence refuses as it did the one before is a denial.
    const refused = answering(unauthorized);
    expect(await checker.hasSpaceAccess(CLOUD, "10")).toBe(false);

    const lost = new TypeError("network connection lost");
    const unanswered = answering((_sent, sends) => {
      if (sends === 1) return unauthorized();
      if (sends === 2) return new Response("unavailable", { status: 503 });
      throw lost;
    });
    expect(await failure(checker.hasSpaceAccess(CLOUD, "10"))).toBe(lost);
    expect([refused.length, unanswered.length]).toEqual([2, 4]);
  });

  it("fails with the network's failure, not the 401, where an answer to the fresh token is cut off and the sends after it get none", async () => {
    const lost = new TypeError("network connection lost");
    const attempts: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const attempt = new AbortController();
      attempts.push(attempt);
      return attempt.signal;
    });
    const requests = answering((_sent, sends) => {
      if (sends === 1) return unauthorized();
      if (sends > 2) throw lost;
      // A success whose body fails as its attempt's timeout fires.
      return new Response(new ReadableStream({
        pull(controller) {
          const reason = new DOMException("The operation timed out.", "TimeoutError");
          attempts.at(-1)?.abort(reason);
          controller.error(reason);
        },
      }));
    });

    expect(await failure(api({ refresh: async () => "token-2" }).getPage("1"))).toBe(lost);
    expect(requests).toHaveLength(4);
    expect(counted()).toEqual([
      ["pages.get", "error", "http", 401], ["pages.get", "error", "timeout", 200],
      ["pages.get", "error", "network", 0], ["pages.get", "error", "network", 0],
    ]);
  });

  it("fails with what the second answer holds, where that cannot be read", async () => {
    answering(sent => bearer(sent) === "Bearer token-2"
      ? new Response("<html>") : unauthorized());

    expect(await failure(api({ refresh: async () => "token-2" }).getPage("1"))).toBeInstanceOf(SyntaxError);
    expect(counted()).toEqual([["pages.get", "error", "http", 401], ["pages.get", "error", "parse", 200]]);
  });

  it.each<[string, (client: ConfluenceApi) => Promise<unknown>, string, unknown]>([
    ["a read", client => client.getSpaceById("10"), "spaces.get", undefined],
    ["a write", client => client.restoreContent("1"), "content.update", JSON.stringify({ status: "current" })],
    ["an upload", client => client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(4) }),
      "attachment.create", expect.any(FormData)],
  ])("refreshes the token and sends %s again while the body of the 401 stays open", async (_kind, call, name, body) => {
    const { requests, cancelled } = unauthorizedWithOpenBody();
    const refresh = vi.fn(async () => "token-2");

    await call(api({ refresh }));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests.map(sent => `${sent.method} ${sent.url}`)).toEqual(Array.from({ length: 2 }, () => `${requests[0].method} ${requests[0].url}`));
    expect(requests.map(bearer)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(requests.map(sent => sent.init.body)).toEqual([body, body]);
    expect(requests[1].init.body).toBe(requests[0].init.body);
    expect(counted()).toEqual([[name, "error", "http", 401], [name, "success", "", 200]]);
    // Nothing waits for the rest of the body, and nothing holds it open.
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1));
  });

  it("asks for the fresh token before it reads anything of the 401", async () => {
    const { pulls } = unauthorizedWithOpenBody();
    const pullsAtRefresh: number[] = [];

    await api({ refresh: async () => {
      pullsAtRefresh.push(pulls());
      return "token-2";
    } }).getSpaceById("10");

    expect(pullsAtRefresh).toEqual([0]);
  });

  it("reads the body of the 401 where the refresh fails, and counts that one send", async () => {
    const refused = unauthorized();
    const requests = answering(() => refused);
    const refresh = vi.fn(async (): Promise<string> => { throw new Error("no grant"); });

    expect(await failure(api({ refresh }).restoreContent("1")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["content.update", "error", "http", 401]]);
    // The error was read from a copy: the answer's own body, which nothing reads, is let go.
    expect(refused.bodyUsed).toBe(true);
  });

  it("fails with what the 401 said where the second send times out after the 401's own attempt has", async () => {
    const expiring = unauthorizedUntilExpired(async () => {
      await turn();
      expiring.expire();
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    expect(await failure(api({ refresh: async () => "token-2" }).restoreContent("1")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized" });
    expect(expiring.requests.map(bearer)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(counted()).toEqual([["content.update", "error", "http", 401], ["content.update", "error", "network", 0]]);
  });

  it("fails with what the 401 said where the refresh fails after the 401's own attempt has timed out", async () => {
    const expiring = unauthorizedUntilExpired(async () => anything());
    const refresh = vi.fn(async (): Promise<string> => {
      await turn();
      expiring.expire();
      throw new Error("no grant");
    });

    expect(await failure(api({ refresh }).getSpaceById("10")))
      .toMatchObject({ constructor: ConfluenceApiError, status: 401, message: "401: Unauthorized" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(expiring.requests).toHaveLength(1);
    expect(counted()).toEqual([["spaces.get", "error", "http", 401]]);
  });

  it("gives the sends before the 401 and after it the three attempts of one read", async () => {
    const requests = answering((_sent, sends) => sends === 2 ? unauthorized() : new Response("unavailable", { status: 503 }));
    const refresh = vi.fn(async () => "token-2");

    expect(await failure(api({ refresh }).getSpaceById("10"))).toMatchObject({ constructor: ConfluenceApiError, status: 503 });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests.map(bearer)).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2", "Bearer token-2"]);
    expect(counted()).toEqual([
      ["spaces.get", "error", "http", 503], ["spaces.get", "error", "http", 401],
      ["spaces.get", "error", "http", 503], ["spaces.get", "error", "http", 503],
    ]);
  });

  describe("the body of a 401 that is kept for its error", () => {
    const MIB = 1024 * 1024;
    // The error of a 401 by its status alone.
    const statusOnly = { constructor: ConfluenceApiError, status: 401, message: "401 Unauthorized", isAuthError: true };

    it.each([
      // The cap, the piece that crosses it and the one a copied body reads ahead.
      ["declares no length", false, MAX_HELD_ERROR_BYTES + 2 * PIECE],
      // The piece a copied body reads ahead.
      ["declares its length", true, PIECE],
    ])("reads no more than the cap of an 8 MiB 401 that %s, and returns the answer to the fresh token", async (_kind, declared, most) => {
      const large = unauthorizedWithBodyOf(8 * MIB, slowAnswer, declared);
      const refresh = vi.fn(slowRefresh);

      expect(await api({ refresh }).getPage("1")).toMatchObject({ id: "1", type: "page" });

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(large.requests.map(bearer)).toEqual(["Bearer token-1", "Bearer token-2"]);
      expect(counted()).toEqual([["pages.get", "error", "http", 401], ["pages.get", "success", "", 200]]);
      expect(large.pulled()).toBeLessThanOrEqual(most);
      // Neither the answer nor its copy holds the body open.
      await vi.waitFor(() => expect(large.cancelled).toHaveBeenCalledTimes(1));
      expect(large.pulled()).toBeLessThanOrEqual(most);
    });

    it("fails with the 401 by its status alone where its body is over the cap and the second send gets no answer", async () => {
      const large = unauthorizedWithBodyOf(MAX_HELD_ERROR_BYTES + 1, noAnswer);

      expect(await failure(api({ refresh: slowRefresh }).restoreContent("1"))).toMatchObject(statusOnly);

      expect(large.requests).toHaveLength(2);
      expect(counted()).toEqual([["content.update", "error", "http", 401], ["content.update", "error", "network", 0]]);
      // The body ended with the byte that passed the cap: all of it was there to be read.
      expect(large.pulled()).toBe(MAX_HELD_ERROR_BYTES + 1);
    });

    it.each([
      // The cap, the piece that crosses it and the one a copied body reads ahead.
      ["declares no length", false, MAX_HELD_ERROR_BYTES + 2 * PIECE],
      // The piece a copied body reads ahead.
      ["declares its length", true, PIECE],
    ])("lets go of an 8 MiB 401 that %s where the second send gets no answer", async (_kind, declared, most) => {
      const large = unauthorizedWithBodyOf(8 * MIB, noAnswer, declared);

      expect(await failure(api({ refresh: slowRefresh }).restoreContent("1"))).toMatchObject(statusOnly);

      expect(large.requests).toHaveLength(2);
      expect(counted()).toEqual([["content.update", "error", "http", 401], ["content.update", "error", "network", 0]]);
      // The reading that the cap stopped let go of the copy, so that nothing holds the body open.
      await vi.waitFor(() => expect(large.cancelled).toHaveBeenCalledTimes(1));
      expect(large.pulled()).toBeLessThanOrEqual(most);
    });

    it("fails with the 401 by its status alone where its body is over the cap and the refresh fails", async () => {
      const large = unauthorizedWithBodyOf(8 * MIB, slowAnswer);
      const refresh = vi.fn(async (): Promise<string> => {
        await turn();
        throw new Error("no grant");
      });

      expect(await failure(api({ refresh }).getSpaceById("10"))).toMatchObject(statusOnly);

      expect(large.requests).toHaveLength(1);
      expect(counted()).toEqual([["spaces.get", "error", "http", 401]]);
      expect(large.pulled()).toBeLessThanOrEqual(MAX_HELD_ERROR_BYTES + 2 * PIECE);
      await vi.waitFor(() => expect(large.cancelled).toHaveBeenCalledTimes(1));
    });

    it("fails with what a 401 of the cap's size said where the second send gets no answer", async () => {
      const small = unauthorizedWithBodyOf(MAX_HELD_ERROR_BYTES, noAnswer);

      expect(await failure(api({ refresh: slowRefresh }).restoreContent("1"))).toMatchObject({
        constructor: ConfluenceApiError, status: 401, message: "401: The token has expired.", isAuthError: true,
      });

      expect(small.pulled()).toBe(MAX_HELD_ERROR_BYTES);
      expect(counted()).toEqual([["content.update", "error", "http", 401], ["content.update", "error", "network", 0]]);
    });
  });

  // A success whose body the method that asked for it throws on: what asks, what Confluence
  // answers, the name the request is counted under, and what the method throws.
  const page = { title: "Page", storageValue: "<p/>", status: "current", spaceId: "10" } as const;
  const UNREAD: [
    what: string, call: (client: ConfluenceApi) => Promise<unknown>, answer: () => Response, name: string,
    thrown: [type: ErrorConstructor | typeof ConfluenceApiError | typeof ConfluenceUnnamedCreationError, message: string],
  ][] = [
    ["a list of sites that is none", () => getAccessibleResources("token-1"), holding({}), "accessible-resources.list",
      [TypeError, "all.filter is not a function"]],
    ["a site that names no scopes", () => getAccessibleResources("token-1"), holding([{ id: "site" }]), "accessible-resources.list",
      [TypeError, "Cannot read properties of undefined (reading 'some')"]],
    ["an identity that holds nothing", () => getAtlassianIdentity("token-1"), none, "me.get",
      [TypeError, "Cannot read properties of null (reading 'account_id')"]],
    ["a listing that holds nothing", client => client.listSpaces({}), none, "spaces.list",
      [TypeError, "Cannot read properties of null (reading 'results')"]],
    ["a listing answered no content", client => client.listChildPages("1", {}), noContent, "children.list",
      [TypeError, "Cannot read properties of undefined (reading 'results')"]],
    ["a space by its key whose listing holds no list", client => client.getSpaceByKey("ENG"), holding({}), "spaces.list",
      [TypeError, "Cannot read properties of undefined (reading '0')"]],
    ["a page answered no content", client => client.getPage("1"), noContent, "pages.get",
      [TypeError, "Cannot set properties of undefined (setting 'type')"]],
    ["a blog post that holds nothing", client => client.getBlogPost("2"), none, "blogposts.get",
      [TypeError, "Cannot set properties of null (setting 'type')"]],
    ["a listing of spaces that holds no list", client => client.listSpaces({}), holding({}), "spaces.list", [ConfluenceApiError, "Confluence answered a listing with no list."]],
    ["a listing of a space's pages that holds no list", client => client.listPagesInSpace({ spaceId: "10" }), holding({}), "pages.list",
      [ConfluenceApiError, "Confluence answered a listing with no list."]],
    ["a listing of blog posts one of which is none", client => client.listBlogPostsInSpace({ spaceId: "10" }),
      holding({ results: [null] }), "blogposts.list", [TypeError, "Cannot set properties of null (setting 'type')"]],
    ["a listing of pages by ID that holds no list", client => client.listPagesById(["1"]), holding({}), "pages.list",
      [ConfluenceApiError, "Confluence answered a listing with no list."]],
    ["labels that are no list", client => client.getLabels("1", "page"), holding({}), "labels.list", [ConfluenceApiError, "Confluence answered a listing with no list."]],
    ["a label that is none", client => client.getLabels("2", "blogpost"), holding({ results: [null] }), "labels.list",
      [TypeError, "Cannot read properties of null (reading 'name')"]],
    ["a search that holds no results", client => client.search("type = page", {}), holding({}), "search.list",
      [TypeError, "Cannot read properties of undefined (reading 'map')"]],
    ["a search whose results are no list", client => client.search("type = page", {}), holding({ results: 5 }), "search.list",
      [TypeError, "res.results.map is not a function"]],
    ["an uploaded attachment whose listing is empty",
      client => client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(1) }),
      holding({ results: [] }), "attachment.create", [ConfluenceUnnamedCreationError, "Confluence did not name the attachment it created."]],
    ["an uploaded attachment that has no ID",
      client => client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(1) }),
      holding({ results: [{ title: "a.txt" }] }), "attachment.create", [ConfluenceUnnamedCreationError, "Confluence did not name the attachment it created."]],
    ["a search with its context that holds no list", client => client.searchWithContext("type = page", {}), holding({}), "search.list",
      [ConfluenceApiError, "Confluence answered a listing with no list."]],
    ["a search with its context that holds nothing", client => client.searchWithContext("type = page", {}), none, "search.list",
      [TypeError, "Cannot read properties of null (reading 'results')"]],
    ["a created page that holds nothing", client => client.createPage(page), none, "pages.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the page it created."]],
    ["a created blog post answered no content", client => client.createBlogPost(page), noContent, "blogposts.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the blog post it created."]],
    ["a created page that has no ID", client => client.createPage(page), holding({}), "pages.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the page it created."]],
    ["a created page whose ID is no string", client => client.createPage(page), holding({ id: 123 }), "pages.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the page it created."]],
    ["a created page whose ID is empty", client => client.createPage(page), holding({ id: "" }), "pages.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the page it created."]],
    ["a created blog post that has no ID", client => client.createBlogPost(page), holding({}), "blogposts.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the blog post it created."]],
    ["a created blog post whose ID is empty", client => client.createBlogPost(page), holding({ id: "" }), "blogposts.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the blog post it created."]],
    ["an added comment that has no ID", client => client.addComment("1", "<p/>", "page"), holding({}), "footer-comments.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the comment it created."]],
    ["an added comment whose ID is empty", client => client.addComment("2", "<p/>", "blogpost"), holding({ id: "" }),
      "footer-comments.create", [ConfluenceUnnamedCreationError, "Confluence did not name the comment it created."]],
    ["an added comment that holds nothing", client => client.addComment("1", "<p/>", "page"), none, "footer-comments.create",
      [ConfluenceUnnamedCreationError, "Confluence did not name the comment it created."]],
    ["an updated page that holds nothing", client => client.updateContent({ id: "1", type: "page", title: "Page", version: 2, storageValue: "<p/>" }),
      none, "pages.update", [TypeError, "Cannot set properties of null (setting 'type')"]],
    ["an uploaded attachment that holds no list",
      client => client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(1) }), holding({}),
      "attachment.create", [ConfluenceUnnamedCreationError, "Confluence did not name the attachment it created."]],
  ];

  // A creation was sent whatever became of its answer's body: one that cannot be decoded is
  // counted as the client counts a body it could not read, and thrown as a creation that names
  // nothing, which is not one to send again.
  it.each<[string, (client: ConfluenceApi) => Promise<unknown>, () => Response, string, string]>([
    ["an uploaded attachment whose body is cut short",
      client => client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(1) }),
      () => new Response('{"results":[{"id":', { status: 201, headers: { "Content-Type": "application/json" } }),
      "attachment.create", "attachment"],
    ["an uploaded attachment answered an empty body",
      client => client.uploadAttachment("1", { filename: "a.txt", mediaType: "text/plain", data: new Uint8Array(1) }),
      () => new Response("", { status: 200 }), "attachment.create", "attachment"],
    ["a created page whose body is cut short", client => client.createPage(page),
      () => new Response('{"id":', { status: 200, headers: { "Content-Type": "application/json" } }), "pages.create", "page"],
  ])("counts %s as a body that could not be read, sent once and thrown as a creation that names nothing", async (_what, call, answer, name, what) => {
    const requests = answering(answer);

    const thrown = await failure(call(api({ refresh: async () => "token-2" })));

    expect(thrown).toBeInstanceOf(ConfluenceUnnamedCreationError);
    expect(thrown).toMatchObject({ message: `Confluence did not name the ${what} it created.`, cause: expect.any(Error) });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([[name, "error", "parse", answer().status]]);
  });

  it("throws what decoding threw where a read's body is cut short, which is no creation", async () => {
    answering(() => new Response('{"id":', { status: 200, headers: { "Content-Type": "application/json" } }));

    const thrown = await failure(api().getPage("1"));

    expect(thrown).toBeInstanceOf(SyntaxError);
  });

  it.each(UNREAD)("counts %s as an error of the API, sent once and failing as its reading does", async (_what, call, answer, name, [type, message]) => {
    const requests = answering(answer);

    const thrown = await failure(call(api({ refresh: async () => "token-2" })));

    expect(Object.getPrototypeOf(thrown)).toBe(type.prototype);
    expect(thrown).toMatchObject({ message });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([[name, "error", "api", answer().status]]);
  });

  it.each<[string, (client: ConfluenceApi) => Promise<unknown>, () => Response, string, unknown]>([
    ["a space by its key that the listing does not hold", client => client.getSpaceByKey("ENG"), holding({ results: [] }), "spaces.list",
      new ConfluenceApiError(404, "No such space: ENG")],
    ["a deleted page answered no content", client => client.trashContent("1", "page"), noContent, "pages.delete", undefined],
    ["a listing that is empty, which is a page", client => client.listSpaces({}), holding({ results: [] }), "spaces.list",
      { results: [], nextCursor: undefined }],
    ["a created page that has an ID", client => client.createPage(page), holding({ id: "7" }), "pages.create",
      { id: "7", type: "page" }],
    ["a created blog post that has an ID", client => client.createBlogPost(page), holding({ id: "8" }), "blogposts.create",
      { id: "8", type: "blogpost" }],
    ["an added comment that has an ID", client => client.addComment("1", "<p/>", "page"), holding({ id: "9" }), "footer-comments.create",
      { id: "9" }],
    ["an updated page that has no ID, which an update need not name",
      client => client.updateContent({ id: "1", type: "page", title: "Page", version: 2, storageValue: "<p/>" }), holding({}),
      "pages.update", { type: "page" }],
  ])("counts %s by its status", async (_what, call, answer, name, outcome) => {
    answering(answer);

    const ended = await call(api()).catch((error: unknown) => error);

    expect(ended).toEqual(outcome);
    expect(counted()).toEqual([[name, "success", "", answer().status]]);
  });

  it("counts a redirect that is not followed as an error, and fails the read with its status", async () => {
    const requests = answering(() => redirectTo("https://elsewhere.example/wiki/api/v2/pages/1"));

    expect(await failure(api().getPage("1"))).toMatchObject({ constructor: ConfluenceApiError, status: 302 });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["pages.get", "error", "http", 302]]);
  });

  it("counts an icon's redirect by whether it is acted on, and an icon over the cap as answered", async () => {
    const refused = answering(() => redirectTo("https://elsewhere.example/icon.png"));
    expect(await failure(api().downloadSpaceIcon("/rest/api/space/ENG/icon", 16))).toMatchObject({ status: 502 });
    const large = answering(({ url }) => url.hostname === "api.media.atlassian.com" ? image(32) : redirectTo(MEDIA_URL));
    expect(await failure(api().downloadSpaceIcon("/rest/api/space/ENG/icon", 16))).toMatchObject({ status: 413 });
    const elsewhere = answering(({ url }) =>
      redirectTo(url.hostname === "api.media.atlassian.com" ? "https://elsewhere.example/icon.png" : MEDIA_URL));
    expect(await failure(api().downloadSpaceIcon("/rest/api/space/ENG/icon", 16))).toMatchObject({ status: 302 });

    expect([refused.length, large.length, elsewhere.length]).toEqual([1, 2, 2]);
    expect(counted()).toEqual([
      ["icons.get", "error", "http", 302],
      ["icons.get", "success", "", 302],
      ["icons.download", "success", "", 200],
      ["icons.get", "success", "", 302],
      ["icons.download", "error", "http", 302],
    ]);
  });

  it("writes nothing a path, a token or an answer holds", async () => {
    answering(() => Response.json({ message: "Secret refusal about Roadmap-2027" }, { status: 403 }));
    await failure(api().getSpaceByKey("Roadmap-2027"));
    await failure(api().getPage("987654321"));
    await failure(refreshAccessToken("refresh-secret", "client-secret-id", "client-secret"));

    const written = JSON.stringify(points);
    expect(points).toHaveLength(3);
    for (const held of [CLOUD, "Roadmap", "987654321", "token-1", "secret", "Secret", "atlassian.com"]) {
      expect(written).not.toContain(held);
    }
  });
});

describe("the operations counted summed", () => {
  const SITE: AccessibleResource = { id: CLOUD, name: "Acme", url: "https://acme.atlassian.net", scopes: [] };

  it("writes one point per kind of request for a batch of space avatars", async () => {
    const requests = answering(({ url }) => {
      if (url.hostname === "api.media.atlassian.com") return image();
      const key = url.searchParams.get("keys");
      if (key === null) return redirectTo(`${MEDIA_URL}&space=${url.pathname.split("/").at(-2)}`);
      return Response.json({ results: [{ id: "10", key, name: key, icon: { apiDownloadLink: `/wiki/rest/api/space/${key}/icon` } }] });
    });
    const configurator = new ConfluenceConfiguratorUI({
      getSites: async () => [SITE],
      getGrantedScopes: async () => null,
      getToken: async () => "token-1",
      refresh: async () => "token-1",
    });

    const avatars = await configurator.spaceAvatars(["ENG", "OPS", "HR"].map(key => `space:${CLOUD}/${key}`));

    expect(Object.keys(avatars)).toHaveLength(3);
    expect(requests).toHaveLength(9);
    expect(summed()).toEqual([["icons.download", 3], ["icons.get", 3], ["spaces.list", 3]]);
  });

  it("writes one point per kind of request for a check of an observer's access", async () => {
    const requests = answering(({ url }) => url.pathname.endsWith("/pages/3")
      ? new Response("missing", { status: 404 }) : anything());
    const stored = new Map<string, unknown>();
    const cache = new KvTtlCache({
      get: <T>(key: string) => stored.get(key) as T | undefined,
      put: <T>(key: string, value: T) => void stored.set(key, value),
    }, () => "credentials-1", { name: "access" });
    const ids = [1, 2, 3, 4, 5].map(id => `site/${CLOUD}/content/${id}`);

    const access = await checkConfluenceSubresourceAccess(cache, {
      getToken: async () => "token-1",
      refresh: async () => "token-1",
      api: () => api(),
    }, ids);

    // The page that is missing is asked for again as a blog post, which is there.
    expect(access).toEqual([true, true, true, true, true]);
    expect(requests).toHaveLength(6);
    expect(points.map(point => [
      SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.calls,
    ].map(slot => column(point, slot))).toSorted()).toEqual([
      ["blogposts.get", "success", 1],
      ["pages.get", "error", 1],
      ["pages.get", "success", 4],
    ]);
  });
});
