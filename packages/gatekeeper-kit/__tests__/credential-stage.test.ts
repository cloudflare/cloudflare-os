import { describe, expect, it } from "vitest";
import {
  commitStagedCredentials,
  discardStagedCredentials,
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

  it("commits what was staged exactly once, to the id it handed out", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(stageId).toMatch(/^[0-9a-f]{64}$/);
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);
    expect(commitStagedCredentials<Grant>(kv, 2_000, stageId)).toEqual(GRANT);
    expect(kv.keys()).toEqual([]);
    expect(commitStagedCredentials<Grant>(kv, 2_000, stageId)).toBeNull();
  });

  it("refuses a ticket from an earlier stage and leaves the newer stage for its own", () => {
    // Two reconnects overlapped: the owner's (or an attacker's) finished first, then a phished
    // victim's replaced the stage. The first flow's ticket must not activate the second's tokens.
    const kv = fakeKv();
    const first = stageCredentials(kv, { ...GRANT, accessToken: "first" }, 1_000);
    const second = stageCredentials(kv, { ...GRANT, accessToken: "second" }, 1_200);
    expect(first).not.toBe(second);

    expect(commitStagedCredentials<Grant>(kv, 1_500, first)).toBeNull();
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);
    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({
      creds: { ...GRANT, accessToken: "second" }, stageId: second,
    });
    expect(commitStagedCredentials<Grant>(kv, 1_500, second)).toEqual({ ...GRANT, accessToken: "second" });
    expect(kv.keys()).toEqual([]);
  });

  it("discards an expired stage rather than committing it", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(commitStagedCredentials<Grant>(kv, 1_000 + OAUTH_NONCE_LIFETIME_MS, stageId)).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("honours a caller-chosen lifetime", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_200, 500);

    expect(peekStagedCredentials<Grant>(kv, 1_600)?.creds).toEqual(GRANT);
    expect(peekStagedCredentials<Grant>(kv, 1_700)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_600, stageId)).toEqual(GRANT);
  });

  it("peeks without consuming and fails closed on a corrupt or unusable clock", () => {
    const kv = fakeKv();
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({ creds: GRANT, stageId });
    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({ creds: GRANT, stageId });
    expect(peekStagedCredentials<Grant>(kv, Number.NaN)).toBeNull();
    expect(kv.keys()).toEqual([STAGED_CREDENTIALS_KEY]);

    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, stageId, expiresAt: "soon" });
    expect(commitStagedCredentials<Grant>(kv, 1_000, stageId)).toBeNull();
    expect(kv.keys()).toEqual([]);

    // A record written before stages carried an id is unusable, not committable by anyone.
    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, expiresAt: 5_000 });
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_000, "")).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("discards the stage on request, touching nothing else", () => {
    const kv = fakeKv();
    kv.put("tokens", { access_token: "live" });
    stageCredentials(kv, GRANT, 1_000);

    discardStagedCredentials(kv);
    expect(kv.keys()).toEqual(["tokens"]);
    discardStagedCredentials(kv);
    expect(kv.keys()).toEqual(["tokens"]);
  });
});
