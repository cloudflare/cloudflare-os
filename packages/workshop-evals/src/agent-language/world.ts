import { z } from "zod";
const Close = z.object({
  id: z.string(),
  resolution: z.enum(["fixed", "duplicate"]),
  metadata: z.object({ tags: z.array(z.string()) }).optional(),
});
const Query = z.object({
  filter: z.object({ priority: z.enum(["high", "low"]) }),
  limit: z.number().int().nonnegative().optional(),
});
/** Synthetic capability state lives in the host, outside the generated program's isolate. */
export function createWorld() {
  const tickets = [
    {
      id: "a",
      priority: "high",
      owner: { name: "Ada" },
      created: "2026-10-01",
      points: 3,
      status: "open",
    },
    { id: "b", priority: "low", owner: null, created: "2026-10-02", points: 5, status: "open" },
    { id: "c", priority: "high", owner: null, created: "2026-10-03", points: 7, status: "open" },
  ];
  let counter = 0,
    tries = 0;
  const calls: { tool: string; input: unknown }[] = [],
    reports: unknown[] = [];
  function call(tool: string, input: unknown): unknown {
    if (calls.length >= 100) throw Error("tool call limit");
    calls.push({ tool, input });
    switch (tool) {
      case "list":
        return tickets;
      case "get":
        return tickets.find((t) => t.id === z.string().parse(input)) ?? null;
      case "close": {
        const arg = Close.parse(input);
        if (arg.id !== "a") throw Error("unauthorized: only a may be modified");
        tickets[0].status = "closed";
        return { ok: true };
      }
      case "flaky":
        return ++tries === 1 ? { ok: false, error: "timeout" } : { ok: true, ids: ["a", "c"] };
      case "read":
        return counter;
      case "write":
        counter = z.number().parse(input);
        return null;
      case "increment":
        counter++;
        return null;
      case "query": {
        const arg = Query.parse(input);
        return {
          items: tickets
            .filter((t) => t.priority === arg.filter.priority)
            .slice(0, arg.limit ?? 99),
        };
      }
      case "report":
        reports.push(input);
        return null;
      default:
        throw Error("unknown capability");
    }
  }
  return {
    calls,
    state: () => ({ tickets, counter, reports }),
    async fetch(request: { json(): Promise<unknown> }) {
      try {
        const { tool, input } = z
          .object({ tool: z.string(), input: z.unknown().optional() })
          .parse(await request.json());
        return Response.json({ value: call(tool, input) });
      } catch (e) {
        return Response.json({ error: String(e) });
      }
    },
  };
}
