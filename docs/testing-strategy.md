# Integration tests and agent evaluation

This document describes the tests above the unit level: the suites, the runtimes, the scoring rules,
and the gates. It follows Simplified Technical English (ASD-STE100).

Read [`integration-testing.md`](integration-testing.md) for the design of the shared toolkit.

## Scope

Every other suite in this repository tests code that we wrote, with inputs that we chose. The result
is a boolean for each code path, and it is the same on every run.

The evaluation suite is different in three ways:

- The input is a prompt in English, and not a call to a typed API.
- The code under test does not exist until the test runs. An agent writes it.
- The same input can give a different result twice, because a model is not deterministic.

Therefore the suite cannot report a boolean. It reports a distribution, and that is why it needs
repeated trials, confidence intervals, and a rule for the trials that it must discard.

Two facts set the boundary. No other suite sends a prompt to a model: `ai-models.test.ts` and
`ai-gateway.test.ts` replace `fetch` with a stub and check the routing decision, and
`__integration__` calls `listModels()` without starting a turn. No other suite runs code that an agent
wrote.

The suites therefore answer two different questions:

1. Does the platform work when all of its parts run together?
2. Does the agent deliver an application that works?

## Suites

Four suites test more than one module at a time. The runtime of a suite decides what it can reach.

| Suite | Runtime | Reaches | Cost |
|---|---|---|---|
| `workshop-backend/__integration__` | in-process workerd (`@cloudflare/vitest-pool-workers`) | Worker and Durable Object internals | free |
| `packages/integration-tests` | out-of-process workerd (`createTestHarness()`) | the public Cap'n Web API | free |
| a consumer repository suite | out-of-process workerd | one real gatekeeper | free |
| `packages/workshop-evals` | out-of-process workerd, and a live model | the agent, then its Gadget | inference |

An in-process suite runs inside workerd. Therefore it can import `cloudflare:test` and call
`abortAllDurableObjects()` or `runInDurableObject(stub, fn)`. It can stop one Durable Object, and it
can test a native RPC boundary.

An out-of-process suite drives workerd from Node. Therefore it gets a real WebSocket connection,
several Workers with bindings to each other, and a Worker Loader that runs Gadget code. It reaches the
platform only through the API that a browser has, and `cloudflare:test` does not exist in it.

Neither runtime can use the other's method to restart a server:

- In-process, call `state.abort(reason)` on the object.
- Out-of-process, call `AgentSession.restartGadgets()`. It applies an empty update to the mainline
  code. This advances the code version, which aborts every Gadget facet. The platform does the same
  thing on every code change.

## Toolkit

`packages/integration-tests` owns the tools. It has four source-only entry points:

| Module | Purpose |
|---|---|
| `src/harness.ts` | boots `workshop-backend` and a list of gatekeepers as real Workers |
| `src/rpc-client.ts` | Cap'n Web over a WebSocket to `/api`, sign-up, and the `waitFor` helper |
| `src/agent-session.ts` | drives one agent session: prompts, history, workpieces, source snapshots |
| `src/network-interceptor.ts` | patches `fetch` and rejects any request that no handler matched |

`AgentSession` also provides two methods for tests that need a known implementation:

- `seedGadget({title, bindingName, files})` writes hand-authored source into the workspace. It creates
  a Gadget without the agent.
- `restartGadgets()` restarts every Gadget server. Storage survives, and memory does not.

`packages/workshop-evals` adds the model, and nothing below it.

## How an evaluation works

A task holds one or more prompts and a verifier. `src/harness.ts` runs one task as follows:

1. Start a workerd Workshop, then create a new account and workspace.
2. Wait for the output formats to install, so the system prompt is deterministic.
3. Send each prompt in order, and wait for the agent to settle.
4. Call the verifier after each prompt.
5. Write the transcript and the accepted source to `.wrangler/evals/runs/`.
6. Read the token count, the duration, and the cost from the AI Gateway logs.

The verifier calls the Gadget's own RPC. `EvalVerifier` gives it four methods: `check`, `connect`,
`restart`, and the `workpieces` list. A throw inside `check` becomes a failed check. A throw outside
one becomes a single failed check named `verifier.threw`, so the trial keeps the checks it recorded.

### The scoring rule

The score is the fraction of checks that passed. Nothing inspects the method that the agent used.

For example, one task asks for an appointment desk that never sells more places than it has. The agent
satisfied it with one synchronous SQL sequence and a database trigger. A check for a mutation queue
rejects that correct answer.

The trajectory is a diagnostic, not a score. We record the model turns, the tool calls, the tool
errors, the agent errors, the tokens, the time, and the cost. An agent that recovered from a failed
tool call still delivered the application.

Two more diagnostics come from the code itself. `src/source-checks.ts` reports each use of a web API
that a Gadget cannot use, such as `localStorage`, which throws in the UI frame. The harness reports
each outbound request that it refused.

Syntax needs no check of its own. Every `.js` file in a Gadget becomes a module in its Worker, so a
file that cannot parse stops the server and fails every check.

### Invalid trials

A trial is invalid when its result does not describe the agent. `src/summary.ts` excludes an invalid
trial from every rate, and counts it in the **Invalid** column. A rate limit therefore reads as missing
data, and not as a regression.

A trial is invalid in three cases:

- The harness did not start, so the run produced no result.
- The task recorded no checks.
- The turn ended with an error, and the trial also failed.

A trial that passed after a transient error stays valid. The agent delivered the application.

Incomplete telemetry is a separate case. It does not make a trial invalid. `src/summary.ts` drops that
trial from the token, duration, and cost figures only, and reports the fraction that it kept.

The platform posts an error message when a turn dies. It posts none when the agent runs out of turns
or gives up. Therefore an error almost always means infrastructure, and not capability.

## What a trial may reach

A trial may reach the model provider, and nothing else. The harness installs the network interceptor
from `packages/integration-tests` and allows two hosts.

The agent keeps its `webFetch` tool inside a trial, so without this a result could depend on a live
third-party site, and the prompt would leave for that site. A refused request appears in the trial's
diagnostics.

A Gadget's own code has no network at all. The platform gives its Worker no outbound service.

## Gates

| | Gate 1 | Gate 2 |
|---|---|---|
| Workflow | `ci.yml` | `workshop-evals.yml` |
| Trigger | every pull request, and every push to `main` | on demand, or the `run-evals` label |
| Command | `pnpm build`, `pnpm test`, `pnpm lint` | `pnpm eval:required`, `pnpm eval:frontier` |
| Trials | not applicable | 10 on a manual run, 3 on a pull request |
| Blocks a merge | yes | only with the label |

Gate 2 runs 6 shards for each task set, and it limits the matrix to 4 jobs at a time. Workers AI
applies a rate limit for each account, and one trial makes many model calls. More jobs at once return
HTTP 429, and the run then measures very little.

Gate 2 has no schedule until its results flow into durable experiment storage. Workflow artifacts
expire after 30 days, so scheduled runs cannot yet show a long-term trend or trigger a regression
alert against a stable baseline.

Each task carries one of two states:

- A **required** task fails the job when its score is below 1.
- A **frontier** task records its score and never fails the job.

We set the state from measurement. A new task starts as frontier, because we have no data for it. We
promote it after a baseline shows that it passes. We return it to frontier if it stops passing, and we
write the observed failure onto the task.

## Statistics

The agent is not deterministic, so one trial proves very little. Each task runs several times.
`src/statistics.ts` then reports these figures for each task and model:

- the pass rate, and a Wilson 95% interval for it
- the mean score, and the sample deviation
- the mean, median, and 90th percentile of the tokens, the duration, and the cost

The interval is wide at three trials. Raise `WORKSHOP_EVAL_TRIALS` before you compare two models.

## Durability

The platform restarts a Gadget server on every code change, and not only after a fault. Therefore an
application must hold its state in storage, and not in memory.

Two suites test this:

- `packages/integration-tests/__tests__/gadget-durability.test.ts` pins the behaviour of the platform
  with a Gadget that we wrote by hand. It also proves that a naive booking implementation oversells,
  which is the premise of the `appointment-desk` task.
- `packages/workshop-evals/tasks/stock-ledger.task.ts` asks whether the application that the agent
  built survives the same treatment.

A restart makes every open stub invalid. Reconnect after a restart. This is also the only honest proof
that a restart occurred, so `stock-ledger` asserts it before the checks that depend on it.

Call `restart()` only in the final turn of a task. It advances the code version, and an agent that
replays its history in a later turn rejects a version that it did not observe.

## Known limits

- Two tasks have no live measurement. Both carry the frontier state.
- One task passes one trial in three. It treats intervals as closed instead of half-open, and it
  accepts a duplicate identifier.
- No task uses a gatekeeper. The fixture gatekeeper exposes no session methods. The Context Library
  gatekeeper is a better candidate, because it auto-provisions its account with no OAuth and keeps its
  own state, so it starts in this harness with no network. A probe confirmed that it starts and mints
  an account.
- Part of `workshop-backend/__integration__` carries `describe.skip`, because it timed out in CI.
