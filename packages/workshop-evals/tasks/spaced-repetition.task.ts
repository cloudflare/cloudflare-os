import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const CardSchema = z.object({
  cardId: z.string(),
  reps: z.number().int().nonnegative(),
  ease: z.number(),
  intervalDays: z.number().int().nonnegative(),
  dueIso: z.string(),
}).loose();

const ReviewSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), card: CardSchema }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

const DueSchema = z.object({ cardIds: z.array(z.string()) }).loose();

interface CardsApi {
  addCard(input: { cardId: string; front: string; back: string }):
    Promise<z.infer<typeof OkSchema>>;
  review(input: { cardId: string; grade: number; onIso: string }):
    Promise<z.infer<typeof ReviewSchema>>;
  due(input: { onIso: string }): Promise<z.infer<typeof DueSchema>>;
}

type CardState = z.infer<typeof CardSchema>;

function state(result: z.infer<typeof ReviewSchema>): CardState | undefined {
  return result.ok ? result.card : undefined;
}

/** SM-2 ease factors are floats, so they are compared to the precision the algorithm implies. */
function easeIs(card: CardState | undefined, expected: number): boolean {
  return card !== undefined && Math.abs(card.ease - expected) < 1e-6;
}

function step(card: CardState | undefined, reps: number, intervalDays: number, dueIso: string) {
  return card?.reps === reps && card.intervalDays === intervalDays &&
    card.dueIso.slice(0, 10) === dueIso;
}

/**
 * SM-2 scheduling, stated precisely enough to be verified exactly.
 *
 * The interesting failures are the two places the published algorithm is ambiguous and the prompt
 * therefore pins down — whether the new interval uses the ease factor from before or after this
 * review's update, and whether a lapse touches the ease factor at all.
 */
export default defineEvalTask({
  id: "spaced-repetition",
  title: "Flashcards on an SM-2 schedule",
  expectation: "required",
  turns: [{
    prompt: `Build a Gadget named exactly "Cards" — a flashcard app that schedules my reviews with
the SM-2 algorithm, so cards I know keep drifting further apart and cards I fail come straight back.
Store everything in the Gadget's own storage. Never read the current clock: every call tells you the
date it happens on.

A new card starts with reps = 0, ease = 2.5, intervalDays = 0, and is due immediately.

Reviewing a card with an integer grade from 0 to 5, on date D, updates it in exactly this order:

1. Work out the new interval, using the ease factor as it is *before* this review changes it:
   - grade < 3:            reps becomes 0, intervalDays becomes 1
   - grade >= 3:           reps increases by 1, and then
       reps == 1  ->  intervalDays = 1
       reps == 2  ->  intervalDays = 6
       reps >= 3  ->  intervalDays = round(previous intervalDays * ease), rounding halves up
2. Then adjust the ease factor, but only when grade >= 3:
       ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
   never letting it fall below 1.3. A grade below 3 leaves the ease factor untouched.
3. dueIso becomes D plus intervalDays days.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- addCard({ cardId: string, front: string, back: string }) -> { ok: true } | { ok: false, error: string }
  Rejects "DUPLICATE_CARD".

- review({ cardId: string, grade: integer 0-5, onIso: "YYYY-MM-DD" })
  -> { ok: true, card: { cardId: string, reps: integer, ease: number, intervalDays: integer,
       dueIso: "YYYY-MM-DD" } }
   | { ok: false, error: string }
  Rejects "UNKNOWN_CARD", "BAD_GRADE" for a grade outside 0-5 or not a whole number, and
  "BAD_DATE".

- due({ onIso: "YYYY-MM-DD" }) -> { cardIds: string[] }
  Every card whose dueIso is on or before that date. A card that has never been reviewed is due.`,
    verify: async verifier => {
      await verifier.check("interval-sequence-follows-sm2", async () => {
        using api = await verifier.connect<CardsApi>("Cards");
        const added = OkSchema.parse(
            await api.addCard({ cardId: "seq", front: "hola", back: "hello" }));
        const first = ReviewSchema.parse(
            await api.review({ cardId: "seq", grade: 5, onIso: "2026-01-01" }));
        const second = ReviewSchema.parse(
            await api.review({ cardId: "seq", grade: 4, onIso: "2026-01-02" }));
        const third = ReviewSchema.parse(
            await api.review({ cardId: "seq", grade: 5, onIso: "2026-01-08" }));
        return {
          pass: added.ok &&
            // First success: interval 1 day, ease 2.5 + 0.1.
            step(state(first), 1, 1, "2026-01-02") && easeIs(state(first), 2.6) &&
            // Grade 4 is ease-neutral, and the second success is always 6 days.
            step(state(second), 2, 6, "2026-01-08") && easeIs(state(second), 2.6) &&
            // Third uses the pre-update ease: round(6 * 2.6) = 16, then ease rises to 2.7.
            step(state(third), 3, 16, "2026-01-24") && easeIs(state(third), 2.7),
          evidence: { first, second, third },
        };
      });

      await verifier.check("a-lapse-resets-the-interval-but-not-the-ease", async () => {
        using api = await verifier.connect<CardsApi>("Cards");
        await api.addCard({ cardId: "lapse", front: "adios", back: "goodbye" });
        await api.review({ cardId: "lapse", grade: 5, onIso: "2026-02-01" });
        const before = ReviewSchema.parse(
            await api.review({ cardId: "lapse", grade: 5, onIso: "2026-02-02" }));
        const lapsed = ReviewSchema.parse(
            await api.review({ cardId: "lapse", grade: 1, onIso: "2026-02-08" }));
        return {
          pass: step(state(lapsed), 0, 1, "2026-02-09") &&
            easeIs(state(lapsed), state(before)?.ease ?? Number.NaN),
          evidence: { before, lapsed },
        };
      });

      await verifier.check("ease-decays-on-hard-passes-and-floors-at-1.3", async () => {
        using api = await verifier.connect<CardsApi>("Cards");
        await api.addCard({ cardId: "floor", front: "gato", back: "cat" });
        // Grade 3 costs 0.14 of ease each time: 2.5 reaches 1.38 after eight, and the ninth would
        // land on 1.24 but must clamp instead.
        const eases: number[] = [];
        for (let day = 1; day <= 9; day++) {
          const result = ReviewSchema.parse(await api.review({
            cardId: "floor",
            grade: 3,
            onIso: `2026-03-${String(day).padStart(2, "0")}`,
          }));
          const card = state(result);
          if (card === undefined) return { pass: false, evidence: { day, result } };
          eases.push(card.ease);
        }
        return {
          pass: Math.abs((eases.at(0) ?? 0) - 2.36) < 1e-6 &&
            Math.abs((eases.at(7) ?? 0) - 1.38) < 1e-6 &&
            Math.abs((eases.at(8) ?? 0) - 1.3) < 1e-6,
          evidence: eases,
        };
      });

      await verifier.check("due-lists-new-cards-and-respects-the-schedule", async () => {
        using api = await verifier.connect<CardsApi>("Cards");
        await api.addCard({ cardId: "due-fresh", front: "uno", back: "one" });
        const fresh = DueSchema.parse(await api.due({ onIso: "2026-04-01" }));
        await api.review({ cardId: "due-fresh", grade: 5, onIso: "2026-04-01" });
        const sameDay = DueSchema.parse(await api.due({ onIso: "2026-04-01" }));
        const nextDay = DueSchema.parse(await api.due({ onIso: "2026-04-02" }));
        return {
          pass: fresh.cardIds.includes("due-fresh") &&
            !sameDay.cardIds.includes("due-fresh") &&
            nextDay.cardIds.includes("due-fresh"),
          evidence: { fresh, sameDay, nextDay },
        };
      });

      await verifier.check("rejects-bad-input-with-named-codes", async () => {
        using api = await verifier.connect<CardsApi>("Cards");
        await api.addCard({ cardId: "reject", front: "sol", back: "sun" });
        const duplicate = OkSchema.parse(
            await api.addCard({ cardId: "reject", front: "sol", back: "sun" }));
        const rejections = {
          UNKNOWN_CARD: ReviewSchema.parse(
              await api.review({ cardId: "no-such-card", grade: 4, onIso: "2026-05-01" })),
          BAD_GRADE: ReviewSchema.parse(
              await api.review({ cardId: "reject", grade: 6, onIso: "2026-05-01" })),
          BAD_DATE: ReviewSchema.parse(
              await api.review({ cardId: "reject", grade: 4, onIso: "2026-13-45" })),
        };
        const wrong = Object.entries(rejections)
            .filter(([code, result]) => result.ok || result.error !== code)
            .map(([code, result]) => ({ expected: code, got: result }));
        return {
          pass: !duplicate.ok && duplicate.error === "DUPLICATE_CARD" && wrong.length === 0,
          evidence: { duplicate, wrong },
        };
      });
    },
  }],
});
