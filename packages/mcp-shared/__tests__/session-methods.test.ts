import { describe, expect, it } from "vitest";

import {
  RESERVED_METHOD_NAMES, installToolMethods, toMethodName, toolMethodNames,
} from "../src/session-methods.js";
import type { ClassifiedTool } from "../src/tools.js";

function tool(name: string): ClassifiedTool {
  return {
    tool: { name, inputSchema: { type: "object", properties: {} } },
    mode: "read",
    autoApprovable: false,
    classifiedBy: "default",
  } as unknown as ClassifiedTool;
}

class Base {
  calls: Array<[string, unknown]> = [];
  callTool(name: string, args?: Record<string, unknown>) {
    this.calls.push([name, args]);
    return `called:${name}`;
  }
  getActionResult(_id: number) { return "result"; }
  listTools() { return []; }
}

describe("toMethodName", () => {
  it("camel-cases the shapes servers actually use", () => {
    expect(toMethodName("list_issues")).toBe("listIssues");
    expect(toMethodName("list-issues")).toBe("listIssues");
    expect(toMethodName("list.issues")).toBe("listIssues");
    expect(toMethodName("listIssues")).toBe("listIssues");
    expect(toMethodName("LIST")).toBe("lIST");
    expect(toMethodName("search")).toBe("search");
    expect(toMethodName("Search")).toBe("search");
  });

  it("returns null when no identifier can be made", () => {
    expect(toMethodName("")).toBeNull();
    expect(toMethodName("___")).toBeNull();
    expect(toMethodName("123")).toBeNull();
    expect(toMethodName("1_issue")).toBeNull();
  });
});

describe("toolMethodNames", () => {
  it("skips names the RPC layer cannot deliver", () => {
    // Measured against a real Cap'n Web session: each of these is intercepted by the stub or resolves
    // to something other than the target's method. A generated method would look present and misbehave.
    for (const name of ["then", "catch", "finally", "dup", "onRpcBroken", "constructor", "toString",
                        "valueOf", "hasOwnProperty", "map"]) {
      expect(toolMethodNames([tool(name)]).size, name).toBe(0);
    }
  });

  it("defuses __proto__ by renaming rather than skipping it", () => {
    // Camel-casing drops the underscores, so a tool named `__proto__` becomes the ordinary method
    // `proto`. Worth pinning: the danger of that name is the prototype setter, and a method called
    // `proto` cannot reach it. `__proto__` stays in RESERVED_METHOD_NAMES as a guard in case the
    // mapping ever starts preserving underscores.
    expect([...toolMethodNames([tool("__proto__")])]).toEqual([["proto", "__proto__"]]);
  });

  it("skips the session's own methods", () => {
    for (const name of ["call_tool", "get_action_result", "list_tools"]) {
      expect(toolMethodNames([tool(name)]).size, name).toBe(0);
    }
  });

  it("preserves delegates that predate progressive discovery", () => {
    expect([...toolMethodNames([
      tool("search_tools"), tool("describe_tool"), tool("call_discovered_tool"),
    ])]).toEqual([
      ["searchTools", "search_tools"],
      ["describeTool", "describe_tool"],
      ["callDiscoveredTool", "call_discovered_tool"],
    ]);
  });

  it("drops both sides of a collision rather than shadowing one", () => {
    const names = toolMethodNames([tool("list_issues"), tool("listIssues"), tool("search")]);
    expect([...names]).toEqual([["search", "search"]]);
  });

  it("keeps every reserved name in the exported set, so the two cannot drift", () => {
    for (const name of ["then", "map", "callTool"]) expect(RESERVED_METHOD_NAMES.has(name)).toBe(true);
  });
});

// Routing a generated method through `callTool` with the right wire name is asserted in
// `session-methods-e2e.test.ts`, against the tool list the generated `.d.ts` was built from. What is
// left here is the structural properties that test cannot see.
describe("installToolMethods", () => {
  it("installs on the prototype, not as own properties", () => {
    // Cap'n Web and Workers RPC both refuse own properties on an RpcTarget, so this is the whole
    // reason the design is a subclass rather than an object with assigned methods.
    const Session = installToolMethods(Base, [tool("list_issues")]);
    const session = new Session();

    expect(Object.hasOwn(session, "listIssues")).toBe(false);
    expect(Object.hasOwn(Object.getPrototypeOf(session), "listIssues")).toBe(true);
    expect(Object.keys(Object.getPrototypeOf(session))).toEqual([]);
  });

  it("leaves the base class untouched", () => {
    installToolMethods(Base, [tool("list_issues")]);
    expect("listIssues" in Base.prototype).toBe(false);
  });

  it("does not let one server's methods leak into another's", () => {
    const A = installToolMethods(Base, [tool("list_issues")]);
    const B = installToolMethods(Base, [tool("send_message")]);

    expect("listIssues" in new A()).toBe(true);
    expect("listIssues" in new B()).toBe(false);
    expect("sendMessage" in new A()).toBe(false);
  });
});
