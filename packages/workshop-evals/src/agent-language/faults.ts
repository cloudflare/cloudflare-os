import { tasks, typescript } from "./tasks.ts";
export const faults = [
  ["syntax", "typed-list", "return ( ;"],
  ["missing-method", "typed-list", "return await env.TICKETS.missing();"],
  ["bad-argument", "nullable", "return await env.TICKETS.get(123);"],
  ["enum", "workflow", 'return await env.TICKETS.close({id:"a",resolution:"oops"});'],
  [
    "nested-argument",
    "workflow",
    'return await env.TICKETS.close({id:"a",resolution:"fixed",metadata:{tags:[1]}});',
  ],
  ["missing-field", "workflow", 'return await env.TICKETS.close({resolution:"fixed"});'],
  ["nullable-read", "nullable", 'return (await env.TICKETS.get("z")).owner.name;'],
  ["forgot-await", "typed-list", "return env.TICKETS.list().map(t=>t.id);"],
  ["wrong-return-member", "typed-list", "return (await env.TICKETS.list()).missing;"],
  ["union", "recovery", "return (await env.TICKETS.flaky()).ids;"],
  ["bad-mcp", "mcp", "return await env.MCP.query({filter:{priority:42}});"],
  [
    "wrong-record",
    "workflow",
    'await env.TICKETS.close({id:"b",resolution:"fixed"}); return "closed";',
  ],
  [
    "date-inclusive",
    "date-boundary",
    'return (await env.TICKETS.list()).filter(t=>t.created>="2026-10-02"&&t.created<="2026-10-03").reduce((n,t)=>n+t.points,0);',
  ],
  [
    "off-by-one",
    "typed-list",
    'return (await env.TICKETS.list()).filter(t=>t.priority==="high").map(t=>t.id).slice(1);',
  ],
  [
    "lost-update",
    "counter",
    "await Promise.all([1,2].map(async()=>{const n=await env.COUNTER.read();await env.COUNTER.write(n+1)})); return await env.COUNTER.read();",
  ],
  [
    "wrong-valid-tool",
    "typed-list",
    'return (await env.MCP.query({filter:{priority:"low"}})).items.map(t=>t.id);',
  ],
  ["false-success", "workflow", 'await self.report("success"); return "closed";'],
] as const;
export function faultProgram(body: string, ts = false) {
  const s = `export default async function(self, env, ctx) { ${body} }`;
  return ts ? typescript(s) : s;
}
export function faultTask(id: string) {
  return tasks.find((t) => t.id === id)!;
}
/** Same fault intentions in the actual BAML ABI; host envelope differences are explicit. */
export const bamlFaults: Record<string, string> = {
  syntax: "return ( ;",
  "missing-method": "missing()",
  "bad-argument": 'let t = get(123); "missing"',
  enum: 'close(CloseInput {id:"a",resolution:"oops",metadata:null}); "closed"',
  "nested-argument":
    'close(CloseInput {id:"a",resolution:"fixed",metadata:Metadata {tags:[1]}}); "closed"',
  "missing-field": 'close(CloseInput {resolution:"fixed",metadata:null}); "closed"',
  "nullable-read": 'get("z").owner.name',
  "forgot-await": "let f=spawn { list() }; f.items",
  "wrong-return-member": "list().missing",
  union: "flaky().ids",
  "bad-mcp": "query(QueryInput {filter:Filter {priority:42},limit:1}).items",
  "wrong-record": 'close(CloseInput {id:"b",resolution:"fixed",metadata:null}); "closed"',
  "date-inclusive":
    'let sum=0; for(let t in list().items) { if(t.created >= "2026-10-02" && t.created <= "2026-10-03") { sum += t.points; } } sum',
  "off-by-one":
    'let ids:string[]=[]; let skip=true; for(let t in list().items) { if(t.priority=="high") {if(skip) {skip=false;} else {ids.push(t.id);}} } ids',
  "lost-update": "let first=read(); let second=read(); write(first+1); write(second+1); read()",
  "wrong-valid-tool":
    'let ids:string[]=[]; for(let t in query(QueryInput {filter:Filter {priority:"low"},limit:null}).items) {ids.push(t.id);} ids',
  "false-success": '"closed"',
};
export function bamlFaultProgram(taskId: string, body: string) {
  const source = faultTask(taskId).baml;
  return source.slice(0, source.indexOf("{", source.indexOf("function Main(")) + 1) + body + " }";
}
