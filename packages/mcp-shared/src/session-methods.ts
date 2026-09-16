// Gives a session a named method per tool, so a Gadget writes `env.LINEAR.listIssues({...})` rather
// than `env.LINEAR.callTool("list_issues", {...})`. The runtime half of `schema-to-ts.ts`.
//
// Methods go on a prototype, never as own properties, since Cap'n Web and Workers RPC both refuse
// own properties on an `RpcTarget`. Each is a one-line delegate to `callTool`, so the scope check,
// approval queue, and observation record stay in one place and the delegates inherit the
// `@validateRpc()` checking applied there.

import type { ClassifiedTool } from "./tools.js";

/**
 * Method names that must never be generated. The first group is measured: an `RpcStub` intercepts
 * these or resolves them to something other than the target's method, so a tool named after one
 * would appear to exist and then misbehave. The second is the session's own surface.
 */
export const RESERVED_METHOD_NAMES: ReadonlySet<string> = new Set([
  // Intercepted or hijacked by the RPC stub itself.
  "then", "catch", "finally", "dup", "onRpcBroken", "constructor", "toString", "valueOf",
  "hasOwnProperty", "__proto__", "map",
  // The session's own methods.
  "callTool", "getActionResult", "listTools",
]);

/**
 * Converts an MCP tool name to a JavaScript method name: `list_issues` -> `listIssues`. Null when
 * the name cannot become a usable identifier; servers are free to name tools anything.
 */
export function toMethodName(wireName: string): string | null {
  const parts = wireName.split(/[^A-Za-z0-9]+/).filter(part => part.length > 0);
  if (parts.length === 0) return null;

  const [first, ...rest] = parts;
  const name = first[0].toLowerCase() + first.slice(1) +
    rest.map(part => part[0].toUpperCase() + part.slice(1)).join("");

  // A leading digit cannot start an identifier, and a name the agent cannot type in the generated
  // `.d.ts` is not worth having. Such tools remain reachable through `callTool`.
  return /^[A-Za-z_$]/.test(name) ? name : null;
}

/**
 * Maps generated method name to wire tool name, for the tools that can have one. Both sides of a
 * collision are dropped: with `list_issues` and `listIssues` both published, one shadowing the other
 * would send a Gadget to a tool it did not mean, while `callTool` keeps the names distinct.
 */
export function toolMethodNames(tools: ClassifiedTool[]): Map<string, string> {
  const claims = new Map<string, string[]>();
  for (const { tool } of tools) {
    const method = toMethodName(tool.name);
    if (method === null || RESERVED_METHOD_NAMES.has(method)) continue;
    const existing = claims.get(method);
    if (existing) existing.push(tool.name);
    else claims.set(method, [tool.name]);
  }

  const names = new Map<string, string>();
  for (const [method, wireNames] of claims) {
    if (wireNames.length === 1) names.set(method, wireNames[0]);
  }
  return names;
}

// A class whose instances have a `callTool` method, which is all the generated delegates need.
type CallsTools = { callTool(name: string, args?: Record<string, unknown>): unknown };

// Constructor shape of a class that can be extended here. `any[]` because TypeScript requires
// exactly this of a mixin base (TS2545); the constructor arguments are never touched.
type SessionBase = abstract new (...args: any[]) => CallsTools;

/**
 * Returns a subclass of `Base` carrying one method per tool. `Base` is untouched, so a session built
 * from it directly still works when the tool list cannot be fetched at all.
 */
export function installToolMethods<T extends SessionBase>(Base: T, tools: ClassifiedTool[]): T {
  // An anonymous subclass, so the prototype this mutates cannot be one anything else shares.
  abstract class WithTools extends Base {}

  for (const [method, wireName] of toolMethodNames(tools)) {
    Object.defineProperty(WithTools.prototype, method, {
      value: function(this: CallsTools, args?: Record<string, unknown>) {
        return this.callTool(wireName, args);
      },
      // Not enumerable, matching how class methods are declared.
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  return WithTools as unknown as T;
}
