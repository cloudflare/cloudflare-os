import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { EndpointRegistry } from "../src/endpoint-registry.js";
import type { EndpointSummary, WebhookEvent } from "../src/types.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { WebhookAccount, WebhookVerifier } from "../src/webhook.js";

type TestExports = {
  EndpointRegistry: DurableObjectNamespace<EndpointRegistry>;
  WebhookScopeTestFacet: DurableObjectClass<WebhookScopeTestFacet>;
};

type TestMode = "success" | "start-reject" | "authorization-reject" | "callback-reject";

let mode: TestMode = "success";
let events: string[] = [];
let received: WebhookEvent[] = [];
let disposedApprovalQueues = 0;

class TestApprovalQueue extends RpcTarget {
  async authorizeObservation(description: { title: string; description: string }): Promise<void> {
    events.push(`authorize:${description.title}`);
    if (mode === "authorization-reject") throw new Error("authorization rejected");
  }

  [Symbol.dispose](): void {
    disposedApprovalQueues++;
  }
}

class TestCallback extends RpcTarget {
  async onWebhook(event: WebhookEvent): Promise<void> {
    events.push(`callback:${event.deliveryId}:${event.attempt}`);
    received.push(event);
    if (mode === "callback-reject") throw new Error("callback rejected");
  }
}

/** Test-only persistent hook initiator. */
export class TestHooks extends WorkerEntrypoint {
  async startHook(): Promise<{ callback: TestCallback; approvalQueue: TestApprovalQueue }> {
    events.push("start");
    if (mode === "start-reject") throw new Error("opaque admission rejection");
    return { callback: new TestCallback(), approvalQueue: new TestApprovalQueue() };
  }

  configure(nextMode: TestMode): void {
    mode = nextMode;
  }

  read() {
    return { events: [...events], received: [...received], disposedApprovalQueues };
  }

  reset(): void {
    mode = "success";
    events = [];
    received = [];
    disposedApprovalQueues = 0;
  }
}

/** Test-only parent used to exercise Webhooks scoping with real workerd facets. */
export class WebhookScopeTestParent extends DurableObject<Cloudflare.Env> {
  /** Lists one shared account through the inherited scope of a named Webhooks facet. */
  async listThroughFacet(facetName: string, accountId: string): Promise<EndpointSummary[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    const facet = this.ctx.facets.get<WebhookScopeTestFacet>(facetName, () => ({
      class: exports.WebhookScopeTestFacet,
    }));
    return facet.listForAccount(accountId);
  }
}

/** Test-only facet that applies the account-registry and inherited-workspace scoping. */
export class WebhookScopeTestFacet extends DurableObject<Cloudflare.Env> {
  /** Lists the shared account registry through this facet's inherited parent ID. */
  listForAccount(accountId: string): Promise<EndpointSummary[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    return exports.EndpointRegistry.getByName(accountId).listWorkspace(this.ctx.id.toString());
  }
}
