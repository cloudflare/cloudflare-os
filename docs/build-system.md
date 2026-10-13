# Build and task guidance

Read this when changing codegen, Vite+ task graphs, caching, or local dev startup. Routine commands
and watchdog configuration are in [testing](testing.md).

## Tasks and generated inputs

Most packages define `build` and `test` as tasks in `vite.config.ts`, not package.json scripts.
Use `pnpm exec vp run -F <package> <task>` for these. A task cannot share a name with a script.
Keep package tasks in the package config: a root-config task is instantiated for every package.

Root build/test/clean commands exclude `cloudflare-os`; selecting the root recursively would
re-enter their own launcher. Each command in an array or `&&` chain caches separately. Use
`pnpm exec vp run --last-details` to identify actual hits and misses before changing caching.

Codegen prerequisites must run before the consumer's fingerprint is taken, and a cache hit must
restore any generated output another task reads (`cache.output`). Integration suites consume
prebuilt `.wrangler/validate` trees, so those trees are inputs, not disposable scratch. Their
harness suppresses rebuilds while file workers are running. See `packages/integration-tests` task
config and [integration testing](integration-testing.md) before altering this boundary.

Most packages are `noEmit`; Wrangler/Vite bundle source directly. `typed-storage` is the exception:
its exports resolve to emitted `dist`. Scripts run as erasable TypeScript under Node and have a
separate type-check (`pnpm types:scripts`).

## Environment and cache correctness

A cached task receives only built-in variables and those declared in its `cache.env` or
`cache.untrackedEnv`. A package.json script cannot declare these; move environment-sensitive work
to a task, or invoke that task from the script. Declaring a variable on a sibling task is not enough.

Use `cache.env` when a value changes output or verification policy; `untrackedEnv` is for scheduling
only. `scripts/env-passthrough.test.ts` guards the declared build-time surface.

An environment variable naming an external directory fingerprints the path, not its contents.
Backend bundled-blueprint codegen is therefore uncached; its consumers can fingerprint the generated
module instead. Keep that distinction when adding external inputs.

Vite+ cannot cache a task that reads paths it also writes. Shared test tasks exclude Vitest/Wrangler
scratch; app builds exclude generated outputs across the workspace, with explicit `cache.output`.
Do not exclude inputs merely to manufacture a hit. TypeScript's `incremental` cache has the same
read/write issue; keep the existing single-threaded type-check configuration unless re-measured.

## Local dev startup

`pnpm dev-server` builds gatekeeper configurators and app bundles before starting their watchers.
The two preflight task graphs share one concurrency budget. Watchers must not race codegen on the
same outputs. App watchers start after Wrangler is listening; their initial build is unavoidable.

`build:app:dev` and the watcher both produce unminified `app.txt` so the watcher does not rewrite it
and restart Wrangler immediately. Production `build:app` remains minified. App-specific Vite
settings live in `vite.app.config.ts`; `vite.config.ts` belongs to the task graph.

For dev-server process shutdown, preserve ownership of Wrangler and its workerd children rather
than exiting the launcher while they remain alive.
