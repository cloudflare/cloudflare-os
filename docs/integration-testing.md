# Integration testing

This is how the integration test suites work, and why they are shaped the way they are.

There are two kinds of suite:

| | this repo's `packages/integration-tests` | a consumer repo's per-vendor suite |
|---|---|---|
| Runs | `pnpm test` (part of CI's normal test job) | its own CI step |
| Gatekeeper | a fixture Worker whose verification outcome the tests set | a real vendor gatekeeper, unmodified |
| Covers | the overseer's observer logic | a genuinely expired credential, end to end |
| Owns | the harness, interceptor, and RPC client | that vendor's handlers and token minting |

A consumer repo is one that vendors this repo as a `public/` submodule and consumes the toolkit as a
workspace dependency (`public/packages/integration-tests` in its `pnpm-workspace.yaml`).

No such suite lives in this repo, and nothing here depends on one existing. The second column is
described anyway because it is what the toolkit is parameterised *for*: the harness takes a list of
gatekeepers and the interceptor takes pluggable handler modules precisely so a suite can be added
outside this repo without forking either. Where this doc describes a per-vendor suite, take it as the
worked example of that shape — one gatekeeper run unmodified against its vendor's mocked endpoints —
rather than as something you will find here.

## What these tests are

`wrangler`'s [`createTestHarness()`](https://developers.cloudflare.com/changelog/post/2026-07-21-integration-test-harness/)
boots `workshop-backend` and one or more gatekeepers as **real Workers in workerd**, with their
checked-in `wrangler.jsonc` patched in memory. Tests speak Cap'n Web over a WebSocket to `/api` — the
same transport the browser uses — and serve an `ObserverConfigCallback` the overseer calls back into.

Nothing is stubbed except outbound HTTP. The consequence worth internalising: **the code under test is
in another process.** Most of what follows falls out of that.

## Findings that shape the design

### Fake timers cannot work here

`vi.useFakeTimers()` patches the test process's clock. The code under test reads workerd's clock, out
of process, so a faked clock is invisible to it. `isTokenExpired()`'s 30-second skew is inside
`gatekeeper-shared` and evaluated inside the Worker.

(Fake timers *do* work for in-isolate unit tests under `vitest-pool-workers`, where the test runs
inside the same isolate)

### A fixture gatekeeper, not a real one, for the overseer's own logic

The overseer cases need a gatekeeper that refuses an observer on command. Every shipping public
gatekeeper can do that only at a cost that would dominate the test:

- **OAuth gatekeepers** need a whole vendor auth surface mocked before an account exists at all.
- **The Context Library** only refuses once an observation has been *recorded*, which takes a gadget
  read session (so a Worker Loader), a slash-command invocation, or an AI-chat catalog snapshot. It is
  also a singleton, so it can never produce the two simultaneously-failing bindings one of these cases
  needs.

Adding a test hook to those workers was considered and rejected. A "mark observed" hook would stub the
very state the tracker maintains, making the test circular.

So `fixtures/gatekeeper-test/` is a real Worker speaking the real protocol, whose verification outcome
the tests set over an HTTP control route. **It is scoped to overseer logic, not a long-term substitute
for per-vendor coverage.** Testing actual gatekeepers is the expected trajectory, which is why the
harness takes a *list* of gatekeepers and the interceptor takes *pluggable* handler modules: a future
`gatekeeper-google` suite is "add `google-handlers.ts`, point the harness at the package" — the same
shape a consumer repo's per-vendor suite takes, with production code unmodified.

### Storage isolation is by convention, because the alternative is worse

`server.reset()` exists, and measuring it settles the question: **~3 s per call**, which is more than
an entire suite run. It also restarts the server — `server.url` becomes undefined and every open
WebSocket RPC session dies with "WebSocket connection failed". It is not a storage wipe you can use
between tests; it is a teardown.

So storage persists for the harness's lifetime and **no test may assume a clean slate**. Tests stay
independent by taking fresh identities: `nextUsernames()` from the toolkit, per-test resource URLs, and
account labels allocated by the connect/provision helper rather than chosen by the caller.

One corollary that is easy to get wrong: the "nothing escaped to the internet" assertion belongs in
`afterAll`, not `afterEach`. With `it.concurrent`, an `afterEach` fires while siblings are still
running, so it would inspect and clear state they are still using — and could discard an escape a
sibling was about to be blamed for.

### wrangler and workerd versions are coupled

The public repo pins `workerd` through a root `overrides` entry, which collapses every transitive
request to one version. A newer `wrangler` brings a newer `miniflare` that demands a newer `workerd`
than the override yields, and the harness then fails to boot:

```
The Workers runtime failed to start ... requires compatibility date "2026-07-08",
but the newest date supported by this server binary is "2026-06-30".
```

So the public package pins `wrangler` to `~4.104.0` — the release whose bundled `workerd` matches the
override. Bumping it means bumping the override in step.

### A consumer in another repo can end up with two copies of capnweb

A consumer repo installs its own workspace *and* the `public/` submodule's, as two separate pnpm
stores. So `capnweb` resolves to two different copies: the toolkit's `rpc-client` gets the
submodule's, while anything importing `capnweb` from one of the consumer's own packages gets the
other. A stub is only serialisable by the instance that owns the session, so mixing them fails:

```
TypeError: Cannot serialize value: [object RpcStub]
```

The trap is that a dev machine where a single `pnpm install` deduped both will not show this. It first
appeared in CI, which runs `pnpm install` and `pnpm --dir public install` separately. To reproduce
locally, do the same.

The toolkit therefore owns the capnweb boundary: mint callback stubs with `stubFor()` from
`rpc-client`, never with an imported `RpcStub`. Importing `RpcStub` as a *type* is fine. This is
enforced structurally in this repo — the lint rules in `vite.config.ts` restrict `capnweb` value
imports within this package to `rpc-client.ts` (`allowTypeImports` leaves type imports alone). A
consumer repo without a linter should treat the rule as a convention its test files follow via
`stubFor()`.

### Worker entry modules may export only classes and the default handler

workerd treats every named export of the entry module as an entrypoint. Exporting a plain string
constant from the fixture produced:

```
Incorrect type for map entry 'THING_URL_PATTERN': the provided value is not of
type 'function or ExportedHandler'.
```

Type-only exports are fine (they erase). Anything else has to stay module-private.
