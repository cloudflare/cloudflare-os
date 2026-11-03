import { exports } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { authenticate, connect } from "./rpc-fixtures";

function setUserSearchEnabled(enabled: boolean): Promise<void> {
  return exports.AdminSettings.getByName("").updateAdminConfig({ userSearchEnabled: enabled });
}

// Needs this suite's in-isolate clock, which the public-API suite can't reach.
it("an open capability re-reads the search policy once its cache expires", async () => {
  await setUserSearchEnabled(true);
  using publicApi = await connect();
  const viewer = await authenticate(publicApi, "policyviewer", "Policy Viewer");
  const target = await authenticate(publicApi, "policytarget", "Policy Target");
  using viewerApi = viewer.api;
  using _targetApi = target.api;
  const record = { id: target.username, name: "Policy Target" };
  await expect.poll(() => viewerApi.searchUsers("policy target", [])).toEqual([record]);

  const now = Date.now();
  const dateNow = vi.spyOn(Date, "now");
  try {
    await setUserSearchEnabled(false);
    dateNow.mockReturnValue(now + 30_000);
    await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([]);

    await setUserSearchEnabled(true);
    dateNow.mockReturnValue(now + 60_000);
    await expect(viewerApi.searchUsers("policy target", [])).resolves.toEqual([record]);
  } finally {
    dateNow.mockRestore();
  }
});
