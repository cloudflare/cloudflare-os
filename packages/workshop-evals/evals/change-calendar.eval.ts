import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

// A week of maintenance for a small platform team, worked the way a person would: build the
// calendar, write the week up as a document from it, change the rules, then ask it a question.
// The seeded windows stay in the calendar from turn 1 on; every later turn is checked against them.

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);
type Ok = z.infer<typeof OkSchema>;

const WindowSchema = z.object({
  id: z.string(),
  service: z.string(),
  startIso: z.string(),
  endIso: z.string(),
  reason: z.string(),
});
type Window = z.infer<typeof WindowSchema>;

function normalized(window: Window): Window {
  const { id, service, startIso, endIso, reason } = window;
  return {
    id, service, reason,
    startIso: new Date(startIso).toISOString(),
    endIso: new Date(endIso).toISOString(),
  };
}

// Extra fields the agent may add are dropped, so what is compared and reported is the contract.
const WindowsSchema = z.object({ windows: z.array(WindowSchema.loose().transform(normalized)) });
const ConflictsSchema = z.object({ ids: z.array(z.string()) });

interface CalendarApi {
  schedule(window: Window): Promise<Ok>;
  cancel(input: { id: string }): Promise<Ok>;
  windows(input: { service?: string; fromIso: string; toIso: string }):
    Promise<z.infer<typeof WindowsSchema>>;
  conflicts(input: { service: string; startIso: string; endIso: string }):
    Promise<z.infer<typeof ConflictsSchema>>;
}

const DocumentSchema = z.object({
  title: z.string(),
  blocks: z.array(z.object({ html: z.string() }).loose()).nullable(),
}).loose();

interface DocsApi {
  getDocument(): Promise<z.infer<typeof DocumentSchema>>;
}

const CALENDAR = "Change Calendar";
const PLAN = "Maintenance Plan — Week 41";
const WEEK = { fromIso: "2027-10-11T00:00:00Z", toIso: "2027-10-18T00:00:00Z" };
const OCTOBER = { fromIso: "2027-10-01T00:00:00Z", toIso: "2027-11-01T00:00:00Z" };

// What the calendar holds once turn 1 is verified. api-gateway totals 6.5 hours.
const TLS_ROTATION: Window = { id: "mw-101", service: "api-gateway",
  startIso: "2027-10-12T23:00:00Z", endIso: "2027-10-13T01:00:00Z", reason: "Rotate TLS certificates" };
const CACHE_WARM: Window = { id: "mw-102", service: "edge-cache",
  startIso: "2027-10-13T00:00:00Z", endIso: "2027-10-13T03:00:00Z", reason: "Purge and re-warm caches" };
const GATEWAY_UPGRADE: Window = { id: "mw-103", service: "api-gateway",
  startIso: "2027-10-14T22:00:00Z", endIso: "2027-10-15T02:30:00Z", reason: "Upgrade gateway to v2.8" };
const INDEX_REBUILD: Window = { id: "mw-104", service: "billing",
  startIso: "2027-10-16T23:30:00Z", endIso: "2027-10-17T01:30:00Z", reason: "Database index rebuild" };
// Week 42: must not appear in the week 41 plan.
const DNS_CHANGE: Window = { id: "mw-105", service: "dns",
  startIso: "2027-10-19T22:00:00Z", endIso: "2027-10-19T23:00:00Z", reason: "Anycast route change" };
const WEEK_41: readonly Window[] = [TLS_ROTATION, CACHE_WARM, GATEWAY_UPGRADE, INDEX_REBUILD];
const SEEDED: readonly Window[] = [...WEEK_41, DNS_CHANGE];
const API_GATEWAY_HOURS = 6.5;

function sameWindows(actual: readonly Window[], expected: readonly Window[]): boolean {
  const key = (window: Window) => JSON.stringify(normalized(window));
  return JSON.stringify(actual.map(key)) === JSON.stringify(expected.map(key));
}

function plainText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function week41(api: CalendarApi): Promise<Window[]> {
  return WindowsSchema.parse(await api.windows(WEEK)).windows;
}

/** Every seeded window, week 42's included, is still there unchanged, and nothing else is. */
async function checkSeededWindowsIntact(verifier: EvalVerifier, id: string): Promise<void> {
  await verifier.check(id, async () => {
    using api = await verifier.connect<CalendarApi>(CALENDAR);
    const windows = WindowsSchema.parse(await api.windows(OCTOBER)).windows;
    return { pass: sameWindows(windows, SEEDED), evidence: { windows } };
  });
}

/** The length a bullet states, in hours: "2 hours", "2h", "2.5 hrs", "4.5-hour". */
function statedHours(bullet: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*-?\s*(?:h|hr|hrs|hour|hours)\b/i.exec(bullet);
  return match === null ? null : Number(match[1]);
}

const task = defineEvalTask({
  id: "change-calendar",
  turns: [{
    prompt: `Build a Gadget named exactly "${CALENDAR}": a maintenance-window calendar for the
platform team. Our services are api-gateway, edge-cache, auth, billing and dns. Keep everything in
the Gadget's own storage.

The rules a window must satisfy:
- It starts between 22:00 and 03:59 UTC. Reject with "OUTSIDE_HOURS".
- It ends after it starts and lasts at most 8 hours. Reject with "INVALID_RANGE".
- It does not overlap another window for the same service. Reject with "OVERLAP". Windows that
  merely touch (one ends exactly when the next starts) do not overlap, and windows for different
  services may overlap freely.
- Its service is one of ours. Reject with "UNKNOWN_SERVICE".
- Its id is new. Reject with "DUPLICATE_ID".
A rejected request changes nothing.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- schedule({ id: string, service: string, startIso: string, endIso: string, reason: string })
  -> { ok: true } | { ok: false, error: string }
- cancel({ id: string }) -> { ok: true } | { ok: false, error: "UNKNOWN_WINDOW" }
- windows({ service?: string, fromIso: string, toIso: string })
  -> { windows: Array<{ id, service, startIso, endIso, reason }> }
  Every window that overlaps [fromIso, toIso), for one service or for all, sorted by startIso
  then id.
- conflicts({ service: string, startIso: string, endIso: string }) -> { ids: string[] }
  The ids of existing windows for that service that would overlap the given range, sorted.`,
    verify: async verifier => {
      await verifier.check("schedules-and-lists-windows", async () => {
        using api = await verifier.connect<CalendarApi>(CALENDAR);
        const scheduled: Ok[] = [];
        for (const window of SEEDED) scheduled.push(OkSchema.parse(await api.schedule(window)));
        const week = await week41(api);
        const gateway = WindowsSchema.parse(
            await api.windows({ service: "api-gateway", ...WEEK })).windows;
        const all = WindowsSchema.parse(await api.windows(OCTOBER)).windows;
        return {
          pass: scheduled.every(result => result.ok) && sameWindows(week, WEEK_41) &&
            sameWindows(gateway, [TLS_ROTATION, GATEWAY_UPGRADE]) && sameWindows(all, SEEDED),
          evidence: { scheduled, week, gateway },
        };
      });

      await verifier.check("rejects-invalid-windows-without-changing-anything", async () => {
        using api = await verifier.connect<CalendarApi>(CALENDAR);
        const base = { id: "mw-bad", service: "auth", reason: "test" };
        const attempts = {
          DUPLICATE_ID: OkSchema.parse(await api.schedule(TLS_ROTATION)),
          UNKNOWN_SERVICE: OkSchema.parse(await api.schedule({
            ...base, service: "cdn", startIso: "2027-10-20T23:00:00Z", endIso: "2027-10-21T00:00:00Z",
          })),
          OUTSIDE_HOURS: OkSchema.parse(await api.schedule({
            ...base, startIso: "2027-10-20T10:00:00Z", endIso: "2027-10-20T11:00:00Z",
          })),
          INVALID_RANGE_backwards: OkSchema.parse(await api.schedule({
            ...base, startIso: "2027-10-20T23:00:00Z", endIso: "2027-10-20T22:00:00Z",
          })),
          INVALID_RANGE_too_long: OkSchema.parse(await api.schedule({
            ...base, startIso: "2027-10-20T22:00:00Z", endIso: "2027-10-21T07:00:00Z",
          })),
        };
        const all = WindowsSchema.parse(await api.windows({
          fromIso: "2027-01-01T00:00:00Z", toIso: "2028-01-01T00:00:00Z",
        })).windows;
        const code = (result: Ok) => result.ok ? "ok" : result.error;
        return {
          pass: code(attempts.DUPLICATE_ID) === "DUPLICATE_ID" &&
            code(attempts.UNKNOWN_SERVICE) === "UNKNOWN_SERVICE" &&
            code(attempts.OUTSIDE_HOURS) === "OUTSIDE_HOURS" &&
            code(attempts.INVALID_RANGE_backwards) === "INVALID_RANGE" &&
            code(attempts.INVALID_RANGE_too_long) === "INVALID_RANGE" &&
            sameWindows(all, SEEDED),
          evidence: { attempts, count: all.length },
        };
      });

      await verifier.check("overlap-is-per-service-and-touching-is-allowed", async () => {
        using api = await verifier.connect<CalendarApi>(CALENDAR);
        // Ends exactly when mw-101 starts: allowed.
        const touching = OkSchema.parse(await api.schedule({
          id: "mw-touch", service: "api-gateway", reason: "test",
          startIso: "2027-10-12T22:00:00Z", endIso: "2027-10-12T23:00:00Z",
        }));
        const overlapping = OkSchema.parse(await api.schedule({
          id: "mw-overlap", service: "api-gateway", reason: "test",
          startIso: "2027-10-12T23:30:00Z", endIso: "2027-10-13T00:30:00Z",
        }));
        const otherService = OkSchema.parse(await api.schedule({
          id: "mw-other", service: "auth", reason: "test",
          startIso: "2027-10-12T23:30:00Z", endIso: "2027-10-13T00:30:00Z",
        }));
        const conflicts = ConflictsSchema.parse(await api.conflicts({
          service: "api-gateway", startIso: "2027-10-12T22:30:00Z", endIso: "2027-10-12T23:30:00Z",
        }));
        const cancelled = [
          OkSchema.parse(await api.cancel({ id: "mw-touch" })),
          OkSchema.parse(await api.cancel({ id: "mw-other" })),
          OkSchema.parse(await api.cancel({ id: "mw-nope" })),
        ];
        const week = await week41(api);
        return {
          pass: touching.ok && !overlapping.ok && overlapping.error === "OVERLAP" &&
            otherService.ok && conflicts.ids.join() === ["mw-101", "mw-touch"].join() &&
            cancelled[0]?.ok === true && cancelled[1]?.ok === true &&
            cancelled[2]?.ok === false && cancelled[2].error === "UNKNOWN_WINDOW" &&
            sameWindows(week, WEEK_41),
          evidence: { touching, overlapping, otherService, conflicts, cancelled },
        };
      });
    },
  }, {
    prompt: `Write up the plan for the week of Monday 11 to Sunday 17 October 2027 (UTC) as a
document named exactly "${PLAN}", taken from the calendar, not retyped. One heading per service
that has a window that week, services in alphabetical order, and under each heading one bullet per
window with its start time in UTC, its length in hours, and the reason. Leave out services with
nothing scheduled that week.`,
    verify: async verifier => {
      await verifier.check("plan-is-a-document-listing-exactly-the-weeks-windows", async () => {
        const plan = verifier.workpieces.find(workpiece => workpiece.title === PLAN);
        if (plan?.type !== "gadget" || plan.output?.id !== "document") {
          return {
            pass: false,
            evidence: verifier.workpieces.map(workpiece => ({
              title: workpiece.title,
              output: workpiece.type === "gadget" ? workpiece.output?.id ?? null : workpiece.type,
            })),
          };
        }
        using api = await verifier.connect<DocsApi>(PLAN);
        const document = DocumentSchema.parse(await api.getDocument());
        const html = (document.blocks ?? []).map(block => block.html).join("\n");
        // Walk headings and bullets in source order; a bullet belongs to the latest heading.
        const sections: { heading: string; bullets: string[] }[] = [];
        for (const match of html.matchAll(/<(h[1-6]|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)) {
          const text = plainText(match[2] ?? "");
          if (match[1]?.toLowerCase().startsWith("h")) {
            if (text.toLowerCase() !== PLAN.toLowerCase()) sections.push({ heading: text, bullets: [] });
          } else {
            sections.at(-1)?.bullets.push(text);
          }
        }
        const expected = [...new Set(WEEK_41.map(window => window.service))].toSorted();
        const headings = sections.map(section => section.heading.toLowerCase());
        const bulletsMatch = expected.every((service, index) => {
          const windows = WEEK_41.filter(window => window.service === service);
          const bullets = sections[index]?.bullets ?? [];
          return bullets.length === windows.length && windows.every(window => {
            const hours = (Date.parse(window.endIso) - Date.parse(window.startIso)) / 3_600_000;
            const startClock = window.startIso.slice(11, 16);
            return bullets.some(bullet =>
              bullet.toLowerCase().includes(window.reason.toLowerCase()) &&
              bullet.includes(startClock) && statedHours(bullet) === hours);
          });
        });
        return {
          pass: headings.length === expected.length &&
            expected.every((service, index) => headings[index]?.includes(service)) && bulletsMatch,
          evidence: { sections, expected },
        };
      });
    },
  }, {
    prompt: `Two rule changes for the calendar. Windows for the same service must now be at least
24 hours apart, measured from the end of one to the start of the next; reject with "TOO_CLOSE"
("OVERLAP" stays for windows that actually overlap). And billing windows are now capped at 4 hours
instead of 8, still "INVALID_RANGE". Everything already scheduled stays exactly as it is.`,
    verify: async verifier => {
      await checkSeededWindowsIntact(verifier, "existing-windows-survive-the-rule-change");

      await verifier.check("same-service-windows-must-be-a-day-apart", async () => {
        using api = await verifier.connect<CalendarApi>(CALENDAR);
        // mw-101 ends 13 Oct 01:00; 21 hours later is too close, 43.5 hours after mw-103 is not.
        const tooClose = OkSchema.parse(await api.schedule({
          id: "mw-close", service: "api-gateway", reason: "test",
          startIso: "2027-10-13T22:00:00Z", endIso: "2027-10-13T23:00:00Z",
        }));
        const stillOverlap = OkSchema.parse(await api.schedule({
          id: "mw-overlap-2", service: "api-gateway", reason: "test",
          startIso: "2027-10-14T23:00:00Z", endIso: "2027-10-15T00:00:00Z",
        }));
        const farEnough = OkSchema.parse(await api.schedule({
          id: "mw-far", service: "api-gateway", reason: "test",
          startIso: "2027-10-16T22:00:00Z", endIso: "2027-10-16T23:00:00Z",
        }));
        const otherService = OkSchema.parse(await api.schedule({
          id: "mw-auth-close", service: "auth", reason: "test",
          startIso: "2027-10-13T02:00:00Z", endIso: "2027-10-13T03:00:00Z",
        }));
        const cancelled = [
          OkSchema.parse(await api.cancel({ id: "mw-far" })),
          OkSchema.parse(await api.cancel({ id: "mw-auth-close" })),
        ];
        return {
          pass: !tooClose.ok && tooClose.error === "TOO_CLOSE" &&
            !stillOverlap.ok && stillOverlap.error === "OVERLAP" &&
            farEnough.ok && otherService.ok && cancelled.every(result => result.ok) &&
            sameWindows(await week41(api), WEEK_41),
          evidence: { tooClose, stillOverlap, farEnough, otherService, cancelled },
        };
      });

      await verifier.check("billing-is-capped-at-four-hours-others-are-not", async () => {
        using api = await verifier.connect<CalendarApi>(CALENDAR);
        const billingFive = OkSchema.parse(await api.schedule({
          id: "mw-bill-5", service: "billing", reason: "test",
          startIso: "2027-10-20T22:00:00Z", endIso: "2027-10-21T03:00:00Z",
        }));
        const billingFour = OkSchema.parse(await api.schedule({
          id: "mw-bill-4", service: "billing", reason: "test",
          startIso: "2027-10-20T22:00:00Z", endIso: "2027-10-21T02:00:00Z",
        }));
        const gatewayFive = OkSchema.parse(await api.schedule({
          id: "mw-gw-5", service: "api-gateway", reason: "test",
          startIso: "2027-10-20T22:00:00Z", endIso: "2027-10-21T03:00:00Z",
        }));
        const outsideHours = OkSchema.parse(await api.schedule({
          id: "mw-noon", service: "dns", reason: "test",
          startIso: "2027-10-25T12:00:00Z", endIso: "2027-10-25T13:00:00Z",
        }));
        const cancelled = [
          OkSchema.parse(await api.cancel({ id: "mw-bill-4" })),
          OkSchema.parse(await api.cancel({ id: "mw-gw-5" })),
        ];
        return {
          pass: !billingFive.ok && billingFive.error === "INVALID_RANGE" && billingFour.ok &&
            gatewayFive.ok && !outsideHours.ok && outsideHours.error === "OUTSIDE_HOURS" &&
            cancelled.every(result => result.ok),
          evidence: { billingFive, billingFour, gatewayFive, outsideHours, cancelled },
        };
      });
    },
    verifyAfterAccept: async verifier => {
      await checkSeededWindowsIntact(verifier, "windows-survive-commit-and-reload");
      await verifier.check("new-rules-survive-commit-and-reload", async () => {
        using api = await verifier.connect<CalendarApi>(CALENDAR);
        const tooClose = OkSchema.parse(await api.schedule({
          id: "mw-close-2", service: "edge-cache", reason: "test",
          startIso: "2027-10-13T23:00:00Z", endIso: "2027-10-14T00:00:00Z",
        }));
        return { pass: !tooClose.ok && tooClose.error === "TOO_CLOSE", evidence: { tooClose } };
      });
    },
  }, {
    prompt: `How many hours of maintenance are scheduled for api-gateway in the week of Monday 11
to Sunday 17 October 2027? Reply with just the number and nothing else, like \`6.5\`.`,
    verify: async verifier => {
      await verifier.check("answers-with-the-number-from-the-calendar", async () => {
        const reply = verifier.replies.at(-1)?.trim() ?? "";
        const match = /^`?(\d+(?:\.\d+)?)`?\.?$/.exec(reply);
        return {
          pass: match !== null && Number(match[1]) === API_GATEWAY_HOURS,
          evidence: { reply, replies: verifier.replies.length },
        };
      });
      await checkSeededWindowsIntact(verifier, "asking-a-question-changes-nothing");
    },
  }],
});

defineTaskEval(task);
