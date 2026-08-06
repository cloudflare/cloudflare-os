import { expect, it } from "vite-plus/test";

import { McpFacetBase } from "../src/facet.js";
import { McpSessionBase } from "../src/session.js";
import { classifyTool, type ClassifiedTool, type ServerTrust } from "../src/tools.js";
import type { ConnectionAccount } from "../src/connection.js";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";

const log = {
  debug() {}, info() {}, error() {},
  warnings: [] as string[],
  warn(message: string) { this.warnings.push(message); },
  with() { return this; },
};

class TestSession extends McpSessionBase {}

class TestFacet extends McpFacetBase<object, {
  endpoint: string;
  scope: {};
}, TestSession> {
  catalog: Promise<ClassifiedTool[]> = Promise.resolve([
    classifyTool({ name: "list_issues", annotations: { readOnlyHint: true } } as never, "byo"),
  ]);

  protected get log() { return log; }
  protected get trust(): ServerTrust { return "byo"; }
  protected get sessionClass() { return TestSession; }
  protected get actionScopeTag() { return "test"; }
  protected get observerName() { return "the test server"; }
  protected account(): ConnectionAccount { throw new Error("not used"); }
  describe(): Promise<ResourceDescription> { throw new Error("not used"); }
  getTypeScriptTypes(): Promise<string> { throw new Error("not used"); }
  get serverName() { return "Test"; }
  override tools() { return this.catalog; }
}

function facet() {
  const ctx = {
    props: { endpoint: "https://example.com/mcp", scope: {} },
    storage: { kv: {} },
  };
  return new TestFacet(ctx as never, {});
}

const queue = {
  dup() { return this; },
  authorizeObservation() {},
};

it("builds tool methods and falls back to the plain session when catalog loading fails", async () => {
  const subject = facet();
  const dynamic = await subject.startSession(queue as never);
  expect("listIssues" in dynamic).toBe(true);

  subject.catalog = Promise.reject(new Error("offline"));
  const fallback = await subject.startSession(queue as never);
  expect("listIssues" in fallback).toBe(false);
  expect(log.warnings).toContain("starting session without per-tool methods");
});

it("keeps facets owner-only using the connector's resource label", async () => {
  await expect(facet().addObserver("observer", {} as never))
    .rejects.toThrow(/test server.*only be opened by its owner/s);
});
