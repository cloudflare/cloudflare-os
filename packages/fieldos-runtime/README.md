# @gadgets/fieldos-runtime

The services a FieldOS deployment needs when there is no Cloudflare underneath it: **KV**, **R2**
and **static assets**.

**Never deployed to Cloudflare.** These run only under standalone `workerd`, wired by a
hand-written capnp config. That is why the package has no `wrangler.jsonc` — its absence is what
keeps it invisible to `findDeployablePackages()` (`scripts/release/manifest-lib.mjs:83`), the
dev-server scan (`run-dev-server.js:70`) and type generation
(`scripts/generate-worker-types.mjs:44`). **Do not add one**; the golden manifest test fails closed
on an unrecognized deployable package.

## Why these exist

`kvNamespace @11` and `r2Bucket @12` are `ServiceDesignator`s in `workerd.capnp`: workerd ships the
**client** half of each binding and converts calls into HTTP requests aimed at a service you
supply. It ships no server. There is no `assets` binding type at all — only a `disk` service that
the schema itself says you "would normally wrap in a Worker".

So each file here is the missing server half:

| File | Binding it serves | Used for |
|---|---|---|
| `src/kv.js` | `kvNamespace` | `BLUEPRINTS`, `AVATARS`, `CONTEXT_COLLECTIONS` |
| `src/r2.js` | `r2Bucket` | `BLUEPRINT_CONTENT` |
| `src/assets.js` | wraps a `disk` service | the SPA, bound as `ASSETS` |

The application needs **no changes** to use them — it keeps calling `env.BLUEPRINTS.get(...)` as
always. That matters because `workshop-backend` is upstream-mergeable and every line changed there
is a line to reconcile on each future upstream port.

## Not MinIO

"R2's API is S3-compatible" is true of R2's *S3 endpoint* and false of the *binding* the app uses,
which speaks a private protocol. MinIO cannot sit behind an `r2Bucket` binding. Miniflare's
S3-backed R2 inverts the dependency — it would require shipping MinIO as a second server process
into an airgapped deployment.

Miniflare's own KV/R2 workers are not reusable either: they import `miniflare:shared` and
`miniflare:zod`, module namespaces workerd resolves only when Miniflare generates the config.

## Plain JavaScript, deliberately

capnp's `esModule = embed "..."` inlines the source file itself. A build step would put a `dist/`
between the config and the code that runs, so the artifact in the deployment would never be the
file you read. `checkJs` plus JSDoc gives full type safety with no such indirection —
`pnpm types:check` covers these files.

## Limits, deliberately

Implemented: `get`/`put`/`delete`, `get(key, "arrayBuffer")`, and R2's `httpMetadata.contentType`.
That is the application's entire measured surface. `list`, `head`, multipart, ranged reads,
`onlyIf` and `customMetadata` have **no call sites** and return an explicit `400 unsupported` —
failing loudly, so that if an audit ever misses a call site it surfaces immediately.

**Value-size ceiling: 2,199,729 bytes**, measured by bisection. It is SQLite's row limit
(`SQLITE_TOOBIG`), not workerd's, so a runtime built against a differently-configured SQLite could
move it. Every application asset sits far below it — avatars are capped at 100 KB
(`server.ts:233`), the site logo at 256 KB, screenshots at 1 MB, and shipped blueprints are
25–50 KB.

The exception is `MAX_BLUEPRINT_CONTENT_BYTES` (`blueprint-archive.ts:19`), which permits **32 MB**
— roughly 15× the ceiling. An oversize import fails fast and leaves no partial object, so the
existing rollback works and no data is lost, but the user sees `SQLITE_TOOBIG` instead of the
friendly "Gadget archive content is too large." Worth aligning for a self-hosted build.

## Two invariants not to refactor away

1. **KV values must stay `ArrayBuffer`.** Storing them as strings would corrupt binary silently and
   only for some images — the avatar path depends on byte-exact round-trips. The test asserts this
   with deliberately invalid UTF-8.
2. **An R2 object is one storage row.** That is what makes its metadata and body atomic; a reader
   can never see one without the other. Chunking for capacity would trade a verified property for
   headroom nothing needs.

And the single most consequential protocol detail: **an R2 miss must return 404 *and* a
`cf-r2-error` header.** Without it `.get()` throws `Unspecified error (0)` instead of resolving to
`null`, and the failure surfaces far from its cause.

## Tests

```sh
pnpm --filter @gadgets/fieldos-runtime test
```

Spawns the pinned `workerd` against `__tests__/fixture/fixture.capnp` and drives all three services
through real bindings, then kills the process with `SIGKILL` and re-reads to prove durability
rather than a clean-shutdown flush.

`packages/integration-tests` **cannot** cover these: it boots via wrangler → miniflare, and
miniflare supplies its own KV/R2, so it would test Cloudflare's services rather than these.

## Version pinning

The protocol framings are unversioned workerd internals, valid for **1.20260801.1** exactly, which
is why `workerd` is an exact-pinned devDependency here. This suite is the upgrade canary: after any
workerd bump, run it, and if it fails re-derive the protocol with `plans/workerd-probe/echo.js`
(about two minutes) and diff. For an accredited deployment that should be a documented release
step.
