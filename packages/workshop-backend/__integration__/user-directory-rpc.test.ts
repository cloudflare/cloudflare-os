import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import server from "../src/server";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await server.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }), env, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(
    publicApi: RpcStub<PublicApi>, prefix: string, displayName: string,
): Promise<{ username: string; token: string }> {
  const name = prefix + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, displayName, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return { username: name, token };
}

// User search is admin policy. The AdminSettings DO is the config's only writer, so go through it
// (rather than the KV mirror) like AdminApiImpl does; each test sets the state it relies on.
function setUserSearchEnabled(enabled: boolean): Promise<void> {
  return exports.AdminSettings.getByName("").updateAdminConfig({ userSearchEnabled: enabled });
}

describe("authenticated user directory RPC", () => {
  it("indexes a user when it authenticates and re-indexes on rename", async () => {
    await setUserSearchEnabled(true);
    using publicApi = await connect();
    const viewer = await createAccount(publicApi, "directoryviewer", "Directory Viewer");
    const target = await createAccount(publicApi, "directorytarget", "Directory Target Before");
    using viewerApi = await publicApi.authenticate(viewer.token);

    // createAccount alone does not index: the directory is written where a session is minted.
    await expect(viewerApi.searchUsers("target bef", [])).resolves.toEqual([]);
    using targetApi = await publicApi.authenticate(target.token);
    // The sync is fire-and-forget from the user DO, so the record lands shortly after the call.
    await expect.poll(() => viewerApi.searchUsers("target bef", [])).toEqual([
      { id: target.username, name: "Directory Target Before" },
    ]);
    // The authenticated caller is always excluded, and callers can exclude more users.
    await expect(viewerApi.searchUsers("directory viewer", [])).resolves.toEqual([]);
    await expect(viewerApi.searchUsers("target bef", [target.username])).resolves.toEqual([]);

    await targetApi.setOwnDisplayName("Directory Target After");
    await expect.poll(() => viewerApi.searchUsers("target aft", [])).toEqual([
      { id: target.username, name: "Directory Target After" },
    ]);
    await expect(viewerApi.searchUsers("target bef", [])).resolves.toEqual([]);
  });

  it("hides the directory from users while search is off, without dropping the index", async () => {
    await setUserSearchEnabled(true);
    using publicApi = await connect();
    const viewer = await createAccount(publicApi, "policyviewer", "Policy Viewer");
    const target = await createAccount(publicApi, "policytarget", "Policy Target");
    using viewerApi = await publicApi.authenticate(viewer.token);
    using _targetApi = await publicApi.authenticate(target.token);
    const record = { id: target.username, name: "Policy Target" };
    await expect.poll(() => viewerApi.searchUsers("policy target", [])).toEqual([record]);

    await setUserSearchEnabled(false);
    await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([]);
    await expect(viewerApi.searchUsers(target.username, [])).resolves.toEqual([]);

    // Indexing continued while search was off: the record is there the moment it's turned back on.
    await setUserSearchEnabled(true);
    await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([record]);
  });
});
