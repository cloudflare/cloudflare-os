# integration-tests

End-to-end tests that drive the real Workshop and a real gatekeeper over the actual RPC API, plus the
toolkit those tests are built from. Part of `pnpm test`, so CI runs it like any other package.

```bash
pnpm --filter @gadgets/integration-tests test:run
```

Two other suites also cover more than one module. `workshop-backend/__integration__` runs in-process
under `@cloudflare/vitest-pool-workers` and reaches Durable Object internals. `packages/workshop-evals`
adds a live model to this toolkit. [`docs/integration-testing.md`](../../docs/integration-testing.md)
compares all four.

## The toolkit

Four source-only entry points, consumed both by the tests here and by per-vendor suites in repos that
vendor this one as a submodule:

- **`src/agent-session.ts`** — `AgentSession`, a production-RPC driver for live agent evaluations.
  It creates a fresh account and workspace, keeps one chat across turns, waits through callback-driven
  agent restarts, reads complete paginated history, discovers workpieces, and optionally accepts and
  snapshots source. It owns transport lifecycle only; evaluation semantics stay in the consuming suite.
- **`src/harness.ts`** — boots `workshop-backend` and any set of gatekeepers as real Workers under
  [`wrangler`'s `createTestHarness()`](https://developers.cloudflare.com/changelog/post/2026-07-21-integration-test-harness/),
  patching their checked-in `wrangler.jsonc` in memory. Parameterised over gatekeepers on purpose: a
  suite for a new gatekeeper should be "point the harness at the package", not a forked copy.
- **`src/network-interceptor.ts`** — `NetworkInterceptor`, mechanism only. It patches
  `globalThis.fetch` (the harness routes Worker subrequests back through the Node process, so that is
  enough), passes loopback through, and **throws on anything a handler didn't match** — a test cannot
  reach the real internet. What a given vendor's endpoints answer lives in a handler module you pass
  in, which is what makes it reusable across gatekeepers. `passThroughHosts` exempts a host a suite
  genuinely has to reach; a handler cannot, because it never receives the request body.
- **`src/rpc-client.ts`** — speaks Cap'n Web over a WebSocket to `/api`, the same transport the
  browser uses: sign-up, reading connected accounts, and `ObserverConfigRecorder`, which records the
  overseer's `configure()` calls and answers from a scripted queue.

## Writing a test here
- **No test may assume a clean slate.** Everything in a file shares one harness, `it.concurrent` runs
  the cases together, and storage is never reset. Take fresh identities from `nextUsernames()` and use
  per-test resource URLs; account labels are allocated for you, so two tests can't pick the same one.
- **The escape assertion lives in `afterAll`, not `afterEach`** — an `afterEach` fires while sibling
  tests are still running, so it would inspect and clear state they are still using.

## Live agent evaluations

Boot the harness with `enableGadgetExecution: true`; the default is false so existing suites do not
need a Worker Loader. Configure the Workshop through `patchWorkshop` with the real deployment model
credentials, then create the driver from the harness URL:

```ts
const harness = await startHarness({
  enableGadgetExecution: true,
  gatekeepers: [],
  patchWorkshop(config) {
    config.vars = {
      ...config.vars,
      CF_AI_GATEWAY: process.env.CF_AI_GATEWAY,
      CF_AI_GATEWAY_ACCOUNT_ID: process.env.CF_AI_GATEWAY_ACCOUNT_ID,
      CF_AI_GATEWAY_API_TOKEN: process.env.CF_AI_GATEWAY_API_TOKEN,
      CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google,cloudflare",
    };
  },
});

using session = await AgentSession.create(harness.url, { modelId: "claude-sonnet-5" });
const first = await session.run("Build a small status page.");
const accepted = await session.run("Add an incident timeline.", { acceptChanges: true });
```

`run()` never accepts changes by default. When acceptance is requested it includes the current live
draft, then returns a Yjs V2 source snapshot keyed by each workpiece's `filesRoot`. Verifiers can use
`getGadget()` or typed `connectToGadget<T>()`, selecting either the accepted or current chat branch.

The unit suite uses no fake model protocol. A credentialed live evaluation is the end-to-end proof
for model execution and must be invoked explicitly by its consuming repository; it is not registered
as a silently skipped test here.

## The fixture gatekeeper

`fixtures/gatekeeper-test/` is a real Worker speaking the real gatekeeper protocol, whose verification
outcome the tests set over an HTTP control route. It exists because the overseer cases need a
gatekeeper that will refuse an observer *on command*, and every shipping one can do that only at a
cost that would dominate the test:

- The OAuth ones need a whole vendor auth surface mocked before an account exists at all.
- The Context Library only refuses after an observation has been *recorded*, which takes a gadget read
  session, a slash command, or an AI-chat catalog snapshot — and it is a singleton, so it cannot
  produce two simultaneously failing bindings.

Adding a test hook to those workers was considered and rejected: a "mark observed" hook would stub the
very state the tracker maintains, and an injected dev credential for an OAuth gatekeeper would bypass
exactly the flow that makes a real vendor worth testing.

Two deliberate departures from a shipping gatekeeper, both to keep the fixture cheap:

- No `capnweb-validate` build step; `main` points straight at source. `@validateRpc()` would require
  the fixture to carry its own `wrangler types` output — half a megabyte of generated `.d.ts` for a
  test double. The harness's handling of a generated `main` is covered anyway, by `workshop-backend`.
- One control knob, `allow`. A settled denial and an expired credential reach the overseer identically
  — both as a thrown error, which it deliberately cannot tell apart because it treats every failure as
  repairable — so the reason string is what carries the difference. Tests cover both narratives by
  choosing reason text.

## Further reading

[`docs/integration-testing.md`](../../docs/integration-testing.md) covers the reasoning behind the
shape of all this: why fake timers cannot work here, why a fixture gatekeeper rather than a real one,
how storage isolation works, and the capnweb, wrangler, and workerd traps to expect. Read it before
changing the toolkit or starting a suite of your own.
