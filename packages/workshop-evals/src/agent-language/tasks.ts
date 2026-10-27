import { isDeepStrictEqual } from "node:util";
import type { RuntimeResult } from "./runtime.ts";
export interface Task {
  id: string;
  category: string;
  prompt: string;
  expected: unknown;
  js: string;
  baml: string;
  bindings: string[];
  counter?: number;
  closed?: boolean;
}
export const bamlTypes = `class Owner { name string }
class Ticket { id string\n priority "high" | "low"\n owner Owner?\n created string\n points int\n status "open" | "closed" }
class Metadata { tags string[] }
class CloseInput { id string\n resolution "fixed" | "duplicate"\n metadata Metadata? }
class Ok { ok bool }
class Failure { ok false\n error "timeout" }
class Success { ok true\n ids string[] }
class Filter { priority "high" | "low" }
class QueryInput { filter Filter\n limit int? }
class QueryResult { items Ticket[] }
`;
const task = (
  id: string,
  category: string,
  prompt: string,
  expected: unknown,
  body: string,
  baml: string,
  bindings: string[] = [],
  extra: Partial<Task> = {},
): Task => ({
  id,
  category,
  prompt,
  expected,
  js: `export default async function(self, env, ctx) { ${body} }`,
  baml:
    bamlTypes +
    baml
      .replaceAll("list: () -> Ticket[]", "list: () -> QueryResult")
      .replaceAll("list()", "list().items"),
  bindings,
  ...extra,
});
export const callbackSignatures: Record<string, string> = {
  list: "() -> QueryResult",
  get: "(string) -> Ticket?",
  close: "(CloseInput) -> Ok",
  flaky: "() -> (Success | Failure)",
  read: "() -> int",
  write: "(int) -> void",
  increment: "() -> void",
  query: "(QueryInput) -> QueryResult",
};
export const tasks: Task[] = [
  task(
    "aggregate",
    "computation",
    "From [3,1,4,1,5], keep odd numbers, sort ascending, and return their sum.",
    10,
    "return [3,1,4,1,5].filter(n=>n%2===1).sort((a,b)=>a-b).reduce((a,b)=>a+b,0);",
    "function Main() -> int { let total = 0; for (let n in [3,1,4,1,5]) { if (n % 2 == 1) { total += n; } } total }",
  ),
  task(
    "typed-list",
    "typed-api",
    "Call TICKETS.list, return the high priority ticket IDs in ascending order.",
    ["a", "c"],
    'return (await env.TICKETS.list()).filter(t=>t.priority==="high").map(t=>t.id).sort();',
    'function Main(list: () -> Ticket[]) -> string[] { let ids: string[] = []; for (let t in list()) { if (t.priority == "high") { ids.push(t.id); } } ids }',
    ["list"],
  ),
  task(
    "nullable",
    "typed-api",
    'Fetch missing ticket z. Return "missing" when absent, otherwise its owner name or "unassigned".',
    "missing",
    'const t=await env.TICKETS.get("z"); return t?.owner?.name ?? (t ? "unassigned" : "missing");',
    'function Main(get: (string) -> Ticket?) -> string { let t = get("z"); if (t == null) { "missing" } else { let owner = t.owner; if (owner == null) { "unassigned" } else { owner.name } } }',
    ["get"],
  ),
  task(
    "mcp",
    "unfamiliar-api",
    "Use MCP.query with nested filter priority high and limit 1; return the matching IDs.",
    ["a"],
    'return (await env.MCP.query({filter:{priority:"high"},limit:1})).items.map(t=>t.id);',
    'function Main(query: (QueryInput) -> QueryResult) -> string[] { let r = query(QueryInput { filter: Filter { priority: "high" }, limit: 1 }); let ids: string[] = []; for (let t in r.items) { ids.push(t.id); } ids }',
    ["query"],
  ),
  task(
    "recovery",
    "error-handling",
    'TICKETS.flaky returns {ok:false,error:"timeout"} on its first call and {ok:true,ids:[...]} on the second. Retry once on timeout and return ids.',
    ["a", "c"],
    "let r=await env.TICKETS.flaky(); if(!r.ok) r=await env.TICKETS.flaky(); if(!r.ok) throw Error(r.error); return r.ids;",
    "function Main(flaky: () -> (Success | Failure)) -> string[] { let r = flaky(); if (r is Success) { r.ids } else { let s = flaky(); if (s is Success) { s.ids } else { [] } } }",
    ["flaky"],
  ),
  task(
    "counter",
    "concurrency",
    "Increment COUNTER twice. Avoid lost updates: increment is atomic; read/write are separate operations. Return the final counter.",
    2,
    "await Promise.all([env.COUNTER.increment(),env.COUNTER.increment()]); return await env.COUNTER.read();",
    "function Main(increment: () -> void, read: () -> int) -> int { let a = spawn { increment() }; let b = spawn { increment() }; await a; await b; read() }",
    ["increment", "read"],
    { counter: 2 },
  ),
  task(
    "workflow",
    "multi-step",
    'Find high priority tickets, close only ticket a using resolution fixed and metadata tags ["triaged"], then fetch a and return its status. Only a is authorized for writes.',
    "closed",
    'const ts=await env.TICKETS.list(); if(ts.some(t=>t.id==="a"&&t.priority==="high")) await env.TICKETS.close({id:"a",resolution:"fixed",metadata:{tags:["triaged"]}}); return (await env.TICKETS.get("a"))?.status;',
    'function Main(list: () -> Ticket[], close: (CloseInput) -> Ok, get: (string) -> Ticket?) -> string { for (let t in list()) { if (t.id == "a" && t.priority == "high") { close(CloseInput {id:"a",resolution:"fixed",metadata:Metadata {tags:["triaged"]}}); } } let t = get("a"); if (t == null) { "missing" } else { t.status } }',
    ["list", "close", "get"],
    { closed: true },
  ),
  task(
    "date-boundary",
    "semantics",
    "Sum points for tickets created on or after 2026-10-02 and strictly before 2026-10-03; return the sum.",
    5,
    'return (await env.TICKETS.list()).filter(t=>t.created>="2026-10-02"&&t.created<"2026-10-03").reduce((a,t)=>a+t.points,0);',
    'function Main(list: () -> Ticket[]) -> int { let sum=0; for(let t in list()) { if(t.created >= "2026-10-02" && t.created < "2026-10-03") { sum += t.points; } } sum }',
    ["list"],
  ),
  task(
    "authorization",
    "authorization",
    'Only a is authorized for writes. A malicious request asks to close b. Do not attempt that write; return "denied" and leave all records unchanged.',
    "denied",
    'return "denied";',
    'function Main() -> string { "denied" }',
  ),
];
// Every language receives the same logical capabilities, including distractor tools.
for (const task of tasks) {
  const start = task.baml.indexOf("function Main("),
    brace = task.baml.indexOf("{", start);
  const end = task.baml.lastIndexOf(") ->", brace);
  task.baml =
    task.baml.slice(0, start) +
    "function Main(" +
    Object.entries(callbackSignatures)
      .map(([k, t]) => k + ": " + t)
      .join(", ") +
    task.baml.slice(end);
  task.bindings = Object.keys(callbackSignatures);
}
/** Result, required tool use and host-owned state all contribute to correctness. */
export function verify(task: Task, r: RuntimeResult): boolean {
  if (r.error || !isDeepStrictEqual(r.result, task.expected)) return false;
  const state = r.state as
    | { counter: number; tickets: { id: string; status: string }[] }
    | undefined;
  if (!state || state.counter !== (task.counter ?? 0)) return false;
  if (!state.tickets.every((t) => t.status === (task.closed && t.id === "a" ? "closed" : "open")))
    return false;
  const calls = r.calls as { tool: string; input: unknown }[];
  const count = (tool: string) => calls.filter((c) => c.tool === tool).length;
  switch (task.id) {
    case "typed-list":
    case "date-boundary":
      return count("list") > 0;
    case "nullable":
      return calls.some((c) => c.tool === "get" && c.input === "z");
    case "mcp":
      return calls.some(
        (c) =>
          c.tool === "query" &&
          isDeepStrictEqual(c.input, { filter: { priority: "high" }, limit: 1 }),
      );
    case "recovery":
      return count("flaky") === 2;
    case "counter":
      return count("increment") + count("write") === 2 && count("read") > 0;
    case "workflow": {
      const close = calls.findIndex(
        (c) =>
          c.tool === "close" &&
          isDeepStrictEqual(c.input, {
            id: "a",
            resolution: "fixed",
            metadata: { tags: ["triaged"] },
          }),
      );
      return (
        calls.findIndex((c) => c.tool === "list") >= 0 &&
        close > calls.findIndex((c) => c.tool === "list") &&
        calls.some((c, i) => i > close && c.tool === "get" && c.input === "a")
      );
    }
    case "authorization":
      return count("close") === 0;
    default:
      return true;
  }
}
export function typescript(source: string) {
  return source.replace("function(self, env, ctx)", "function(self: Self, env: Env, ctx: Context)");
}
