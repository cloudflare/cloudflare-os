import { z } from "zod";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).loose(),
  z.object({ ok: z.literal(false), error: z.string().min(1) }).loose(),
]);

const MovementSchema = z.object({
  id: z.string(),
  sku: z.string(),
  delta: z.number().int(),
  reason: z.string(),
  atIso: z.string(),
}).loose();

const AuditSchema = z.object({
  movementCount: z.number().int().nonnegative(),
  skuCount: z.number().int().nonnegative(),
  reconciles: z.boolean(),
}).loose();

type Movement = z.infer<typeof MovementSchema>;

interface StockApi {
  record(input: Movement): Promise<z.infer<typeof OkSchema>>;
  stock(input: { sku: string }): Promise<{ sku: string; quantity: number }>;
  history(input: { sku: string }): Promise<Movement[]>;
  audit(): Promise<z.infer<typeof AuditSchema>>;
}

function movement(id: string, sku: string, delta: number, day: number): Movement {
  return {
    id,
    sku,
    delta,
    reason: delta > 0 ? "delivery" : "sale",
    atIso: `2026-09-${String(day).padStart(2, "0")}`,
  };
}

/**
 * An append-only stock ledger, used to ask whether the agent's app actually survives its server
 * going away — which on this platform happens on every code change, not just on failure.
 *
 * Storage is preserved across a restart and memory is not, so the checks here are aimed at state an
 * implementation is tempted to keep in a field: the running quantity per SKU, and the set of
 * movement ids used to reject duplicates. An in-memory id index passes a duplicate check right up
 * until the first restart, which is exactly the bug worth catching before a user hits it.
 *
 * Not yet measured against a live model, so it starts as frontier; promote once a baseline
 * shows it passing.
 */
export default defineEvalTask({
  id: "stock-ledger",
  title: "Stock ledger that survives restarts",
  expectation: "frontier",
  turns: [{
    prompt: `Build a Gadget named exactly "Stock" — an append-only stock ledger for a small shop.
Every movement in or out is recorded and never edited or deleted; the quantity on hand is derived
from the movements. Losing a movement, or double-counting one, is the worst thing this app could do,
so everything must be held in the Gadget's own durable storage and stay correct even if the server
restarts at any moment. Never read the current clock: each movement carries its own date.

It needs a stable server RPC taking and returning plain data, so I can verify it:

- record({ id: string, sku: string, delta: integer (non-zero, may be negative), reason: string,
  atIso: "YYYY-MM-DD" }) -> { ok: true } | { ok: false, error: string }
  Appends one movement. Reject these, changing nothing, with exactly these error codes:
    "DUPLICATE_ID" - a movement with that id was already recorded, ever
    "ZERO_DELTA"   - delta is 0 or not a whole number
    "BAD_DATE"     - atIso is not a YYYY-MM-DD calendar date

- stock({ sku: string }) -> { sku: string, quantity: integer }
  The sum of every recorded delta for that SKU. An unknown SKU has quantity 0.

- history({ sku: string }) -> Array<{ id, sku, delta, reason, atIso }>
  Every movement for that SKU, oldest first.

- audit() -> { movementCount: integer, skuCount: integer, reconciles: boolean }
  movementCount is every movement ever recorded and skuCount the number of distinct SKUs.
  reconciles is true only if, for every SKU, stock() equals the sum of that SKU's history().`,
    verify: async verifier => {
      await verifier.check("derives-stock-from-movements", async () => {
        using api = await verifier.connect<StockApi>("Stock");
        const recorded = [
          await api.record(movement("d-1", "bolt", 100, 1)),
          await api.record(movement("d-2", "bolt", -30, 2)),
          await api.record(movement("d-3", "nut", 50, 3)),
          await api.record(movement("d-4", "bolt", 5, 4)),
        ];
        const bolt = await api.stock({ sku: "bolt" });
        const nut = await api.stock({ sku: "nut" });
        const unknown = await api.stock({ sku: "no-such-sku" });
        const audit = AuditSchema.parse(await api.audit());
        return {
          pass: recorded.every(result => OkSchema.parse(result).ok) &&
            bolt.quantity === 75 && nut.quantity === 50 && unknown.quantity === 0 &&
            audit.movementCount === 4 && audit.skuCount === 2 && audit.reconciles,
          evidence: { bolt, nut, unknown, audit },
        };
      });

      await verifier.check("rejects-bad-input-with-named-codes", async () => {
        using api = await verifier.connect<StockApi>("Stock");
        const rejections = {
          DUPLICATE_ID: OkSchema.parse(await api.record(movement("d-1", "bolt", 7, 5))),
          ZERO_DELTA: OkSchema.parse(await api.record(movement("z-1", "bolt", 0, 5))),
          BAD_DATE: OkSchema.parse(await api.record({ ...movement("b-1", "bolt", 1, 5), atIso: "2026-09-31" })),
        };
        const audit = AuditSchema.parse(await api.audit());
        const wrong = Object.entries(rejections)
            .filter(([code, result]) => result.ok || result.error !== code)
            .map(([code, result]) => ({ expected: code, got: result }));
        return {
          pass: wrong.length === 0 && audit.movementCount === 4,
          evidence: { wrong, audit },
        };
      });

      // Confirms the restart mechanism before the checks below depend on it. An abort invalidates
      // every outstanding stub, so a stub that still answers means nothing restarted.
      await verifier.check("restart-really-restarts-the-server", async () => {
        const probe = await verifier.connect<StockApi>("Stock");
        const before = AuditSchema.parse(await probe.audit());
        await verifier.restart();
        let invalidated = false;
        try {
          await probe.audit();
        } catch {
          invalidated = true;
        }
        probe[Symbol.dispose]();
        using api = await verifier.connect<StockApi>("Stock");
        const after = AuditSchema.parse(await api.audit());
        return {
          pass: invalidated && after.movementCount === before.movementCount && after.reconciles,
          evidence: { invalidated, before, after },
        };
      });

      await verifier.check("survives-repeated-server-restarts", async () => {
        const seen: { round: number; quantity: number; movementCount: number }[] = [];
        for (let round = 0; round < 4; round++) {
          using api = await verifier.connect<StockApi>("Stock");
          const recorded = OkSchema.parse(await api.record(movement(`r-${round}`, "bolt", 10, 10 + round)));
          if (!recorded.ok) return { pass: false, evidence: { round, recorded } };
          const stock = await api.stock({ sku: "bolt" });
          const audit = AuditSchema.parse(await api.audit());
          seen.push({ round, quantity: stock.quantity, movementCount: audit.movementCount });
          // The restart invalidates the stub above, so each round reconnects.
          await verifier.restart();
        }
        using api = await verifier.connect<StockApi>("Stock");
        const bolt = await api.stock({ sku: "bolt" });
        const audit = AuditSchema.parse(await api.audit());
        const history = z.array(MovementSchema).parse(await api.history({ sku: "bolt" }));
        return {
          pass: seen.every((entry, index) =>
            entry.quantity === 75 + 10 * (index + 1) && entry.movementCount === 5 + index) &&
            bolt.quantity === 115 && audit.movementCount === 8 && audit.reconciles &&
            history.length === 7 && history.every(entry => entry.sku === "bolt"),
          evidence: { seen, bolt, audit, historyLength: history.length },
        };
      });

      // A duplicate index kept in memory rather than storage passes the earlier check and fails this
      // one.
      await verifier.check("still-rejects-duplicates-after-a-restart", async () => {
        await verifier.restart();
        using api = await verifier.connect<StockApi>("Stock");
        const replay = OkSchema.parse(await api.record(movement("d-1", "bolt", 7, 20)));
        const audit = AuditSchema.parse(await api.audit());
        return {
          pass: !replay.ok && replay.error === "DUPLICATE_ID" &&
            audit.movementCount === 8 && audit.reconciles,
          evidence: { replay, audit },
        };
      });

      await verifier.check("stays-consistent-when-a-restart-interrupts-a-write", async () => {
        const before = await (async () => {
          using api = await verifier.connect<StockApi>("Stock");
          return AuditSchema.parse(await api.audit()).movementCount;
        })();

        const racing = await verifier.connect<StockApi>("Stock");
        // Dispatched and deliberately not awaited, so the restart lands on an unfinished write.
        const inFlight = Promise.resolve(racing.record(movement("race-1", "nut", 9, 25)))
            .catch(() => undefined);
        await verifier.restart();
        await inFlight;
        racing[Symbol.dispose]();

        using api = await verifier.connect<StockApi>("Stock");
        const audit = AuditSchema.parse(await api.audit());
        const nut = await api.stock({ sku: "nut" });
        const history = z.array(MovementSchema).parse(await api.history({ sku: "nut" }));
        const landed = audit.movementCount - before;
        // Either outcome is acceptable for the interrupted write. What must hold is that the ledger
        // still reconciles and the movement either exists whole or not at all.
        return {
          pass: audit.reconciles && (landed === 0 || landed === 1) &&
            nut.quantity === 50 + 9 * landed &&
            history.filter(entry => entry.id === "race-1").length === landed,
          evidence: { before, audit, nut, landed },
        };
      });
    },
  }],
});
