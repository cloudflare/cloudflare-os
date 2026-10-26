import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudIdentityApi } from "../src/cloud-identity-api";

const MAILBOX = { "cloudidentity.googleapis.com/groups.discussion_forum": "" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudIdentityApi.listGroupsOf", () => {
  it("lists only groups with a mailbox, filtering on each result's labels", async () => {
    const queries: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      queries.push(url.searchParams.get("query"));
      return Response.json({
        memberships: [
          { group: "groups/0team", groupKey: { id: "Team@example.com" }, displayName: "Team", labels: MAILBOX },
          { group: "groups/0sec", groupKey: { id: "security@example.com" }, displayName: "Security",
            labels: { "cloudidentity.googleapis.com/groups.security": "" } },
          { group: "groups/0bare", groupKey: { id: "bare@example.com" } },
        ],
      });
    }));

    const groups = await new CloudIdentityApi(async () => "token").listGroupsOf("owner@example.com");

    expect(groups).toEqual([{ name: "groups/0team", address: "team@example.com", displayName: "Team" }]);
    // Google answers 400 to a query that also filters on labels.
    expect(queries).toEqual(['member_key_id == "owner@example.com"']);
  });
});
