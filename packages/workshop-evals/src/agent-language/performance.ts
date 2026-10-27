import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tasks, typescript } from "./tasks.ts";
import { validate } from "./compiler.ts";
import { execute } from "./runtime.ts";
const result: unknown[] = [];
for (const variant of ["js", "checkjs", "ts"] as const) {
  const source = variant === "ts" ? typescript(tasks[0].js) : tasks[0].js;
  const warm = Array.from({ length: 30 }, () => validate(source, variant).validationMs);
  const cold = Array.from({ length: 5 }, () =>
    Number(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {validate} from './src/agent-language/compiler.ts';console.log(validate(${JSON.stringify(source)},${JSON.stringify(variant)}).validationMs)`,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
  result.push({
    variant,
    stage: "validation",
    coldProcessMs: cold,
    warmProcessMs: warm,
    note: "Fresh compiler Program every check; warm is process/JIT/OS, not incremental compilation.",
  });
}
for (const variant of ["js", "baml"] as const) {
  const r = await execute(
    variant === "baml" ? tasks[0].baml : tasks[0].js,
    variant === "baml",
    tasks[0].bindings,
    6,
  );
  result.push({
    variant,
    stage: "workerd-aggregate",
    ...r,
    note: "First request includes startup; next five reuse isolate but reinitialize BAML source. Pure computation only; tool state is not reset between these microbenchmark requests.",
  });
}
await writeFile(
  process.argv[2] ?? "../../docs/research/agent-language-data/performance.json",
  JSON.stringify(result, null, 2),
);
