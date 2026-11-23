import { describe, expect, it } from "vitest";

import { formatSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import { assertOwnServerSubresources, serverSubresourceId } from "../src/server-subresources.js";

// `verifyObserverAccess` denies every observer, so the only behavior left to get wrong is which IDs
// it accepts: anything this binding never reported must fail the call rather than pass silently.
describe("assertOwnServerSubresources", () => {
  it("accepts the binding's own server ID", () => {
    expect(() => assertOwnServerSubresources([serverSubresourceId("linear")], "linear"))
      .not.toThrow();
  });

  it("refuses another server's ID", () => {
    expect(() => assertOwnServerSubresources([serverSubresourceId("github")], "linear"))
      .toThrow(/different MCP server/);
  });

  it("refuses namespaced and multi-fragment IDs", () => {
    const namespaced = formatSubresourceId({
      namespace: "other",
      fragments: [{ name: "server", id: "linear" }],
    });
    const nested = formatSubresourceId({
      fragments: [{ name: "server", id: "linear" }, { name: "tool", id: "x" }],
    });
    const wrongKind = formatSubresourceId({ fragments: [{ name: "workspace", id: "linear" }] });
    for (const id of [namespaced, nested, wrongKind]) {
      expect(() => assertOwnServerSubresources([id], "linear")).toThrow(/Not an MCP server/);
    }
  });
});
