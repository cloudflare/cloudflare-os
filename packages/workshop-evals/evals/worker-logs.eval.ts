import { z } from "zod";
import { Seeded } from "./seeded.js";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

// A day of Workers request logs for six Workers across four colos, generated from a fixed seed with
// one planted bad hour. The agent builds the analyzer, extends it, then is asked what the data
// says; every answer is checked against a reference computed here from the same events.

type LogEvent = {
  ts: string;
  worker: string;
  colo: string;
  status: number;
  durationMs: number;
  route: string;
};

const DAY = "2027-03-09";
const WORKERS: Record<string, { base: number; routes: string[] }> = {
  "auth-edge": { base: 18, routes: ["/session", "/token/refresh", "/logout"] },
  "checkout-api": { base: 95, routes: ["/cart", "/checkout", "/order/status"] },
  "image-resizer": { base: 140, routes: ["/img/thumb", "/img/hero"] },
  "pricing-svc": { base: 30, routes: ["/price", "/price/bulk"] },
  "search-index": { base: 210, routes: ["/search", "/suggest"] },
  "webhook-relay": { base: 60, routes: ["/hook/stripe", "/hook/github", "/hook/slack"] },
};
const COLOS = ["FRA", "LHR", "SIN", "SJC"];
const PLANTED = { worker: "checkout-api", hour: 14, errorRate: 0.6 };
const DECOY = { worker: "webhook-relay", hour: 3, errorRate: 0.25 };

function hourIso(hour: number): string {
  return `${DAY}T${String(hour).padStart(2, "0")}:00:00Z`;
}

function generate(): LogEvent[] {
  const random = new Seeded(20270309);
  const events: LogEvent[] = [];
  for (const [worker, profile] of Object.entries(WORKERS)) {
    for (let hour = 0; hour < 24; hour++) {
      // Quiet nights, busy afternoons; never so few requests that one error dominates an hour.
      const volume = random.int(15, 25) + Math.round(20 * Math.sin((hour - 6) * Math.PI / 12) + 20);
      // Background errors are random; the planted hours fail exactly the stated share of their
      // requests, so the answer the question turn expects is the one the data was built to hold.
      const planted = [PLANTED, DECOY].find(plant =>
        plant.worker === worker && plant.hour === hour);
      for (let index = 0; index < volume; index++) {
        const failed = planted === undefined
          ? random.next() < 0.015
          : index < Math.round(volume * planted.errorRate);
        const status = failed
          ? random.pick([500, 502, 503])
          : random.next() < 0.06 ? random.pick([301, 404]) : 200;
        const spread = 0.5 + random.next() * random.next() * 3;
        const durationMs = Math.round(profile.base * spread * (failed ? 4 : 1));
        events.push({
          ts: `${DAY}T${String(hour).padStart(2, "0")}:${String(random.int(0, 59)).padStart(2, "0")}:${
            String(random.int(0, 59)).padStart(2, "0")}Z`,
          worker, colo: random.pick(COLOS), status, durationMs, route: random.pick(profile.routes),
        });
      }
    }
  }
  return events;
}

const EVENTS = generate();

// Reference statistics, computed the way the prompt defines them.

type Filter = { fromIso?: string; toIso?: string; worker?: string; colo?: string; route?: string };

function select(filter: Filter): LogEvent[] {
  return EVENTS.filter(event =>
    (filter.fromIso === undefined || event.ts >= filter.fromIso) &&
    (filter.toIso === undefined || event.ts < filter.toIso) &&
    (filter.worker === undefined || event.worker === filter.worker) &&
    (filter.colo === undefined || event.colo === filter.colo) &&
    (filter.route === undefined || event.route === filter.route));
}

function isError(event: LogEvent): boolean {
  return event.status >= 500;
}

/** Nearest-rank p95: the value at position ceil(0.95 * n) of the sorted durations. */
function p95(events: readonly LogEvent[]): number {
  const sorted = events.map(event => event.durationMs).toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
}

type Stats = { requests: number; errors: number; errorRate: number; p95Ms: number };

function stats(events: readonly LogEvent[]): Stats {
  const errors = events.filter(isError).length;
  return {
    requests: events.length, errors,
    errorRate: events.length === 0 ? 0 : errors / events.length,
    p95Ms: p95(events),
  };
}

function groupBy<Key extends string>(events: readonly LogEvent[], key: (event: LogEvent) => Key) {
  const groups = new Map<Key, LogEvent[]>();
  for (const event of events) {
    const group = groups.get(key(event));
    if (group === undefined) groups.set(key(event), [event]);
    else group.push(event);
  }
  return [...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right));
}

function referenceSummary(filter: Filter) {
  return groupBy(select(filter), event => event.worker)
    .map(([worker, events]) => ({ worker, ...stats(events) }));
}

function referenceHourly(filter: Filter & { fromIso: string; toIso: string }) {
  const events = select(filter);
  const buckets = [];
  for (let at = Date.parse(filter.fromIso); at < Date.parse(filter.toIso); at += 3_600_000) {
    const start = new Date(at).toISOString();
    const end = new Date(at + 3_600_000).toISOString();
    const inHour = events.filter(event => event.ts >= start && event.ts < end);
    buckets.push({
      hourIso: start.replace(".000Z", "Z"),
      requests: inHour.length,
      errors: inHour.filter(isError).length,
    });
  }
  return buckets;
}

function referenceByColo(filter: Filter) {
  return groupBy(select(filter), event => event.colo)
    .map(([colo, events]) => {
      const { requests, errors, errorRate } = stats(events);
      return { colo, requests, errors, errorRate };
    });
}

function referenceSlowestRoutes(filter: Filter, limit: number) {
  return groupBy(select(filter), event => `${event.worker} ${event.route}`)
    .map(([key, events]) => {
      const [worker, route] = key.split(" ") as [string, string];
      return { worker, route, requests: events.length, p95Ms: p95(events) };
    })
    .toSorted((left, right) => right.p95Ms - left.p95Ms ||
      left.worker.localeCompare(right.worker) || left.route.localeCompare(right.route))
    .slice(0, limit);
}

/** The worst worker-hour by error rate, which the question in turn 3 asks for. */
function referenceWorstHour() {
  let worst = { worker: "", hour: -1, errorRate: -1 };
  for (const worker of Object.keys(WORKERS)) {
    for (let hour = 0; hour < 24; hour++) {
      const inHour = select({ worker, fromIso: hourIso(hour), toIso: hourIso(hour + 1) });
      const errorRate = inHour.filter(isError).length / inHour.length;
      if (errorRate > worst.errorRate) worst = { worker, hour, errorRate };
    }
  }
  return worst;
}

const WORST = referenceWorstHour();
if (WORST.worker !== PLANTED.worker || WORST.hour !== PLANTED.hour) {
  throw new Error(`Seeded data no longer plants the worst hour where the task expects it: ${
    JSON.stringify(WORST)}`);
}

// RPC contract.

const OkSchema = z.object({ ok: z.literal(true) });
const StatsSchema = z.object({
  requests: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  errorRate: z.number().min(0).max(1),
  p95Ms: z.number().nonnegative(),
});
const SummarySchema = z.object({
  perWorker: z.array(StatsSchema.extend({ worker: z.string() })),
});
const HourlySchema = z.object({
  buckets: z.array(z.object({
    hourIso: z.string(),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })),
});
const ByColoSchema = z.object({
  perColo: z.array(z.object({
    colo: z.string(),
    requests: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    errorRate: z.number().min(0).max(1),
  })),
});
const SlowestSchema = z.object({
  routes: z.array(z.object({
    worker: z.string(),
    route: z.string(),
    requests: z.number().int().nonnegative(),
    p95Ms: z.number().nonnegative(),
  })),
});

type Range = { fromIso: string; toIso: string };
type Filters = { worker?: string; colo?: string; route?: string };

interface LogsApi {
  reset(): Promise<{ ok: true }>;
  ingest(input: { events: LogEvent[] }): Promise<{ accepted: number }>;
  summary(input: Range & Filters): Promise<z.infer<typeof SummarySchema>>;
  hourly(input: Range & Filters): Promise<z.infer<typeof HourlySchema>>;
  byColo(input: Range & Filters): Promise<z.infer<typeof ByColoSchema>>;
  slowestRoutes(input: Range & Filters & { limit: number }): Promise<z.infer<typeof SlowestSchema>>;
}

const TITLE = "Worker Logs";
const FULL_DAY: Range = { fromIso: hourIso(0), toIso: `2027-03-10T00:00:00Z` };
const AFTERNOON: Range = { fromIso: hourIso(12), toIso: hourIso(16) };

/**
 * Rows agree when every field agrees: error rates to within rounding, hours as instants, and
 * key order not at all (the agent's rows and the reference build theirs in different orders).
 */
function sameRows<Row extends object>(actual: readonly Row[], expected: readonly Row[]): boolean {
  const canonical = (row: Row) => JSON.stringify(Object.fromEntries(Object.entries(row)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key,
      key === "errorRate" && typeof value === "number" ? value.toFixed(9)
      : key === "hourIso" && typeof value === "string" ? new Date(value).toISOString()
      : value])));
  return JSON.stringify(actual.map(canonical)) === JSON.stringify(expected.map(canonical));
}

async function ingestAll(api: LogsApi): Promise<number> {
  await api.reset();
  let accepted = 0;
  for (let at = 0; at < EVENTS.length; at += 500) {
    accepted += (await api.ingest({ events: EVENTS.slice(at, at + 500) })).accepted;
  }
  return accepted;
}

async function checkSummaryStillMatches(verifier: EvalVerifier, id: string): Promise<void> {
  await verifier.check(id, async () => {
    using api = await verifier.connect<LogsApi>(TITLE);
    const summary = SummarySchema.parse(await api.summary(FULL_DAY)).perWorker;
    return {
      pass: sameRows(summary, referenceSummary(FULL_DAY)),
      evidence: { summary, expected: referenceSummary(FULL_DAY) },
    };
  });
}

const task = defineEvalTask({
  id: "worker-logs",
  turns: [{
    prompt: `Build a Gadget named exactly "${TITLE}" for analysing Workers request logs. I'll push
the log events in over RPC; each event is
{ ts: ISO 8601 UTC, worker: string, colo: string, status: integer, durationMs: integer,
  route: string }.
Show error rate and p95 latency per Worker and requests per hour. Keep the events in the Gadget's
own storage; there will be a few thousand a day.

Definitions: an error is a status of 500 or above. errorRate is errors divided by requests, as a
number between 0 and 1. p95Ms is the nearest-rank 95th percentile: sort the durations ascending
and take the value at position ceil(0.95 × n), counting from 1. Time ranges are half-open,
[fromIso, toIso).

It needs a stable server RPC taking and returning plain data, so I can verify it:

- ingest({ events: Event[] }) -> { accepted: integer }
- reset() -> { ok: true }   deletes every stored event
- summary({ fromIso, toIso, worker? })
  -> { perWorker: Array<{ worker, requests, errors, errorRate, p95Ms }> }
  One row per Worker with at least one request in the range, sorted by worker.
- hourly({ fromIso, toIso, worker? }) -> { buckets: Array<{ hourIso, requests, errors }> }
  One bucket for every whole UTC hour in the range, in order, including hours with nothing in
  them. hourIso is the start of the hour.`,
    verify: async verifier => {
      await verifier.check("ingests-resets-and-summarises-per-worker", async () => {
        using api = await verifier.connect<LogsApi>(TITLE);
        await ingestAll(api);
        const cleared = OkSchema.parse(await api.reset());
        const afterReset = SummarySchema.parse(await api.summary(FULL_DAY)).perWorker;
        const emptyHours = HourlySchema.parse(await api.hourly(AFTERNOON)).buckets;
        const accepted = await ingestAll(api);
        const summary = SummarySchema.parse(await api.summary(FULL_DAY)).perWorker;
        const expected = referenceSummary(FULL_DAY);
        return {
          pass: cleared.ok && afterReset.length === 0 &&
            emptyHours.length === 4 && emptyHours.every(bucket => bucket.requests === 0) &&
            accepted === EVENTS.length && sameRows(summary, expected),
          evidence: { cleared, afterReset, accepted, summary, expected },
        };
      });

      await verifier.check("hourly-buckets-cover-every-hour-including-empty-ones", async () => {
        using api = await verifier.connect<LogsApi>(TITLE);
        const quiet = { worker: "pricing-svc", fromIso: "2027-03-08T22:00:00Z", toIso: hourIso(4) };
        const buckets = HourlySchema.parse(await api.hourly(quiet)).buckets;
        const all = HourlySchema.parse(await api.hourly(FULL_DAY)).buckets;
        return {
          pass: sameRows(buckets, referenceHourly(quiet)) &&
            sameRows(all, referenceHourly(FULL_DAY)),
          evidence: { buckets, expected: referenceHourly(quiet) },
        };
      });

      await verifier.check("ranges-are-half-open-and-filter-by-worker", async () => {
        using api = await verifier.connect<LogsApi>(TITLE);
        const afternoon = SummarySchema.parse(await api.summary(AFTERNOON)).perWorker;
        const one = { ...AFTERNOON, worker: PLANTED.worker };
        const onlyOne = SummarySchema.parse(await api.summary(one)).perWorker;
        const single = { fromIso: hourIso(14), toIso: hourIso(15) };
        const singleHour = HourlySchema.parse(await api.hourly(single)).buckets;
        return {
          pass: sameRows(afternoon, referenceSummary(AFTERNOON)) &&
            sameRows(onlyOne, referenceSummary(one)) &&
            sameRows(singleHour, referenceHourly(single)),
          evidence: { afternoon, onlyOne, singleHour },
        };
      });
    },
  }, {
    prompt: `I need to slice this by location and see what's slow. summary and hourly should also
accept optional colo and route filters, combining with each other and with worker. And add:

- byColo({ fromIso, toIso, worker?, route? }) -> { perColo: Array<{ colo, requests, errors,
  errorRate }> }   sorted by colo
- slowestRoutes({ fromIso, toIso, colo?, limit }) -> { routes: Array<{ worker, route, requests,
  p95Ms }> }   the limit slowest worker+route pairs by p95Ms, highest first; ties by worker then
  route.

The events I've already loaded must still be there.`,
    verify: async verifier => {
      await checkSummaryStillMatches(verifier, "existing-data-and-summary-survive");

      await verifier.check("filters-combine-across-colo-route-and-worker", async () => {
        using api = await verifier.connect<LogsApi>(TITLE);
        const byColo = { ...FULL_DAY, colo: "LHR" };
        const byRoute = { ...AFTERNOON, worker: "search-index", route: "/search" };
        const hourlyFiltered = { ...FULL_DAY, worker: "checkout-api", colo: "SJC", route: "/checkout" };
        const colo = SummarySchema.parse(await api.summary(byColo)).perWorker;
        const route = SummarySchema.parse(await api.summary(byRoute)).perWorker;
        const buckets = HourlySchema.parse(await api.hourly(hourlyFiltered)).buckets;
        return {
          pass: sameRows(colo, referenceSummary(byColo)) &&
            sameRows(route, referenceSummary(byRoute)) &&
            sameRows(buckets, referenceHourly(hourlyFiltered)),
          evidence: { colo, route, buckets },
        };
      });

      await verifier.check("breaks-down-by-colo-and-ranks-slow-routes", async () => {
        using api = await verifier.connect<LogsApi>(TITLE);
        const perColo = ByColoSchema.parse(await api.byColo(FULL_DAY)).perColo;
        const oneWorker = { ...FULL_DAY, worker: "image-resizer" };
        const perColoOne = ByColoSchema.parse(await api.byColo(oneWorker)).perColo;
        const slowest = SlowestSchema.parse(await api.slowestRoutes({ ...FULL_DAY, limit: 5 })).routes;
        const slowestSin = SlowestSchema.parse(
            await api.slowestRoutes({ ...FULL_DAY, colo: "SIN", limit: 3 })).routes;
        return {
          pass: sameRows(perColo, referenceByColo(FULL_DAY)) &&
            sameRows(perColoOne, referenceByColo(oneWorker)) &&
            sameRows(slowest, referenceSlowestRoutes(FULL_DAY, 5)) &&
            sameRows(slowestSin, referenceSlowestRoutes({ ...FULL_DAY, colo: "SIN" }, 3)),
          evidence: { perColo, slowest, expectedSlowest: referenceSlowestRoutes(FULL_DAY, 5) },
        };
      });
    },
  }, {
    prompt: `Looking at the data I've loaded: which Worker had the worst single hour by error rate on
${DAY}, and what was that hour's error rate? Answer in exactly this form and nothing else:
worker: <name>
hour: <YYYY-MM-DDTHH:00Z>
error-rate: <percent with one decimal>`,
    verify: async verifier => {
      await verifier.check("names-the-worst-hour-from-the-data", async () => {
        const reply = verifier.replies.at(-1)?.trim().replace(/^```\w*\n?|\n?```$/g, "").trim() ?? "";
        const lines = reply.split("\n").map(line => line.trim()).filter(line => line !== "");
        // The three fields, in the stated order, each on its own line.
        const field = (index: number, name: string) => {
          const line = lines[index] ?? "";
          return line.toLowerCase().startsWith(`${name}:`)
            ? line.slice(name.length + 1).trim().replace(/^`|`$/g, "")
            : null;
        };
        const worker = field(0, "worker");
        const hour = field(1, "hour");
        const rate = /^(\d+\.\d)\s*%?$/.exec(field(2, "error-rate") ?? "")?.[1];
        const expectedHour = hourIso(WORST.hour);
        return {
          pass: lines.length === 3 && worker === WORST.worker && hour !== null &&
            Date.parse(hour) === Date.parse(expectedHour) &&
            rate !== undefined && Math.abs(Number(rate) - WORST.errorRate * 100) <= 0.05,
          evidence: { reply, expected: { ...WORST, hourIso: expectedHour } },
        };
      });
      await checkSummaryStillMatches(verifier, "asking-a-question-changes-nothing");
    },
  }],
});

defineTaskEval(task);
