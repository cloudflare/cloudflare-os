import { it, expect } from "vitest";
import { execute } from "./runtime.ts";
it("executes ordinary JavaScript in workerd", async () => {
  const r = await execute(
    "export default async function(self,env,ctx){return (await env.TICKETS.list()).map(t=>t.id)}",
  );
  expect(r.error).toBeUndefined();
  expect(r.result).toEqual(["a", "b", "c"]);
}, 20000);
it("denies network and unauthorized effects", async () => {
  const r = await execute(
    'export default async function(self,env,ctx){return await env.TICKETS.close({id:"b",resolution:"fixed"})}',
  );
  expect(r.error).toContain("unauthorized");
  const net = await execute(
    'export default async function(){return (await fetch("https://example.com")).status}',
  );
  expect(net.result).toBe(403);
}, 20000);
it("compiles and runs real BAML v1 in workerd", async () => {
  const r = await execute("function Main() -> int { 42 }", true);
  expect(r.error).toBeUndefined();
  expect(r.result).toBe(42);
}, 30000);
it("passes asynchronous host callbacks into BAML", async () => {
  const r = await execute("function Main(read: () -> int) -> int { read() }", true, ["read"]);
  expect(r.error).toBeUndefined();
  expect(r.result).toBe(0);
}, 30000);
it("records the v1 bridge direct-array host callback limitation", async () => {
  const r = await execute(
    "class Owner { name string }\nclass Ticket { id string priority string owner Owner? created string points int status string }\nfunction Main(listRaw: () -> Ticket[]) -> string { listRaw()[0].id }",
    true,
    ["listRaw"],
  );
  expect(r.error).toContain("HostContractViolation");
}, 30000);
it("keeps authoritative state outside candidate serialization", async () => {
  const r = await execute(
    'export default async function(self,env,ctx){Response.json=()=>new Response(JSON.stringify({result:"closed",state:{tickets:[{id:"a",status:"closed"}]}}));return "closed"}',
  );
  expect((r.state as { tickets: { status: string }[] }).tickets[0].status).toBe("open");
}, 20000);
it("normalizes BAML optional null fields at the host ABI", async () => {
  const r = await execute(
    'class Filter { priority string }\nclass QueryInput { filter Filter limit int? }\nclass Ticket {id string priority string owner Owner? created string points int status string}\nclass Owner {name string}\nclass QueryResult {items Ticket[]}\nfunction Main(query:(QueryInput)->QueryResult) -> int {query(QueryInput {filter:Filter {priority:"low"},limit:null}).items.length()}',
    true,
    ["query"],
  );
  expect(r.error).toBeUndefined();
  expect(r.result).toBe(1);
}, 30000);
