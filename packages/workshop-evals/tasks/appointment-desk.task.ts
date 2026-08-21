import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

const StatusSchema = z.object({
  capacity: z.number().int().nonnegative(),
  bookedCount: z.number().int().nonnegative(),
  personIds: z.array(z.string()),
}).loose();

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

/**
 * Overselling under concurrent booking.
 *
 * Durable Object RPC calls interleave at every `await`, so the obvious "read the count, check it,
 * write the booking" shape oversells a slot the moment two requests arrive together. Nothing in the
 * agent's instructions mentions this, yet both format blueprints the platform ships defend against
 * it with a mutation queue — so it is a real capability question rather than prompt recall.
 *
 * The prompt states the requirement — never exceed capacity, people book at the same moment — and not
 * a technique. GLM 5.2 satisfied it by making the check and the insert one synchronous SQL sequence,
 * plus a BEFORE INSERT trigger that aborts at capacity. A check for a mutation queue would reject
 * that.
 */
export default defineEvalTask({
  id: "appointment-desk",
  title: "Appointment desk under concurrent booking",
  expectation: "required",
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
        const results = [
          OkSchema.parse(await api.book({ bookingId: "seq-1", slotId: "seq", personId: "ana" })),
          OkSchema.parse(await api.book({ bookingId: "seq-2", slotId: "seq", personId: "ben" })),
          OkSchema.parse(await api.book({ bookingId: "seq-3", slotId: "seq", personId: "cy" })),
        ];
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "seq" }));
        return {
          pass: defined.ok &&
            results[0]?.ok === true && results[1]?.ok === true &&
            results[2]?.ok === false && results[2].error === "SLOT_FULL" &&
            status.bookedCount === 2 && status.personIds.length === 2,
          evidence: { results, status },
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
        const reused = OkSchema.parse(
            await api.book({ bookingId: "cancel-3", slotId: "cancel", personId: "ben" }));
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "cancel" }));
        return {
          pass: !blocked.ok && blocked.error === "SLOT_FULL" && cancelled.ok &&
            !unknown.ok && unknown.error === "UNKNOWN_BOOKING" && reused.ok &&
            status.bookedCount === 1 && status.personIds.join() === "ben",
          evidence: { blocked, cancelled, unknown, reused, status },
        };
      });

      await verifier.check("rejects-unknown-slot", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        const result = OkSchema.parse(
            await api.book({ bookingId: "ghost", slotId: "no-such-slot", personId: "ana" }));
        return {
          pass: !result.ok && result.error === "UNKNOWN_SLOT",
          evidence: result,
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
        return {
          pass: accepted === capacity && status.bookedCount === capacity &&
            status.personIds.length === capacity &&
            new Set(status.personIds).size === capacity &&
            errors.SLOT_FULL === 10 - capacity,
          evidence: { accepted, errors, status },
        };
      });

      await verifier.check("concurrent-duplicate-booking-ids-collapse-to-one", async () => {
        using api = await verifier.connect<DeskApi>("Desk");
        await api.defineSlot({ slotId: "dupe", startIso: "2026-07-04T09:00:00Z", capacity: 8 });
        const results = (await Promise.all(Array.from({ length: 6 }, () =>
          api.book({ bookingId: "dupe-same", slotId: "dupe", personId: "ana" }))))
            .map(result => OkSchema.parse(result));
        const status = StatusSchema.parse(await api.slotStatus({ slotId: "dupe" }));
        const { accepted, errors } = tally(results);
        return {
          pass: accepted === 1 && errors.DUPLICATE_BOOKING === 5 && status.bookedCount === 1,
          evidence: { accepted, errors, status },
        };
      });
    },
  }],
});
