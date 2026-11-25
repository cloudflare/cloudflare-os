import { env, RpcTarget, type RpcStub } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import type {
  ApprovalQueue, GitCache, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  WEB_SEARCH_IN_MODEL, WEB_SEARCH_PROVIDER_SETTING,
} from "@gadgets/workshop-shared/web-search-gatekeeper";

// The Workshop's queue, as far as a search uses it: it holds what an admin stored, and it refuses
// every record, which must stop a search before anything is sent.
class RefusingQueue extends RpcTarget implements ApprovalQueue {
  settingsReads = 0;
  readonly refused: ObservationDescription[] = [];
  readonly #settings: Record<string, string>;

  constructor(settings: Record<string, string>) {
    super();
    this.#settings = settings;
  }

  async getAdminSettings(): Promise<Record<string, string>> {
    ++this.settingsReads;
    return this.#settings;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.refused.push(description);
    throw new Error("refused");
  }

  getGitCache(): Promise<GitCache> { return unexpected(); }
  requireLive(): Promise<void> { return unexpected(); }
  watchSession(): Promise<RpcStub<RpcTarget>> { return unexpected(); }
  getExecutionId(): Promise<string | undefined> { return unexpected(); }
  submitAction(): Promise<void> { return unexpected(); }
  bindHook(): Promise<void> { return unexpected(); }
  getFetcher(): Promise<Fetcher> { return unexpected(); }
}

function unexpected(): never {
  throw new Error("A search uses only the queue's settings and its record.");
}

it("searches with what the admin stored, read once for each search", async () => {
  const queue = new RefusingQueue({ [WEB_SEARCH_PROVIDER_SETTING]: "linkup" });
  using session = await env.WEB_SEARCH_GATEKEEPER.getByName("stored-provider").startSession(queue);
  const search = async () => { await session.search("durable objects alarms"); };

  // The test Worker has no AI binding, so a search that went on past the refused record would
  // fail for want of one instead.
  await expect(search()).rejects.toThrow("refused");
  expect(queue.settingsReads).toBe(1);
  expect(queue.refused.map(record => record.description))
      .toEqual([expect.stringContaining('"linkup"')]);

  await expect(search()).rejects.toThrow("refused");
  expect(queue.settingsReads).toBe(2);
});

it("records nothing under the model's provider while the admin stored no fallback", async () => {
  const queue = new RefusingQueue({ [WEB_SEARCH_PROVIDER_SETTING]: WEB_SEARCH_IN_MODEL });
  using session = await env.WEB_SEARCH_GATEKEEPER.getByName("no-fallback").startSession(queue);
  const search = async () => { await session.search("durable objects alarms"); };

  await expect(search()).rejects.toThrow();
  expect(queue.refused).toEqual([]);
});

it("declares its two settings to the Workshop, the fallback shown under the model's provider",
    async () => {
  const { adminSettings } = await createExecutionContext().exports.GatekeeperVendor({}).describe();

  expect(adminSettings?.map(setting => setting.id)).toEqual([WEB_SEARCH_PROVIDER_SETTING, "fallback"]);
  expect(adminSettings?.[0]?.defaultValue).not.toBe(WEB_SEARCH_IN_MODEL);
  expect(adminSettings?.[1]?.shownWhen)
      .toEqual({ settingId: WEB_SEARCH_PROVIDER_SETTING, value: WEB_SEARCH_IN_MODEL });
});
