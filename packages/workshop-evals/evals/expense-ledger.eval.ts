import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

const BudgetResultSchema = z.object({ ok: z.boolean() });

const BalancesSchema = z.object({
  perPerson: z.array(z.object({ personId: z.string(), netCents: z.number().int() })),
});

const SettlementSchema = z.object({
  transfers: z.array(z.object({
    fromId: z.string(),
    toId: z.string(),
    amountCents: z.number().int().positive(),
  })),
});

const MonthlySchema = z.object({
  totalCents: z.number().int(),
  byPayer: z.array(z.object({
    personId: z.string(),
    paidCents: z.number().int(),
  })),
});

const BudgetStatusSchema = z.object({
  byCategory: z.array(z.object({
    category: z.string(),
    limitCents: z.number().int().nullable(),
    spentCents: z.number().int(),
    remainingCents: z.number().int().nullable(),
  })),
});

type Expense = {
  id: string;
  description: string;
  payerId: string;
  amountCents: number;
  splitBetween: string[];
  dateIso: string;
  category?: string;
};

interface LedgerApi {
  addExpense(input: Expense): Promise<z.infer<typeof OkSchema>>;
  balances(): Promise<z.infer<typeof BalancesSchema>>;
  settlement(): Promise<z.infer<typeof SettlementSchema>>;
  monthlyTotals(input: { month: string }): Promise<z.infer<typeof MonthlySchema>>;
}

interface BudgetedLedgerApi extends LedgerApi {
  setBudget(input: { category: string; month: string; limitCents: number }): Promise<{ ok: boolean }>;
  budgetStatus(input: { month: string }): Promise<z.infer<typeof BudgetStatusSchema>>;
}

/** Net balance for one person, or null when the ledger does not know them. */
function net(balances: z.infer<typeof BalancesSchema>, personId: string): number | null {
  return balances.perPerson.find(entry => entry.personId === personId)?.netCents ?? null;
}

function analyzeSettlement(
    balances: z.infer<typeof BalancesSchema>, settlement: z.infer<typeof SettlementSchema>) {
  const remaining = new Map(balances.perPerson.map(entry => [entry.personId, entry.netCents]));
  const knownEndpoints = settlement.transfers.every(
      transfer => remaining.has(transfer.fromId) && remaining.has(transfer.toId));
  for (const transfer of settlement.transfers) {
    remaining.set(transfer.fromId, (remaining.get(transfer.fromId) ?? 0) + transfer.amountCents);
    remaining.set(transfer.toId, (remaining.get(transfer.toId) ?? 0) - transfer.amountCents);
  }
  return {
    knownEndpoints,
    owing: balances.perPerson.filter(entry => entry.netCents !== 0).length,
    unsettled: [...remaining].filter(([, value]) => value !== 0),
  };
}

function canonicalBalances(balances: z.infer<typeof BalancesSchema>) {
  return balances.perPerson
      .map(entry => ({ personId: entry.personId, netCents: entry.netCents }))
      .toSorted((left, right) => left.personId.localeCompare(right.personId));
}

function canonicalMonthly(monthly: z.infer<typeof MonthlySchema>) {
  return {
    totalCents: monthly.totalCents,
    byPayer: monthly.byPayer.toSorted((left, right) =>
      left.personId.localeCompare(right.personId)),
  };
}

function canonicalBudgetStatus(status: z.infer<typeof BudgetStatusSchema>) {
  return status.byCategory.toSorted((left, right) =>
    left.category.localeCompare(right.category));
}

const TURN_ONE_MONTH = "2026-03";
const TURN_ONE_IDS = ["survive-1", "survive-2"];

/**
 * A shared-expense ledger, which is the archetypal thing people build on a platform like this.
 *
 * Most checks assert an invariant rather than a hand-computed constant: balances sum to zero,
 * transfers clear them, and split shares total the expense exactly. An invariant survives an
 * arithmetic slip in the task and still catches the bug it describes, such as per-share rounding that
 * loses a cent.
 */
const task = defineEvalTask({
  id: "expense-ledger",
  turns: [{
    prompt: `Build a Gadget named exactly "Ledger" for tracking shared household expenses between
flatmates and working out who owes whom. I want to add an expense, see everyone's running balance,
and get a short list of payments that settles us up.

Store all money as integer cents. Never use floating point. Keep everything in the Gadget's own
storage so nothing is lost when the server restarts.

It also needs a stable server RPC taking and returning plain data, so I can verify it:

- addExpense({ id: string, description: string, payerId: string, amountCents: integer > 0,
  splitBetween: string[], dateIso: "YYYY-MM-DD" }) -> { ok: true } | { ok: false, error: string }
  The payer paid amountCents on behalf of everyone in splitBetween, split as evenly as integer
  cents allow. When it does not divide evenly, give the leftover cents to the earliest people in
  splitBetween order, so the shares always sum to exactly amountCents.
  Reject these, changing nothing, with exactly these error codes:
    "DUPLICATE_ID"   - an expense with that id already exists
    "INVALID_AMOUNT" - amountCents is not a positive integer
    "EMPTY_SPLIT"    - splitBetween is empty
    "BAD_DATE"       - dateIso is not a YYYY-MM-DD calendar date

- balances() -> { perPerson: Array<{ personId: string, netCents: integer }> }
  netCents is positive when that person is owed money, negative when they owe it. Include everyone
  who appears in any expense as a payer or in a split.

- settlement() -> { transfers: Array<{ fromId: string, toId: string, amountCents: integer > 0 }> }
  Payments that bring every balance to zero. Keep it short: never more transfers than one fewer
  than the number of people with a non-zero balance.

- monthlyTotals({ month: "YYYY-MM" }) -> { totalCents: integer,
  byPayer: Array<{ personId: string, paidCents: integer }> }
  Counting only expenses whose dateIso falls inside that month.`,
    verify: async verifier => {
      await verifier.check("splits-leftover-cents-without-losing-any", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const emptySettlement = SettlementSchema.parse(await api.settlement());
        // 100 split three ways cannot divide evenly; flooring each share would lose a cent.
        const added = await api.addExpense({
          id: "cents-1",
          description: "Milk",
          payerId: "cents-ana",
          amountCents: 100,
          splitBetween: ["cents-ana", "cents-ben", "cents-cy"],
          dateIso: "2026-05-04",
        });
        const nonLexical = OkSchema.parse(await api.addExpense({
          id: "cents-order",
          description: "Order-sensitive split",
          payerId: "order-z",
          amountCents: 5,
          splitBetween: ["order-z", "order-a"],
          dateIso: "2026-05-04",
        }));
        const balances = BalancesSchema.parse(await api.balances());
        const trio = ["cents-ana", "cents-ben", "cents-cy"].map(id => net(balances, id));
        const [ana, ben, cy] = trio;
        return {
          pass: emptySettlement.transfers.length === 0 && OkSchema.parse(added).ok &&
            nonLexical.ok &&
            // Ana paid 100 and owes the first, largest share of 34, leaving her owed 66. Flooring
            // every share to 33 would lose a cent and show up as a 65/-33/-33 that does not balance.
            ana === 66 && ben === -33 && cy === -33 &&
            trio.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0) === 0 &&
            net(balances, "order-z") === 2 && net(balances, "order-a") === -2,
          evidence: { emptySettlement, ana, ben, cy, nonLexical },
        };
      });

      await verifier.check("balances-always-sum-to-zero", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const added = [
          await api.addExpense({
            id: "sum-1",
            description: "Rent",
            payerId: "sum-ana",
            amountCents: 133_337,
            splitBetween: ["sum-ana", "sum-ben", "sum-cy", "sum-dee"],
            dateIso: "2026-05-01",
          }),
          await api.addExpense({
            id: "sum-2",
            description: "Wifi",
            payerId: "sum-ben",
            amountCents: 4_999,
            splitBetween: ["sum-ben", "sum-cy"],
            dateIso: "2026-05-02",
          }),
          await api.addExpense({
            id: "sum-3",
            description: "Cleaner",
            payerId: "sum-cy",
            amountCents: 7,
            splitBetween: ["sum-ana", "sum-ben", "sum-cy", "sum-dee"],
            dateIso: "2026-05-03",
          }),
          await api.addExpense({
            id: "sum-outside-payer",
            description: "Shared supplies",
            payerId: "outside-payer",
            amountCents: 101,
            splitBetween: ["outside-ana", "outside-ben"],
            dateIso: "2026-05-03",
          }),
        ];
        const balances = BalancesSchema.parse(await api.balances());
        const expectedPeople = [
          "sum-ana", "sum-ben", "sum-cy", "sum-dee",
          "outside-payer", "outside-ana", "outside-ben",
        ];
        const missingPeople = expectedPeople.filter(personId => net(balances, personId) === null);
        const expectedBalances = {
          "sum-ana": 100_000,
          "sum-ben": -30_837,
          "sum-cy": -35_828,
          "sum-dee": -33_335,
        };
        const wrongBalances = Object.entries(expectedBalances)
          .filter(([personId, expected]) => net(balances, personId) !== expected);
        const total = balances.perPerson.reduce((sum, entry) => sum + entry.netCents, 0);
        return {
          pass: added.every(result => OkSchema.parse(result).ok) &&
            missingPeople.length === 0 && wrongBalances.length === 0 && total === 0 &&
            net(balances, "outside-payer") === 101 &&
            net(balances, "outside-ana") === -51 && net(balances, "outside-ben") === -50 &&
            balances.perPerson.every(entry => Number.isInteger(entry.netCents)),
          evidence: { total, missingPeople, wrongBalances, perPerson: balances.perPerson },
        };
      });

      await verifier.check("settlement-clears-every-balance-and-stays-short", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const balances = BalancesSchema.parse(await api.balances());
        const mayBefore = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-05" }));
        const settlement = SettlementSchema.parse(await api.settlement());
        const analysis = analyzeSettlement(balances, settlement);
        const balancesAfter = BalancesSchema.parse(await api.balances());
        const mayAfter = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-05" }));
        const unchanged = JSON.stringify(canonicalBalances(balances)) ===
            JSON.stringify(canonicalBalances(balancesAfter)) &&
          JSON.stringify(canonicalMonthly(mayBefore)) === JSON.stringify(canonicalMonthly(mayAfter));
        return {
          pass: analysis.owing >= 2 && settlement.transfers.length >= 1 &&
            analysis.knownEndpoints && analysis.unsettled.length === 0 && unchanged &&
            settlement.transfers.length <= analysis.owing - 1 &&
            settlement.transfers.every(transfer => transfer.fromId !== transfer.toId),
          evidence: {
            transfers: settlement.transfers.length,
            owing: analysis.owing,
            knownEndpoints: analysis.knownEndpoints,
            unsettled: Object.fromEntries(analysis.unsettled),
            unchanged,
          },
        };
      });

      await verifier.check("rejects-bad-input-with-named-codes", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const valid: Expense = {
          id: "reject-1",
          description: "Beer",
          payerId: "reject-ana",
          amountCents: 500,
          splitBetween: ["reject-ana", "reject-ben"],
          dateIso: "2026-05-05",
        };
        const accepted = OkSchema.parse(await api.addExpense(valid));
        const before = BalancesSchema.parse(await api.balances());
        const rejections = [
          { expected: "DUPLICATE_ID", result: OkSchema.parse(
            await api.addExpense({ ...valid, amountCents: 999 })) },
          { expected: "INVALID_AMOUNT", result: OkSchema.parse(
            await api.addExpense({ ...valid, id: "reject-2", amountCents: 0 })) },
          { expected: "INVALID_AMOUNT", result: OkSchema.parse(
            await api.addExpense({ ...valid, id: "reject-5", amountCents: 1.5 })) },
          { expected: "EMPTY_SPLIT", result: OkSchema.parse(
            await api.addExpense({ ...valid, id: "reject-3", splitBetween: [] })) },
          { expected: "BAD_DATE", result: OkSchema.parse(
            await api.addExpense({ ...valid, id: "reject-4", dateIso: "2026-02-31" })) },
        ];
        const afterRejections = BalancesSchema.parse(await api.balances());
        const corrected = (await Promise.all([
          api.addExpense({ ...valid, id: "reject-2", amountCents: 200 }),
          api.addExpense({ ...valid, id: "reject-3" }),
          api.addExpense({ ...valid, id: "reject-4" }),
          api.addExpense({ ...valid, id: "reject-5", amountCents: 1 }),
        ])).map(result => OkSchema.parse(result));
        const wrong = rejections.filter(
            ({ expected, result }) => result.ok || result.error !== expected);
        const unchanged = JSON.stringify(canonicalBalances(before)) ===
          JSON.stringify(canonicalBalances(afterRejections));
        return {
          pass: accepted.ok && wrong.length === 0 && unchanged &&
            corrected.every(result => result.ok),
          evidence: { wrong, unchanged, corrected },
        };
      });

      await verifier.check("monthly-totals-count-only-that-month", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const added = [
          await api.addExpense({
            id: TURN_ONE_IDS[0] ?? "survive-1",
            description: "March groceries",
            payerId: "month-ana",
            amountCents: 2_500,
            splitBetween: ["month-ana", "month-ben"],
            dateIso: `${TURN_ONE_MONTH}-05`,
          }),
          await api.addExpense({
            id: TURN_ONE_IDS[1] ?? "survive-2",
            description: "March taxi",
            payerId: "month-ben",
            amountCents: 1_200,
            splitBetween: ["month-ana", "month-ben"],
            dateIso: `${TURN_ONE_MONTH}-31`,
          }),
          await api.addExpense({
            id: "month-outside",
            description: "April rent",
            payerId: "month-ana",
            amountCents: 90_000,
            splitBetween: ["month-ana", "month-ben"],
            dateIso: "2026-04-01",
          }),
        ];
        const duplicateInputs: Expense[] = [{
          id: "month-race",
          description: "April supplies",
          payerId: "race-ana",
          amountCents: 1_000,
          splitBetween: ["race-ana", "race-ben"],
          dateIso: "2026-04-02",
        }, {
          id: "month-race",
          description: "April replacement",
          payerId: "race-ben",
          amountCents: 2_000,
          splitBetween: ["race-ana", "race-ben"],
          dateIso: "2026-04-03",
        }];
        const duplicateRace = (await Promise.all(
            duplicateInputs.map(input => api.addExpense(input))))
          .map(result => OkSchema.parse(result));
        const winnerIndex = duplicateRace.findIndex(result => result.ok);
        const winner = duplicateInputs.at(winnerIndex);
        const march = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        const april = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-04" }));
        const empty = MonthlySchema.parse(await api.monthlyTotals({ month: "2025-12" }));
        const marchPaid = (personId: string) =>
          march.byPayer.find(entry => entry.personId === personId)?.paidCents ?? null;
        const aprilPaid = (personId: string) =>
          april.byPayer.find(entry => entry.personId === personId)?.paidCents ?? null;
        return {
          pass: added.every(result => OkSchema.parse(result).ok) &&
            duplicateRace.filter(result => result.ok).length === 1 &&
            duplicateRace.filter(result => !result.ok && result.error === "DUPLICATE_ID").length === 1 &&
            march.totalCents === 3_700 &&
            marchPaid("month-ana") === 2_500 && marchPaid("month-ben") === 1_200 &&
            winner !== undefined && april.totalCents === 90_000 + winner.amountCents &&
            aprilPaid("month-ana") === 90_000 &&
            aprilPaid(winner.payerId) === winner.amountCents &&
            empty.totalCents === 0 && empty.byPayer.length === 0,
          evidence: { march, april, empty, duplicateRace, winner: winner ?? null },
        };
      });
    },
    verifyAfterAccept: async verifier => {
      await verifier.check("turn-one-state-survives-code-reload", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const march = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        const duplicate = OkSchema.parse(await api.addExpense({
          id: TURN_ONE_IDS[0] ?? "survive-1",
          description: "Replay after reload",
          payerId: "month-ana",
          amountCents: 1,
          splitBetween: ["month-ana"],
          dateIso: `${TURN_ONE_MONTH}-05`,
        }));
        const balances = BalancesSchema.parse(await api.balances());
        const settlement = SettlementSchema.parse(await api.settlement());
        const analysis = analyzeSettlement(balances, settlement);
        return {
          pass: march.totalCents === 3_700 && !duplicate.ok &&
            duplicate.error === "DUPLICATE_ID" &&
            net(balances, "month-ana") === 45_650 && net(balances, "month-ben") === -45_650 &&
            settlement.transfers.length > 0 && analysis.knownEndpoints &&
            analysis.unsettled.length === 0,
          evidence: { march, duplicate, balances, settlement, analysis },
        };
      });
    },
  }, {
    prompt: `Now I want to see where the money actually goes. Add to the same Gadget:

- addExpense takes an optional category: string. Expenses recorded before this change, and any
  added without one, count as "uncategorized".
- setBudget({ category: string, month: "YYYY-MM", limitCents: integer >= 0 }) -> { ok: boolean }.
  Setting the same category and month again replaces the previous limit.
- budgetStatus({ month: "YYYY-MM" }) -> { byCategory: Array<{ category: string,
  limitCents: integer | null, spentCents: integer, remainingCents: integer | null }> }
  One row per category that either has a budget for that month or had spending in it. Spending
  counts the full expense amount against the month its dateIso falls in. limitCents and
  remainingCents are null when no budget is set. remainingCents is limitCents - spentCents and is
  allowed to go negative.

Everything that already worked must keep working, including the expenses I have already recorded.`,
    verify: async verifier => {
      // Accepting turn one bumps the loader version before this prompt. Missing March rows were not
      // stored durably.
      await verifier.check("expenses-recorded-before-the-change-survive", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const march = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        return {
          pass: march.totalCents === 3_700,
          evidence: march,
        };
      });

      await verifier.check("pre-existing-spending-counts-as-uncategorized", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const status = BudgetStatusSchema.parse(await api.budgetStatus({ month: TURN_ONE_MONTH }));
        const uncategorized = status.byCategory.find(row => row.category === "uncategorized");
        return {
          pass: uncategorized?.spentCents === 3_700 && uncategorized.limitCents === null &&
            uncategorized.remainingCents === null,
          evidence: status,
        };
      });

      await verifier.check("budget-remaining-tracks-spending-and-can-go-negative", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const initialFood = BudgetResultSchema.parse(
            await api.setBudget({ category: "food", month: "2026-06", limitCents: 10_000 }));
        const budgets = [initialFood, ...(await Promise.all([
          api.setBudget({ category: "food", month: "2026-06", limitCents: 5_000 }),
          api.setBudget({ category: "food", month: "2026-07", limitCents: 8_000 }),
          api.setBudget({ category: "travel", month: "2026-06", limitCents: 20_000 }),
          api.setBudget({ category: "savings", month: "2026-06", limitCents: 30_000 }),
        ])).map(result => BudgetResultSchema.parse(result))];
        const added = (await Promise.all([
          api.addExpense({
            id: "budget-1", description: "Market", payerId: "budget-ana",
            amountCents: 6_500, splitBetween: ["budget-ana", "budget-ben"],
            dateIso: "2026-06-02", category: "food",
          }),
          api.addExpense({
            id: "budget-2", description: "Train", payerId: "budget-ben",
            amountCents: 4_000, splitBetween: ["budget-ana", "budget-ben"],
            dateIso: "2026-06-03", category: "travel",
          }),
          api.addExpense({
            id: "budget-3", description: "Soap", payerId: "budget-ana",
            amountCents: 100, splitBetween: ["budget-ana", "budget-ben"],
            dateIso: "2026-06-04",
          }),
        ])).map(result => OkSchema.parse(result));
        const june = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-06" }));
        const july = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-07" }));
        const monthlyBefore = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-06" }));
        const balancesBefore = BalancesSchema.parse(await api.balances());
        const settlement = SettlementSchema.parse(await api.settlement());
        const analysis = analyzeSettlement(balancesBefore, settlement);
        const monthlyAfter = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-06" }));
        const balancesAfter = BalancesSchema.parse(await api.balances());
        const juneAfter = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-06" }));
        const julyAfter = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-07" }));
        const juneRow = (category: string) =>
          june.byCategory.find(entry => entry.category === category);
        const julyFood = july.byCategory.find(entry => entry.category === "food");
        const junePaid = (personId: string) =>
          monthlyBefore.byPayer.find(entry => entry.personId === personId)?.paidCents ?? null;
        const uniqueCategories = june.byCategory.length === 4 && july.byCategory.length === 1 &&
          new Set(june.byCategory.map(entry => entry.category)).size === june.byCategory.length &&
          new Set(july.byCategory.map(entry => entry.category)).size === july.byCategory.length;
        const unchanged = JSON.stringify(canonicalMonthly(monthlyBefore)) ===
            JSON.stringify(canonicalMonthly(monthlyAfter)) &&
          JSON.stringify(canonicalBalances(balancesBefore)) ===
            JSON.stringify(canonicalBalances(balancesAfter)) &&
          JSON.stringify(canonicalBudgetStatus(june)) ===
            JSON.stringify(canonicalBudgetStatus(juneAfter)) &&
          JSON.stringify(canonicalBudgetStatus(july)) ===
            JSON.stringify(canonicalBudgetStatus(julyAfter));
        return {
          pass: budgets.every(result => result.ok) && added.every(result => result.ok) &&
            uniqueCategories &&
            juneRow("food")?.limitCents === 5_000 && juneRow("food")?.spentCents === 6_500 &&
            juneRow("food")?.remainingCents === -1_500 &&
            juneRow("travel")?.limitCents === 20_000 && juneRow("travel")?.spentCents === 4_000 &&
            juneRow("travel")?.remainingCents === 16_000 &&
            juneRow("savings")?.limitCents === 30_000 && juneRow("savings")?.spentCents === 0 &&
            juneRow("savings")?.remainingCents === 30_000 &&
            juneRow("uncategorized")?.limitCents === null &&
            juneRow("uncategorized")?.spentCents === 100 &&
            julyFood?.limitCents === 8_000 && julyFood.spentCents === 0 &&
            julyFood.remainingCents === 8_000 &&
            monthlyBefore.totalCents === 10_600 &&
            junePaid("budget-ana") === 6_600 && junePaid("budget-ben") === 4_000 &&
            net(balancesBefore, "budget-ana") === 1_300 &&
            net(balancesBefore, "budget-ben") === -1_300 &&
            analysis.knownEndpoints && analysis.unsettled.length === 0 && unchanged,
          evidence: {
            budgets, added, june, july, monthlyBefore, balancesBefore, settlement,
            juneAfter, julyAfter, uniqueCategories, unchanged,
          },
        };
      });

      await verifier.check("turn-one-contract-still-holds", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const duplicate = OkSchema.parse(await api.addExpense({
          id: TURN_ONE_IDS[0] ?? "survive-1",
          description: "Replay",
          payerId: "after-ana",
          amountCents: 111,
          splitBetween: ["after-ana", "after-ben"],
          dateIso: "2026-06-09",
        }));
        const balances = BalancesSchema.parse(await api.balances());
        const settlement = SettlementSchema.parse(await api.settlement());
        const analysis = analyzeSettlement(balances, settlement);
        const total = balances.perPerson.reduce((sum, entry) => sum + entry.netCents, 0);
        return {
          pass: !duplicate.ok && duplicate.error === "DUPLICATE_ID" &&
            net(balances, "month-ana") === 45_650 && net(balances, "month-ben") === -45_650 &&
            total === 0 && settlement.transfers.length > 0 &&
            analysis.knownEndpoints && analysis.unsettled.length === 0,
          evidence: { duplicate, total, balances, settlement, analysis },
        };
      });
    },
    verifyAfterAccept: async verifier => {
      await verifier.check("turn-two-state-survives-code-reload", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const june = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-06" }));
        const july = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-07" }));
        const juneTotals = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-06" }));
        const marchTotals = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        const balances = BalancesSchema.parse(await api.balances());
        const settlement = SettlementSchema.parse(await api.settlement());
        const analysis = analyzeSettlement(balances, settlement);
        const juneAfter = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-06" }));
        const julyAfter = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-07" }));
        const juneTotalsAfter = MonthlySchema.parse(await api.monthlyTotals({ month: "2026-06" }));
        const balancesAfter = BalancesSchema.parse(await api.balances());
        const unchanged = JSON.stringify(canonicalBudgetStatus(june)) ===
            JSON.stringify(canonicalBudgetStatus(juneAfter)) &&
          JSON.stringify(canonicalBudgetStatus(july)) ===
            JSON.stringify(canonicalBudgetStatus(julyAfter)) &&
          JSON.stringify(canonicalMonthly(juneTotals)) ===
            JSON.stringify(canonicalMonthly(juneTotalsAfter)) &&
          JSON.stringify(canonicalBalances(balances)) ===
            JSON.stringify(canonicalBalances(balancesAfter));
        const uniqueCategories = june.byCategory.length === 4 && july.byCategory.length === 1 &&
          new Set(june.byCategory.map(entry => entry.category)).size === june.byCategory.length &&
          new Set(july.byCategory.map(entry => entry.category)).size === july.byCategory.length;
        const juneRow = (category: string) =>
          june.byCategory.find(entry => entry.category === category);
        const julyFood = july.byCategory.find(entry => entry.category === "food");
        return {
          pass: uniqueCategories &&
            juneRow("food")?.limitCents === 5_000 && juneRow("food")?.spentCents === 6_500 &&
            juneRow("travel")?.limitCents === 20_000 && juneRow("travel")?.spentCents === 4_000 &&
            juneRow("savings")?.limitCents === 30_000 && juneRow("savings")?.spentCents === 0 &&
            juneRow("uncategorized")?.spentCents === 100 &&
            julyFood?.limitCents === 8_000 && julyFood.spentCents === 0 &&
            juneTotals.totalCents === 10_600 && marchTotals.totalCents === 3_700 &&
            net(balances, "budget-ana") === 1_300 && net(balances, "budget-ben") === -1_300 &&
            analysis.knownEndpoints && analysis.unsettled.length === 0 && unchanged,
          evidence: {
            june, july, juneTotals, marchTotals, balances, settlement,
            juneAfter, julyAfter, juneTotalsAfter, balancesAfter, uniqueCategories, unchanged,
          },
        };
      });
    },
  }],
});

defineTaskEval(task);
