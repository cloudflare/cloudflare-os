# Agent language comparison

Experiment CO-1, 27 October 2026. This branch changes evaluation code only. It does not modify the production executeCode contract, merge main, or touch EducateOS upstream integration.

## Source and toolchain provenance

- Cloudflare OS: `fd624bcdddbb071b1244edea055cb1c033f8ba80` (upstream main at checkout). Recent commits include Drive picker icons (#898), Calendar availability (#777), workspace API naming (#895), and package-specific AGENTS guides (#891). Older descriptions of the agent engine cannot be assumed current.
- BAML source: `3d20df898fbea29e24be06222aeee25ad48f8597` (27 October 2026, allocation/write-barrier lock change #5429).
- Executed BAML compiler/runtime: `@boundaryml/baml-bridge-web` **0.23.0**, pinned in pnpm lockfile. This is the **v1 agent language**, despite its 0.x package version. Not legacy `baml-ts` prompt-only v0.
- Installed native CLI: `baml-cli 0.23.1-nightly.20261026.a`, GitHub release asset for aarch64-apple-darwin. `--version`, `--help`, `run --help`, and `check --help` executed. The benchmark uses the pinned web bridge, not this newer CLI. Source HEAD and executed release are explicitly different revisions.
- TypeScript compiler API: **5.9.3**, alias `typescript-compiler`. Repository build compiler remains TypeScript **7.0.2**, whose package in this checkout does not export `createProgram`. No repository compiler downgrade.
- Miniflare **5.20261001.0-alpha**, matching the existing dependency graph; esbuild **0.28.2**, Node **22.22.0**, macOS arm64. Reproduction uses pnpm **11.17.0**.

## Current execution path

1. `packages/workshop-backend/src/agent.ts` builds the system prompt with named chat bindings, ambient resource catalogs and the executeCode tool description. `describeBinding` returns TypeScript interfaces and documentation. The prompt explicitly warns that RPC interfaces cannot be discovered by enumerating object properties and that familiar APIs must not be guessed.
2. The agent loop uses `@earendil-works/pi-agent-core` and pi-ai. executeCode's schema validates a **string** called `code`. Its required shape is a self-contained JavaScript module exporting an async function `(self, env, ctx)`. This is not TypeScript source.
3. `agent.ts` executeCode checks the step transaction barrier: buffered edits must be persisted in an earlier step before execution. This validates sequencing, not the generated program's types.
4. `OverseerImpl.executeCodeMode` (`overseer.ts`, around line 9014 at the pinned commit) creates a random execution ID, registers temporary worktree access and output subscribers, and creates a Dynamic Worker definition. Modules are `harness.js` and the **unchanged** `agent.js` string. It calls `LOADER.load(workerDef).getEntrypoint()`, then `verify()` to detect startup errors and `run()` to invoke the agent function.
5. The worker sets `globalOutbound: null`; `disallow_importable_env` blocks alternate access to bindings and importable exports; `allow_irrevocable_stub_storage` supports restore. The env is constructed by `getEnvForAgent` from the chat's granted bindings, not ambient production credentials. Gatekeeper sessions provide scoped capabilities. The harness adds a transient restore forger only to relevant bindings.
6. RPC implementations use `@validateRpc()` / capnweb-validate generated validation. Gatekeepers and the MCP adapter retain runtime enforcement. Type declarations do not authorize an action. MCP `tools.ts` classifies observation versus queued writes; read-only annotations and vetted-endpoint policy affect approval. JSON Schema-derived TypeScript declarations are not a substitute for validation of wire values or backend authority.
7. Runtime exceptions are caught, their stacks are appended to tool output, and the model can issue a subsequent corrected executeCode call through the ordinary agent loop. There is no compiler-specific repair loop in this path. Startup errors fail the tool. The harness logs a non-undefined return value; console logs become tool output.
8. Code Mode calls are sequential within a chat turn; generated JavaScript can use async operations and Promise concurrency. Other chats and Durable Object requests may interleave across awaits. Worktree overlays, buffered commits, step persistence barriers, and execution-ID-bound sessions restrict stale capabilities. Persistent restore stubs and gatekeeper effects are distinct from ephemeral worker locals. Cancellation uses the chat AbortController and turn lifecycle; the executeCode method shown does not receive an AbortSignal. Its **five-second timer waits for tail logs after execution**, not a five-second execution deadline. Do not claim it bounds an infinite-running program. Pending external actions are not globally transactional or rolled back by an exception.
9. Agent trace spans cover invocation, chat, tools and approval; token counts include cache reads/writes (`agent-tracing.ts`). Stored assistant messages carry usage and gateway log identifiers. Tail logs, output streaming, stored chat messages and content-free observability counters are distinct channels. There is no isolated per-generated-program compilation cost metric because no such compilation stage exists today. Provider model costs and complete end-to-end costs need the benchmark's separate ledger.

**Conclusion from source:** dynamically generated executeCode JavaScript is not semantically type-checked today. The TypeScript application build checks the host application and code-generation sources; it does not type-check arbitrary strings returned later by a model. Worker startup performs parsing/linking, not TypeScript semantic validation.

## checkJs prototype

`compiler.ts` provides strict `allowJs`, `checkJs`, `noEmit` checking in a virtual compiler host. The host adds JSDoc parameter annotations to a virtual source copy and supplies `environment.d.ts`. The original bytes execute for both A and B. A sibling `.d.ts` alone cannot contextually type the parameters of an arbitrary default function declaration: those identifiers need a local annotation or an equivalent typed wrapper. Injecting JSDoc achieves that without asking the model to produce TypeScript.

The compiler resolves only the candidate, environment declarations and its standard library; arbitrary local files/packages cannot resolve. TypeScript variants transpile only after a clean check. Diagnostics include codes and candidate-relative positions (injected one-line JSDoc is subtracted). This prototype supports the exact default function declaration contract with three identifier parameters; arrow functions, destructured parameters, existing conflicting JSDoc and alternate exports require more adapter work. Such policy rejections must be reported as coverage limits, not syntax failures.

A policy additionally rejects `any`, casts, non-null assertions and TypeScript suppression comments for checked variants. This is a benchmark policy, not a security boundary or proof that every escape hatch is impossible. Unchecked JavaScript keeps syntax-only validation. Return types are not task-specific; the external oracle catches wrong valid IDs, date boundaries, aggregation errors and lost updates.

The API used here is Node-hosted and rereads library declarations for each validation. Calls in one process are warm at the JS engine/OS level, **not an incremental language-service measurement**. An integration can cache parsed standard libraries and use a language service keyed by program and binding schema versions. A Workers deployment would need bundled compiler code and preloaded virtual lib files; the current filesystem-backed host cannot be copied unchanged into workerd. Browser/Workers compiler footprint, incremental invalidation and production latency remain unmeasured.

MCP coverage is only as strong as the declarations. Current `schema-to-ts.ts` supports nested properties, unions, nullable values, named methods and overloads, limits recursion to depth 8 and rendering to 2,000 nodes, and degrades unsupported/deep forms to `unknown`. Generic `callTool` discovery overloads and broad return schemas leave gaps. Cap'n Web promise pipelining must be represented by real stub types: replacing them with ordinary `Promise<T>` everywhere would falsely reject legal pipelined calls. This experiment's mock interfaces use ordinary promises and do not establish full Cap'n Web type coverage.

## BAML v1 findings

The current source contains the v1 lexer/parser, AST, HIR, HIR type checking, MIR, emit/linker layers and BEX VM/engine. See `baml_language/crates/baml_compiler_*`, `baml_compiler2_*`, `baml_type_runtime`, `bex_engine`, and `bex_vm`. This is a compiler plus executable runtime, not simply a schema validator or prompt templater.

- Functions can compose deterministic code and typed model functions. Classes are nominal and types persist at the host boundary. Unions and nullable types require narrowing. No general TypeScript-style `any` cast is available.
- Error effects are represented by `throws`, with typed handlers and checking. The parser includes explicit function/throws union handling. Effects do not prove recovery is correct: returning an empty list after a timeout can still satisfy types and fail the task.
- Concurrency uses `spawn` futures and `await`, while ordinary host callbacks are colorless; an async JavaScript callback is called normally from BAML. The counter reference exercises two spawned increments. The bridge exports cancellation, runtime shutdown and invocation cancellation facilities. Cancellation propagation under arbitrary host RPC and persistent sessions is not fully evaluated here.
- TypeScript SDK generation emits typemaps, generated nominal classes, callable wrappers and embedded bytecode loading. The web bridge exports source-based `initializeRuntime`, blob initialization, `callFunction`, `callFunctionSync`, and `getRuntime`. We execute the source-based API, including dynamically generated functions, inside workerd.
- The npm bridge has a `workerd` export, a statically imported WASM module and Workers tests in upstream source. The installed WASM artifact is roughly 14 MiB on disk. Successful local workerd execution establishes local compatibility, not paid Cloudflare plan size limits, production startup costs or deploy acceptance.
- Host callables returning a direct typed array of Ticket objects fail with `HostContractViolation` in the pinned bridge; the same values inside `QueryResult {items Ticket[]}` work. This was independently reproduced and retained in `runtime.test.ts`. The BAML list adapter therefore returns an envelope, while JavaScript list returns an array. No v0 fallback was used. Other class-valued callbacks require nominal typemap registration.
- The native CLI has filesystem/network/runtime facilities; restrictive syntax alone is not a sandbox. This benchmark executes the WASM bridge in workerd with denied outbound access and only synthetic host capabilities. No production secrets are bound.

Thus BAML **can** dynamically compile and execute agent programs in a Workers-compatible local runtime. The unsupported direct-array callback, nominal host marshaling, bundle footprint, persistent-stub integration and distinct function contract prevent claiming drop-in parity with the present executeCode pathway.

## Experimental scope and fairness

Nine synthetic tasks cover computation, typed APIs, nullable records, an unfamiliar MCP-shaped interface, transient failure recovery, shared-state concurrency, multi-step effects, date semantics and authorization. All variants have the same logical tools, data, write scope and oracle. JS/checkJs reuse identical first-generation bytes; TS and BAML are independently generated. BAML has an explicit Main callback signature with all capabilities, including unused distractors, and neutral syntax/collection documentation. BAML's nominal classes are supplied by the host. Documentation tokens are separately estimated with o200k_base; provider usage measures the full prompt and generation.

The mock capability service and state are held **outside the candidate isolate**. Every call is runtime-validated; only record a can be closed. Tampering with candidate-side Response.json cannot alter authoritative state. Tool calls are capped at 100 and each workerd instance has a 10-second outer watchdog. Candidate imports are limited to the modules supplied to that runtime. No production data or network access is available.

The harness uses Miniflare static module provisioning, not the live Overseer/Dynamic Worker Loader. It preserves the exported JS function contract and workerd execution but does not reproduce persistent restore, actual Gatekeeper approval UIs, Cap'n Web promises, full incident-desk persistence or all production quotas. The counter task borrows the lost-update concern from incident-desk; it does not rerun that entire evaluation.

First attempts, repairs, raw diagnostics, tool calls, final state and functional outcome are retained. All variants receive at most two repairs, including runtime/semantic feedback; the oracle never gives expected output or a task solution. State resets per repair attempt. This is a deliberate experimental retry policy: real external effects are not always resettable.

The 17 fault mutations are newly authored fixtures. No previous zip archive was attached or found in the task directory. Their counts are **not an exact reproduction of the unspecified earlier 17 cases**. Deterministic faults measure checker sensitivity, not LLM generation success.

## Integration options

| Option | Assessment |
|---|---|
| Keep JS unchanged | Minimal complexity; depends on runtime failures and model repair for shape/type mistakes. Semantic and authorization enforcement remain necessary regardless. |
| Add checkJs | Best candidate for a feature-flagged next experiment: keeps generated syntax and catches typed interface mistakes. Requires trustworthy complete env types, Cap'n Web fidelity, bounded compiler work and a fallback for unsupported declarations. |
| Switch to strict TS | Similar static coverage on paired fault fixtures, but changes the generation contract and adds transpilation/policy. Needs measured completion advantage to justify migration. |
| BAML alternate language | Technically feasible locally, but requires a separate host ABI, typed marshaling, larger runtime and broader integration testing. The current experiment does not justify replacing Code Mode. |
| JS plus selected BAML functions | Plausible for fixed schemas, typed errors, reusable prompts and generated SDKs. Precompiled functions avoid per-program source compilation; inference quality/cost benefits still require a separate task-specific experiment. |

## Fixed typed LLM functions

A fixed extraction/classification function is a different workload from arbitrary orchestration. BAML can centralize prompt/schema definitions, generated clients and typed model results; JavaScript retains mature orchestration and capability bindings. A hybrid can precompile the function and expose it through an ordinary narrow Gatekeeper interface. This avoids teaching every agent to author BAML programs. No hybrid model-function quality, streaming, parsing or cost benchmark was executed here, so this is an engineering assessment, not an empirical win.

Sources: [Cloudflare OS](https://github.com/cloudflare/cloudflare-os/tree/fd624bcdddbb071b1244edea055cb1c033f8ba80), [BAML source](https://github.com/BoundaryML/baml/tree/3d20df898fbea29e24be06222aeee25ad48f8597), [developer documentation](https://developer.boundaryml.com), [BAML release](https://github.com/BoundaryML/baml/releases/tag/baml-language-0.23.1-nightly.20261026.a), [official OpenAI pricing example](https://developers.openai.com/cookbook/examples/agent_optimization/optimizing_agents_for_cost_and_quality#metrics-helpers).
