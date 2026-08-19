import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

const BillingSchema = z.object({
  byProject: z.array(z.object({
    projectId: z.string(),
    rawMinutes: z.number().int().nonnegative(),
    billedMinutes: z.number().int().nonnegative(),
  }).loose()),
}).loose();

const WeeklySchema = z.object({
  totalMinutes: z.number().int().nonnegative(),
  byProject: z.array(z.object({
    projectId: z.string(),
    minutes: z.number().int().nonnegative(),
  }).loose()),
}).loose();

type Session = { id: string; projectId: string; startIso: string; endIso: string };

interface TimesheetApi {
  logSession(input: Session): Promise<z.infer<typeof OkSchema>>;
  dailyBilling(input: { dateIso: string; roundUpToMinutes: number }):
    Promise<z.infer<typeof BillingSchema>>;
  weeklyTotals(input: { weekStartIso: string }): Promise<z.infer<typeof WeeklySchema>>;
}

/**
 * Freelance timesheet: interval arithmetic, half-open overlap, and billing rounding.
 *
 * Frontier on measured evidence — GLM 5.2 passed 1 of 3 trials, failing the same two things both
 * times: it treated intervals as closed, rejecting a session that starts exactly when another ends,
 * and it accepted a duplicate session id outright. Billing and weekly aggregation were never the
 * problem. Promote once a baseline shows the two holding.
 *
 * Every date below is distinct per check, so the checks stay independent even though they all
 * accumulate into one Gadget. Overlap is the exception — it is global by construction — so its
 * check owns its own day.
 */
export default defineEvalTask({
  id: "time-tracker",
  title: "Freelance timesheet",
  expectation: "frontier",
  turns: [{
    prompt: `Build a Gadget named exactly "Timesheet" that I use to bill clients for my time. I log
work sessions against a project, and it tells me what to invoice. I never want it to let me log two
sessions that overlap — if I've double-recorded something I want to know immediately, not at
invoicing time. Store everything in the Gadget's own storage.

Times are ISO 8601 UTC instants like "2026-05-04T09:00:00Z". Never use the current clock: every
question I ask names the date or week it is about.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- logSession({ id: string, projectId: string, startIso: string, endIso: string })
  -> { ok: true } | { ok: false, error: string }
  Reject these, changing nothing, with exactly these error codes:
    "DUPLICATE_ID" - a session with that id already exists
    "BAD_RANGE"    - endIso is not strictly after startIso
    "BAD_TIME"     - either timestamp is not a valid ISO 8601 instant
    "OVERLAP"      - the session overlaps one already logged, for any project. Treat sessions as
                     half-open [start, end): one ending exactly when another begins is fine.

- dailyBilling({ dateIso: "YYYY-MM-DD", roundUpToMinutes: integer > 0 })
  -> { byProject: Array<{ projectId: string, rawMinutes: integer, billedMinutes: integer }> }
  One row per project with time on that UTC day. rawMinutes is the exact total. billedMinutes is
  that project's daily total rounded *up* to the next whole multiple of roundUpToMinutes, so 95
  minutes at 15 becomes 105. A project with a raw total already on a multiple is unchanged.

- weeklyTotals({ weekStartIso: "YYYY-MM-DD" })
  -> { totalMinutes: integer, byProject: Array<{ projectId: string, minutes: integer }> }
  Exact unrounded minutes over the seven UTC days beginning weekStartIso.`,
    verify: async verifier => {
      await verifier.check("rejects-overlaps-but-allows-touching-sessions", async () => {
        using api = await verifier.connect<TimesheetApi>("Timesheet");
        const base = await api.logSession({
          id: "ov-base",
          projectId: "ov-alpha",
          startIso: "2026-05-04T09:00:00Z",
          endIso: "2026-05-04T10:30:00Z",
        });
        const inside = OkSchema.parse(await api.logSession({
          id: "ov-inside",
          projectId: "ov-beta",
          startIso: "2026-05-04T09:30:00Z",
          endIso: "2026-05-04T10:00:00Z",
        }));
        const straddling = OkSchema.parse(await api.logSession({
          id: "ov-straddle",
          projectId: "ov-beta",
          startIso: "2026-05-04T10:00:00Z",
          endIso: "2026-05-04T11:00:00Z",
        }));
        const touching = OkSchema.parse(await api.logSession({
          id: "ov-touching",
          projectId: "ov-beta",
          startIso: "2026-05-04T10:30:00Z",
          endIso: "2026-05-04T11:00:00Z",
        }));
        return {
          pass: OkSchema.parse(base).ok &&
            !inside.ok && inside.error === "OVERLAP" &&
            !straddling.ok && straddling.error === "OVERLAP" &&
            touching.ok,
          evidence: { inside, straddling, touching },
        };
      });

      await verifier.check("rejects-bad-input-with-named-codes", async () => {
        using api = await verifier.connect<TimesheetApi>("Timesheet");
        const valid: Session = {
          id: "bad-base",
          projectId: "bad-alpha",
          startIso: "2026-05-06T09:00:00Z",
          endIso: "2026-05-06T09:30:00Z",
        };
        const accepted = OkSchema.parse(await api.logSession(valid));
        const rejections = {
          DUPLICATE_ID: OkSchema.parse(await api.logSession({
            ...valid, startIso: "2026-05-06T18:00:00Z", endIso: "2026-05-06T18:30:00Z",
          })),
          BAD_RANGE: OkSchema.parse(await api.logSession({
            ...valid, id: "bad-range", startIso: "2026-05-06T12:00:00Z",
            endIso: "2026-05-06T12:00:00Z",
          })),
          BAD_TIME: OkSchema.parse(await api.logSession({
            ...valid, id: "bad-time", startIso: "not-a-time", endIso: "2026-05-06T13:00:00Z",
          })),
        };
        const wrong = Object.entries(rejections)
            .filter(([code, result]) => result.ok || result.error !== code)
            .map(([code, result]) => ({ expected: code, got: result }));
        return { pass: accepted.ok && wrong.length === 0, evidence: { wrong } };
      });

      await verifier.check("bills-each-project-rounded-up-separately", async () => {
        using api = await verifier.connect<TimesheetApi>("Timesheet");
        const logged = [
          // ov-alpha: 90 + 5 = 95 raw -> 105 at 15-minute granularity.
          await api.logSession({
            id: "bill-1", projectId: "bill-alpha",
            startIso: "2026-05-07T09:00:00Z", endIso: "2026-05-07T10:30:00Z",
          }),
          await api.logSession({
            id: "bill-2", projectId: "bill-alpha",
            startIso: "2026-05-07T13:00:00Z", endIso: "2026-05-07T13:05:00Z",
          }),
          // bill-beta: exactly 30 raw, already a multiple, so billing must not inflate it.
          await api.logSession({
            id: "bill-3", projectId: "bill-beta",
            startIso: "2026-05-07T11:00:00Z", endIso: "2026-05-07T11:30:00Z",
          }),
        ];
        const billing = BillingSchema.parse(
            await api.dailyBilling({ dateIso: "2026-05-07", roundUpToMinutes: 15 }));
        const row = (projectId: string) =>
          billing.byProject.find(entry => entry.projectId === projectId);
        return {
          pass: logged.every(result => OkSchema.parse(result).ok) &&
            row("bill-alpha")?.rawMinutes === 95 && row("bill-alpha")?.billedMinutes === 105 &&
            row("bill-beta")?.rawMinutes === 30 && row("bill-beta")?.billedMinutes === 30,
          evidence: billing,
        };
      });

      await verifier.check("weekly-totals-cover-seven-days-exactly", async () => {
        using api = await verifier.connect<TimesheetApi>("Timesheet");
        const logged = [
          await api.logSession({
            id: "wk-first", projectId: "wk-alpha",
            startIso: "2026-06-01T09:00:00Z", endIso: "2026-06-01T10:00:00Z",
          }),
          // The seventh and final day of the week beginning 2026-06-01.
          await api.logSession({
            id: "wk-last", projectId: "wk-beta",
            startIso: "2026-06-07T23:00:00Z", endIso: "2026-06-07T23:30:00Z",
          }),
          // One day past the end of that week, so it must not be counted.
          await api.logSession({
            id: "wk-after", projectId: "wk-alpha",
            startIso: "2026-06-08T09:00:00Z", endIso: "2026-06-08T11:00:00Z",
          }),
        ];
        const week = WeeklySchema.parse(await api.weeklyTotals({ weekStartIso: "2026-06-01" }));
        const minutes = (projectId: string) =>
          week.byProject.find(entry => entry.projectId === projectId)?.minutes ?? null;
        return {
          pass: logged.every(result => OkSchema.parse(result).ok) &&
            minutes("wk-alpha") === 60 && minutes("wk-beta") === 30 && week.totalMinutes === 90,
          evidence: week,
        };
      });
    },
  }],
});
