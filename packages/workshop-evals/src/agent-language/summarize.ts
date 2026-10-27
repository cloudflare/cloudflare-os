import { readFile, writeFile, mkdir } from "node:fs/promises";
const root = process.argv[2] ?? "../../docs/research/agent-language-data";
async function rows(dir: string) {
  try {
    return (await readFile(`${root}/${dir}/runs.jsonl`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch {
    return [];
  }
}
const deterministic = await rows("deterministic"),
  pilot = await rows("pilot");
export function wilson(k: number, n: number) {
  if (!n) return null;
  const z = 1.96,
    d = 1 + (z * z) / n,
    c = (k / n + (z * z) / (2 * n)) / d,
    h = (z * Math.sqrt(((k / n) * (1 - k / n)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}
const pct = (xs: number[], p: number) =>
  xs.length ? xs.toSorted((a, b) => a - b)[Math.ceil(p * xs.length) - 1] : null;
const groups = [];
for (const key of new Set(pilot.map((r) => `${r.model}|${r.variant}`))) {
  const rr = pilot.filter((r) => `${r.model}|${r.variant}` === key);
  const success = rr.filter((r) => r.success).length;
  const tokens = rr.reduce(
    (s, r) =>
      s +
      r.calls.reduce(
        (n: number, c: { usage: { input_tokens: number; output_tokens: number } }) =>
          n + c.usage.input_tokens + c.usage.output_tokens,
        0,
      ),
    0,
  );
  const cost = rr.reduce(
    (s, r) =>
      s + r.calls.reduce((n: number, c: { costEstimatedUsd: number }) => n + c.costEstimatedUsd, 0),
    0,
  );
  const latency = rr.map(
    (r) =>
      r.calls.reduce((n: number, c: { generationMs: number }) => n + c.generationMs, 0) +
      r.attempts.reduce((n: number, a: { totalMs: number }) => n + a.totalMs, 0),
  );
  groups.push({
    model: rr[0].model,
    variant: rr[0].variant,
    n: rr.length,
    firstSuccess: rr.filter((r) => r.attempts[0].success).length,
    finalSuccess: success,
    wilson95: wilson(success, rr.length),
    tokensPerSuccess: success ? tokens / success : null,
    costPerSuccess: success ? cost / success : null,
    costEstimatedUsd: cost,
    p50Ms: pct(latency, 0.5),
    p95Ms: pct(latency, 0.95),
    repairs: rr.reduce((n, r) => n + r.attempts.length - 1, 0),
    outcomes: Object.fromEntries(
      [...new Set(rr.flatMap((r) => r.attempts.map((a: { outcome: string }) => a.outcome)))].map(
        (o) => [o, rr.flatMap((r) => r.attempts).filter((a) => a.outcome === o).length],
      ),
    ),
  });
}
const faults = ["js", "checkjs", "ts", "baml"].map((variant) => {
  const rr = deterministic.filter((r) => r.kind === "fault" && r.variant === variant);
  return {
    variant,
    total: rr.length,
    rejected: rr.filter((r) => r.outcome === "rejected-before-execution").length,
    executionFailed: rr.filter((r) => r.outcome === "failed-during-execution").length,
    incorrect: rr.filter((r) => r.outcome.includes("incorrect")).length,
  };
});
await mkdir(root, { recursive: true });
await writeFile(
  `${root}/summary.json`,
  JSON.stringify(
    {
      groups,
      faults,
      notes: [
        "Pilot intervals are descriptive, pooled across heterogeneous tasks; no significance claim.",
        "Paired initial JS cost appears in both hypothetical arms; actual spend is in pilot/spend.json.",
        "Compiler timing inside workerd uses its restricted clock; use external runtimeMs for wall-clock comparisons.",
      ],
    },
    null,
    2,
  ),
);
const fields = [
  "model",
  "variant",
  "n",
  "firstSuccess",
  "finalSuccess",
  "tokensPerSuccess",
  "costPerSuccess",
  "p50Ms",
  "p95Ms",
  "repairs",
];
await writeFile(
  `${root}/summary.csv`,
  [
    fields.join(","),
    ...groups.map((g) => fields.map((f) => JSON.stringify(g[f as keyof typeof g] ?? "")).join(",")),
  ].join("\n") + "\n",
);
const flat = deterministic.map((r) => [
  r.kind,
  r.variant,
  r.task,
  r.id ?? "",
  r.outcome,
  r.validationMs,
  r.runtimeMs ?? "",
  r.totalMs,
]);
await writeFile(
  `${root}/deterministic.csv`,
  [
    "kind,variant,task,fault,outcome,validationMs,runtimeMs,totalMs",
    ...flat.map((r) => r.map((x) => JSON.stringify(x)).join(",")),
  ].join("\n"),
);
const charts = [
  [
    "First attempt success",
    groups.map((g) => [`${g.model} / ${g.variant}`, (g.firstSuccess / g.n) * 100]),
  ],
  [
    "Final functional success",
    groups.map((g) => [`${g.model} / ${g.variant}`, (g.finalSuccess / g.n) * 100]),
  ],
  [
    "Tokens per successful task",
    groups.map((g) => [`${g.model} / ${g.variant}`, g.tokensPerSuccess]),
  ],
  [
    "USD per successful task (estimated)",
    groups.map((g) => [`${g.model} / ${g.variant}`, g.costPerSuccess]),
  ],
  ["End-to-end p50 milliseconds", groups.map((g) => [`${g.model} / ${g.variant}`, g.p50Ms])],
  [
    "End-to-end p95 milliseconds (tiny sample)",
    groups.map((g) => [`${g.model} / ${g.variant}`, g.p95Ms]),
  ],
  ["Faults failing during execution (of 17)", faults.map((g) => [g.variant, g.executionFailed])],
  ["Faults completing incorrectly (of 17)", faults.map((g) => [g.variant, g.incorrect])],
  ["Repair calls", groups.map((g) => [`${g.model} / ${g.variant}`, g.repairs])],
  ["Faults rejected before execution (of 17)", faults.map((g) => [g.variant, g.rejected])],
] as const;
const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
let y = 55;
const parts = [];
for (const [title, data] of charts) {
  parts.push(`<text x="20" y="${y}" font-size="20">${title}</text>`);
  y += 25;
  const max = Math.max(1, ...data.map((r) => Number(r[1] ?? 0)));
  for (const [label, value] of data) {
    parts.push(
      `<text x="20" y="${y + 17}" font-size="12">${escape(String(label))}</text><rect x="340" y="${y}" width="${(Number(value ?? 0) / max) * 430}" height="22" fill="#3271ae"/><text x="780" y="${y + 17}" font-size="12">${value === null ? "N/A" : Number(value).toFixed(3)}</text>`,
    );
    y += 30;
  }
  y += 35;
}
await writeFile(
  `${root}/charts.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${y}" viewBox="0 0 900 ${y}"><rect width="100%" height="100%" fill="white"/><g font-family="sans-serif" fill="#172338">${parts.join("")}</g></svg>`,
);
console.log(JSON.stringify({ groups, faults }, null, 2));
