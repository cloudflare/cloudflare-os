# Observability

`@gadgets/observability`: server-side logging, issue reporting and usage metrics. Frontend browser
`console.*` is out of scope, and frontend error reporting is `packages/error-reporting/AGENTS.md`.

## Logging

Server-side logging uses `@gadgets/observability/logger`:

- Define a package-owned field type and module-scoped logger with a stable dot-separated `component`
  and, for gatekeepers, `vendorId`:
  `const logger = createLogger<GitHubLogFields>({ component: "gatekeeper.github", vendorId: VENDOR_ID });`.
- Emit concrete event names and relevant typed fields, for example:
  `logger.warn("failed to notify credential expiry", { event: "credentials.expiry.notify.failed", error: err });`.
  Each call emits one indexed object; module/child fields such as `vendorId` are inherited.
- Use immutable `logger.with(fields)` for object-owned or nearby context. Prefer module/object loggers
  over logger parameters, and do not replace a shallow child logger with ambient context just to
  remove a local variable.
- For bounded operation context needed by deep helpers, independent loggers, or other observability
  consumers, use `createObservabilityContext` from `@gadgets/observability/observability-context`.
  Re-establish it per operation; it does not cross RPC, hibernation, or restart, and requires
  `nodejs_als` or `nodejs_compat`.
- Pass caught values as `error`. The helper stringifies `Error` instances and primitives, uses an
  own string `message` for plain objects, omits `undefined`, and adds stacks to all `Error` logs.
  Keep this normalization deliberately small; do not traverse causes or copy arbitrary properties.
- Extend field vocabularies locally. Levels: `error` needs attention, `warn` continues best-effort,
  `info` is notable lifecycle, and `debug` is noisy breadcrumbs. Never log secrets, prompts, headers,
  tokens, or request/response bodies.

## Issue reporting

To also dispatch a failure to the optional external issue Reporter (in addition to logging it), call
`reportIssue(failureSite, caught, options?)` from `@gadgets/observability/error-reporting`. Attach
ambient fields from the package's observability context and augment them with capture-site fields:
`reportIssue("overseer.catalog-fallback", err, { handled: true, attributes: { ...obsContext.get(), gatekeeperId } });`.
It is a no-op when the `ERROR_REPORTER` binding is absent (local dev / deployments without an issue
destination). Only bounded scalars are retained as attributes; reported context obeys the same
no-secrets rules as log fields.

## Metrics

Usage metrics go to the optional `METRICS` Analytics Engine dataset through
`@gadgets/observability/metrics`, whose column layout (`metrics-schema.ts`) is also what dashboards
query; Workshop product events reach it through `recordAnalytics`.
