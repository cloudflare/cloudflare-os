import { expect, it } from "vitest";
import { authenticate, connect } from "./rpc-fixtures";

it("authenticated capabilities read/edit/clear only their own document, across sessions", async () => {
  using publicApi = await connect();
  const alice = await authenticate(publicApi, "alice", "Alice");
  const bob = await authenticate(publicApi, "bob", "Bob");
  using aliceApi = alice.api;
  using bobApi = bob.api;
  expect(await aliceApi.getOwnGlobalInstructions()).toBe("");
  await aliceApi.setOwnGlobalInstructions("Alice private defaults");
  await bobApi.setOwnGlobalInstructions("Bob private defaults");
  expect(await aliceApi.getOwnGlobalInstructions()).toBe("Alice private defaults");
  expect(await bobApi.getOwnGlobalInstructions()).toBe("Bob private defaults");
  expect(await aliceApi.whoami()).not.toHaveProperty("globalInstructions");
  using sameUser = await publicApi.authenticate(alice.token);
  expect(await sameUser.getOwnGlobalInstructions()).toBe("Alice private defaults");
  await sameUser.setOwnGlobalInstructions("Changed from another session");
  expect(await aliceApi.getOwnGlobalInstructions()).toBe("Changed from another session");
  await aliceApi.setOwnGlobalInstructions("");
  expect(await sameUser.getOwnGlobalInstructions()).toBe("");
  expect(await bobApi.getOwnGlobalInstructions()).toBe("Bob private defaults");
});
