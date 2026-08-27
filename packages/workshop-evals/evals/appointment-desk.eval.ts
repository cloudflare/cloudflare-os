import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

const StatusSchema = z.object({
  capacity: z.number().int().nonnegative(),
  bookedCount: z.number().int().nonnegative(),
  personIds: z.array(z.string()),
});

interface DeskApi {
  defineSlot(input: { slotId: string; startIso: string; capacity: number }):
    Promise<z.infer<typeof OkSchema>>;
  book(input: { bookingId: string; slotId: string; personId: string }):
    Promise<z.infer<typeof OkSchema>>;
  cancel(input: { bookingId: string }): Promise<z.infer<typeof OkSchema>>;
  slotStatus(input: { slotId: string }): Promise<z.infer<typeof StatusSchema>>;
}

/** Settles a batch of concurrent results into counts of accepted and each rejection code. */
function tally(results: readonly z.infer<typeof OkSchema>[]) {
  const accepted = results.filter(result => result.ok).length;
  const errors: Record<string, number> = {};
  for (const result of results) {
    if (result.ok) continue;
    errors[result.error] = (errors[result.error] ?? 0) + 1;
  }
  return { accepted, errors };
}

/** Whether two personId lists name exactly the same people, in any order. */
function samePeople(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].toSorted()) === JSON.stringify([...right].toSorted());
}

/**
 * Durable Object RPC calls can interleave at each `await`. A count check followed by an awaited
 * insert can therefore oversell. Both shipped format blueprints guard this race, so the task probes
 * a platform-relevant capability rather than prompt recall.
 *
 * The prompt states the capacity invariant without prescribing synchronization. In a measured GLM
 * 5.2 run, synchronous SQL plus a BEFORE INSERT trigger passed. Requiring a mutation queue would
 * have rejected that correct implementation.
 */
const task = defineEvalTask({
  id: "appointment-desk",
  turns: [{
    prompt: `Build a Gadget named exactly "Desk" for booking appointment slots at a small clinic.
Reception shares the link, so several people book at the same moment from their own phones. A slot
must never be oversold: if it has three places, exactly three bookings can ever succeed, no matter
how many arrive at once. Getting this wrong is the one failure I cannot live with, so make it
impossible rather than unlikely. Store everything in the Gadget's own storage.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- defineSlot({ slotId: string, startIso: string, capacity: integer > 0 })
  -> { ok: true } | { ok: false, error: string }
  Rejects "DUPLICATE_SLOT" if that slotId already exists.

- book({ bookingId: string, slotId: string, personId: string })
  -> { ok: true } | { ok: false, error: string }
  Reject these, changing nothing, with exactly these error codes:
    "UNKNOWN_SLOT"      - no slot with that id
    "SLOT_FULL"         - the slot already holds its capacity in bookings
    "DUPLICATE_BOOKING" - a booking with that bookingId already exists

- cancel({ bookingId: string }) -> { ok: true } | { ok: false, error: string }
  Rejects "UNKNOWN_BOOKING". A cancelled booking frees its place for someone else.

- slotStatus({ slotId: string })
  -> { capacity: integer, bookedCount: integer, personIds: string[] }
  personIds lists the people currently holding a place, and its length always equals bookedCount.`,
    verify: async verifier => {
      await verifier.check("sequential-booking-respects-capacity", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        const defined = OkSchema.parse(await api.defineSlot({
          slotId: "seq", startIso: "2026-07-01T09:00:00Z", capacity: 2,
        }));
        const duplicate = OkSchema.parse(await api.defineSlot({
          slotId: "seq", startIso: "2026-07-01T10:00:00Z", capacity: 3,
        }));
        const results = [
          OkSchema.parse(await api.book({ bookingId: "seq-1", slotId: "seq", personId: "ana" })),
          OkSchema.parse(await api.book({ bookingId: "seq-2", slotId: "seq", personId: "ben" })),
          OkSchema.parse(await api.book({ bookingId: "seq-3", slotId: "seq", personId: "cy" })),
        ];
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "seq" }));
        return {
          pass: defined.ok && !duplicate.ok && duplicate.error === "DUPLICATE_SLOT" &&
            results[0]?.ok === true && results[1]?.ok === true &&
            results[2]?.ok === false && results[2].error === "SLOT_FULL" &&
            status.capacity === 2 && status.bookedCount === 2 &&
            samePeople(status.personIds, ["ana", "ben"]),
          evidence: { defined, duplicate, results, status },
        };
      });

      await verifier.check("cancelling-frees-a-place", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        await api.defineSlot({ slotId: "cancel", startIso: "2026-07-02T09:00:00Z", capacity: 1 });
        await api.book({ bookingId: "cancel-1", slotId: "cancel", personId: "ana" });
        const blocked = OkSchema.parse(
            await api.book({ bookingId: "cancel-2", slotId: "cancel", personId: "ben" }));
        const cancelled = OkSchema.parse(await api.cancel({ bookingId: "cancel-1" }));
        const unknown = OkSchema.parse(await api.cancel({ bookingId: "cancel-nope" }));
        // Retrying the exact ID that was refused with SLOT_FULL proves the rejection changed
        // nothing: reserving booking IDs before checking capacity would leave cancel-2 consumed.
        const retried = OkSchema.parse(
            await api.book({ bookingId: "cancel-2", slotId: "cancel", personId: "ben" }));
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "cancel" }));
        return {
          pass: !blocked.ok && blocked.error === "SLOT_FULL" && cancelled.ok &&
            !unknown.ok && unknown.error === "UNKNOWN_BOOKING" && retried.ok &&
            status.capacity === 1 && status.bookedCount === 1 && status.personIds.join() === "ben",
          evidence: { blocked, cancelled, unknown, retried, status },
        };
      });

      await verifier.check("rejects-unknown-slot", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        const result = OkSchema.parse(
            await api.book({ bookingId: "ghost", slotId: "no-such-slot", personId: "ana" }));
        const defined = OkSchema.parse(await api.defineSlot({
          slotId: "no-such-slot", startIso: "2026-07-02T10:00:00Z", capacity: 1,
        }));
        const retried = OkSchema.parse(
            await api.book({ bookingId: "ghost", slotId: "no-such-slot", personId: "ana" }));
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "no-such-slot" }));
        return {
          pass: !result.ok && result.error === "UNKNOWN_SLOT" && defined.ok && retried.ok &&
            status.bookedCount === 1 && status.personIds.join() === "ana",
          evidence: { result, defined, retried, status },
        };
      });

      // Ten bookings dispatched without awaiting arrive as ten interleaved RPC calls, so a
      // check-then-write implementation oversells the slot.
      await verifier.check("concurrent-booking-never-oversells", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        const capacity = 3;
        await api.defineSlot({ slotId: "race", startIso: "2026-07-03T09:00:00Z", capacity });
        const results = (await Promise.all(Array.from({ length: 10 }, (_unused, index) =>
          api.book({
            bookingId: `race-${index}`, slotId: "race", personId: `person-${index}`,
          })))).map(result => OkSchema.parse(result));
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "race" }));
        const { accepted, errors } = tally(results);
        // The stored holders must be exactly the callers whose requests succeeded; counting
        // successes and holders separately would let them describe different bookings.
        const succeeded = results.flatMap((result, index) => result.ok ? [`person-${index}`] : []);
        return {
          pass: accepted === capacity && status.capacity === capacity &&
            status.bookedCount === capacity && status.personIds.length === capacity &&
            new Set(status.personIds).size === capacity &&
            samePeople(status.personIds, succeeded) &&
            errors.SLOT_FULL === 10 - capacity,
          evidence: { accepted, errors, status, succeeded },
        };
      });

      await verifier.check("concurrent-duplicate-booking-ids-collapse-to-one", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        await api.defineSlot({ slotId: "dupe", startIso: "2026-07-04T09:00:00Z", capacity: 8 });
        // Two definitions of the same slotId race: a check-then-insert defineSlot lets both
        // succeed, so exactly one may win and the stored capacity must be the winner's.
        const [racedLow, racedHigh] = (await Promise.all([
          api.defineSlot({ slotId: "dupe-other", startIso: "2026-07-04T10:00:00Z", capacity: 2 }),
          api.defineSlot({ slotId: "dupe-other", startIso: "2026-07-04T11:00:00Z", capacity: 7 }),
        ])).map(result => OkSchema.parse(result));
        const winnerCapacity = racedLow.ok ? 2 : racedHigh.ok ? 7 : null;
        const defineRejections = [racedLow, racedHigh]
          .map(result => result.ok ? null : result.error);
        const results = (await Promise.all(Array.from({ length: 6 }, () =>
          api.book({ bookingId: "dupe-same", slotId: "dupe", personId: "ana" }))))
            .map(result => OkSchema.parse(result));
        const crossSlot = OkSchema.parse(
            await api.book({ bookingId: "dupe-same", slotId: "dupe-other", personId: "ben" }));
        // Reading both slots only after the rejected cross-slot attempt proves the rejection
        // changed nothing, including the raced definition's stored capacity.
        const dupeStatus = StatusSchema.parse(await api.slotStatus({ slotId: "dupe" }));
        const otherStatus = StatusSchema.parse(await api.slotStatus({ slotId: "dupe-other" }));
        const { accepted, errors } = tally(results);
        // Capacity 8 must admit five further distinct bookings; an implementation capping unique
        // bookings at three would refuse the fourth.
        const extras = (await Promise.all(Array.from({ length: 5 }, (_unused, index) =>
          api.book({
            bookingId: `dupe-extra-${index}`, slotId: "dupe", personId: `extra-${index}`,
          })))).map(result => OkSchema.parse(result));
        const finalStatus = StatusSchema.parse(await api.slotStatus({ slotId: "dupe" }));
        return {
          pass: accepted === 1 && errors.DUPLICATE_BOOKING === 5 &&
            racedLow.ok !== racedHigh.ok &&
            defineRejections.every(code => code === null || code === "DUPLICATE_SLOT") &&
            otherStatus.capacity === winnerCapacity &&
            !crossSlot.ok && crossSlot.error === "DUPLICATE_BOOKING" &&
            dupeStatus.capacity === 8 && dupeStatus.bookedCount === 1 &&
            dupeStatus.personIds.join() === "ana" &&
            otherStatus.bookedCount === 0 && otherStatus.personIds.length === 0 &&
            extras.every(result => result.ok) &&
            finalStatus.capacity === 8 && finalStatus.bookedCount === 6 &&
            samePeople(finalStatus.personIds,
                ["ana", "extra-0", "extra-1", "extra-2", "extra-3", "extra-4"]),
          evidence: {
            accepted, errors, racedLow, racedHigh, winnerCapacity, crossSlot,
            dupeStatus, otherStatus, extras, finalStatus,
          },
        };
      });
    },
    verifyAfterAccept: async verifier => {
      await verifier.check("bookings-survive-code-reload", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "seq" }));
        // The cancel slot must reload with exactly its post-cancellation state: a cancelled
        // booking restored from memory would oversell this capacity-1 slot.
        const cancelStatus = StatusSchema.parse(await api.slotStatus({ slotId: "cancel" }));
        const cancelledAgain = OkSchema.parse(await api.cancel({ bookingId: "cancel-2" }));
        const rebooked = OkSchema.parse(
            await api.book({ bookingId: "cancel-4", slotId: "cancel", personId: "dee" }));
        const rebookedStatus = StatusSchema.parse(await api.slotStatus({ slotId: "cancel" }));
        return {
          pass: status.capacity === 2 && status.bookedCount === 2 &&
            status.personIds.length === 2 && status.personIds.includes("ana") &&
            status.personIds.includes("ben") &&
            cancelStatus.capacity === 1 && cancelStatus.bookedCount === 1 &&
            cancelStatus.personIds.join() === "ben" &&
            cancelledAgain.ok && rebooked.ok &&
            rebookedStatus.capacity === 1 && rebookedStatus.bookedCount === 1 &&
            rebookedStatus.personIds.join() === "dee",
          evidence: { status, cancelStatus, cancelledAgain, rebooked, rebookedStatus },
        };
      });
    },
  }],
});

defineTaskEval(task);
