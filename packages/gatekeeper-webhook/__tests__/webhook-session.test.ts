import { env } from "cloudflare:workers";
import { RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { EndpointRegistry } from "../src/endpoint-registry.js";
import { WebhookSessionImpl, describeWebhookAccount } from "../src/webhook.js";
import type { EndpointSummary } from "../src/types.js";

vi.mock("@gadgets/backend-utils/error-reporting", () => ({ reportIssue: vi.fn() }));

const testEnv = env as unknown as {
  ENDPOINT_REGISTRY: DurableObjectNamespace<EndpointRegistry>;
  WEBHOOK_SCOPE_TEST_PARENT: DurableObjectNamespace<{
    listThroughFacet(facetName: string, accountId: string): Promise<EndpointSummary[]>;
  }> & { idFromName(name: string): { toString(): string } };
};

/** A minimal workspace callback; capnweb validates that it really implements `WebhookHook`. */
const callback = new (class extends RpcTarget {
  async onWebhook(): Promise<void> {}
})();

function testCallback() {
  return callback as never;
}

const WORKSPACE = "workspace-session";

type Recorded = { bound: number; observations: string[] };

/** Stands in for the Overseer's approval queue, recording what the session asks of it. */
class FakeApprovalQueue extends RpcTarget {
  readonly recorded: Recorded = { bound: 0, observations: [] };
  constructor(private readonly failBind = false) {
    super();
  }
  async bindHook(): Promise<void> {
    if (this.failBind) throw new Error("hook binding refused");
    this.recorded.bound++;
  }
  async authorizeObservation(description: { title: string }): Promise<void> {
    this.recorded.observations.push(description.title);
  }
  dup(): FakeApprovalQueue {
    return this;
  }
  [Symbol.dispose](): void {}
}

let seq = 0;

function newSession(options: { failBind?: boolean } = {}) {
  const accountId = `session-account-${++seq}`;
  const approvalQueue = new FakeApprovalQueue(options.failBind);
  const claimed: string[] = [];
  let idSeq = 0;
  const session = new WebhookSessionImpl({
    accountId,
    workspaceId: WORKSPACE,
    // The real session takes an RPC stub; the fake implements the same surface.
    approvalQueue: approvalQueue as unknown as never,
    controllerFactory: () => ({}) as never,
    registry: testEnv.ENDPOINT_REGISTRY.getByName(accountId),
    claimEndpointId: async (endpointId) => {
      claimed.push(endpointId);
    },
    newEndpointId: () => `sess${String(++idSeq).padStart(2, "0")}aaaaaaaaaaaaaaaa`,
  });
  return { session, approvalQueue, claimed, accountId };
}

describe("WebhookSessionImpl", () => {
  it("mints credentials and binds one hook per registration", async () => {
    const { session, approvalQueue, claimed } = newSession();
    const credentials = await session.register(testCallback(), {
      title: "Stripe",
      description: "Payment events",
    });

    expect(credentials.url).toMatch(/\/e\/sess01aaaaaaaaaaaaaaaa$/);
    expect(credentials.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The public ID is claimed before the endpoint exists, so a live URL always resolves.
    expect(claimed).toEqual([credentials.endpointId]);
    expect(approvalQueue.recorded.bound).toBe(1);
  });

  it("does not leave a dead URL behind when hook binding fails", async () => {
    const { session } = newSession({ failBind: true });
    await expect(
      session.register(testCallback(), { title: "Stripe", description: "Payment events" }),
    ).rejects.toThrow(/hook binding refused/);
    expect(await session.list()).toHaveLength(0);
  });

  it("records an observation for each read", async () => {
    const { session, approvalQueue } = newSession();
    await session.register(testCallback(), { title: "Stripe", description: "Payment events" });
    await session.list();
    await session.deliveries();
    expect(approvalQueue.recorded.observations).toEqual([
      "List webhook endpoints",
      "Read webhook delivery history",
    ]);
  });

  it("rotates and revokes only within its own workspace", async () => {
    const { session, accountId } = newSession();
    const mine = await session.register(testCallback(), { title: "Mine", description: "d" });
    // An endpoint of a sibling workspace in the same account must be untouchable from here.
    const registry = testEnv.ENDPOINT_REGISTRY.getByName(accountId);
    await registry.register("other-workspace", "foreignaaaaaaaaaaaaaaa", {
      title: "Theirs",
      description: "d",
      methods: ["POST"],
    });

    const rotateError = await session
      .rotateToken("foreignaaaaaaaaaaaaaaa")
      .then(() => undefined, (error: unknown) => error);
    expect(String(rotateError)).toMatch(/Unknown webhook/);
    await session.revoke("foreignaaaaaaaaaaaaaaa");
    expect((await registry.listAccount()).endpoints.map((e) => e.endpointId).toSorted()).toEqual(
      [mine.endpointId, "foreignaaaaaaaaaaaaaaa"].toSorted(),
    );
  });
});

describe("account description", () => {
  it("advertises the ambient singleton and the management app", () => {
    expect(describeWebhookAccount()).toMatchObject({
      singleton: { tsType: "WebhookSession" },
      providesUi: { title: "Webhooks" },
    });
  });
});

describe("workspace scoping", () => {
  it("scopes a facet's listing to its inherited parent ID", async () => {
    const accountId = `scope-account-${++seq}`;
    const registry = testEnv.ENDPOINT_REGISTRY.getByName(accountId);
    const parent = testEnv.WEBHOOK_SCOPE_TEST_PARENT.getByName("scope-parent");
    expect(await parent.listThroughFacet("webhook", accountId)).toHaveLength(0);

    // A facet inherits its parent's ID, so registering under the parent's ID is what a workspace
    // session sees — and every sibling facet of that parent sees exactly the same set.
    const parentId = testEnv.WEBHOOK_SCOPE_TEST_PARENT.idFromName("scope-parent").toString();
    await registry.register(parentId, "scopedaaaaaaaaaaaaaaaa", {
      title: "Scoped",
      description: "d",
      methods: ["POST"],
    });
    expect(await parent.listThroughFacet("webhook", accountId)).toHaveLength(1);
    expect(await parent.listThroughFacet("sibling", accountId)).toHaveLength(1);
  });
});
