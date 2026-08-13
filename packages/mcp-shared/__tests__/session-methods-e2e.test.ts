import { expect, it } from "vitest";

import { generateSessionTypes } from "../src/schema-to-ts.js";
import { installToolMethods } from "../src/session-methods.js";
import { classifyTool } from "../src/tools.js";

// The generated `.d.ts` is the only description of this binding an agent ever sees, so it must match
// the object it will actually be handed -- every promised method callable, and nothing callable that
// was not promised. Both sides derive from `callableTools`, and this asserts they really do agree.
it("every method the .d.ts promises is really installed, and routes to the right tool", () => {
  const reads = ["list_issues", "whoami", "map", "then", "2fa", "listIssues", "get-user-by-id",
                 "Search"];
  const writes = ["save_issue", "delete_project"];

  const tools = [
    ...reads.map(name => classifyTool({ name, annotations: { readOnlyHint: true } } as never, "byo")),
    // No `readOnlyHint` means "action", because classification fails closed.
    ...writes.map(name => classifyTool({ name } as never, "byo")),
  ];

  const dts = generateSessionTypes({
    baseTypes: "", serverId: "linear", serverName: "Linear",
    endpoint: "https://mcp.linear.app/mcp", discriminator: "https://mcp.linear.app/mcp",
    trust: "byo", tools,
  });
  const promised = [...dts.matchAll(/^ {2}([a-z]\w*)\(/gm)].map(match => match[1])
    .filter(name => ![
      "listTools", "callTool",
      "getActionResult",
    ].includes(name));

  class Base {
    called: string | null = null;
    callTool(name: string) { this.called = name; return name; }
  }
  const Session = installToolMethods(Base, tools);
  const session = new Session() as Base & Record<string, () => string>;

  // `list_issues` and `listIssues` collide so neither may claim the name; `then`/`map` are hijacked by
  // the RPC stub; `2fa` is not an identifier. The rest camel-case as expected -- including the writes,
  // which are queued for approval rather than refused.
  expect(promised.toSorted())
    .toEqual(["deleteProject", "getUserById", "saveIssue", "search", "whoami"]);

  for (const method of promised) {
    expect(typeof session[method], method).toBe("function");
    session[method]();
    expect([...reads, ...writes], method).toContain(session.called);
  }

  // Writes reach `callTool` like anything else; the approval queue, not the type, is the gate.
  for (const write of writes) expect(dts).toContain(`callTool(name: ${JSON.stringify(write)}`);
});
