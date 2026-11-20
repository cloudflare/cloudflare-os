import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { AdminApi } from "@gadgets/workshop-shared/api";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import { ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel } from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { RpcTarget, connect, signUp, stubFor, withOwnerWorkspace, WorkpieceRecorder } from "../src/rpc-client.js";

// fetch() from executeCode and from a gadget's server code, which a FetchLoopback sends under the
// workspace's fetch policy, and a gatekeeper's fetches through the Fetcher its approval queue
// gives it. The trusted-host list is deployment-wide, so this file owns its harness and runs
// serially.
let harness: Harness;
let admin: RpcStub<AdminApi>;
const fileScope = new DisposableStack();
const models = scriptedModelRouter();

const TRUSTED_HOST = "gadgets-test.example";
const OTHER_HOST = "other.example";
const PAGE = "The fetched page.";
// A trusted host's path that redirects to an untrusted host.
const REDIRECT_PATH = "/redirect-to-other";

// What the origin received, per request.
type Received = { url: string; method: string; headers: Headers };
let received: Received[] = [];
const web: Handler = (url, method, headers) => {
  if (url.host !== TRUSTED_HOST && url.host !== OTHER_HOST) return null;
  received.push({ url: url.href, method, headers });
  if (url.pathname === REDIRECT_PATH) {
    return new Response(null, { status: 302, headers: { location: `https://${OTHER_HOST}/redirected` } });
  }
  return new Response(PAGE, { headers: { "content-type": "text/plain" } });
};
const network = new NetworkInterceptor({ handlers: [models.handler, web] });
const receivedUrls = () => received.map(entry => entry.url);

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
  const adminApi = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const adminStub = fileScope.use(await adminApi.getAdminApi());
  if (adminStub === null) throw new Error("The deployment admin API was unavailable");
  admin = adminStub;
});

beforeEach(() => {
  received = [];
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const READ_RESTRICTED_CODE = "await env.TEST_AMBIENT.readValue(true);";

// An executeCode step that runs `body`, then fetches each of `requests` and logs what came back.
const fetchCode = (id: string, requests: [string, RequestInit?][], body = "") => ({ toolCall: {
  id, name: "executeCode", arguments: { code: `export default async function(self, env) {
  ${body}
  for (let [url, init] of ${JSON.stringify(requests)}) {
    let response = await fetch(url, init);
    console.log(\`\${init?.method ?? "GET"} \${url}: \${response.status} \${await response.text()}\`);
  }
}` },
} });

const readRestricted = (id = "read-restricted") => fetchCode(id, [], READ_RESTRICTED_CODE);

const toolResult = (id: string, content: string) => ({ messages: expect.arrayContaining([
  expect.objectContaining({ role: "tool", tool_call_id: id, content: expect.stringContaining(content) }),
]) });

// The workspace's record of each request it allowed, oldest first.
const fetchObservations = async (session: WorkshopAgentSession) =>
  (await session.listActions({ filter: "observation" })).entries
      .filter(entry => entry.description.title.startsWith("Fetched "))
      .map(entry => entry.description.description).toReversed();

const openSession = (model: RoutedScriptedModel) => openAgentSession(harness.url, {
  modelId: SCRIPTED_MODEL_ID,
  userModel: model.userModel,
  ambientVendorIds: [TEST_VENDOR_ID],
  usernamePrefix: "sandboxfetch",
});

it("fetches a page from executeCode, and refuses a POST", async () => {
  const page = `https://${OTHER_HOST}/page`;
  const model = models.script([
    fetchCode("fetch", [[page], [page, { method: "POST", body: "data" }]]),
    { text: "Done." },
  ]);
  await using session = await openSession(model);
  const turn = await session.runTurn("Fetch the page.");

  expect(turn.outcome).toEqual({ status: "completed" });
  expect(model.requests[1]).toMatchObject(toolResult("fetch", `GET ${page}: 200 ${PAGE}`));
  expect(model.requests[1]).toMatchObject(toolResult("fetch",
      `POST ${page}: 405 Only GET and HEAD requests are allowed, not POST.`));
  expect(received.map(({ url, method }) => [method, url])).toEqual([["GET", page]]);
  expect(await fetchObservations(session)).toEqual([`GET \`${page}\``]);
});

it("refuses a fetch in the same executeCode call that read restricted data", async () => {
  const page = `https://${OTHER_HOST}/after-restricted`;
  const model = models.script([
    fetchCode("read-and-fetch", [[page]], READ_RESTRICTED_CODE),
    { text: "Done." },
  ]);
  await using session = await openSession(model);
  await session.runTurn("Read the restricted value, then fetch the page.");

  expect(model.requests[1]).toMatchObject(toolResult("read-and-fetch",
      `GET ${page}: 403 This workspace has observed sensitive data.`));
  expect(received).toEqual([]);
  expect(await fetchObservations(session)).toEqual([]);
});

it("fetches from a trusted host once restricted, but not with a query string", async () => {
  await admin.setRestrictedWebFetchHosts([TRUSTED_HOST]);
  try {
    const plain = `https://${TRUSTED_HOST}/docs`;
    const query = `https://${TRUSTED_HOST}/docs?q=secret`;
    const model = models.script([
      readRestricted(),
      fetchCode("fetch", [[plain], [query]]),
      { text: "Done." },
    ]);
    await using session = await openSession(model);
    await session.runTurn("Read the restricted value, then fetch the pages.");

    expect(model.requests[2]).toMatchObject(toolResult("fetch", `GET ${plain}: 200 ${PAGE}`));
    expect(model.requests[2]).toMatchObject(toolResult("fetch", `GET ${query}: 403 `));
    expect(receivedUrls()).toEqual([plain]);
    expect(await fetchObservations(session)).toEqual([`GET \`${plain}\``]);
  } finally {
    await admin.setRestrictedWebFetchHosts([]);
  }
});

it("checks each redirect executeCode's fetch follows, refusing one to an untrusted host", async () => {
  await admin.setRestrictedWebFetchHosts([TRUSTED_HOST]);
  try {
    const start = `https://${TRUSTED_HOST}${REDIRECT_PATH}`;
    const model = models.script([
      readRestricted(),
      fetchCode("fetch", [[start]]),
      { text: "Done." },
    ]);
    await using session = await openSession(model);
    await session.runTurn("Read the restricted value, then fetch the page.");

    // The runtime follows the redirect, and its next hop comes back through the FetchLoopback,
    // which refuses it before it reaches the untrusted host.
    expect(model.requests[2]).toMatchObject(toolResult("fetch",
        `GET ${start}: 403 This workspace has observed sensitive data, so it may only fetch from ${TRUSTED_HOST}`));
    expect(receivedUrls()).toEqual([start]);
    expect(await fetchObservations(session)).toEqual([`GET \`${start}\``]);
  } finally {
    await admin.setRestrictedWebFetchHosts([]);
  }
});

it("ends the turn when executeCode's fetch needs approval, and fetches once approved", async () => {
  await admin.setRestrictedWebFetchApprovals(true);
  try {
    const page = `https://${OTHER_HOST}/needs-approval`;
    // Caller headers, none of which may reach the origin of a URL fetched in a restricted
    // workspace, approved or not.
    const headers = {
      "authorization": "Bearer secret", "accept": "application/json", "accept-language": "x-secret",
      "x-custom": "secret",
    };
    const fetchStep = (id: string) => fetchCode(id, [[page, { headers }]]);
    const model = models.script([
      readRestricted(),
      fetchStep("ask"),
      fetchStep("fetch-approved"),
      { text: "Done." },
    ]);
    await using session = await openSession(model);
    const asked = await session.runTurn("Read the restricted value, then fetch the page.");

    // The turn ends on the card, with no further model request.
    expect(asked.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(2);
    const requests = asked.history.filter(msg => msg.type === "webFetchRequest");
    expect(requests).toEqual([expect.objectContaining({ url: page, state: "pending" })]);
    expect(received).toEqual([]);

    const resumed = await session.approveWebFetchRequestsAndWait([requests[0].requestId]);
    expect(resumed.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(4);
    expect(model.requests[3]).toMatchObject(toolResult("fetch-approved", `GET ${page}: 200 ${PAGE}`));
    expect(receivedUrls()).toEqual([page]);
    const sent = received[0].headers;
    expect(sent.get("user-agent")).toBe("Cloudflare-OS/1.0");
    expect(sent.get("accept")).not.toBe(headers.accept);
    for (let name of ["authorization", "accept-language", "x-custom"]) {
      expect(sent.has(name)).toBe(false);
    }
    expect(await fetchObservations(session)).toEqual([`GET \`${page}\``]);
  } finally {
    await admin.setRestrictedWebFetchApprovals(false);
  }
});

interface Fetching extends RpcTarget {
  fetchPage(url: string): Promise<string>;
}

const FETCHING_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async fetchPage(url) {
    let response = await fetch(url);
    return \`\${response.status} \${await response.text()}\`;
  }
}
`;

it("fetches from a gadget's server code, and refuses the same gadget once restricted", async () => {
  const page = `https://${OTHER_HOST}/from-gadget`;
  const model = models.script([
    { toolCalls: [
      { id: "create", name: "createGadget", arguments: { title: "Fetcher", bindingName: "FETCHER" } },
      { id: "write", name: "writeFile",
        arguments: { workpiece: "FETCHER", filename: "server.js", content: FETCHING_SERVER } },
    ] },
    { text: "Built." },
    readRestricted(),
    { text: "Read." },
  ]);
  await using session = await openSession(model);
  expect((await session.runTurn("Build the fetcher.")).outcome).toEqual({ status: "completed" });
  await session.acceptChanges();

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const workpieces = new WorkpieceRecorder();
    using workpiecesStub = stubFor(workpieces);
    using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
    await workpieces.loaded;
    const summary = [...workpieces.summaries.values()]
        .find(entry => entry.type === "gadget" && entry.title === "Fetcher");
    if (summary === undefined) throw new Error("The Fetcher gadget was not created");
    using gadget = await ws.getGadget(summary.id);
    using fetching = await gadget.connectToGadget() as RpcStub<Fetching>;

    expect(await fetching.fetchPage(page)).toBe(`200 ${PAGE}`);
    expect(receivedUrls()).toEqual([page]);
    expect(await fetchObservations(session)).toEqual([`GET \`${page}\``]);

    // The gadget's worker stays loaded, but its fetcher asks the workspace about each request.
    expect((await session.runTurn("Read the restricted value.")).outcome)
        .toEqual({ status: "completed" });
    expect(await fetching.fetchPage(page))
        .toMatch(/^403 This workspace has observed sensitive data\./);
    expect(receivedUrls()).toEqual([page]);
  });
});

// An executeCode step that runs `body`, then makes each of `calls` to the test gatekeeper's fetch
// methods (see TestSession.fetchUrl()) and logs what came back.
const gatekeeperFetchCode = (id: string, calls: ["fetchUrl" | "fetchInstalled", string][], body = "") =>
  ({ toolCall: { id, name: "executeCode", arguments: { code: `export default async function(self, env) {
  ${body}
  for (let [method, url] of ${JSON.stringify(calls)}) {
    let { status, body, refused } = await env.TEST_AMBIENT[method](url);
    console.log(\`\${method} \${url}: \${status} \${refused ?? "sent"} \${body}\`);
  }
}` } } });

// The gatekeeper's own record of each fetchUrl() call, oldest first.
const gatekeeperFetchAudits = async (session: WorkshopAgentSession) =>
  (await session.listActions({ filter: "observation" })).entries
      .filter(entry => entry.description.title === "Ran the test gatekeeper's fetch")
      .map(entry => entry.description.description).toReversed();

it("fetches through a gatekeeper's Fetcher, which the workspace does not record", async () => {
  const page = `https://${OTHER_HOST}/from-gatekeeper`;
  const model = models.script([
    gatekeeperFetchCode("fetch", [["fetchUrl", page]]),
    { text: "Done." },
  ]);
  await using session = await openSession(model);
  expect((await session.runTurn("Fetch the page.")).outcome).toEqual({ status: "completed" });

  expect(model.requests[1]).toMatchObject(toolResult("fetch", `fetchUrl ${page}: 200 sent ${PAGE}`));
  expect(receivedUrls()).toEqual([page]);
  expect(received[0].headers.get("user-agent")).toBe("Cloudflare-OS/1.0");
  // The snapshot allowed it, so only the gatekeeper's audit of its own call records it.
  expect(await fetchObservations(session)).toEqual([]);
  expect(await gatekeeperFetchAudits(session)).toEqual([`Fetched \`${page}\` through the caller's fetch policy.`]);
});

it("refuses a gatekeeper's fetch from an untrusted host once restricted, or with a query string", async () => {
  await admin.setRestrictedWebFetchHosts([TRUSTED_HOST]);
  try {
    const other = `https://${OTHER_HOST}/from-gatekeeper`;
    const plain = `https://${TRUSTED_HOST}/from-gatekeeper`;
    const query = `https://${TRUSTED_HOST}/from-gatekeeper?q=secret`;
    const model = models.script([
      readRestricted(),
      gatekeeperFetchCode("fetch", [["fetchUrl", other], ["fetchUrl", plain], ["fetchUrl", query]]),
      { text: "Done." },
    ]);
    await using session = await openSession(model);
    expect((await session.runTurn("Read the restricted value, then fetch the pages.")).outcome)
        .toEqual({ status: "completed" });

    expect(model.requests[2]).toMatchObject(toolResult("fetch",
        `fetchUrl ${other}: 403 denied This workspace has observed sensitive data, so it may only fetch from ${TRUSTED_HOST}`));
    expect(model.requests[2]).toMatchObject(toolResult("fetch", `fetchUrl ${plain}: 200 sent ${PAGE}`));
    expect(model.requests[2]).toMatchObject(toolResult("fetch", `fetchUrl ${query}: 403 denied `));
    expect(receivedUrls()).toEqual([plain]);
    expect(await fetchObservations(session)).toEqual([]);
  } finally {
    await admin.setRestrictedWebFetchHosts([]);
  }
});

it("keeps a gatekeeper's Fetcher at the policy it was taken under, until the next call replaces it", async () => {
  const pages = ["before", "stale", "fresh", "replaced"].map(name => `https://${OTHER_HOST}/${name}`);
  const [before, stale, fresh, replaced] = pages;
  const model = models.script([
    gatekeeperFetchCode("install", [["fetchUrl", before]]),
    readRestricted(),
    gatekeeperFetchCode("fetch", [["fetchInstalled", stale], ["fetchUrl", fresh], ["fetchInstalled", replaced]]),
    { text: "Done." },
  ]);
  await using session = await openSession(model);
  expect((await session.runTurn("Fetch, read the restricted value, then fetch again.")).outcome)
      .toEqual({ status: "completed" });

  expect(model.requests[1]).toMatchObject(toolResult("install", `fetchUrl ${before}: 200 sent ${PAGE}`));
  // Taken before the workspace was restricted, the installed Fetcher never updates...
  expect(model.requests[3]).toMatchObject(toolResult("fetch", `fetchInstalled ${stale}: 200 sent ${PAGE}`));
  // ...until the gatekeeper's next call takes a new one and installs it in its place.
  expect(model.requests[3]).toMatchObject(toolResult("fetch",
      `fetchUrl ${fresh}: 403 denied This workspace has observed sensitive data.`));
  expect(model.requests[3]).toMatchObject(toolResult("fetch",
      `fetchInstalled ${replaced}: 403 denied This workspace has observed sensitive data.`));
  expect(receivedUrls()).toEqual([before, stale]);
});

it("ends the turn when a gatekeeper's fetch needs approval, and fetches once approved", async () => {
  await admin.setRestrictedWebFetchApprovals(true);
  try {
    const page = `https://${OTHER_HOST}/gatekeeper-needs-approval`;
    const model = models.script([
      readRestricted(),
      gatekeeperFetchCode("ask", [["fetchUrl", page]]),
      gatekeeperFetchCode("fetch-approved", [["fetchUrl", page]]),
      { text: "Done." },
    ]);
    await using session = await openSession(model);
    const asked = await session.runTurn("Read the restricted value, then fetch the page.");

    // The snapshot refused it, and the workspace asked the user: the turn ends on the card.
    expect(asked.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(2);
    const requests = asked.history.filter(msg => msg.type === "webFetchRequest");
    expect(requests).toEqual([expect.objectContaining({ url: page, state: "pending" })]);
    expect(received).toEqual([]);

    const resumed = await session.approveWebFetchRequestsAndWait([requests[0].requestId]);
    expect(resumed.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(4);
    expect(model.requests[3]).toMatchObject(toolResult("fetch-approved", `fetchUrl ${page}: 200 sent ${PAGE}`));
    expect(receivedUrls()).toEqual([page]);
    // The workspace decided this one, so it records it.
    expect(await fetchObservations(session)).toEqual([`GET \`${page}\``]);
  } finally {
    await admin.setRestrictedWebFetchApprovals(false);
  }
});
