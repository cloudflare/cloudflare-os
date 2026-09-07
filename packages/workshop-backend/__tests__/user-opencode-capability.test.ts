import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { CodingSessionsService } from "@gadgets/workshop-shared/coding-sessions";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

describe("UserDurableObject.mintCodingSessionOpenCodeCapability", () => {
  it.each([
    { scenario: "authorized", error: undefined },
    { scenario: "missing session", error: "Coding session was not found." },
    { scenario: "repository denied", error: "Your GitHub account cannot push to every selected repository." },
    { scenario: "missing connection", error: "Connect a valid GitHub account to use coding sessions." },
    { scenario: "expired connection", error: "Connect a valid GitHub account to use coding sessions." },
    { scenario: "disabled GitHub", error: "GitHub is disabled on this deployment." },
    { scenario: "owner failure", error: "Owner unavailable" },
    { scenario: "registry rejection", error: "Coding session is not running." },
  ])("uses metadata before live authorization and mint: $scenario", async ({ scenario, error }) => {
    const stub = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (user: UserDurableObject, state) => {
      const calls: string[] = [];
      const owner = { userId: state.id.toString(), email: "owner@example.com" };
      const capability = { url: "https://sessions.example/opencode/test/", expiresAt: new Date() };
      const service = {
        getSession: vi.fn<CodingSessionsService["getSession"]>(),
        getSessionMetadata: vi.fn<CodingSessionsService["getSessionMetadata"]>(async () => {
          calls.push("metadata");
          return scenario === "missing session" ? undefined : {
            id: "session-1", title: "Test", repositories: ["jarvis", "odie"],
            runtime: "opencode", status: "running", createdAt: new Date(), lastActiveAt: new Date(),
          };
        }),
        mintOpenCodeCapability: vi.fn<CodingSessionsService["mintOpenCodeCapability"]>(async () => {
          calls.push("mint");
          if (scenario === "registry rejection") throw new Error(error);
          return capability;
        }),
      } satisfies Pick<CodingSessionsService, "getSession" | "getSessionMetadata" | "mintOpenCodeCapability">;
      const hasRepoWriteAccess = vi.fn(async (repoOwner: string, repository: string) => {
        calls.push(`repository:${repoOwner}/${repository}`);
        return scenario !== "repository denied" || repository !== "odie";
      });
      Object.assign(user, {
        sessionsService: service,
        env: { BLUEPRINTS: { get: async () => {
          calls.push("config");
          return JSON.stringify({ disabledGatekeepers: scenario === "disabled GitHub" ? ["github"] : [] });
        } } },
        storage: {
          profile: { get: () => {
            calls.push("owner");
            if (scenario === "owner failure") throw new Error(error);
            return { type: "user", id: owner.email, name: "Owner" };
          } },
          nextAccountId: { get: () => 1 },
          connectedAccounts: { get: () => scenario === "missing connection" ? undefined : {
            vendorId: "github", credentialsExpired: scenario === "expired connection",
            account: {
              describe: async () => { calls.push("describe"); return { uniqueName: "owner" }; },
              getVerifier: async () => { calls.push("verifier"); return { hasRepoWriteAccess }; },
            },
          } },
        },
      });

      const result = user.mintCodingSessionOpenCodeCapability("session-1");
      if (error) await expect(result).rejects.toThrow(error);
      else await expect(result).resolves.toEqual(capability);

      const expected = ["owner"];
      if (scenario !== "owner failure") {
        expected.push("metadata");
        expect(service.getSessionMetadata).toHaveBeenCalledExactlyOnceWith(owner, "session-1");
        if (scenario !== "missing session") {
          expected.push("config");
          if (!["disabled GitHub", "missing connection", "expired connection"].includes(scenario)) {
            expected.push("describe", "verifier", "repository:totango/jarvis", "repository:totango/odie");
            if (scenario !== "repository denied") expected.push("owner", "mint");
          }
        }
      }
      expect(calls).toEqual(expected);
      expect(service.getSession).not.toHaveBeenCalled();
      if (expected.includes("mint")) {
        expect(service.mintOpenCodeCapability).toHaveBeenCalledExactlyOnceWith(
          { ...owner, githubLogin: "owner" }, "session-1",
        );
      } else {
        expect(service.mintOpenCodeCapability).not.toHaveBeenCalled();
      }
    });
  });
});
