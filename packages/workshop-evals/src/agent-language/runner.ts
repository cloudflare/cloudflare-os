import { getEncoding } from "js-tiktoken";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL, URL } from "node:url";
import { tasks, verify, typescript, bamlTypes, callbackSignatures, type Task } from "./tasks.ts";
import { validate, declarations, type Variant } from "./compiler.ts";
import { execute } from "./runtime.ts";
import { faults, faultProgram, faultTask, bamlFaults, bamlFaultProgram } from "./faults.ts";
export const MAX_REPAIRS = 2;
export async function attempt(task: Task, source: string, variant: Variant) {
  const started = performance.now();
  const checked =
    variant === "baml"
      ? { diagnostics: [] as string[], javascript: source, validationMs: 0 }
      : validate(source, variant);
  if (checked.diagnostics.length)
    return {
      outcome: "rejected-before-execution",
      success: false,
      diagnostics: checked.diagnostics,
      validationMs: checked.validationMs,
      totalMs: performance.now() - started,
    };
  const runtime = await execute(checked.javascript, variant === "baml", task.bindings);
  const success = verify(task, runtime);
  const outcome = runtime.error
    ? runtime.stage === "compile"
      ? "rejected-before-execution"
      : "failed-during-execution"
    : success
      ? "completed-correctly"
      : ((runtime.state as { reports?: unknown[] })?.reports ?? []).some(
            (value) => value === "success",
          )
        ? "claimed-success-incorrect"
        : "completed-incorrectly";
  return {
    outcome,
    success,
    diagnostics: runtime.error ? [runtime.error] : [],
    validationMs: checked.validationMs,
    ...runtime,
    totalMs: performance.now() - started,
  };
}
export async function repairLoop(
  task: Task,
  initial: string,
  variant: Variant,
  repair: (source: string, diagnostics: string[], n: number) => Promise<string>,
) {
  let source = initial;
  const attempts = [];
  for (let n = 0; n <= MAX_REPAIRS; n++) {
    const result = await attempt(task, source, variant);
    attempts.push({ source, ...result });
    if (result.success || n === MAX_REPAIRS) break;
    source = await repair(
      source,
      result.diagnostics.length
        ? result.diagnostics
        : [
            "Program ran but the external functional result/state check failed. Recheck the task requirements.",
          ],
      n + 1,
    );
  }
  return attempts;
}
const bamlDocs = `BAML v1 agent language (bridge 0.23.0): ordinary functions use function Name(arg: Type) -> ReturnType { ... }. Last expression is returned; explicit return is also supported. let declares mutable locals. Loops use for (let x in xs) { ... }. Arrays have push() and length() (a method, not a property). Strings have length(). Classes use class Name { field Type } and literals Name {field:value}; fields are nominally typed. Nullable types use T?; bind a nullable member to a local before narrowing with if (local == null). Unions narrow with x is ClassName. Host callbacks are colorless: call them directly without await, even when the host is async. Concurrency: let f = spawn { work() }; await f;. Errors have throws clauses and catch handlers. No any or unsafe casts. All tool classes are provided below; do not redefine them. Return only the Main function (plus helpers if needed). No clients, network or filesystem. The list callback returns QueryResult with items (bridge envelope); JS list returns the items directly.\n${bamlTypes}`;
export function prompt(task: Task, variant: Variant) {
  const common =
    "Write a complete program, code only, no Markdown. Use the supplied synthetic tools when required. Return the requested value. Writes permitted only to ticket a. Fresh state: tickets a/high/3/2026-10-01/owner Ada, b/low/5/2026-10-02/no owner, c/high/7/2026-10-03/no owner; all open; counter 0. No network or imports. No check suppression, casts, any, non-null assertions.\n";
  const docs =
    variant === "baml"
      ? bamlDocs +
        `\nUse this exact parameter list for Main, choosing the appropriate return type: function Main(${Object.entries(
          callbackSignatures,
        )
          .map(([k, t]) => k + ": " + t)
          .join(", ")}) -> YOUR_RETURN_TYPE { ... }.`
      : declarations +
        `\nUse export default async function(self${variant === "ts" ? ": Self" : ""}, env${variant === "ts" ? ": Env" : ""}, ctx${variant === "ts" ? ": Context" : ""}) { ... }. ${variant === "ts" ? "Strict TypeScript." : "Ordinary JavaScript; host supplies parameter types separately."}`;
  return { text: common + docs + "\nTask: " + task.prompt, docs };
}
const tokenizer = getEncoding("o200k_base");
const prices: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-5.4-2026-03-05": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini-2026-03-17": { input: 0.75, cached: 0.075, output: 4.5 },
};
export async function main() {
  const mode = process.argv[2] ?? "deterministic";
  const out = process.argv[3] ?? "results/agent-language";
  await mkdir(out, { recursive: true });
  // Refuse overwrites, including an interrupted/uncertain billing ledger.
  await writeFile(
    `${out}/manifest.json`,
    JSON.stringify(
      {
        mode,
        created: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        models: Object.keys(prices),
        prices,
        capUsd: 10,
        maxRepairs: MAX_REPAIRS,
        maxOutputTokens: 8192,
        sourceHash: createHash("sha256")
          .update(await readFile(new URL("./tasks.ts", import.meta.url)))
          .digest("hex"),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const emit = async (row: unknown) => appendFile(`${out}/runs.jsonl`, JSON.stringify(row) + "\n");
  if (mode === "deterministic") {
    for (const variant of ["js", "checkjs", "ts", "baml"] as const)
      for (const task of tasks) {
        const source =
          variant === "baml" ? task.baml : variant === "ts" ? typescript(task.js) : task.js;
        await emit({
          kind: "reference",
          variant,
          task: task.id,
          source,
          ...(await attempt(task, source, variant)),
        });
      }
    for (const variant of ["js", "checkjs", "ts", "baml"] as const)
      for (const [id, task, body] of faults) {
        const source =
          variant === "baml"
            ? bamlFaultProgram(task, bamlFaults[id])
            : faultProgram(body, variant === "ts");
        await emit({
          kind: "fault",
          variant,
          task,
          id,
          source,
          ...(await attempt(faultTask(task), source, variant)),
        });
      }
    return;
  }
  if (mode === "dry-run") {
    for (const variant of ["js", "checkjs", "ts", "baml"] as const)
      for (const task of tasks)
        await emit({ kind: "prompt", variant, task: task.id, ...prompt(task, variant) });
    return;
  }
  if (mode !== "pilot") throw Error("Expected deterministic, dry-run or pilot");
  if (!process.env.OPENAI_API_KEY) throw Error("OPENAI_API_KEY unavailable");
  const ledger = {
    spentEstimatedUsd: 0,
    priorPilotReserveUsd: 0.5,
    reservedUsd: 0,
    unknownCharges: false,
    calls: 0,
  };
  const save = () => writeFile(`${out}/spend.json`, JSON.stringify(ledger, null, 2));
  await save();
  async function generate(model: string, text: string) {
    const p = prices[model];
    const reserve = ((Buffer.byteLength(text) + 1024) * p.input) / 1e6 + (8192 * p.output) / 1e6;
    if (
      ledger.unknownCharges ||
      ledger.spentEstimatedUsd + ledger.priorPilotReserveUsd + reserve > 10
    )
      throw Error("budget_exhausted");
    ledger.reservedUsd = reserve;
    await save();
    const start = performance.now();
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: text,
          max_output_tokens: 8192,
          reasoning: { effort: "low" },
          service_tier: "default",
          store: false,
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      ledger.unknownCharges = true;
      await save();
      throw e;
    }
    if (!response.ok) {
      ledger.unknownCharges = response.status >= 500;
      ledger.reservedUsd = ledger.unknownCharges ? reserve : 0;
      await save();
      throw Error(`provider ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const body = (await response.json()) as {
      id: string;
      status: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        input_tokens_details: { cached_tokens: number };
      };
      output: { type: string; content: { type: string; text: string }[] }[];
    };
    const usage = body.usage;
    if (!usage) {
      ledger.unknownCharges = true;
      await save();
      throw Error("missing provider usage");
    }
    const cost =
      ((usage.input_tokens - usage.input_tokens_details.cached_tokens) * p.input +
        usage.input_tokens_details.cached_tokens * p.cached +
        usage.output_tokens * p.output) /
      1e6;
    ledger.spentEstimatedUsd += cost;
    ledger.reservedUsd = 0;
    ledger.calls++;
    await save();
    const source = body.output
      .filter((x: { type: string }) => x.type === "message")
      .flatMap((x: { content: { type: string; text?: string }[] }) => x.content)
      .filter((x: { type: string }) => x.type === "output_text")
      .map((x) => x.text ?? "")
      .join("\n")
      .replace(/^```\w*\n|\n```$/g, "")
      .trim();
    const measurement = {
      source,
      usage,
      costEstimatedUsd: cost,
      generationMs: performance.now() - start,
      providerResponseId: body.id,
      status: body.status,
    };
    await appendFile(
      `${out}/calls.jsonl`,
      JSON.stringify({ model, prompt: text, ...measurement }) + "\n",
    );
    return measurement;
  }
  try {
    for (let trial = 1; trial <= 3; trial++)
      for (const task of tasks)
        for (const model of Object.keys(prices)) {
          let paired: Awaited<ReturnType<typeof generate>> | undefined;
          for (const variant of ["js", "checkjs", "ts", "baml"] as const) {
            const p = prompt(task, variant);
            const initial = variant === "checkjs" ? paired! : await generate(model, p.text);
            if (variant === "js") paired = initial;
            const calls = [initial];
            const prepare = (s: string) => (variant === "baml" ? bamlTypes + s : s);
            const attempts = await repairLoop(
              task,
              prepare(initial.source),
              variant,
              async (source, diagnostics) => {
                const g = await generate(
                  model,
                  p.text +
                    "\nPrevious program:\n" +
                    source +
                    "\nDiagnostics:\n" +
                    diagnostics.join("\n") +
                    "\nReturn the corrected complete program.",
                );
                calls.push(g);
                return prepare(g.source);
              },
            );
            await emit({
              kind: "model",
              model,
              task: task.id,
              variant,
              trial,
              pairedInitial: variant === "checkjs",
              documentationCharacters: p.docs.length,
              documentationTokens: tokenizer.encode(p.docs).length,
              documentationTokenNote:
                "o200k_base estimate for documentation only; full prompt tokens from provider",
              calls,
              attempts,
              success: attempts.at(-1)!.success,
            });
            console.log(
              model,
              task.id,
              trial,
              variant,
              attempts.at(-1)!.outcome,
              ledger.spentEstimatedUsd.toFixed(4),
            );
          }
        }
  } catch (e) {
    await writeFile(`${out}/STOP.json`, JSON.stringify({ error: String(e), ...ledger }, null, 2));
    console.error(String(e));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
