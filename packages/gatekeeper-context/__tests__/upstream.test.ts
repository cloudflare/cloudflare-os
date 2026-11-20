// The calls this gatekeeper makes to Artifacts and the name each is counted under: the methods of
// the binding, which a collection's Durable Object and a read of its remote call, and the git
// smart-HTTP requests isomorphic-git sends through the gatekeeper's HTTP client. It runs in
// workerd, where the Durable Object lives. The metrics read the Worker's bindings from
// `cloudflare:workers`, whose `env` this suite shares with the Durable Object, so a dataset set
// on it here records what the gatekeeper writes.

import { runInDurableObject } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { init as initRepository, packObjects, writeBlob, writeCommit, writeTree } from "isomorphic-git";
import type { GitHttpRequest, GitHttpResponse } from "isomorphic-git";
import { request as webRequest } from "isomorphic-git/http/web";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot } from "@gadgets/observability/metrics";
import { gitFetches, makeHttp, readArtifactRepoDocuments } from "../src/artifact-sync.js";
import { ContextCollectionDurableObject } from "../src/context-collection.js";
import { CONTEXT_OPERATIONS, GIT_OPERATIONS, contextUpstream } from "../src/context-upstream.js";
import { domainName } from "../src/domain.js";

const REMOTE = "https://artifacts.example/git/library/mirror.git";
const DOMAIN = "workshop.example";
// What a point must never hold: the token Artifacts creates with a repository, and the one it mints.
const INITIAL_TOKEN = "art_v1_initial-secret";
const TOKEN = "art_v1_minted-secret";
// The commit the remote's branch points at.
const TIP = "1".repeat(40);

/** Every kind of git request the gatekeeper sends, with the name it is counted under. */
const REQUESTS: [method: string, url: string, name: string][] = [
  ["GET", `${REMOTE}/info/refs?service=git-upload-pack`, "git.info-refs"],
  ["POST", `${REMOTE}/git-upload-pack`, "git.upload-pack"],
];

const ambient = bindings as Cloudflare.Env & {
  METRICS?: AnalyticsEngineDataset;
  SUBSERVICE_METRICS?: string;
  COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
};
let points: AnalyticsEngineDataPoint[];
// The operation of every point a test wrote, whether or not the test looked at it.
let operations: unknown[];

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

beforeEach(() => {
  points = [];
  operations = [];
  ambient.METRICS = {
    writeDataPoint(point) {
      if (!point) return;
      points.push(point);
      operations.push(column(point, SUBSERVICE_V1_SLOTS.operation));
    },
  };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // No call of these tests is counted under a bare method: each has a name of the union.
  const names: readonly unknown[] = CONTEXT_OPERATIONS;
  expect(operations.filter(operation => !names.includes(operation))).toEqual([]);
});

// The points written since the last look, as each one's operation, outcome, reason, HTTP status
// and number of calls, ordered by operation and then by status.
function written() {
  const rows = points.splice(0).map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
  return rows.toSorted((a, b) =>
    String(a[0]).localeCompare(String(b[0])) || Number(a[3]) - Number(b[3]));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

// A method of the binding that the gatekeeper has no call to.
async function unused(): Promise<never> {
  throw new Error("The gatekeeper does not call this method.");
}

/** One call a fake binding received: the method and the arguments it was given. */
type BindingCall = [method: string, ...args: unknown[]];

/** An Artifacts binding that records every call it receives, and can be made to fail revocations. */
function fakeArtifacts() {
  const tokens = new Map<string, "read" | "write">();
  const fake = {
    calls: [] as BindingCall[],
    failRevocations: false,
    /** The calls received since the last look. */
    received: () => fake.calls.splice(0),
  };
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const repo: ArtifactsRepo = {
    async createToken(...args) {
      fake.calls.push(["createToken", ...args]);
      const id = `token-${tokens.size}`;
      tokens.set(id, args[0] ?? "write");
      return { id, plaintext: TOKEN, scope: args[0] ?? "write", expiresAt };
    },
    async listTokens(...args) {
      fake.calls.push(["listTokens", ...args]);
      const listed = [...tokens].map(([id, scope]) => ({
        id, scope, state: "active" as const, createdAt: expiresAt, expiresAt,
      }));
      return { tokens: listed, total: listed.length };
    },
    async revokeToken(...args) {
      fake.calls.push(["revokeToken", ...args]);
      if (fake.failRevocations) throw new Error(`Artifacts could not revoke ${args[0]}.`);
      return tokens.delete(args[0]);
    },
    info: unused,
    readBlob: unused,
    readTree: unused,
    readCommit: unused,
    readFile: unused,
    log: unused,
    fork: unused,
    [Symbol.dispose]() {},
  };
  const binding: Artifacts = {
    async create(...args) {
      fake.calls.push(["create", ...args]);
      return {
        id: "repository", name: args[0], description: null, defaultBranch: "main", remote: REMOTE,
        token: INITIAL_TOKEN,
      };
    },
    async get(...args) {
      fake.calls.push(["get", ...args]);
      return repo;
    },
    async delete(...args) {
      fake.calls.push(["delete", ...args]);
      return true;
    },
    import: unused,
    list: unused,
  };
  return Object.assign(fake, { binding });
}

/**
 * Runs `work` on a private git collection of its own, owned by alice, whose Durable Object has
 * `artifacts` for its binding. The collection has been created: its repository exists.
 */
async function withCollection<T>(
  artifacts: Artifacts, work: (collection: ContextCollectionDurableObject, id: string) => Promise<T>,
): Promise<T> {
  const id = `collection-${crypto.randomUUID()}`;
  const stub = ambient.COLLECTIONS.get(ambient.COLLECTIONS.idFromName(domainName(DOMAIN, id)));
  return runInDurableObject(stub, async (_instance, state) => {
    const collection = new ContextCollectionDurableObject(state, { ...bindings, ARTIFACTS: artifacts });
    const now = new Date();
    await collection.initialize({
      id, title: "Mirror", description: "", visibility: "private",
      created: now, lastUpdated: now, documentCount: 0,
      content: { source: "git", remote: "", branch: "main", lastRefreshedAt: now },
    }, DOMAIN, "alice");
    return work(collection, id);
  });
}

/** One request the fake remote received. */
type Sent = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Whether the request has a signal, which is the timeout of its attempt. */
  timed: boolean;
  /** That signal. */
  signal: AbortSignal | undefined;
  redirect: RequestInit["redirect"];
};

// A git packet line: its length in four hexadecimal digits, itself included, then the line.
const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, "0") + line;
const FLUSH = "0000";
// The content type of an answer that advertises refs, and of one that lists them or holds a pack.
const ADVERTISED = { "Content-Type": "application/x-git-upload-pack-advertisement" };
const RESULT = { "Content-Type": "application/x-git-upload-pack-result" };

// What a remote that speaks protocol version 2 answers a request for its refs' advertisement.
const ADVERTISEMENT = pkt("# service=git-upload-pack\n") + FLUSH + pkt("version 2\n") + pkt("ls-refs\n") + FLUSH;

function advertisement(): Response {
  return new Response(ADVERTISEMENT, { headers: ADVERTISED });
}

function refs(tip: string = TIP): Response {
  return new Response(pkt(`${tip} refs/heads/main\n`) + FLUSH, { headers: RESULT });
}

// An answer whose body holds `head` and then never ends: it fails with the reason of the
// attempt's signal once that aborts, as the body of a real answer does.
function stalled(signal: AbortSignal | undefined, headers: Record<string, string>, head: string = ""): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      if (head) controller.enqueue(new TextEncoder().encode(head));
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  }), { headers });
}

// What a body fails with when its connection is lost.
const LOST = new TypeError("Network connection lost.");

// An answer whose body holds `head` and then fails, as that of a connection that is lost does.
function cut(headers: Record<string, string>, head: string): Response {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(LOST);
      sent = true;
      controller.enqueue(new TextEncoder().encode(head));
    },
  }), { headers });
}

// Gives every attempt 20 ms in place of the upstream's 30 seconds.
function quickTimeouts() {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(20));
}

/** A repository a fake remote serves: the commit its branch points at, and the pack that holds it. */
type Served = { tip: string; pack: Uint8Array };

// A repository of one commit, whose tree holds `readme.md`, built and packed by isomorphic-git.
async function servedRepository(): Promise<Served> {
  const dir = `/tmp/served-${crypto.randomUUID()}`;
  try {
    await initRepository({ fs, dir, defaultBranch: "main" });
    const blob = await writeBlob({ fs, dir, blob: new TextEncoder().encode("# Mirrored\n") });
    const tree = await writeTree({ fs, dir, tree: [{ mode: "100644", path: "readme.md", oid: blob, type: "blob" }] });
    const author = { name: "Alice", email: "alice@workshop.example", timestamp: 0, timezoneOffset: 0 };
    const tip = await writeCommit({
      fs, dir, commit: { message: "Add the readme\n", tree, parent: [], author, committer: author },
    });
    const { packfile } = await packObjects({ fs, dir, oids: [tip, tree, blob] });
    if (!packfile) throw new Error("isomorphic-git packed nothing.");
    return { tip, pack: packfile };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// What a remote that speaks protocol version 1 advertises of `served`, as a clone asks for it.
function branches({ tip }: Served): Response {
  const capabilities = "side-band-64k shallow symref=HEAD:refs/heads/main";
  return new Response(
    pkt("# service=git-upload-pack\n") + FLUSH
      + pkt(`${tip} HEAD\0${capabilities}\n`) + pkt(`${tip} refs/heads/main\n`) + FLUSH,
    { headers: ADVERTISED });
}

// The answer to a shallow clone of `served`: the commit the history is cut at, no commit in
// common, and the pack on the side band that carries it. Its body comes in two chunks.
function packed({ tip, pack }: Served): Response {
  const encoder = new TextEncoder();
  const band = (pack.byteLength + 5).toString(16).padStart(4, "0");
  const bytes = new Uint8Array([
    ...encoder.encode(pkt(`shallow ${tip}\n`) + FLUSH + pkt("NAK\n") + band + "\u0001"), ...pack,
    ...encoder.encode(FLUSH),
  ]);
  const chunks = [bytes.subarray(0, 40), bytes.subarray(40)];
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  }, { highWaterMark: 0 }), { headers: RESULT });
}

/**
 * Answers every request the gatekeeper sends with `answer`, in place of the global `fetch`.
 * @returns The requests received, in order.
 */
function remote(answer: (sent: Sent) => Response): Sent[] {
  const received: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const sent: Sent = {
      method: init.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : undefined,
      timed: init.signal instanceof AbortSignal,
      signal: init.signal ?? undefined,
      redirect: init.redirect,
    };
    received.push(sent);
    return answer(sent);
  });
  return received;
}

/**
 * A remote as Artifacts serves one: it asks for credentials, advertises protocol version 2 to a
 * request that asks for it, and lists its branch at `TIP`. `otherwise` answers what is left: the
 * advertisement a clone asks for, which is of protocol version 1.
 */
function artifactsRemote(otherwise: (sent: Sent) => Response = () => new Response(null, { status: 404 })) {
  return remote(sent => {
    if (!sent.headers.authorization) return new Response("Authentication required.", { status: 401 });
    if (sent.method === "POST") return refs();
    return sent.headers["git-protocol"] === "version=2" ? advertisement() : otherwise(sent);
  });
}

/**
 * A remote as Artifacts serves `served`, to the listing of its refs and to the clone that
 * follows. `listing` answers the request that lists its refs.
 */
function servedRemote(served: Served, listing: (sent: Sent) => Response = () => refs(served.tip)) {
  return remote(sent => {
    if (!sent.headers.authorization) return new Response("Authentication required.", { status: 401 });
    if (sent.method === "POST") return sent.body?.includes("command=ls-refs") ? listing(sent) : packed(served);
    return sent.headers["git-protocol"] === "version=2" ? advertisement() : branches(served);
  });
}

/** Reads the remote of a repository named `repoName`, whose stored commit is `currentCommit`. */
function read(artifacts: Artifacts, currentCommit: string, repoName = `mirror-${crypto.randomUUID()}`) {
  return readArtifactRepoDocuments(artifacts, repoName, REMOTE, "main", currentCommit);
}

describe("the names of the git requests", () => {
  it.each(REQUESTS)("names %s %s as %s", (method, url, name) => {
    expect(contextUpstream.operationOf(method, url)).toBe(name);
  });

  it("has a request for every git name, and lists no name twice", () => {
    expect(REQUESTS.map(([, , name]) => name).toSorted()).toEqual(GIT_OPERATIONS.toSorted());
    expect(new Set(CONTEXT_OPERATIONS).size).toBe(CONTEXT_OPERATIONS.length);
  });

  it("names a request by its endpoint alone, whatever remote and repository its URL holds", () => {
    for (const repository of [
      "https://artifacts.example/git/library/mirror.git",
      "https://account-1234.artifacts.example/git/secret-namespace/secret-collection.git",
      "http://localhost:8787/info/refs/git-upload-pack.git",
    ]) {
      expect(contextUpstream.operationOf("GET", `${repository}/info/refs?service=git-upload-pack`))
        .toBe("git.info-refs");
      expect(contextUpstream.operationOf("POST", `${repository}/git-upload-pack`)).toBe("git.upload-pack");
    }
  });

  it("names a request that is neither by its method alone", () => {
    expect(contextUpstream.operationOf("GET", `${REMOTE}/HEAD`)).toBe("GET");
    expect(contextUpstream.operationOf("GET", `${REMOTE}/git-upload-pack`)).toBe("GET");
    expect(contextUpstream.operationOf("POST", `${REMOTE}/info/refs?service=git-upload-pack`)).toBe("POST");
    expect(contextUpstream.operationOf("POST", `${REMOTE}/git-receive-pack`)).toBe("POST");
    expect(contextUpstream.operationOf("DELETE", REMOTE)).toBe("DELETE");
  });
});

// A body as isomorphic-git hands one over: in chunks.
async function* pieces(): AsyncIterableIterator<Uint8Array> {
  yield new TextEncoder().encode(pkt("command=ls-refs\n"));
  yield new TextEncoder().encode(FLUSH);
}

// A body that isomorphic-git hands over in one chunk.
async function* piece(text: string): AsyncIterableIterator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

// What `fetch` is called with for `request` by `client`, without the members that are undefined,
// and what `client` answers isomorphic-git, with the chunks of its body.
async function exchange(
  client: (request: GitHttpRequest) => Promise<GitHttpResponse>, request: GitHttpRequest, answer: Response,
) {
  const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => answer);
  vi.stubGlobal("fetch", fetch);
  const { body, ...answered } = await client(request);
  const chunks: number[][] = [];
  for await (const chunk of body ?? []) chunks.push([...chunk]);
  expect(fetch).toHaveBeenCalledOnce();
  const [input, init = {}] = fetch.mock.calls[0];
  const { body: sentBody, ...members } = init;
  return {
    input,
    init: Object.fromEntries(Object.entries(members).filter(([, value]) => value !== undefined)),
    body: sentBody instanceof Uint8Array ? [...sentBody] : sentBody,
    answered: Object.fromEntries(Object.entries(answered).filter(([, value]) => value !== undefined)),
    chunks,
  };
}

// The bytes read of the answer to a transfer whose body may hold `maxBytes` at most.
async function transferred(maxBytes: number): Promise<number> {
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array(5)));
  const { body } = await makeHttp(maxBytes, gitFetches({ timeoutMs: null }))
    .request({ method: "POST", url: `${REMOTE}/git-upload-pack` });
  let bytes = 0;
  for await (const chunk of body ?? []) bytes += chunk.byteLength;
  return bytes;
}

describe("the HTTP client isomorphic-git is given", () => {
  const credentials = { Authorization: "Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0", "Git-Protocol": "version=2" };

  /** Each kind of request isomorphic-git hands its HTTP client, and what the remote answers it. */
  const EXCHANGES: [kind: string, request: () => GitHttpRequest, answer: () => Response][] = [
    ["a discovery with no credentials",
      () => ({ method: "GET", url: `${REMOTE}/info/refs?service=git-upload-pack`, headers: {} }),
      () => new Response("Authentication required.", { status: 401, statusText: "Unauthorized" })],
    ["a discovery with credentials",
      () => ({ method: "GET", url: `${REMOTE}/info/refs?service=git-upload-pack`, headers: { ...credentials } }),
      advertisement],
    ["a request with a body in pieces",
      () => ({
        method: "POST",
        url: `${REMOTE}/git-upload-pack`,
        headers: { ...credentials, "content-type": "application/x-git-upload-pack-request" },
        body: pieces(),
      }),
      refs],
    ["a request with neither method nor headers",
      () => ({ url: `${REMOTE}/info/refs?service=git-upload-pack` }),
      () => new Response(null, { status: 204, statusText: "No Content" })],
  ];

  it.each(EXCHANGES)("sends %s as isomorphic-git's web client does, and answers the same", async (_kind, request, answer) => {
    const web = await exchange(webRequest, request(), answer());
    const client = makeHttp(1024, gitFetches({ timeoutMs: null }));
    const own = await exchange(client.request, request(), answer());
    // The one member the upstream adds: no redirect is followed.
    expect(own).toEqual({ ...web, init: { ...web.init, redirect: "manual" } });
    expect(Object.keys(web.init).toSorted()).toEqual(["headers", "method"]);
  });

  it("fails the reading of an answer longer than the cap, and reads one as long as it", async () => {
    expect(await transferred(5)).toBe(5);
    expect(await failure(transferred(4))).toMatchObject({
      name: "GitTransferTooLargeError", message: "Repository too large: Git transfer exceeded 4 bytes.",
    });
  });

  /** Each request that asks for a list of refs, and the content type of its answer. */
  const LISTINGS: [kind: string, request: () => GitHttpRequest, headers: Record<string, string>][] = [
    ["an advertisement",
      () => ({ method: "GET", url: `${REMOTE}/info/refs?service=git-upload-pack`, headers: { ...credentials } }),
      ADVERTISED],
    ["a listing", () => ({ method: "POST", url: `${REMOTE}/git-upload-pack`, headers: { ...credentials }, body: pieces() }),
      RESULT],
  ];

  // The requests to the upload endpoint that ask for a pack: a negotiation of protocol version 1,
  // and the `fetch` command of version 2, which names `ls-refs` further on.
  const TRANSFERS = [
    ["a negotiation", pkt(`want ${TIP} side-band-64k\n`) + pkt("deepen 1\n") + FLUSH + pkt("done\n")],
    ["a fetch command", pkt("command=fetch\n") + pkt("agent=command=ls-refs\n") + FLUSH],
  ];

  it.each(LISTINGS)("reads %s whole before it answers, in one chunk", async (_kind, request, headers) => {
    const whole = pkt(`${TIP} refs/heads/main\n`) + FLUSH;
    let ended = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (ended) return controller.close();
        ended = true;
        controller.enqueue(new TextEncoder().encode(whole));
      },
    }, { highWaterMark: 0 }), { headers }));
    const { body } = await makeHttp(1024, gitFetches()).request(request());
    // The body had ended when the request was answered.
    expect(ended).toBe(true);
    const chunks: string[] = [];
    for await (const chunk of body ?? []) chunks.push(new TextDecoder().decode(chunk));
    expect(chunks).toEqual([whole]);
  });

  it.each(LISTINGS)("fails %s that is longer than the cap as the request, and counts it", async (_kind, request, headers) => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(5), { headers }));
    expect(await failure(makeHttp(4, gitFetches()).request(request()))).toMatchObject({
      name: "GitTransferTooLargeError", message: "Repository too large: Git transfer exceeded 4 bytes.",
    });
    expect(written().map(([, outcome, reason, status]) => [outcome, reason, status])).toEqual([["error", "parse", 200]]);
  });

  it.each(LISTINGS)("leaves the body of %s that is no 200 as it came", async (_kind, request, headers) => {
    let pulls = 0;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.close();
      },
    }, { highWaterMark: 0 }), { status: 503, headers }));
    const { statusCode } = await makeHttp(1024, gitFetches()).request(request());
    expect([statusCode, pulls]).toEqual([503, 0]);
  });

  it.each(TRANSFERS)("hands over the pack of %s as it arrives, unread", async (_kind, asked) => {
    // A pack that never ends: a client that read it whole would not answer.
    let pulls = 0;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(8));
      },
    }, { highWaterMark: 0 }), { headers: RESULT }));
    const { body } = await makeHttp(1024, gitFetches()).request({
      method: "POST", url: `${REMOTE}/git-upload-pack`, headers: { ...credentials },
      body: piece(asked),
    });
    expect(pulls).toBe(0);
    // Each chunk is asked of the remote when isomorphic-git asks for it.
    const reader = body?.[Symbol.asyncIterator]();
    expect((await reader?.next())?.value).toHaveLength(8);
    expect(pulls).toBe(1);
    expect((await reader?.next())?.value).toHaveLength(8);
    expect(pulls).toBe(2);
    await reader?.return?.();
    expect(written()).toEqual([["git.upload-pack", "success", "", 200, 1]]);
  });
});

describe("a read of a collection's remote", () => {
  it("lists the remote's refs with a token of its own, and counts each call under its name", async () => {
    const artifacts = fakeArtifacts();
    const sent = artifactsRemote();
    const result = await read(artifacts.binding, TIP, "mirror-1");

    expect(result).toEqual({ commit: TIP, changed: false });
    expect(artifacts.received()).toEqual([["get", "mirror-1"], ["createToken", "read", 3600], ["revokeToken", "token-0"]]);
    const authorization = `Basic ${btoa(`x-access-token:${TOKEN}`)}`;
    expect(sent.map(({ method, url, headers }) => [method, url, headers.authorization])).toEqual([
      ["GET", `${REMOTE}/info/refs?service=git-upload-pack`, undefined],
      ["GET", `${REMOTE}/info/refs?service=git-upload-pack`, authorization],
      ["POST", `${REMOTE}/git-upload-pack`, authorization],
    ]);
    expect(sent[2].body).toContain("command=ls-refs");
    expect(sent[2].body).toContain("ref-prefix refs/heads/main");
    // Listing refs has the upstream's timeout, and follows no redirect.
    expect(sent.map(({ timed, redirect }) => `${timed} ${redirect}`)).toEqual(Array(3).fill("true manual"));
    expect(points.map(point => [SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service].map(slot => column(point, slot)).join(" ")))
      .toEqual(Array(6).fill("gatekeeper.context.api context"));
    expect(written()).toEqual([
      ["git.info-refs", "success", "", 200, 1],
      // The remote's request for credentials, which the discovery then sends: no failure.
      ["git.info-refs", "success", "", 401, 1],
      ["git.upload-pack", "success", "", 200, 1],
      ["repos.get", "success", "", 0, 1],
      ["tokens.create", "success", "", 0, 1],
      ["tokens.revoke", "success", "", 0, 1],
    ]);
  });

  it("counts a token the remote rejects as an error, beside its request for credentials", async () => {
    const artifacts = fakeArtifacts();
    const sent = remote(() => new Response("Authentication required.", { status: 401, statusText: "Unauthorized" }));
    expect(await failure(read(artifacts.binding, TIP))).toMatchObject({
      code: "HttpError", data: { statusCode: 401 },
    });
    expect(sent.map(({ method, headers }) => `${method} ${headers.authorization ? "with" : "without"} credentials`))
      .toEqual(["GET without credentials", "GET with credentials"]);
    const discoveries = written().filter(([operation]) => operation === "git.info-refs");
    expect(discoveries).toHaveLength(2);
    expect(discoveries).toContainEqual(["git.info-refs", "success", "", 401, 1]);
    expect(discoveries).toContainEqual(["git.info-refs", "error", "http", 401, 1]);
  });

  it("counts no other answer to a request without credentials as a success", async () => {
    const sent = remote(() => new Response("Forbidden.", { status: 403, statusText: "Forbidden" }));
    expect(await failure(read(fakeArtifacts().binding, TIP))).toMatchObject({
      code: "HttpError", data: { statusCode: 403 },
    });
    expect(sent.map(({ headers }) => headers.authorization)).toEqual([undefined]);
    expect(written()).toContainEqual(["git.info-refs", "error", "http", 403, 1]);
  });

  it("sends a clone with no timeout, and its advertisement again after an outage", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const artifacts = fakeArtifacts();
    const sent = artifactsRemote(() => new Response("Unavailable.", { status: 503, statusText: "Service Unavailable" }));
    const error = await failure(read(artifacts.binding, "0".repeat(40)));

    expect(error).toMatchObject({ code: "HttpError", data: { statusCode: 503 } });
    // The clone's requests follow the three that list the remote's refs.
    const clone = sent.slice(3);
    const advertised = `GET ${REMOTE}/info/refs?service=git-upload-pack`;
    expect(clone.map(({ method, url, headers }) => `${method} ${url} ${headers.authorization ? "with" : "without"} credentials`))
      .toEqual([`${advertised} without credentials`, ...Array(3).fill(`${advertised} with credentials`)]);
    expect(clone.map(({ timed, redirect }) => `${timed} ${redirect}`)).toEqual(Array(4).fill("false manual"));
    expect(written()).toContainEqual(["git.info-refs", "error", "http", 503, 3]);
    expect(artifacts.received().at(-1)).toEqual(["revokeToken", "token-0"]);
  });

  it("sends the advertisement again after a network failure, and fails with it", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const lost = new TypeError("Network connection lost.");
    const sent = remote(() => { throw lost; });
    expect(await failure(read(fakeArtifacts().binding, TIP))).toBe(lost);
    expect(sent.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
    expect(written()).toContainEqual(["git.info-refs", "error", "network", 0, 3]);
  });

  // A body that ends cleanly may still end short of the list: git ends one with a flush packet.
  it.each<[string, string]>([
    ["a ref and no flush packet", pkt(`${TIP} refs/heads/main\n`)],
    ["half a packet line", pkt(`${TIP} refs/heads/main\n`).slice(0, 20)],
    ["nothing", ""],
    ["an end-of-response packet before its ref", "0002" + pkt(`${TIP} refs/heads/main\n`) + FLUSH],
    ["a delimiter packet before its ref", "0001" + pkt(`${TIP} refs/heads/main\n`) + FLUSH],
  ])("fails a listing of refs with %s, and counts it an error", async (_what, body) => {
    const sent = remote(({ method }) => method === "POST" ? new Response(body, { headers: RESULT }) : advertisement());
    expect(await failure(read(fakeArtifacts().binding, TIP))).toMatchObject({
      message: "git ref list ended before its flush packet; the list is incomplete.",
    });
    expect(sent.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(written()).toContainEqual(["git.upload-pack", "error", "parse", 200, 1]);
  });

  it("counts a git answer that is a 2xx but no 200 an error, which isomorphic-git refuses", async () => {
    remote(({ method }) => method === "POST" ? new Response(null, { status: 204, headers: RESULT }) : advertisement());
    expect(await failure(read(fakeArtifacts().binding, TIP))).toMatchObject({ code: "HttpError", data: { statusCode: 204 } });
    expect(written()).toContainEqual(["git.upload-pack", "error", "http", 204, 1]);
  });

  it("takes a listing of refs that is a flush packet alone for a remote with none", async () => {
    remote(({ method }) => method === "POST" ? new Response(FLUSH, { headers: RESULT }) : advertisement());
    expect(await read(fakeArtifacts().binding, TIP)).toMatchObject({ commit: "", documents: [] });
    expect(written()).toContainEqual(["git.upload-pack", "success", "", 200, 1]);
  });

  it("sends the listing of refs once when the remote fails it", async () => {
    const sent = remote(({ method }) => method === "POST"
      ? new Response("Unavailable.", { status: 503, statusText: "Service Unavailable" }) : advertisement());
    expect(await failure(read(fakeArtifacts().binding, TIP))).toMatchObject({
      code: "HttpError", data: { statusCode: 503 },
    });
    expect(sent.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(written()).toContainEqual(["git.upload-pack", "error", "http", 503, 1]);
  });

  it("does not follow a redirect of the remote, and counts it an error", async () => {
    const sent = remote(() => new Response(null, {
      status: 302, statusText: "Found", headers: { Location: "https://elsewhere.example/mirror.git/info/refs" },
    }));
    expect(await failure(read(fakeArtifacts().binding, TIP))).toMatchObject({
      code: "HttpError", data: { statusCode: 302 },
    });
    expect(sent.map(({ url, redirect }) => [url, redirect])).toEqual([
      [`${REMOTE}/info/refs?service=git-upload-pack`, "manual"],
    ]);
    expect(written()).toContainEqual(["git.info-refs", "error", "http", 302, 1]);
  });

  it("reads the documents of a branch whose list of refs is whole, from the pack of the clone that follows", async () => {
    const served = await servedRepository();
    const sent = servedRemote(served);
    const result = await read(fakeArtifacts().binding, "0".repeat(40));

    expect(result).toMatchObject({ commit: served.tip, changed: true });
    expect("documents" in result && result.documents.map(({ path, body }) => [path, new TextDecoder().decode(body)]))
      .toEqual([["readme.md", "# Mirrored\n"]]);
    expect(sent.map(({ method, headers }) => `${method} ${headers.authorization ? "with" : "without"} credentials`))
      .toEqual([
        "GET without credentials", "GET with credentials", "POST with credentials",
        "GET without credentials", "GET with credentials", "POST with credentials",
      ]);
    expect(sent[5].body).toContain(`want ${served.tip}`);
    expect(written().filter(([operation]) => String(operation).startsWith("git."))).toEqual([
      ["git.info-refs", "success", "", 200, 2],
      ["git.info-refs", "success", "", 401, 2],
      ["git.upload-pack", "success", "", 200, 2],
    ]);
  });

  describe("whose list of refs is cut off", () => {
    // The stored commit of a collection that has mirrored documents: a remote read as one with
    // no branch would have them deleted.
    const STORED = "0".repeat(40);
    // Half of the line that names the branch.
    const HALF = pkt(`${TIP} refs/heads/main\n`).slice(0, 30);

    it("fails where the timeout of its attempt cuts the listing off, and sends it once", async () => {
      quickTimeouts();
      const artifacts = fakeArtifacts();
      const sent = remote(({ method, signal }) => method === "POST" ? stalled(signal, RESULT) : advertisement());

      expect(await failure(read(artifacts.binding, STORED))).toMatchObject({ name: "TimeoutError" });
      expect(sent.map(({ method }) => method)).toEqual(["GET", "POST"]);
      expect(written().filter(([operation]) => operation === "git.upload-pack"))
        .toEqual([["git.upload-pack", "error", "timeout", 200, 1]]);
      expect(artifacts.received().at(-1)).toEqual(["revokeToken", "token-0"]);
    });

    it("fails where the timeout cuts the listing off after a part of it", async () => {
      quickTimeouts();
      remote(({ method, signal }) => method === "POST" ? stalled(signal, RESULT, HALF) : advertisement());
      expect(await failure(read(fakeArtifacts().binding, STORED))).toMatchObject({ name: "TimeoutError" });
      expect(written()).toContainEqual(["git.upload-pack", "error", "timeout", 200, 1]);
    });

    it("fails where the connection of the listing is lost, and sends it once", async () => {
      const sent = remote(({ method }) => method === "POST" ? cut(RESULT, HALF) : advertisement());
      expect(await failure(read(fakeArtifacts().binding, STORED))).toBe(LOST);
      expect(sent.map(({ method }) => method)).toEqual(["GET", "POST"]);
      expect(written().filter(([operation]) => operation === "git.upload-pack"))
        .toEqual([["git.upload-pack", "error", "parse", 200, 1]]);
    });

    it("sends the advertisement again where the timeout cuts it off, and fails with it", async () => {
      quickTimeouts();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const sent = remote(({ signal }) => stalled(signal, ADVERTISED, pkt("# service=git-upload-pack\n")));
      expect(await failure(read(fakeArtifacts().binding, STORED))).toMatchObject({ name: "TimeoutError" });
      expect(sent.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
      expect(written()).toContainEqual(["git.info-refs", "error", "timeout", 200, 3]);
    });

    it("fails where the connection of the advertisement is lost, and sends it once", async () => {
      // A remote of protocol version 1 lists its refs in the advertisement: this one is cut off
      // before the line of the branch.
      const sent = remote(() => cut(ADVERTISED,
        pkt("# service=git-upload-pack\n") + FLUSH + pkt(`${TIP} HEAD\0shallow\n`)));
      expect(await failure(read(fakeArtifacts().binding, STORED))).toBe(LOST);
      expect(sent.map(({ method }) => method)).toEqual(["GET"]);
      expect(written()).toContainEqual(["git.info-refs", "error", "parse", 200, 1]);
    });

    it("fails a clone whose advertisement is cut off", async () => {
      const served = await servedRepository();
      // The advertisement a clone asks for names no protocol version.
      const sent = remote(({ method, headers }) => {
        if (method === "POST") return refs(served.tip);
        return headers["git-protocol"] === "version=2" ? advertisement()
          : cut(ADVERTISED, pkt("# service=git-upload-pack\n") + FLUSH);
      });
      expect(await failure(read(fakeArtifacts().binding, STORED))).toBe(LOST);
      expect(sent.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
      expect(written()).toContainEqual(["git.info-refs", "error", "parse", 200, 1]);
    });
  });

  it("writes nothing of the remote, the repository, its token or its commit", async () => {
    artifactsRemote();
    await read(fakeArtifacts().binding, TIP, "secret-mirror");
    const text = JSON.stringify(points);
    expect(points).toHaveLength(6);
    for (const secret of ["artifacts.example", "library", "mirror", TOKEN, "token-0", TIP, "refs/heads", "Basic"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("a collection's calls to the binding", () => {
  it("counts each method under its name, and calls it with the same arguments", async () => {
    const artifacts = fakeArtifacts();
    await withCollection(artifacts.binding, async (collection, id) => {
      expect(artifacts.received()).toEqual([
        ["create", id, { setDefaultBranch: "main" }], ["get", id], ["revokeToken", INITIAL_TOKEN],
      ]);
      expect(written()).toEqual([
        ["repos.create", "success", "", 0, 1],
        ["repos.get", "success", "", 0, 1],
        ["tokens.revoke", "success", "", 0, 1],
      ]);

      expect(await collection.createGitToken("alice")).toEqual({ id: "token-0", plaintext: TOKEN, remote: REMOTE });
      expect(artifacts.received()).toEqual([["get", id], ["createToken", "write", 31_536_000]]);
      expect(written()).toEqual([["repos.get", "success", "", 0, 1], ["tokens.create", "success", "", 0, 1]]);

      expect((await collection.listGitTokens()).tokens.map(token => token.id)).toEqual(["token-0"]);
      expect(artifacts.received()).toEqual([["get", id], ["listTokens"]]);
      expect(written()).toEqual([["repos.get", "success", "", 0, 1], ["tokens.list", "success", "", 0, 1]]);

      expect(await collection.revokeGitToken("token-0")).toBe(true);
      expect(artifacts.received()).toEqual([["get", id], ["revokeToken", "token-0"]]);
      expect(written()).toEqual([["repos.get", "success", "", 0, 1], ["tokens.revoke", "success", "", 0, 1]]);

      await collection.deleteSelf("alice", false);
      expect(artifacts.received()).toEqual([["delete", id]]);
      expect(written()).toEqual([["repos.delete", "success", "", 0, 1]]);
    });
  });

  it("writes the revocations of a former editor's tokens as one point", async () => {
    const artifacts = fakeArtifacts();
    await withCollection(artifacts.binding, async (collection, id) => {
      await collection.share("alice", [{ accountId: "bob", displayName: "bob" }], "editor");
      for (let minted = 0; minted < 3; minted++) await collection.createGitToken("bob");
      artifacts.received();
      written();

      await collection.removeMember("alice", "bob");
      expect(artifacts.received()).toEqual([
        ["get", id], ["revokeToken", "token-0"], ["revokeToken", "token-1"], ["revokeToken", "token-2"],
      ]);
      expect(written()).toEqual([["repos.get", "success", "", 0, 1], ["tokens.revoke", "success", "", 0, 3]]);
      await collection.deleteSelf("alice", false);
    });
  });

  it("counts a call the binding fails as an error, and fails with what the binding threw", async () => {
    const artifacts = fakeArtifacts();
    await withCollection(artifacts.binding, async (collection) => {
      await collection.createGitToken("alice");
      written();
      artifacts.failRevocations = true;
      expect(await failure(collection.revokeGitToken("token-0"))).toEqual(new Error("Artifacts could not revoke token-0."));
      expect(written()).toEqual([["repos.get", "success", "", 0, 1], ["tokens.revoke", "error", "exception", 0, 1]]);
      expect(JSON.stringify(points)).not.toContain("token-0");
      artifacts.failRevocations = false;
      await collection.deleteSelf("alice", false);
    });
  });

  it("counts every name of the union in a call the gatekeeper makes", async () => {
    const artifacts = fakeArtifacts();
    artifactsRemote();
    await read(artifacts.binding, TIP);
    await withCollection(artifacts.binding, async (collection) => {
      await collection.listGitTokens();
      await collection.deleteSelf("alice", false);
    });
    const counted = new Set(written().map(([operation]) => operation));
    expect([...counted].toSorted()).toEqual(CONTEXT_OPERATIONS.toSorted());
  });
});

describe("a collection's refresh of its mirror", () => {
  it("keeps the mirrored documents where a refresh cannot list the remote's refs", async () => {
    const artifacts = fakeArtifacts();
    const served = await servedRepository();
    await withCollection(artifacts.binding, async (collection) => {
      servedRemote(served);
      await collection.syncArtifactSource();
      const mirrored = await collection.listContextDocuments();
      expect(mirrored.map(({ path }) => path)).toEqual(["readme.md"]);
      expect(collection.getMetadata()).toMatchObject({ documentCount: 1, content: { commit: served.tip } });

      servedRemote(served, () => cut(RESULT, pkt(`${served.tip} refs/heads/main\n`).slice(0, 30)));
      expect(await failure(collection.syncArtifactSource())).toBe(LOST);
      quickTimeouts();
      servedRemote(served, ({ signal }) => stalled(signal, RESULT));
      expect(await failure(collection.syncArtifactSource())).toMatchObject({ name: "TimeoutError" });

      expect(await collection.listContextDocuments()).toEqual(mirrored);
      expect((await collection.getContextDocument("readme.md"))?.body).toBe("# Mirrored\n");
      expect(collection.getMetadata()).toMatchObject({ documentCount: 1, content: { commit: served.tip } });
      await collection.deleteSelf("alice", false);
    });
  });
});
