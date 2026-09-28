import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AdminApi } from "@gadgets/workshop-shared/api";
import { ADMIN_USERNAME, startHarness, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

// Admin config is deployment-wide, so this file owns its harness and runs serially.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
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

it("user search tracks display names and honours the admin switch without dropping the index",
    async () => {
  using stack = new DisposableStack();
  const publicApi = stack.use(connect(harness.url));
  const [viewer, target] = nextUsernames("viewer", "target");
  stack.use(await signUp(publicApi, viewer!));
  const targetApi = stack.use(await signUp(publicApi, target!, "Directory Target Before"));
  const before = [{ id: target, name: "Directory Target Before" }];
  const after = [{ id: target, name: "Directory Target After" }];

  await admin.setUserSearchEnabled(true);
  expect((await publicApi.getServerConfig()).userSearchEnabled).toBe(true);
  // Each capability caches the search policy, so every phase logs in afresh.
  let viewerApi = stack.use(await logIn(publicApi, viewer!));
  await waitFor("the target to be indexed", async () =>
    (await viewerApi.searchUsers("target before", [])).length > 0 || null);
  await expect(viewerApi.searchUsers("target before", [])).resolves.toEqual(before);
  await waitFor("the viewer to be indexed", async () =>
    (await targetApi.searchUsers(viewer!, [])).length > 0 || null);
  await expect(viewerApi.searchUsers(viewer!, [])).resolves.toEqual([]);
  await expect(viewerApi.searchUsers("target before", [target!])).resolves.toEqual([]);

  await targetApi.setOwnDisplayName("Directory Target After");
  await waitFor("the rename to be indexed", async () =>
    (await viewerApi.searchUsers("target after", [])).length > 0 || null);
  await expect(viewerApi.searchUsers("target after", [])).resolves.toEqual(after);
  await expect(viewerApi.searchUsers("target before", [])).resolves.toEqual([]);

  await admin.setUserSearchEnabled(false);
  viewerApi = stack.use(await logIn(publicApi, viewer!));
  await expect(viewerApi.searchUsers("target after", [])).resolves.toEqual([]);
  expect((await publicApi.getServerConfig()).userSearchEnabled).toBe(false);

  await admin.setUserSearchEnabled(true);
  viewerApi = stack.use(await logIn(publicApi, viewer!));
  await expect(viewerApi.searchUsers("target after", [])).resolves.toEqual(after);
});

it("closing signups refuses new accounts but keeps existing ones", async () => {
  using stack = new DisposableStack();
  const publicApi = stack.use(connect(harness.url));
  const [existing, late] = nextUsernames("existing", "late");
  stack.use(await signUp(publicApi, existing!));

  await admin.setSignupsEnabled(false);
  expect((await publicApi.getServerConfig()).signupsEnabled).toBe(false);
  await expect(signUp(publicApi, late!))
    .rejects.toThrow("New signups are currently disabled on this deployment.");
  stack.use(await logIn(publicApi, existing!));
});
