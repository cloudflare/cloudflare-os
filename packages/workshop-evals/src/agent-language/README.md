# Agent language experiment

Run from repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm --filter @gadgets/workshop-evals test:run
pnpm --filter @gadgets/workshop-evals exec tsc --noEmit
pnpm --filter @gadgets/mcp-shared test:run
pnpm --filter @gadgets/workshop-evals benchmark:language deterministic /tmp/language-deterministic
pnpm --filter @gadgets/workshop-evals benchmark:language dry-run /tmp/language-prompts
pnpm --filter @gadgets/workshop-evals benchmark:language:performance /tmp/language-performance.json
```

Output directories must be new. A manifest uses exclusive creation to refuse accidental replacement or continuation of an uncertain billing ledger. `deterministic` executes the 9 reference tasks × 4 variants, then 17 planted faults × 4 variants. It costs no inference credits. Workerd tests need local process/loopback permissions and approximately 10 seconds of wall-clock allowance per invocation. Under contention, serialize files with `exec vitest run --config vitest.config.ts --no-file-parallelism` from the eval package.

`compiler.test.ts` tests host typing, `mcp.test.ts` uses the real JSON Schema generator, `faults.test.ts` tests the oracle on fault injections, `runtime.test.ts` executes workerd and the BAML WASM bridge, `oracle.test.ts` tests scoring boundaries, and `repair.test.ts` exercises bounded diagnostic repair without a model. Existing eval infrastructure remains Vitest; the batch CLI only records results. Full Workshop/incident-desk paid evals remain separate.

Paid command, **only after checking the recorded stop condition and account billing**:

```sh
OPENAI_API_KEY=... pnpm --filter @gadgets/workshop-evals benchmark:language pilot /tmp/language-pilot-new
```

Do not paste keys into shell history; use your normal environment/secret setup. The runner uses the configured environment key, passes no credentials into candidate workerd, requests standard-tier Responses API, low reasoning, 8192 output-token maximum, and at most 2 repairs. Initial JavaScript is reused by checkJs; TS/BAML are independent. Three trials per task/model/variant are scheduled, interleaving tiers. The two pinned models and verified text-token prices are in runner.ts. There is no implicit automatic full run.

A $10 cap reserves UTF-8 prompt bytes plus overhead as a conservative token bound and maximum output cost before each serial request. $0.50 is additionally reserved against the earlier superseded pilot. Usage-derived text cost includes cached input and reasoning tokens already included in output usage. It is **estimated billing**, not an invoice. Unknown usage, transport failures, server errors, auth/credit errors and cap exhaustion stop the run; uncertain reservations remain visible. Re-running in a new directory creates another ledger, so the $10 bound is per invocation, not a global account cap. Account/budget reconciliation is required before another paid run. No full 30-trial campaign ran in this session.

To regenerate report data, create a parent directory containing `deterministic/runs.jsonl` and `pilot/runs.jsonl`, then:

```sh
pnpm --filter @gadgets/workshop-evals benchmark:language:summary /absolute/path/to/parent
```

The summary counts paired first-generation costs in both hypothetical arms. Actual incurred usage appears once per provider call in `calls.jsonl` and `spend.json`. Prompt/documentation token estimates are separate from provider usage. Failed requests and orphaned calls are not silently assigned successful task rows. p50/p95 over one or two observations are descriptive samples, not stable service percentiles.

BAML's v1 language is provided by pinned `@boundaryml/baml-bridge-web@0.23.0`, not old `baml-ts`. esbuild bundles its workerd entrypoint and the static WASM module. A nominal typemap adapts JSON fixtures into host classes. The list callback uses a response envelope because direct typed-array returns fail the pinned bridge; nullable optional input fields normalize to omission. No native CLI is needed for reproduction.

Limitations: mock capability service, no live Dynamic Worker loader or Gatekeeper approvals, no production deployment, ordinary Promise types rather than full Cap'n Web, no malformed-response/cancellation soak, and no incremental TypeScript compiler implementation. The checkJs adapter only accepts the documented three-identifier default function shape. Runtime compute billing is not measured. See the research documents for complete interpretation.
