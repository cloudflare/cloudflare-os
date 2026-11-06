import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AdminApi } from "@gadgets/workshop-shared/api";
import { openAgentSession } from "../src/agent-session.js";
import { ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel } from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import { connect, signUp } from "../src/rpc-client.js";

// The trusted-host list is deployment-wide, so this file owns its harness and runs serially.
let harness: Harness;
let admin: RpcStub<AdminApi>;
const fileScope = new DisposableStack();
const models = scriptedModelRouter();

const TRUSTED_HOST = "gadgets-test.example";
const TARGET = `https://${TRUSTED_HOST}/restricted-web-fetch`;
const OTHER_HOST = "other.example";
const PAGE = "The trusted page.";
const webRequests: string[] = [];
const web: Handler = url => {
  if (url.host !== TRUSTED_HOST && url.host !== OTHER_HOST) return null;
  webRequests.push(url.href);
  return new Response(PAGE, { headers: { "content-type": "text/plain" } });
};
const network = new NetworkInterceptor({ handlers: [models.handler, web] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
  const adminApi = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const adminStub = fileScope.use(await adminApi.getAdminApi());
  if (adminStub === null) throw new Error("The deployment admin API was unavailable");
  admin = adminStub;
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

const READ_RESTRICTED = { toolCall: { id: "read-restricted", name: "executeCode", arguments: {
  code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue(true)); }",
} } };

const fetchStep = (id: string, url: string) => ({ toolCall: { id, name: "webFetch", arguments: { url } } });

const toolResult = (id: string, content: string) => ({ messages: expect.arrayContaining([
  expect.objectContaining({ role: "tool", tool_call_id: id, content: expect.stringContaining(content) }),
]) });

const openSession = (model: RoutedScriptedModel) => openAgentSession(harness.url, {
  modelId: SCRIPTED_MODEL_ID,
  userModel: model.userModel,
  ambientVendorIds: [TEST_VENDOR_ID],
  usernamePrefix: "restrictedfetch",
});

it("refuses a web fetch once the workspace has read restricted data, with no trusted hosts", async () => {
  const model = models.script([
    READ_RESTRICTED,
    fetchStep("fetch-page", TARGET),
    { text: "The page could not be fetched." },
  ]);
  await using session = await openSession(model);
  const turn = await session.runTurn("Read the restricted value, then fetch the page.");

  expect(turn.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(3);
  expect(model.requests[2]).toMatchObject(toolResult("fetch-page",
      "This workspace has observed sensitive data. To prevent leaks, the workspace is " +
      "prohibited from fetching from public web sites."));
  expect(webRequests).toEqual([]);
});

it("fetches only from trusted hosts once the workspace has read restricted data", async () => {
  await admin.setRestrictedWebFetchHosts([TRUSTED_HOST]);
  try {
    const model = models.script([
      READ_RESTRICTED,
      fetchStep("fetch-trusted", TARGET),
      fetchStep("fetch-other", "https://other.example/"),
      { text: "Done." },
    ]);
    await using session = await openSession(model);
    const turn = await session.runTurn("Read the restricted value, then fetch the pages.");

    expect(turn.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(4);
    expect(model.requests[2]).toMatchObject(toolResult("fetch-trusted", PAGE));
    expect(model.requests[3]).toMatchObject(toolResult("fetch-other", `may only fetch from ${TRUSTED_HOST}`));
    expect(webRequests).toEqual([TARGET]);
  } finally {
    await admin.setRestrictedWebFetchHosts([]);
  }
});

it("fetches a URL the trusted hosts refuse once the user approves it, if the admin allows that", async () => {
  await admin.setRestrictedWebFetchApprovals(true);
  try {
    const approved = `https://${OTHER_HOST}/approved?ref=docs`;
    const denied = `https://${OTHER_HOST}/another`;
    const model = models.script([
      READ_RESTRICTED,
      fetchStep("ask", approved),
      fetchStep("fetch-approved", approved),
      fetchStep("ask-again", denied),
      fetchStep("ask-after-prompt", approved),
    ]);
    await using session = await openSession(model);
    const asked = await session.runTurn("Read the restricted value, then fetch the page.");

    expect(asked.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(2);
    const requests = asked.history.filter(msg => msg.type === "webFetchRequest");
    expect(requests).toEqual([expect.objectContaining({ url: approved, state: "pending" })]);
    expect(webRequests).not.toContain(approved);

    const resumed = await session.approveWebFetchRequestsAndWait([requests[0].requestId]);

    expect(resumed.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(4);
    expect(model.requests[3]).toMatchObject(toolResult("fetch-approved", PAGE));
    expect(webRequests).toContain(approved);
    const pending = resumed.history.filter(msg => msg.type === "webFetchRequest")
        .filter(msg => msg.state === "pending");
    expect(pending).toEqual([expect.objectContaining({ url: denied })]);

    // A denial leaves the turn ended, and an approval ends with the turn it was given in.
    await session.denyWebFetchRequest(pending[0].requestId);
    const next = await session.runTurn("Fetch the first page again.");

    expect(next.outcome).toEqual({ status: "completed" });
    expect(model.requests).toHaveLength(5);
    expect(model.requests[4]).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining(`The user denied fetching ${denied}`) }),
    ]) });
    expect(next.history.filter(msg => msg.type === "webFetchRequest").at(-1))
      .toEqual(expect.objectContaining({ url: approved, state: "pending" }));
    expect(webRequests.filter(url => url === approved)).toHaveLength(1);
    expect(webRequests).not.toContain(denied);
  } finally {
    await admin.setRestrictedWebFetchApprovals(false);
  }
});
