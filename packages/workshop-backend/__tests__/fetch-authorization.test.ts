import { afterAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

let doCounter = 0;

// Runs `fn` against a fresh workspace whose admin settings are `config`, restricted if `restricted`.
async function inOverseer(
    config: { restrictedWebFetchHosts?: string[]; restrictedWebFetchApprovals?: boolean },
    restricted: boolean, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`fetch-authorization-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // (Bracket access reaches the private field.)
    let impl = instance["impl"] as any;
    impl.ownerId = "owner";
    impl.env = { ...impl.env, BLUEPRINTS: { get: async () => JSON.stringify(config) } };
    impl.storage.containsRestrictedData.put(restricted);
    await fn(impl);
  });
}

const AGENT = { from: "agent", chatId: 1 } as const;

describe("OverseerImpl.authorizeFetch", () => {
  it("allows any public host in an unrestricted workspace, and records the request", async () => {
    await inOverseer({}, false, async impl => {
      let before = impl.storage.nextActionId.get();
      expect(await impl.authorizeFetch(AGENT, undefined, "HEAD", "https://example.com/a?q=1"))
          .toEqual({ allowed: true, restricted: false, approved: false });
      expect(impl.storage.actions.get(before)).toMatchObject({
        type: "observation", state: "approved", caller: AGENT,
        resourceUrl: "https://example.com/a?q=1",
        description: { title: "Fetched example.com", description: "HEAD `https://example.com/a?q=1`" },
      });
    });
  });

  it("allows only the trusted hosts once restricted, recording only what it allows", async () => {
    await inOverseer({ restrictedWebFetchHosts: ["docs.example.com"] }, true, async impl => {
      let gadget = { from: "gadget", gadgetId: 2 };
      expect(await impl.authorizeFetch(gadget, undefined, "GET", "https://docs.example.com/"))
          .toEqual({ allowed: true, restricted: true, approved: false });
      let before = impl.storage.nextActionId.get();
      for (let [url, message] of [
        ["https://other.example/", /may only fetch from docs\.example\.com/],
        ["https://docs.example.com/?q=secret", /query string/],
      ] as const) {
        expect(await impl.authorizeFetch(gadget, undefined, "GET", url))
            .toEqual({ allowed: false, message: expect.stringMatching(message) });
      }
      expect(impl.storage.nextActionId.get()).toBe(before);
    });
  });

  it("asks the user only on an agent's behalf where approvals are on", async () => {
    await inOverseer({ restrictedWebFetchApprovals: true }, true, async impl => {
      for (let caller of [{ from: "gadget", chatId: 1, gadgetId: 2 }, { from: "hook" }, { from: "user" }]) {
        expect(await impl.authorizeFetch(caller, undefined, "GET", "https://example.com/"))
            .toEqual({ allowed: false, message: expect.stringMatching(/prohibited from fetching/) });
      }
      expect(impl.consumeCapturedDecisionRequests(1)).toEqual([]);

      expect(await impl.authorizeFetch(AGENT, undefined, "GET", "https://example.com/"))
          .toEqual({ allowed: false, approvalRequested: true,
                     message: expect.stringMatching(/needs the user's approval/) });
      expect(impl.consumeCapturedDecisionRequests(1)).toEqual([expect.objectContaining({
        type: "webFetchRequest", url: "https://example.com/", state: "pending",
      })]);
    });
  });

  it("refuses once the workspace is deleted, recording nothing", async () => {
    // A deleted workspace's storage is wiped, so it reads as unrestricted.
    await inOverseer({}, false, async impl => {
      impl.ownerId = undefined;
      let before = impl.storage.nextActionId.get();
      for (let caller of [{ from: "hook" }, { from: "gadget", chatId: 1, gadgetId: 2 }, AGENT]) {
        expect(await impl.authorizeFetch(caller, undefined, "GET", "https://example.com/"))
            .toEqual({ allowed: false, message: "Workspace has been deleted." });
      }
      expect(impl.storage.nextActionId.get()).toBe(before);
    });
  });

  it("refuses an agent's execution that has ended or was stopped, without asking", async () => {
    await inOverseer({ restrictedWebFetchApprovals: true }, false, async impl => {
      impl.isLiveExecution = () => false;
      expect(await impl.authorizeFetch(AGENT, "exec", "GET", "https://example.com/"))
          .toEqual({ allowed: false, message: expect.stringMatching(/has ended/) });
      impl.isLiveExecution = () => true;
      impl.isStoppedExecution = () => true;
      expect(await impl.authorizeFetch(AGENT, "exec", "GET", "https://example.com/"))
          .toEqual({ allowed: false, message: expect.stringMatching(/stopped/) });
      impl.isStoppedExecution = () => false;
      expect(await impl.authorizeFetch(AGENT, "exec", "GET", "https://example.com/"))
          .toEqual({ allowed: true, restricted: false, approved: false });
    });
    await inOverseer({ restrictedWebFetchApprovals: true }, true, async impl => {
      impl.isLiveExecution = () => false;
      expect(await impl.authorizeFetch(AGENT, "exec", "GET", "https://example.com/"))
          .toEqual({ allowed: false, message: expect.stringMatching(/has ended/) });
      expect(impl.consumeCapturedDecisionRequests(1)).toEqual([]);
    });
  });
});

describe("ApprovalQueueImpl.getFetcher", () => {
  // A session's queue on a gatekeeper connection, as the gatekeeper receives it.
  async function openQueue(impl: any, caller: object, executionId?: string) {
    impl.storage.gatekeepers.put({ id: 7, class: impl.ctx.exports.ReplicaGitSource({}) });
    return await impl.openGatekeeperSession(
        7, { startSession: (queue: unknown) => queue } as never, caller, executionId);
  }

  it("mints a fetcher for the queue's caller that trusts the admin's trusted hosts", async () => {
    await inOverseer({ restrictedWebFetchHosts: ["docs.example.com"] }, false, async impl => {
      let minted = vi.spyOn(impl, "makeFetchLoopback");
      let queue = await openQueue(impl, AGENT, "exec");
      impl.isLiveExecution = () => true;
      impl.isStoppedExecution = () => false;
      let fetcher = await queue.getFetcher();
      expect(minted.mock.calls).toEqual([
        [AGENT, { executionId: "exec", agentDriven: false, trustedHosts: ["docs.example.com"] }],
      ]);

      // The workspace decides another host's request by its policy as it stands now.
      impl.storage.containsRestrictedData.put(true);
      let asked = vi.spyOn(impl, "authorizeFetch");
      let response = await fetcher.fetch("https://other.example/");
      expect(response.status).toBe(403);
      expect(response.headers.get("cloudflare-os-fetch-refused")).toBe("denied");
      expect(await response.text()).toMatch(/may only fetch from docs\.example\.com/);
      expect(asked).toHaveBeenCalledWith(AGENT, "exec", "GET", "https://other.example/");
    });
  });

  it("throws once the session has ended", async () => {
    await inOverseer({}, false, async impl => {
      let queue = await openQueue(impl, AGENT, "exec");
      impl.isLiveExecution = () => false;
      await expect(queue.getFetcher()).rejects.toThrow(/code execution this session belongs to has ended/);
      queue = await openQueue(impl, { from: "user" });
      impl.removeGatekeeper(7);
      await expect(queue.getFetcher()).rejects.toThrow(/connection has been removed/);
    });
  });
});

afterAll(() => abortAllDurableObjects());
