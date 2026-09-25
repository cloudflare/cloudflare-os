# Observability

`@gadgets/observability` is a shared library for code that runs in Cloudflare Workers. It is not a
standalone Worker and has no deployable entrypoint or Wrangler project configuration.

The package's Vitest configuration uses the Workers test pool to exercise runtime-specific APIs.
Consumers that import `@gadgets/observability/observability-context` must enable `nodejs_als` (or
`nodejs_compat`); the default `@gadgets/observability/logger` entry point has no such requirement.

An observability context exposes typed `.with()` and `.get()` methods, and creates loggers that
inherit its ambient fields.

The optional `@gadgets/observability/error-reporting` entry point dispatches bounded error events to
a private Reporter bound as `ERROR_REPORTER`; `reportIssue(failureSite, caught, options?)` accepts
ambient fields under `options.attributes`, so callers can spread the context's `.get()` result and
augment it inline. Reporting is a no-op when the binding is absent.

The optional `@gadgets/observability/metrics` entry point writes usage metrics to a Workers
Analytics Engine dataset bound as `METRICS`, and is likewise a no-op without the binding. Each event
is written once per scope it names (fleet, actor, owner, workspace), so per-entity queries read their
own index and survive sampling. The column layout lives in the import-free `metrics-schema.ts` (also
exported as `@gadgets/observability/metrics-schema`), so dashboards can name columns rather than
`blobN`.
