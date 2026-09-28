import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

// An on-call desk where several responders acknowledge the same page at the same instant. Durable
// Object RPC calls interleave at every `await`, so a check-then-write acknowledge hands one incident
// to two people. The prompt states the invariant and leaves the synchronisation to the agent. Turn 2
// adds escalation and metrics; turn 3 adds ownership handoff, raced against itself, resolve and
// escalate, where a stale read-modify-write either elects two owners or erases the other update.

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
type Ok = z.infer<typeof OkSchema>;

const AckSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), owner: z.string() }),
  z.object({ ok: z.literal(false), error: z.string().min(1), owner: z.string().nullable() }),
]);
type Ack = z.infer<typeof AckSchema>;

const IncidentSchema = z.object({
  id: z.string(),
  service: z.string(),
  severity: z.number().int().min(1).max(3),
  summary: z.string(),
  status: z.enum(["open", "acknowledged", "resolved"]),
  owner: z.string().nullable(),
  openedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  escalations: z.number().int().nonnegative().optional(),
  handoffs: z.number().int().nonnegative().optional(),
});
type Incident = z.infer<typeof IncidentSchema>;

/** From turn 3 on, every record carries the handoff count. */
const HandedIncidentSchema = IncidentSchema.extend({ handoffs: z.number().int().nonnegative() });
const HandedBoardSchema = z.object({ incidents: z.array(HandedIncidentSchema) });

const BoardSchema = z.object({ incidents: z.array(IncidentSchema) });

const MetricsSchema = z.object({
  count: z.number().int().nonnegative(),
  acknowledged: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  meanTimeToAcknowledgeMs: z.number().nonnegative().nullable(),
  meanTimeToResolveMs: z.number().nonnegative().nullable(),
});

interface DeskApi {
  open(input: { id: string; service: string; severity: number; summary: string }): Promise<Ok>;
  acknowledge(input: { id: string; responder: string }): Promise<Ack>;
  resolve(input: { id: string; responder: string }): Promise<Ok>;
  incident(input: { id: string }): Promise<Incident>;
  board(): Promise<z.infer<typeof BoardSchema>>;
  escalate(input: { id: string }): Promise<Ok>;
  metrics(input: { service?: string }): Promise<z.infer<typeof MetricsSchema>>;
  handoff(input: { id: string; responder: string; to: string }): Promise<Ok>;
}

const TITLE = "Incident Desk";
const RESPONDERS = Array.from({ length: 20 }, (_unused, index) => `oncall-${index + 1}`);
/** The severities the simultaneous opens of race-open carry; attempt N's summary names N. */
const RACE_OPEN_SEVERITIES = [1, 2, 3, 1, 2, 3, 1, 2];

function code(result: Ok | Ack): string {
  return result.ok ? "ok" : result.error;
}

async function openIncident(
    api: DeskApi, id: string, severity: number, service = "api-gateway"): Promise<Ok> {
  return OkSchema.parse(await api.open({ id, service, severity, summary: `Incident ${id}` }));
}

/** Open an incident a check depends on; a refusal fails the check rather than the later steps. */
async function mustOpen(api: DeskApi, id: string, severity: number, service: string): Promise<void> {
  const result = await openIncident(api, id, severity, service);
  if (!result.ok) throw new Error(`open(${id}) was refused: ${result.error}`);
}

/** Escalation changes severity and the count and nothing else about an incident. */
function escalatedOnce(before: Incident, after: Incident): boolean {
  return after.severity === before.severity - 1 && after.escalations === (before.escalations ?? 0) + 1 &&
    JSON.stringify({ ...after, severity: before.severity, escalations: before.escalations }) ===
      JSON.stringify(before);
}

/**
 * A record as a later turn must give it back: it may add the escalation and handoff counts, at 0.
 * Parsing puts the keys in schema order whichever of the counts the record already had.
 */
function asKept(incident: Incident): string {
  return JSON.stringify(IncidentSchema.parse(
    { ...incident, escalations: incident.escalations ?? 0, handoffs: incident.handoffs ?? 0 }));
}

/** `before` with only `changes` applied, in the form `asKept` gives. */
function amended(before: Incident, changes: Partial<Incident>): string {
  return asKept({ ...before, ...changes });
}

/**
 * What turn 1 leaves on the board, by id, as far as it is known before the races run: who won a
 * race and when is decided at run time, so owners are checked against the responder set and
 * timestamps against the status they go with.
 */
const TURN_ONE_BOARD: Record<string, {
  service: string; severity: number | null; status: Incident["status"];
  owners: readonly string[] | null;
}> = {
  "inc-1": { service: "api-gateway", severity: 2, status: "resolved", owners: ["alice"] },
  ...Object.fromEntries(["race-1", "race-2", "race-3", "race-4", "race-5"].map(id =>
    [id, { service: "edge-cache", severity: 1, status: "acknowledged", owners: RESPONDERS }])),
  "race-open": { service: "dns", severity: null, status: "open", owners: null },
};

function instant(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

function asTurnOneLeftIt(incident: Incident): boolean {
  const seeded = TURN_ONE_BOARD[incident.id];
  if (seeded === undefined) return false;
  const openedAt = Date.parse(incident.openedAt);
  const acknowledgedAt = instant(incident.acknowledgedAt);
  const resolvedAt = instant(incident.resolvedAt);
  // race-open's winner is decided at run time, but its summary names the attempt that won.
  const attempt = /^attempt ([0-7])$/.exec(incident.summary);
  const summaryAndSeverity = incident.id === "race-open"
    ? attempt !== null && incident.severity === RACE_OPEN_SEVERITIES[Number(attempt[1])]
    : incident.summary === `Incident ${incident.id}` && incident.severity === seeded.severity;
  return incident.service === seeded.service && incident.status === seeded.status &&
    summaryAndSeverity &&
    (seeded.owners === null
      ? incident.owner === null : incident.owner !== null && seeded.owners.includes(incident.owner)) &&
    (acknowledgedAt === null) === (incident.status === "open") &&
    (resolvedAt === null) === (incident.status !== "resolved") &&
    (acknowledgedAt === null || acknowledgedAt >= openedAt) &&
    (resolvedAt === null || acknowledgedAt === null || resolvedAt >= acknowledgedAt) &&
    (incident.escalations ?? 0) === 0;
}

/**
 * Every record a turn 1 left, as a later turn must give it back. Trials share this module and a
 * Workpiece id is workspace-local, so the records are pooled, not filed by trial. Each one holds
 * its own trial's timestamps and race winners, so a record that turn 2 changed matches no copy.
 */
const keptByTurnOne = new Set<string>();

/** Every record turn 2 left, pooled like `keptByTurnOne`. */
const keptByTurnTwo = new Set<string>();
/** Turn 1's incidents and the four turn 2's checks open. */
const TURN_TWO_IDS = [...Object.keys(TURN_ONE_BOARD), "race-6", "esc-1", "bill-open", "bill-done"];

/** Open an incident and have `owner` acknowledge it; return the record as it then reads. */
async function heldBy(
    api: DeskApi, id: string, severity: number, service: string, owner: string): Promise<Incident> {
  await mustOpen(api, id, severity, service);
  const ack = AckSchema.parse(await api.acknowledge({ id, responder: owner }));
  if (!ack.ok) throw new Error(`acknowledge(${id}) was refused: ${ack.error}`);
  return HandedIncidentSchema.parse(await api.incident({ id }));
}

/** Twenty responders acknowledge at once; exactly one may win and everyone must be told who. */
async function race(api: DeskApi, id: string) {
  const attempts = await Promise.all(RESPONDERS.map(async responder =>
    ({ responder, result: AckSchema.parse(await api.acknowledge({ id, responder })) })));
  const winners = attempts.flatMap(attempt => attempt.result.ok ? [attempt.responder] : []);
  const losers = attempts.flatMap(attempt => attempt.result.ok ? [] : [attempt.result]);
  const incident = IncidentSchema.parse(await api.incident({ id }));
  const winner = winners[0];
  const consistent = winners.length === 1 && winner !== undefined &&
    attempts.every(attempt => !attempt.result.ok || attempt.result.owner === attempt.responder) &&
    incident.status === "acknowledged" && incident.owner === winner &&
    incident.acknowledgedAt !== null &&
    losers.every(result => result.error === "ALREADY_ACKNOWLEDGED" && result.owner === winner);
  return { consistent, winners, loserCodes: [...new Set(losers.map(code))], owner: incident.owner };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Recompute the metrics the board's own timestamps imply. */
function referenceMetrics(incidents: readonly Incident[]) {
  const sinceOpened = (at: string | null, incident: Incident) =>
    at === null ? [] : [Date.parse(at) - Date.parse(incident.openedAt)];
  const timeToAcknowledge = incidents.flatMap(incident =>
    sinceOpened(incident.acknowledgedAt, incident));
  const timeToResolve = incidents.flatMap(incident => sinceOpened(incident.resolvedAt, incident));
  return {
    count: incidents.length,
    acknowledged: timeToAcknowledge.length,
    resolved: timeToResolve.length,
    meanTimeToAcknowledgeMs: mean(timeToAcknowledge),
    meanTimeToResolveMs: mean(timeToResolve),
  };
}

function closeEnough(actual: number | null, expected: number | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) <= 1;
}

/** Check the board's order; return what it listed, or null when the check could not read it. */
async function checkBoardOrder(verifier: EvalVerifier, id: string): Promise<Incident[] | null> {
  let listed: Incident[] | null = null;
  await verifier.check(id, async () => {
    using api = await verifier.connect<DeskApi>(TITLE);
    const board = BoardSchema.parse(await api.board()).incidents;
    listed = board;
    const ordered = board.every((incident, index) => {
      const previous = board[index - 1];
      return previous === undefined || previous.severity < incident.severity ||
        (previous.severity === incident.severity &&
          Date.parse(previous.openedAt) <= Date.parse(incident.openedAt));
    });
    return { pass: board.length > 0 && ordered, evidence: { board: board.map(incident =>
      ({ id: incident.id, severity: incident.severity, openedAt: incident.openedAt })) } };
  });
  return listed;
}

const task = defineEvalTask({
  id: "incident-desk",
  turns: [{
    prompt: `Build a Gadget named exactly "${TITLE}" for our on-call rotation. When an incident is
opened everyone on call gets paged, and whoever acknowledges first owns it. Several people will hit
acknowledge at the same instant from their phones. Exactly one of them must win, the incident must
have exactly one owner, and everyone else must be told who got it. Double ownership is the one
failure we cannot have; make it impossible rather than unlikely. Only the owner can resolve. Keep
everything in the Gadget's own storage. This is the real board, so if you try it out yourself,
clean up afterwards: only incidents I open should be on it.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- open({ id: string, service: string, severity: 1 | 2 | 3, summary: string })
  -> { ok: true } | { ok: false, error: "DUPLICATE_ID" | "INVALID_SEVERITY" }
- acknowledge({ id: string, responder: string })
  -> { ok: true, owner: responder }
   | { ok: false, error: "ALREADY_ACKNOWLEDGED", owner: string }
   | { ok: false, error: "UNKNOWN_INCIDENT" | "ALREADY_RESOLVED", owner: null }
- resolve({ id: string, responder: string })
  -> { ok: true } | { ok: false, error: "UNKNOWN_INCIDENT" | "NOT_ACKNOWLEDGED" | "NOT_OWNER" |
     "ALREADY_RESOLVED" }
- incident({ id: string })
  -> { id, service, severity, summary, status: "open" | "acknowledged" | "resolved",
       owner: string | null, openedAt: ISO 8601, acknowledgedAt: ISO 8601 | null,
       resolvedAt: ISO 8601 | null }
- board() -> { incidents: Incident[] }   every incident, severity 1 first, then oldest first`,
    verify: async verifier => {
      await verifier.check("opens-acknowledges-and-resolves-in-order", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const opened = await openIncident(api, "inc-1", 2);
        const duplicate = await openIncident(api, "inc-1", 1);
        const badSeverity = await openIncident(api, "inc-bad", 4);
        const early = OkSchema.parse(await api.resolve({ id: "inc-1", responder: "alice" }));
        const acked = AckSchema.parse(await api.acknowledge({ id: "inc-1", responder: "alice" }));
        const again = AckSchema.parse(await api.acknowledge({ id: "inc-1", responder: "bob" }));
        const notOwner = OkSchema.parse(await api.resolve({ id: "inc-1", responder: "bob" }));
        const resolved = OkSchema.parse(await api.resolve({ id: "inc-1", responder: "alice" }));
        const twice = OkSchema.parse(await api.resolve({ id: "inc-1", responder: "alice" }));
        const lateAck = AckSchema.parse(await api.acknowledge({ id: "inc-1", responder: "carol" }));
        const unknown = AckSchema.parse(await api.acknowledge({ id: "inc-x", responder: "carol" }));
        const incident = IncidentSchema.parse(await api.incident({ id: "inc-1" }));
        return {
          pass: opened.ok && code(duplicate) === "DUPLICATE_ID" &&
            code(badSeverity) === "INVALID_SEVERITY" && code(early) === "NOT_ACKNOWLEDGED" &&
            acked.ok && acked.owner === "alice" &&
            !again.ok && again.error === "ALREADY_ACKNOWLEDGED" && again.owner === "alice" &&
            code(notOwner) === "NOT_OWNER" && resolved.ok && code(twice) === "ALREADY_RESOLVED" &&
            !lateAck.ok && lateAck.error === "ALREADY_RESOLVED" && lateAck.owner === null &&
            !unknown.ok && unknown.error === "UNKNOWN_INCIDENT" && unknown.owner === null &&
            asTurnOneLeftIt(incident),
          evidence: { opened, duplicate, badSeverity, early, acked, again, notOwner, resolved,
            twice, lateAck, unknown, incident },
        };
      });

      // Twenty un-awaited acknowledges arrive as twenty interleaved RPC calls; a check-then-write
      // implementation hands the incident to more than one responder.
      await verifier.check("simultaneous-acknowledges-yield-exactly-one-owner", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const outcomes = [];
        for (const id of ["race-1", "race-2", "race-3", "race-4", "race-5"]) {
          await mustOpen(api, id, 1, "edge-cache");
          outcomes.push({ id, ...await race(api, id) });
        }
        return { pass: outcomes.every(outcome => outcome.consistent), evidence: outcomes };
      });

      await verifier.check("simultaneous-opens-of-one-id-admit-exactly-one", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const results = (await Promise.all(RACE_OPEN_SEVERITIES.map((severity, index) =>
          api.open({ id: "race-open", service: "dns", severity, summary: `attempt ${index}` }))))
          .map(result => OkSchema.parse(result));
        const incident = IncidentSchema.parse(await api.incident({ id: "race-open" }));
        const winners = results.flatMap((result, index) => result.ok ? [index] : []);
        const winner = winners[0];
        return {
          pass: winners.length === 1 && winner !== undefined &&
            incident.summary === `attempt ${winner}` &&
            incident.severity === RACE_OPEN_SEVERITIES[winner] &&
            results.every(result => result.ok || result.error === "DUPLICATE_ID"),
          evidence: { results, incident },
        };
      });

      const board = await checkBoardOrder(verifier, "board-lists-by-severity-then-age");
      for (const incident of board ?? []) keptByTurnOne.add(asKept(incident));
    },
  }, {
    prompt: `Two additions. Escalation: escalate({ id }) raises the incident one severity level
toward 1 and counts it in a new escalations field on the incident (starting at 0); reject with
"AT_MAX_SEVERITY" at severity 1, "ALREADY_RESOLVED" once resolved, "UNKNOWN_INCIDENT" otherwise.
And metrics({ service? }) -> { count, acknowledged, resolved, meanTimeToAcknowledgeMs,
meanTimeToResolveMs }, for one service or for all, computed from the incidents' own timestamps:
both means are measured from openedAt, to acknowledgedAt and to resolvedAt respectively, and are
null when there is nothing to average. Everything already on the board stays.`,
    verify: async verifier => {
      await verifier.check("existing-incidents-survive-and-race-still-holds", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const board = BoardSchema.parse(await api.board()).incidents;
        const ids = Object.keys(TURN_ONE_BOARD);
        const changed = ids.flatMap(id => {
          const now = board.find(incident => incident.id === id);
          return now !== undefined && keptByTurnOne.has(asKept(now)) ? [] : [id];
        });
        const intact = board.length === ids.length && board.every(asTurnOneLeftIt) &&
          changed.length === 0;
        await mustOpen(api, "race-6", 2, "billing");
        const outcome = await race(api, "race-6");
        return { pass: intact && outcome.consistent, evidence: { changed, board, outcome } };
      });

      await verifier.check("escalation-moves-toward-severity-one-and-stops", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        await mustOpen(api, "esc-1", 3, "auth");
        const opened = IncidentSchema.parse(await api.incident({ id: "esc-1" }));
        const first = OkSchema.parse(await api.escalate({ id: "esc-1" }));
        const afterFirst = IncidentSchema.parse(await api.incident({ id: "esc-1" }));
        const second = OkSchema.parse(await api.escalate({ id: "esc-1" }));
        const afterSecond = IncidentSchema.parse(await api.incident({ id: "esc-1" }));
        const third = OkSchema.parse(await api.escalate({ id: "esc-1" }));
        const afterThird = IncidentSchema.parse(await api.incident({ id: "esc-1" }));
        // race-6 is acknowledged at severity 2: escalation must not touch its ownership.
        const before = IncidentSchema.parse(await api.incident({ id: "race-6" }));
        const acknowledged = OkSchema.parse(await api.escalate({ id: "race-6" }));
        const after = IncidentSchema.parse(await api.incident({ id: "race-6" }));
        const resolvedBefore = IncidentSchema.parse(await api.incident({ id: "inc-1" }));
        const resolved = OkSchema.parse(await api.escalate({ id: "inc-1" }));
        const resolvedAfter = IncidentSchema.parse(await api.incident({ id: "inc-1" }));
        const unknown = OkSchema.parse(await api.escalate({ id: "esc-x" }));
        const board = BoardSchema.parse(await api.board()).incidents;
        const untouched = IncidentSchema.parse(await api.incident({ id: "race-1" }));
        return {
          // The desk's extension must not have broken open(): esc-1 reads back as submitted.
          pass: opened.service === "auth" && opened.severity === 3 &&
            opened.summary === "Incident esc-1" && opened.status === "open" &&
            opened.owner === null && opened.acknowledgedAt === null && opened.resolvedAt === null &&
            (opened.escalations ?? 0) === 0 &&
            first.ok && escalatedOnce(opened, afterFirst) &&
            second.ok && escalatedOnce(afterFirst, afterSecond) && afterSecond.severity === 1 &&
            code(third) === "AT_MAX_SEVERITY" &&
            JSON.stringify(afterThird) === JSON.stringify(afterSecond) &&
            before.status === "acknowledged" && acknowledged.ok && escalatedOnce(before, after) &&
            code(resolved) === "ALREADY_RESOLVED" && code(unknown) === "UNKNOWN_INCIDENT" &&
            JSON.stringify(resolvedAfter) === JSON.stringify(resolvedBefore) &&
            !board.some(incident => incident.id === "esc-x") &&
            (untouched.escalations ?? 0) === 0,
          evidence: { opened, first, afterFirst, second, afterSecond, third, afterThird, before,
            acknowledged, after, resolved, resolvedAfter, unknown },
        };
      });

      await verifier.check("metrics-follow-the-boards-own-timestamps", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        // billing then holds one incident in each state: race-6 acknowledged, and these two.
        await mustOpen(api, "bill-open", 3, "billing");
        await mustOpen(api, "bill-done", 2, "billing");
        const acked = AckSchema.parse(await api.acknowledge({ id: "bill-done", responder: "dana" }));
        const done = OkSchema.parse(await api.resolve({ id: "bill-done", responder: "dana" }));
        const board = BoardSchema.parse(await api.board()).incidents;
        const billingIncidents = board.filter(incident => incident.service === "billing");
        const all = MetricsSchema.parse(await api.metrics({}));
        const billing = MetricsSchema.parse(await api.metrics({ service: "billing" }));
        const none = MetricsSchema.parse(await api.metrics({ service: "no-such-service" }));
        const expectedAll = referenceMetrics(board);
        const expectedBilling = referenceMetrics(billingIncidents);
        const matches = (actual: z.infer<typeof MetricsSchema>, expected: typeof expectedAll) =>
          actual.count === expected.count && actual.acknowledged === expected.acknowledged &&
          actual.resolved === expected.resolved &&
          closeEnough(actual.meanTimeToAcknowledgeMs, expected.meanTimeToAcknowledgeMs) &&
          closeEnough(actual.meanTimeToResolveMs, expected.meanTimeToResolveMs);
        return {
          pass: acked.ok && done.ok &&
            new Set(billingIncidents.map(incident => incident.status)).size === 3 &&
            matches(all, expectedAll) && matches(billing, expectedBilling) &&
            matches(none, referenceMetrics([])) && expectedAll.resolved >= 1,
          evidence: { all, expectedAll, billing, expectedBilling, none },
        };
      });

      const board = await checkBoardOrder(verifier, "board-order-survives-escalation");
      for (const incident of board ?? []) keptByTurnTwo.add(asKept(incident));
    },
  }, {
    prompt: `Add ownership handoff. Every incident() and board() record now also has
handoffs: number, the count of successful handoffs; incidents already on the board get 0 and
otherwise stay exactly as they are.

- handoff({ id: string, responder: string, to: string })
  -> { ok: true } | { ok: false, error: "UNKNOWN_INCIDENT" | "ALREADY_RESOLVED" |
     "NOT_ACKNOWLEDGED" | "NOT_OWNER" | "SAME_OWNER" }

Only the current owner of an acknowledged incident may hand it to someone else; any string is a
valid responder name. A handoff sets owner to \`to\` and adds 1 to handoffs, and changes nothing
else: status, severity, escalations, summary and every timestamp stay, so neither metrics clock
restarts. When several errors apply, report the first of: unknown id, already resolved, not yet
acknowledged, responder is not the current owner, \`to\` is already the owner. A refused handoff
changes nothing. After a handoff the new owner is the owner everywhere: acknowledge() reports them,
only they can resolve, and resolving keeps them as owner along with the handoffs count. Escalation
keeps owner and handoffs.

Handoffs will arrive at the same instant as each other and as resolve() and escalate() calls on
the same incident. Each call must take effect as if the calls ran one at a time in some order:
never two handoffs from the same owner succeeding, never one call's change overwriting another's.`,
    verify: async verifier => {
      await verifier.check("prior-state-handoff-errors-and-new-owner-resolves", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const board = HandedBoardSchema.parse(await api.board()).incidents;
        const changed = TURN_TWO_IDS.filter(id => {
          const now = board.find(incident => incident.id === id);
          return now === undefined || !keptByTurnTwo.has(asKept(now));
        });
        const intact = board.length === TURN_TWO_IDS.length && changed.length === 0;

        const handoff = async (id: string, responder: string, to: string) =>
          OkSchema.parse(await api.handoff({ id, responder, to }));
        const read = async (id: string) => HandedIncidentSchema.parse(await api.incident({ id }));
        const refuse = async (id: string, responder: string, to: string, expected: string) => {
          const before = await read(id);
          const result = await handoff(id, responder, to);
          const after = await read(id);
          return { id, responder, to, expected, result, pass: code(result) === expected &&
            JSON.stringify(after) === JSON.stringify(before) };
        };
        const missing = await handoff("handoff-missing", "lead", "relief");
        const listed = BoardSchema.parse(await api.board()).incidents;
        const before = await read("race-6");
        const owner = before.owner ?? "";
        const refusals = [
          await refuse("inc-1", "outsider", "relief", "ALREADY_RESOLVED"),
          await refuse("race-open", "outsider", "relief", "NOT_ACKNOWLEDGED"),
          await refuse("race-6", "outsider", "relief", "NOT_OWNER"),
          await refuse("race-6", owner, owner, "SAME_OWNER"),
        ];
        const handed = await handoff("race-6", owner, "relief");
        const after = await read("race-6");
        const ack = AckSchema.parse(await api.acknowledge({ id: "race-6", responder: "observer" }));
        const formerResolves = OkSchema.parse(await api.resolve({ id: "race-6", responder: owner }));
        const resolved = OkSchema.parse(await api.resolve({ id: "race-6", responder: "relief" }));
        const final = await read("race-6");
        refusals.push(await refuse("race-6", "relief", "lead", "ALREADY_RESOLVED"));
        return {
          pass: intact && code(missing) === "UNKNOWN_INCIDENT" &&
            !listed.some(incident => incident.id === "handoff-missing") &&
            refusals.every(refusal => refusal.pass) &&
            handed.ok && asKept(after) === amended(before, { owner: "relief", handoffs: 1 }) &&
            !ack.ok && ack.error === "ALREADY_ACKNOWLEDGED" && ack.owner === "relief" &&
            code(formerResolves) === "NOT_OWNER" && resolved.ok && final.status === "resolved" &&
            final.owner === "relief" && final.handoffs === 1,
          evidence: { changed, board, missing, refusals, before, handed, after, ack, formerResolves,
            resolved, final },
        };
      });

      // Twenty handoffs from the same owner: a check-then-write handoff lets several succeed.
      await verifier.check("simultaneous-handoffs-elect-exactly-one-owner", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const outcomes = [];
        for (const id of ["handoff-1", "handoff-2"]) {
          const before = await heldBy(api, id, 2, "auth", "lead");
          const results = (await Promise.all(RESPONDERS.map(to =>
            api.handoff({ id, responder: "lead", to })))).map(result => OkSchema.parse(result));
          const winners = RESPONDERS.filter((_to, index) => results[index]?.ok === true);
          const winner = winners[0] ?? "";
          const after = HandedIncidentSchema.parse(await api.incident({ id }));
          const rows = HandedBoardSchema.parse(await api.board()).incidents
            .filter(incident => incident.id === id);
          const ack = AckSchema.parse(await api.acknowledge({ id, responder: "observer" }));
          const expected = amended(before, { owner: winner, handoffs: 1 });
          outcomes.push({ id, winners, codes: [...new Set(results.map(code))], after, ack,
            pass: winners.length === 1 &&
              results.every(result => result.ok || result.error === "NOT_OWNER") &&
              asKept(after) === expected && rows.length === 1 && asKept(rows[0]!) === expected &&
              !ack.ok && ack.owner === winner });
        }
        // A second handoff counts on from the first, and the original owner stays locked out.
        const first = HandedIncidentSchema.parse(await api.incident({ id: "handoff-1" }));
        const again = OkSchema.parse(
          await api.handoff({ id: "handoff-1", responder: first.owner ?? "", to: "relief" }));
        const stale = OkSchema.parse(
          await api.handoff({ id: "handoff-1", responder: "lead", to: "lead-2" }));
        const last = HandedIncidentSchema.parse(await api.incident({ id: "handoff-1" }));
        return {
          pass: outcomes.every(outcome => outcome.pass) && again.ok && code(stale) === "NOT_OWNER" &&
            asKept(last) === amended(first, { owner: "relief", handoffs: 2 }),
          evidence: { outcomes, again, stale, last },
        };
      });

      // Either order is correct; a mix, such as a resolved incident with a new owner, is not.
      await verifier.check("simultaneous-handoffs-and-resolve-are-linearizable", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const outcomes = [];
        for (const [index, id] of ["handoff-resolve-1", "handoff-resolve-2"].entries()) {
          const before = await heldBy(api, id, 2, "billing", "lead");
          // Calls go out as they are made, so each batch makes them in a different order to give
          // each linearization a chance.
          const handoffs = () => RESPONDERS.map(to => api.handoff({ id, responder: "lead", to }));
          const resolve = () => api.resolve({ id, responder: "lead" });
          const calls = index === 0 ? [...handoffs(), resolve()] : [resolve(), ...handoffs()];
          const settled = (await Promise.all(calls)).map(result => OkSchema.parse(result));
          const resolveAt = index === 0 ? RESPONDERS.length : 0;
          const resolved = settled[resolveAt]!;
          const handed = settled.filter((_result, at) => at !== resolveAt);
          const winners = RESPONDERS.filter((_to, at) => handed[at]?.ok === true);
          const after = HandedIncidentSchema.parse(await api.incident({ id }));
          const rows = HandedBoardSchema.parse(await api.board()).incidents
            .filter(incident => incident.id === id);
          const resolvedAt = instant(after.resolvedAt);
          const consistent = resolved.ok
            ? winners.length === 0 && handed.every(result => code(result) === "ALREADY_RESOLVED") &&
              resolvedAt !== null && !Number.isNaN(resolvedAt) &&
              resolvedAt >= Date.parse(after.acknowledgedAt ?? "") &&
              asKept(after) === amended(before, { status: "resolved", resolvedAt: after.resolvedAt })
            : winners.length === 1 && code(resolved) === "NOT_OWNER" &&
              handed.every(result => result.ok || result.error === "NOT_OWNER") &&
              asKept(after) === amended(before, { owner: winners[0], handoffs: 1 });
          outcomes.push({ id, resolved, winners, codes: [...new Set(handed.map(code))], after,
            pass: consistent && rows.length === 1 && asKept(rows[0]!) === asKept(after) });
        }
        return { pass: outcomes.every(outcome => outcome.pass), evidence: outcomes };
      });

      // Both calls succeed in either order; a whole-record write from a stale read drops one.
      await verifier.check("handoff-and-escalate-commit-both-changes", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const id = "handoff-escalate-1";
        const before = await heldBy(api, id, 3, "auth", "lead");
        const [handed, escalated] = (await Promise.all([
          api.handoff({ id, responder: "lead", to: "relief" }), api.escalate({ id }),
        ])).map(result => OkSchema.parse(result));
        const after = HandedIncidentSchema.parse(await api.incident({ id }));
        const rows = HandedBoardSchema.parse(await api.board()).incidents
          .filter(incident => incident.id === id);
        const expected = amended(before,
          { owner: "relief", handoffs: 1, severity: 2, escalations: (before.escalations ?? 0) + 1 });
        return {
          pass: handed?.ok === true && escalated?.ok === true && asKept(after) === expected &&
            rows.length === 1 && asKept(rows[0]!) === expected,
          evidence: { before, handed, escalated, after },
        };
      });

      await verifier.check("handoff-board-and-metrics", async () => {
        using api = await verifier.connect<DeskApi>(TITLE);
        const board = HandedBoardSchema.parse(await api.board()).incidents;
        const expectedIds = [...TURN_TWO_IDS, "handoff-1", "handoff-2", "handoff-resolve-1",
          "handoff-resolve-2", "handoff-escalate-1"].toSorted();
        const ids = board.map(incident => incident.id).toSorted();
        const metrics = [];
        for (const service of [null, "billing", "auth"]) {
          const actual = MetricsSchema.parse(await api.metrics(service === null ? {} : { service }));
          const expected = referenceMetrics(service === null
            ? board : board.filter(incident => incident.service === service));
          metrics.push({ service, actual, expected,
            pass: actual.count === expected.count && actual.acknowledged === expected.acknowledged &&
              actual.resolved === expected.resolved &&
              closeEnough(actual.meanTimeToAcknowledgeMs, expected.meanTimeToAcknowledgeMs) &&
              closeEnough(actual.meanTimeToResolveMs, expected.meanTimeToResolveMs) });
        }
        return {
          pass: JSON.stringify(ids) === JSON.stringify(expectedIds) &&
            metrics.every(metric => metric.pass),
          evidence: { ids, metrics },
        };
      });

      await checkBoardOrder(verifier, "board-order-survives-handoffs");
    },
  }],
});

defineTaskEval(task);
