import { describe, expect, it } from "vitest";
import {
  commitStagedCredentials,
  peekStagedCredentials,
  stageCredentials,
  STAGED_CREDENTIALS_KEY,
} from "../src/credential-stage";
import { OAUTH_NONCE_LIFETIME_MS } from "../src/connect-nonce";
import { fakeKv } from "./fake-kv";

type Grant = { accessToken: string; scopes: string[] };
const GRANT: Grant = { accessToken: "new-token", scopes: ["repo"] };

describe("credential stage", () => {
  it("pins the durable key", () => {
    expect(STAGED_CREDENTIALS_KEY).toBe("stagedCredentials");
  });

  it("commits what was staged exactly once", () => {
    const kv = fakeKv();
    stageCredentials(kv, GRANT, 1_000);

    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);
    expect(commitStagedCredentials<Grant>(kv, 2_000)).toEqual(GRANT);
    expect(kv.keys()).toEqual([]);
    expect(commitStagedCredentials<Grant>(kv, 2_000)).toBeNull();
  });

  it("discards an expired stage rather than committing it", () => {
    const kv = fakeKv();
    stageCredentials(kv, GRANT, 1_000);

    expect(commitStagedCredentials<Grant>(kv, 1_000 + OAUTH_NONCE_LIFETIME_MS)).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("honours a caller-chosen lifetime and replaces an earlier stage", () => {
    const kv = fakeKv();
    stageCredentials(kv, { ...GRANT, accessToken: "first" }, 1_000, 500);
    stageCredentials(kv, GRANT, 1_200, 500);

    expect(peekStagedCredentials<Grant>(kv, 1_600)).toEqual(GRANT);
    expect(commitStagedCredentials<Grant>(kv, 1_600)).toEqual(GRANT);
  });

  it("peeks without consuming and fails closed on a corrupt or unusable clock", () => {
    const kv = fakeKv();
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    stageCredentials(kv, GRANT, 1_000);

    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual(GRANT);
    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual(GRANT);
    expect(peekStagedCredentials<Grant>(kv, Number.NaN)).toBeNull();
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);

    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, expiresAt: "soon" });
    expect(commitStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(kv.keys()).toEqual([]);
  });
});
