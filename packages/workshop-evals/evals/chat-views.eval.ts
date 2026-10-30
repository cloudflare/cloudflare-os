import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { asEvidence, defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";
import {
  checkAnswersInProse, checkAnswersWithView, checkBuildsGadget, checkMakesNoGadget, checkView,
  mentions, showsAmount,
} from "./views.js";

// How the agent answers in one chat (agent.ts, "Workspaces" and "Live views in your answers"): an
// explanation is prose; a chart, a choice and a one-off tool are views in the answer; data that
// must last is a Gadget; and a look at that Gadget's data is a view whose values the agent read
// with `executeCode` first, since a view has no `env`. Each view must also run, keep the view
// rules, and do what the user asked of it.

const USAGE = [
  ["Jan", 410], ["Feb", 380], ["Mar", 340], ["Apr", 300], ["May", 290], ["Jun", 360],
  ["Jul", 520], ["Aug", 610], ["Sep", 450], ["Oct", 330], ["Nov", 370], ["Dec", 430],
] as const;

// Each month by its name or the usual short form of it.
const MONTHS = [
  /\bjan(?:uary)?\b/i, /\bfeb(?:ruary)?\b/i, /\bmar(?:ch)?\b/i, /\bapr(?:il)?\b/i, /\bmay\b/i,
  /\bjune?\b/i, /\bjuly?\b/i, /\baug(?:ust)?\b/i, /\bsep(?:t|tember)?\b/i, /\boct(?:ober)?\b/i,
  /\bnov(?:ember)?\b/i, /\bdec(?:ember)?\b/i,
];

const PLANS = [
  { name: "Basic", price: 15 },
  { name: "Everyday", price: 30 },
  { name: "Streamer", price: 45 },
  { name: "Family", price: 80 },
] as const;
const PICK = "Streamer";

const BILL = 184.6;
const TIP = 0.18;
/** What each person pays, tip included, to the cent. */
const share = (people: number) => Math.round(BILL * (1 + TIP) / people * 100) / 100;

const LOG = "Expense Log";
const CATEGORIES = ["Food", "Travel", "Books"] as const;
const SEEDS = [
  { category: "Food", amount: 120, note: "groceries" },
  { category: "Travel", amount: 185, note: "train tickets" },
  { category: "Food", amount: 300, note: "restaurants" },
  { category: "Books", amount: 96, note: "novels" },
] as const;
// What the seeds add to each category.
const SEEDED = { Food: 420, Travel: 185, Books: 96 } as const;

const OkSchema = z.object({ ok: z.literal(true) });
const TotalsSchema = z.object({ byCategory: z.record(z.string(), z.number()) });

interface ExpenseApi {
  add(entry: { category: string; amount: number; note: string }): Promise<z.infer<typeof OkSchema>>;
  totals(): Promise<z.infer<typeof TotalsSchema>>;
}

async function verifyProse(verifier: EvalVerifier): Promise<void> {
  await checkAnswersInProse(verifier);
  await checkMakesNoGadget(verifier);
}

async function verifyChart(verifier: EvalVerifier): Promise<void> {
  const view = await checkAnswersWithView(verifier);
  await checkMakesNoGadget(verifier);
  if (view === undefined) return;
  await checkView(verifier, view, async rendered => {
    await verifier.check("labels-every-month", async () => {
      const shown = await rendered.waitForText(text => MONTHS.every(month => month.test(text)));
      const missing = USAGE.filter((_, index) => !MONTHS[index]?.test(shown.text)).map(([month]) => month);
      return { pass: shown.pass, evidence: asEvidence({ missing, text: shown.text }) };
    });
  });
}

async function verifyPlanPicker(verifier: EvalVerifier): Promise<void> {
  const view = await checkAnswersWithView(verifier);
  await checkMakesNoGadget(verifier);
  if (view === undefined) return;
  await checkView(verifier, view, async rendered => {
    await verifier.check("compares-every-plan", async () => {
      const shown = await rendered.waitForText(text =>
        PLANS.every(plan => mentions(text, plan.name) && showsAmount(text, plan.price)));
      return { pass: shown.pass, evidence: asEvidence({ text: shown.text }) };
    });
    await verifier.check("picking-a-plan-asks-about-it", async () => {
      const tried = await rendered.click(PICK, PLANS.map(plan => plan.name).filter(name => name !== PICK));
      return {
        pass: rendered.messages.some(message => mentions(message, PICK)),
        evidence: asEvidence({ tried, messages: rendered.messages }),
      };
    });
  });
}

async function verifyBillSplitter(verifier: EvalVerifier): Promise<void> {
  const view = await checkAnswersWithView(verifier);
  await checkMakesNoGadget(verifier);
  if (view === undefined) return;
  await checkView(verifier, view, async rendered => {
    await verifier.check("shows-each-share", async () => {
      const shown = await rendered.waitForText(text => showsAmount(text, share(4)));
      return { pass: shown.pass, evidence: asEvidence({ expected: share(4), text: shown.text }) };
    });
    await verifier.check("splits-again-for-five", async () => {
      const changed = await rendered.setValue("4", "5", text => showsAmount(text, share(5)));
      return { pass: changed.pass, evidence: asEvidence({ expected: share(5), how: changed.how, text: changed.text }) };
    });
  });
}

async function verifyExpenseLog(verifier: EvalVerifier): Promise<void> {
  await checkBuildsGadget(verifier);
  await verifier.check("records-and-totals-expenses", async () => {
    using api = await verifier.connect<ExpenseApi>(LOG);
    const before = TotalsSchema.parse(await api.totals()).byCategory;
    const added = [];
    for (const entry of SEEDS) added.push(OkSchema.safeParse(await api.add({ ...entry })).success);
    const after = TotalsSchema.parse(await api.totals()).byCategory;
    // The agent may have logged entries of its own: the seeds must add exactly their amounts.
    return {
      pass: added.every(Boolean) && CATEGORIES.every(category =>
        Math.abs((after[category] ?? 0) - (before[category] ?? 0) - SEEDED[category]) < 0.005),
      evidence: asEvidence({ added, before, after }),
    };
  });
}

async function verifySpendingView(verifier: EvalVerifier): Promise<void> {
  const view = await checkAnswersWithView(verifier);
  await checkMakesNoGadget(verifier, "makes-no-new-gadget");
  if (view === undefined) return;
  await checkView(verifier, view, async rendered => {
    await verifier.check("shows-each-category-total", async () => {
      using api = await verifier.connect<ExpenseApi>(LOG);
      const expected = TotalsSchema.parse(await api.totals()).byCategory;
      const shown = await rendered.waitForText(text => CATEGORIES.every(category =>
        mentions(text, category) && showsAmount(text, expected[category] ?? Number.NaN)));
      return { pass: shown.pass, evidence: asEvidence({ expected, text: shown.text }) };
    });
    await verifier.check("asks-about-a-category", async () => {
      const tried = await rendered.click("Travel", ["Food", "Books"]);
      return {
        pass: rendered.messages.some(message => mentions(message, "travel")),
        evidence: asEvidence({ tried, messages: rendered.messages }),
      };
    });
  });
}

const task = defineEvalTask({
  id: "chat-views",
  turns: [{
    prompt: `Why does a Durable Object lose what it keeps in memory after I deploy a new version of
my Worker?`,
    verify: verifyProse,
  }, {
    prompt: `Here's my electricity use last year, in kWh: ${
      USAGE.map(([month, kwh]) => `${month} ${kwh}`).join(", ")}. Show me how it changed over the
year.`,
    verify: verifyChart,
  }, {
    prompt: `I'm picking a phone plan. Basic is $15 a month with 5 GB of data. Everyday is $30
with 20 GB. Streamer is $45 with unlimited data and HD video. Family is $80 for 4 lines sharing
50 GB. Lay them out side by side so I can compare them, and let me pick one to ask you more
about it.`,
    verify: verifyPlanPicker,
  }, {
    prompt: `Split tonight's dinner bill: $184.60 for 4 of us, plus an 18% tip. Start with those
numbers, and let me try others.`,
    verify: verifyBillSplitter,
  }, {
    prompt: `I want to log what I spend this month and keep adding to it as I go. Name it exactly
"${LOG}" and keep the entries in its own storage, with this server RPC taking and returning plain
data:

- add({ category: string, amount: number, note: string }) -> { ok: true }
- totals() -> { byCategory: { [category: string]: number } }, the sum of the amounts in each
  category`,
    verify: verifyExpenseLog,
  }, {
    prompt: `Now show me where my money goes: each category's total, right here in the chat. Let me
click a category to ask you about it.`,
    verify: verifySpendingView,
  }],
});

defineTaskEval(task);
