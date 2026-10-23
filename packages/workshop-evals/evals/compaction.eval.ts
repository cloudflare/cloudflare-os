import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask, type EvalSkill, type EvalTurn } from "../src/task.js";
import type { EvalVerifier, VerifierChat } from "../src/verifier.js";
import { Seeded } from "./seeded.js";

// A long chat that must compact. The user states a project brief, then has the agent read batches
// of service logs from the Skills library, each with one FATAL line to find, until the prompt passes
// the compaction trigger of an admin-set budget. The logs reach the prompt as tool results, as most
// of a real chat does, so the messages compaction summarizes hold tool calls. The chat usually
// compacts after a tool step, mid-turn, but compacts as the next turn starts when a turn's final
// reply is what crosses the trigger; the checks accept both. The last turn asks for the brief from
// memory. The checks look at the Workshop's own record first -- the agent read the batches whole and
// batch 1 right, a checkpoint exists, it covers the brief, its summary keeps every fact, and it
// freed the window -- and only then at the agent's answer, so a failure says whether the model or
// compaction lost the facts.

// Far below the models' windows, yet large enough that the retained tail is a small part of it.
const BUDGET = 200_000;
// 11-17k tokens a batch, depending on the tokenizer: the batches alone pass 85% of the budget.
const BATCHES = 20;
const LINES_PER_BATCH = 280;

const FACTS = {
  codename: "HARBOR-LANTERN-27",
  cutover: "2026-11-19",
  owner: "Priya Raman",
  constraint: "ledger_entries",
};
// Ways a summary or an answer may write the cutover date, after normalize().
const CUTOVER_FORMS = ["20261119", "november192026", "nov192026", "19november2026", "19nov2026"];

const SERVICES = ["billing-api", "invoice-worker", "ledger-sync", "payments-gw", "tax-calc"];
const ROUTES = ["/v1/invoices", "/v1/charges", "/v1/refunds", "/v1/ledger", "/v1/customers"];

type Batch = { log: string; lastLine: string; fatalRequestId: string };

function generateBatches(): Batch[] {
  const random = new Seeded(20261119);
  const used = new Set<string>();
  const requestId = () => {
    let id: string;
    do {
      id = Array.from({ length: 8 }, () => random.int(0, 15).toString(16)).join("");
    } while (used.has(id));
    used.add(id);
    return id;
  };
  return Array.from({ length: BATCHES }, (_, batch) => {
    const fatalAt = random.int(LINES_PER_BATCH / 4, LINES_PER_BATCH - 1);
    let fatalRequestId = "";
    const lines = Array.from({ length: LINES_PER_BATCH }, (_line, index) => {
      const roll = random.next();
      const level = index === fatalAt ? "FATAL" : roll < 0.05 ? "ERROR" : roll < 0.15 ? "WARN" : "INFO";
      const id = requestId();
      if (level === "FATAL") fatalRequestId = id;
      const status = level === "INFO" ? 200 : level === "WARN" ? 429 : 500;
      const second = batch * LINES_PER_BATCH + index;
      const time = `2026-10-14T${String(9 + Math.floor(second / 3600)).padStart(2, "0")}:` +
        `${String(Math.floor(second / 60) % 60).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}Z`;
      return `${time} ${level.padEnd(5)} ${random.pick(SERVICES)} req=${id} ` +
        `tenant=t-${String(random.int(0, 9999)).padStart(4, "0")} route=${random.pick(ROUTES)} ` +
        `status=${status} dur=${random.int(3, 900)}ms`;
    });
    return { log: lines.join("\n"), lastLine: lines.at(-1) ?? "", fatalRequestId };
  });
}

const batches = generateBatches();
const firstFatal = batches[0]?.fatalRequestId ?? "";

function skillName(index: number): string {
  return `rehearsal-log-${String(index + 1).padStart(2, "0")}`;
}

const skills: EvalSkill[] = batches.map((batch, index) => ({
  name: skillName(index),
  description: `Batch ${index + 1} of ${BATCHES} of the billing migration rehearsal's service logs.`,
  instructions: batch.log,
}));

/** Lowercase letters and digits only, so formatting doesn't decide a match. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const expected: Record<string, readonly string[]> = {
  "codename": [normalize(FACTS.codename)],
  "cutover-date": CUTOVER_FORMS,
  "rollback-owner": [normalize(FACTS.owner)],
  "batch-1-fatal": [normalize(firstFatal)],
};

// The constraint survives only with its prohibition and its end: a clause that names the table but
// lost the "no", lifted it ("not prohibited"), or lost the "until cutover" states a different rule.
// A clause prohibits by negating migrations or by naming a ban.
const NEGATES = /\b(no|never|cannot|can't|don't|(do|must) not|not (until|before|allowed))\b/;
const BANS = /\b(forbid\w*|prohibit\w*|bans?|banned|freeze|frozen|block(s|ed)?)\b/;
const LIFTS = /\b(not|never|no longer|\w+n't)\s+(\w+\s+)?(forbidden|prohibited|banned|blocked|frozen)\b/;
const DEADLINES = [normalize("cutover"), ...CUTOVER_FORMS];

function keepsTheConstraint(text: string): boolean {
  return text.toLowerCase().split(/\n|(?<=[.;])\s/).some(clause => {
    const deadline = /\b(until|before|prior to)\b(.*)/.exec(clause)?.[2];
    return /ledger[_ ]entries/.test(clause) && /migrat|schema/.test(clause) &&
      (NEGATES.test(clause) || BANS.test(clause)) && !LIFTS.test(clause) &&
      deadline !== undefined && DEADLINES.some(form => normalize(deadline).includes(form));
  });
}

function missingFacts(text: string): string[] {
  const normalized = normalize(text);
  const missing = Object.entries(expected)
    .filter(([, forms]) => !forms.some(form => normalized.includes(form)))
    .map(([fact]) => fact);
  return keepsTheConstraint(text) ? missing : [...missing, "hard-constraint"];
}

type StepPrompt = { sequence: number; tokens: number };

/**
 * Each model request's prompt size and the agent message it produced, in order. A reconnect's
 * catch-up reports several requests as one, so it leaves a gap rather than a false size.
 */
function stepPrompts(usage: VerifierChat["usage"]): (StepPrompt | undefined)[] {
  return (usage.steps ?? []).map(step => step.modelSteps === undefined
    ? {
      sequence: step.sequence,
      tokens: step.uncachedTokens + step.cacheReadTokens + step.cacheWriteTokens,
    }
    : undefined);
}

const ignore = async () => {};

const brief = `I'm reviewing logs from our billing migration rehearsal. I added them to my Skills library as ${skillName(0)} to ${skillName(BATCHES - 1)}, one batch of service logs each, and I'll ask for them one at a time. For each, print the whole batch and read it yourself rather than searching it with code, find its single FATAL line, and reply with exactly one line: \`Batch <n> FATAL: <request id>\`. Don't read a batch before I ask for it, and don't create gadgets or change files.

Keep these project facts; I'll ask for them at the end:
- Codename: ${FACTS.codename}
- Cutover date: ${FACTS.cutover}
- Rollback owner: ${FACTS.owner}
- Hard constraint: no schema migrations on the ${FACTS.constraint} table until cutover.

Also remember batch 1's FATAL request id; I'll ask for it at the end too.

Reply "Ready" to start.`;

const batchTurns = batches.map((_batch, index): EvalTurn => ({
  prompt: `Read ${skillName(index)} and reply with exactly one line: ` +
    `\`Batch ${index + 1} FATAL: <request id>\`.`,
  verify: index > 0 ? ignore : async verifier => {
    // The recall checks expect this id, so they mean something only if the agent found it.
    await verifier.check("batch-1.finds-the-fatal", async () => ({
      pass: normalize(verifier.replies.join("\n")).includes(normalize(firstFatal)),
      evidence: { expected: firstFatal, replies: [...verifier.replies] },
    }));
  },
}));

async function verifyRecall(verifier: EvalVerifier): Promise<void> {
  const { history, compactions, usage } = verifier.chat;
  const latest = compactions.at(-1);
  const userSequences = history.flatMap(message =>
    message.type === "message" && message.author.type === "user" ? [message.sequence] : []);

  // A batch the agent filtered in code never reached the prompt, so the chat may not have grown.
  await verifier.check("batches.read-whole", async () => {
    const outputs = history.flatMap(message => message.type === "message"
      ? (message.toolCalls ?? []).flatMap(call =>
        call.toolName === "executeCode" && call.output !== undefined ? [call.output] : [])
      : []);
    const unread = batches.flatMap((batch, index) =>
      outputs.some(output => output.includes(batch.lastLine)) ? [] : [index + 1]);
    return { pass: unread.length === 0, evidence: { unread } };
  });
  await verifier.check("compaction.ran", async () => ({
    pass: latest !== undefined,
    evidence: { boundaries: compactions.map(compaction => compaction.to) },
  }));
  // The brief and batch 1's request are the first two user messages; both must lie before the
  // boundary.
  await verifier.check("compaction.covers-the-brief", async () => ({
    pass: latest !== undefined && userSequences[1] !== undefined && userSequences[1] < latest.to,
    evidence: { boundary: latest?.to ?? null, firstBatchSequence: userSequences[1] ?? null },
  }));
  await verifier.check("compaction.summary-keeps-the-facts", async () => {
    const missing = missingFacts(latest?.summary ?? "");
    return { pass: latest !== undefined && missing.length === 0, evidence: { missing } };
  });
  // The first request's prompt stands for the system prompt and tools. What the first request after
  // a compaction adds to it is the summary and the retained tail. With the 20k limit that is at most
  // about 40k (the limit, one batch over it, and the summary); a 30% share would retain more than
  // 50k.
  await verifier.check("compaction.frees-the-window", async () => {
    const prompts = stepPrompts(usage);
    const base = prompts.at(0)?.tokens;
    const retained = prompts.flatMap((prompt, index) => {
      const before = prompts[index - 1];
      return prompt !== undefined && before !== undefined && prompt.tokens < before.tokens &&
        base !== undefined ? [prompt.tokens - base] : [];
    });
    return {
      pass: retained.length > 0 && retained.every(tokens => tokens <= 45_000),
      evidence: {
        base: base ?? null, retained, prompts: prompts.map(prompt => prompt?.tokens ?? null),
      },
    };
  });

  await verifier.check("final-turn.uses-no-tools", async () => {
    const calls = verifier.messages.flatMap(message =>
      message.type === "message" ? (message.toolCalls ?? []).map(call => call.toolName) : []);
    return { pass: calls.length === 0, evidence: { calls } };
  });
  await verifier.check("recall.answers-from-memory", async () => {
    const reply = verifier.replies.join("\n");
    const missing = missingFacts(reply);
    return { pass: missing.length === 0, evidence: { missing, reply } };
  });
}

const task = defineEvalTask({
  id: "compaction",
  modelSettings: { compactionInputBudget: BUDGET },
  turns: [
    { skills, prompt: brief, verify: ignore },
    ...batchTurns,
    {
      prompt: `That was the last batch. From memory, without tools, reply with exactly these five lines:
Codename: <codename>
Cutover date: <YYYY-MM-DD>
Rollback owner: <name>
Hard constraint: <constraint>
Batch 1 FATAL: <request id>`,
      verify: verifyRecall,
    },
  ],
});

defineTaskEval(task);
