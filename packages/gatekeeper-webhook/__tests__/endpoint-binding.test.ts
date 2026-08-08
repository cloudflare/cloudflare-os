import { env } from "cloudflare:workers";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EndpointRegistry, ReceiveInput } from "../src/endpoint-registry.js";
import { WebhookEndpointSessionImpl, WebhookEndpointConfiguratorUI } from "../src/webhook.js";

vi.mock("@gadgets/backend-utils/error-reporting", () => ({ reportIssue: vi.fn() }));

const testEnv = env as unknown as {
  ENDPOINT_REGISTRY: DurableObjectNamespace<EndpointRegistry>;
};

/** A minimal workspace callback; capnweb validates that it really implements `WebhookHook`. */
const callback = new (class extends RpcTarget {
  async onWebhook(): Promise<void> {}
})();

class FakeApprovalQueue extends RpcTarget {
  readonly bound: { title: string; description: string }[] = [];
  readonly observations: string[] = [];
  async bindHook(
    _controller: unknown,
    _callback: unknown,
    description: { title: string; description: string },
  ): Promise<void> {
    this.bound.push(description);
  }
  async authorizeObservation(description: { title: string }): Promise<void> {
    this.observations.push(description.title);
  }
  dup(): FakeApprovalQueue {
    return this;
  }
  [Symbol.dispose](): void {}
}

const WORKSPACE = "workspace-binding";
const REGISTRATION = { title: "Alertmanager", description: "Pod alerts", methods: ["POST"] };

let seq = 0;

function newRegistry(): DurableObjectStub<EndpointRegistry> {
  return testEnv.ENDPOINT_REGISTRY.getByName(`binding-account-${++seq}`);
}

function endpointSession(
  registry: DurableObjectStub<EndpointRegistry>,
  endpointId: string,
  workspaceId = WORKSPACE,
) {
  const approvalQueue = new FakeApprovalQueue();
  const session = new WebhookEndpointSessionImpl({
    accountId: "account",
    workspaceId,
    endpointId,
    approvalQueue: approvalQueue as unknown as never,
    controllerFactory: () => ({}) as never,
    registry,
  });
  return { session, approvalQueue };
}

function receiveInput(endpointId: string, token: string | null): ReceiveInput {
  return {
    endpointId,
    token,
    method: "POST",
    subPath: "",
    query: {},
    headers: {},
    body: "{}",
    truncated: false,
  };
}

beforeEach(() => {
  seq += 0;
});

describe("endpoints created from the workspace configurator", () => {
  it("mints an endpoint with no token, which therefore accepts nothing", async () => {
    const registry = newRegistry();
    const { url } = await registry.createWithoutToken("", "cfgaaaaaaaaaaaaaaaaaaa", REGISTRATION);
    expect(url).toMatch(/\/e\/cfgaaaaaaaaaaaaaaaaaaa$/);

    const summary = await registry.getEndpoint("cfgaaaaaaaaaaaaaaaaaaa");
    expect(summary).toMatchObject({ hasToken: false, status: "disabled" });

    // No token issued means no credential can match, so even a well-formed request is refused.
    expect(await registry.receive(receiveInput("cfgaaaaaaaaaaaaaaaaaaa", "anything"))).toMatchObject(
      { status: 401 },
    );
  });

  it("starts accepting once a token is generated and the hook is enabled", async () => {
    const registry = newRegistry();
    await registry.createWithoutToken("", "cfgbbbbbbbbbbbbbbbbbbb", REGISTRATION);
    await registry.adopt("cfgbbbbbbbbbbbbbbbbbbb", WORKSPACE);
    const { token } = await registry.rotateToken("cfgbbbbbbbbbbbbbbbbbbb", WORKSPACE);
    expect((await registry.getEndpoint("cfgbbbbbbbbbbbbbbbbbbb", WORKSPACE))?.hasToken).toBe(true);

    await runInDurableObject(registry, (instance) =>
      instance.enable(
        WORKSPACE,
        "cfgbbbbbbbbbbbbbbbbbbb",
        (instance.ctx.exports as unknown as { TestHooks(o: object): never }).TestHooks({}),
      ),
    );
    expect(
      await registry.receive(receiveInput("cfgbbbbbbbbbbbbbbbbbbb", token), Date.now() + 600_000),
    ).toMatchObject({ accepted: true });
  });

  it("claims the ID and creates the endpoint unassigned", async () => {
    const registry = newRegistry();
    const claimed: string[] = [];
    const ui = new WebhookEndpointConfiguratorUI({
      accountId: "account",
      registry,
      claimEndpointId: async (endpointId) => {
        claimed.push(endpointId);
      },
      newEndpointId: () => "cfgcccccccccccccccccc",
    });

    const url = await ui.createEndpoint("Alertmanager", "Pod alerts", "POST,PUT");
    expect(url).toMatch(/\/e\/cfgcccccccccccccccccc$/);
    expect(claimed).toEqual(["cfgcccccccccccccccccc"]);
    // Unassigned: it belongs to no workspace until a workspace binds it.
    expect(await registry.listWorkspace(WORKSPACE)).toHaveLength(0);
    expect((await registry.getEndpoint("cfgcccccccccccccccccc"))?.methods).toEqual(["POST", "PUT"]);
  });
});

describe("WebhookEndpointSessionImpl", () => {
  it("binds a hook using the endpoint's own title and description", async () => {
    const registry = newRegistry();
    await registry.createWithoutToken("", "sesaaaaaaaaaaaaaaaaaa", REGISTRATION);
    await registry.adopt("sesaaaaaaaaaaaaaaaaaa", WORKSPACE);

    const { session, approvalQueue } = endpointSession(registry, "sesaaaaaaaaaaaaaaaaaa");
    await session.onWebhook(new RpcStub(callback) as never);
    expect(approvalQueue.bound).toEqual([
      { title: "Alertmanager", description: "Pod alerts" },
    ]);
  });

  it("cannot reach an endpoint belonging to another workspace", async () => {
    const registry = newRegistry();
    await registry.createWithoutToken("", "sesbbbbbbbbbbbbbbbbbb", REGISTRATION);
    await registry.adopt("sesbbbbbbbbbbbbbbbbbb", "someone-elses-workspace");

    const { session } = endpointSession(registry, "sesbbbbbbbbbbbbbbbbbb");
    const caught = await session.onWebhook(new RpcStub(callback) as never).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(caught).toMatch(/no longer exists/);
  });

  it("refuses to re-bind an endpoint into a second workspace", async () => {
    const registry = newRegistry();
    await registry.createWithoutToken("", "sesccccccccccccccccccc", REGISTRATION);
    await registry.adopt("sesccccccccccccccccccc", WORKSPACE);

    // Called in-process: a rejection crossing the RPC boundary is reported twice by the test pool.
    const caught = await runInDurableObject(registry, (instance) =>
      instance
        .adopt("sesccccccccccccccccccc", "other-workspace")
        .then(() => "", (error: unknown) => String(error)),
    );
    // Re-pointing a live URL at a different workspace would silently redirect its deliveries.
    expect(caught).toMatch(/already bound to another workspace/);
  });

  it("adopting into the same workspace twice is a no-op", async () => {
    const registry = newRegistry();
    await registry.createWithoutToken("", "sesddddddddddddddddddd", REGISTRATION);
    await registry.adopt("sesddddddddddddddddddd", WORKSPACE);
    await registry.adopt("sesddddddddddddddddddd", WORKSPACE);
    expect(await registry.listWorkspace(WORKSPACE)).toHaveLength(1);
  });

  it("records observations for reads and scopes deliveries to its own endpoint", async () => {
    const registry = newRegistry();
    await registry.createWithoutToken("", "seseeeeeeeeeeeeeeeeeee", REGISTRATION);
    await registry.adopt("seseeeeeeeeeeeeeeeeeee", WORKSPACE);

    const { session, approvalQueue } = endpointSession(registry, "seseeeeeeeeeeeeeeeeeee");
    await session.describe();
    await session.deliveries();
    expect(approvalQueue.observations).toEqual([
      "Read webhook endpoint details",
      "Read webhook delivery history",
    ]);
  });
});
