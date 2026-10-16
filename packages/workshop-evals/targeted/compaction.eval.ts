import { Seeded } from "../evals/seeded.js";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask, type EvalTurn } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

// A long chat that must compact. The user states a project brief, then pastes batches of service
// logs, each with one FATAL line to find, until the prompt passes the compaction trigger of an
// admin-set budget. The last turn asks for the brief from memory. The checks look at the Workshop's
// own record first -- the agent read batch 1 right, a checkpoint exists, it covers the brief, its
// summary keeps every fact, and it freed the window -- and only then at the agent's answer, so a
// failure says whether the model or compaction lost the facts.

// Far below either model's window, yet large enough that the retained tail is a small part of it.
const BUDGET = 200_000;
// 8-11k tokens a batch, depending on the tokenizer: the batches alone pass 85% of the budget.
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

type Batch = { log: string; fatalRequestId: string };

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
    return { log: lines.join("\n"), fatalRequestId };
  });
}

const batches = generateBatches();
const firstFatal = batches[0]?.fatalRequestId ?? "";

/** Lowercase letters and digits only, so formatting doesn't decide a match. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const expected: Record<string, readonly string[]> = {
  "codename": [normalize(FACTS.codename)],
  "cutover-date": CUTOVER_FORMS,
  "rollback-owner": [normalize(FACTS.owner)],
  "hard-constraint": [normalize(FACTS.constraint)],
  "batch-1-fatal": [normalize(firstFatal)],
};

function missingFacts(text: string): string[] {
  const normalized = normalize(text);
  return Object.entries(expected)
    .filter(([, forms]) => !forms.some(form => normalized.includes(form)))
    .map(([fact]) => fact);
}

const ignore = async () => {};

const brief = `I'm reviewing logs from our billing migration rehearsal. Over the next messages I'll paste ${BATCHES} batches of service logs. For each batch, find the single FATAL line and reply with exactly one line: \`Batch <n> FATAL: <request id>\`. Work from the text I paste: don't run code, use tools, or create gadgets.

Keep these project facts; I'll ask for them at the end:
- Codename: ${FACTS.codename}
- Cutover date: ${FACTS.cutover}
- Rollback owner: ${FACTS.owner}
- Hard constraint: no schema migrations on the ${FACTS.constraint} table until cutover.

Also remember batch 1's FATAL request id; I'll ask for it at the end too.

Reply "Ready" to start.`;

const batchTurns = batches.map((batch, index): EvalTurn => ({
  prompt: `Batch ${index + 1} of ${BATCHES}:\n\`\`\`\n${batch.log}\n\`\`\`\n` +
    `Reply with exactly one line: \`Batch ${index + 1} FATAL: <request id>\`.`,
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
  // The brief and batch 1 are the first two user messages; both must lie before the boundary.
  const firstBatch = history.filter(message =>
    message.type === "message" && message.author.type === "user").at(1);

  await verifier.check("compaction.ran", async () => ({
    pass: latest !== undefined,
    evidence: { boundaries: compactions.map(compaction => compaction.to) },
  }));
  await verifier.check("compaction.covers-the-brief", async () => ({
    pass: latest !== undefined && firstBatch !== undefined && firstBatch.sequence < latest.to,
    evidence: { boundary: latest?.to ?? null, firstBatchSequence: firstBatch?.sequence ?? null },
  }));
  await verifier.check("compaction.summary-keeps-the-facts", async () => {
    const missing = missingFacts(latest?.summary ?? "");
    return { pass: latest !== undefined && missing.length === 0, evidence: { missing } };
  });

  // The prompt of the first step stands for the system prompt and tools. The step after a drop in
  // prompt size is the first after a compaction; what it adds to that base is the summary and the
  // retained tail. With the 20k limit that is at most about 35k (limit, one batch over it, and the
  // summary); a 30% share would retain more than 50k.
  await verifier.check("compaction.frees-the-window", async () => {
    const prompts = (usage.steps ?? []).map(step => step.modelSteps === undefined
      ? step.uncachedTokens + step.cacheReadTokens + step.cacheWriteTokens
      : undefined);
    const base = prompts.at(0);
    const retained = prompts.flatMap((prompt, index) => {
      const before = prompts[index - 1];
      return prompt !== undefined && before !== undefined && prompt < before && base !== undefined
        ? [prompt - base] : [];
    });
    return {
      pass: retained.length > 0 && retained.every(tokens => tokens <= BUDGET * 0.2),
      evidence: { base: base ?? null, retained, prompts: prompts.map(prompt => prompt ?? null) },
    };
  });

  const lastPrompt = history.findLast(message =>
    message.type === "message" && message.author.type === "user");
  await verifier.check("final-turn.uses-no-tools", async () => {
    const calls = history.flatMap(message => lastPrompt !== undefined &&
        message.sequence > lastPrompt.sequence && message.type === "message"
      ? (message.toolCalls ?? []).map(call => call.toolName) : []);
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
    { prompt: brief, verify: ignore },
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
