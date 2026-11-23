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
is written once to its actor's index, the canonical copy to count, and once more per owner or
workspace it names, so per-entity queries read their own index. The column layout lives in the import-free `metrics-schema.ts` (also
exported as `@gadgets/observability/metrics-schema`), so dashboards can name columns rather than
`blobN`.

## Subservice calls

The same entry point writes a second family to that dataset, `subservice/v1`: the calls a
deployment makes to the services behind it, which today are Workers AI, the PDF renderer and
Google's APIs. `recordSubserviceCall()` writes one call as one point. A point holds closed words
and numbers and nothing else: no file name, id, URL, query, address, token, prompt, model output
or error message. Every string is a literal in the calling code or a value from a closed table
there. The family checks the shape all the same: a `source`, `service`, `operation`, `reason` or
`detail` that is not a letter or digit followed by at most 63 letters, digits, dots, underscores
or hyphens is written as `invalid`, and so is an event type or an outcome that its list does not
have. A number that is negative or not finite is written as 0.

A usage event is copied to its owner and workspace. A call is not: it is written once, under
`sys_unattributed` as its actor, because the code that makes it knows a vendor and no user or
workspace. Its index is `subservice|<service>|<operation>|<outcome>`.

| Column | Slot | Holds |
|---|---|---|
| `discriminator` | `blob1` | `subservice/v1` |
| `eventType` | `blob2` | `call`, or `release` for something a service held being let go |
| `scope` | `blob3` | `actor` |
| `actorId` | `blob4` | `sys_unattributed` |
| `ownerId`, `workspaceId` | `blob5`, `blob6` | empty |
| `outcome` | `blob7` | `success`, `refused` for a call the service declined, or `error` |
| `source` | `blob8` | the logger `component` of the code that made the call |
| `service` | `blob9` | the service called |
| `operation` | `blob10` | what was asked of it |
| `reason` | `blob11` | why it did not succeed, or empty |
| `detail` | `blob12` | the operation's own qualifier, or empty |
| `durationMs` | `double1` | milliseconds, summed over the point's calls; 0 where none is measured |
| `present` | `double2` | 0 |
| `httpStatus` | `double3` | the status answered, 0 when there is none |
| `providerCode` | `double4` | the service's numeric error code, 0 when there is none |
| `calls` | `double5` | how many calls the point stands for |
| `bytes` | `double6` | payload bytes sent, summed over the point's calls |

`blob8` and `blob9` mean something else in `activity/v1`, so a query always names the family in
`blob1`. The words each writer uses are listed where it writes them: the
[Google gatekeeper's README](../gatekeeper-google/README.md) and the
[PDF renderer's](../pdf-renderer/README.md#metrics).

The family is off unless a deployment turns it on. A point is written only by a Worker that has
the `METRICS` binding and whose `SUBSERVICE_METRICS` variable is `true`, read with surrounding
spaces trimmed and in any case, each time a point would be written (a JSON `true` in the Worker's
vars counts as `true`). Otherwise nothing is written, nothing is logged and nothing else changes.
No Worker config in this repository declares the binding or the variable: a deployment adds both
itself, to each Worker whose calls it wants counted. A write that throws never fails the call it
counts. It is logged as `metrics.write.failed` with `family: "subservice/v1"`, at most once a
minute in an isolate.

Analytics Engine takes at most 250 data points from one invocation, and reading one PDF can make
thousands of calls. Work like that sums its calls in a tally (`subserviceTally()`) and writes the
sums once, when it ends. Calls that agree in every string column, the status and the provider
code are one sum, written as one point with their `calls`, `durationMs` and `bytes` added up,
which is why a count is `SUM(_sample_interval * double5)` and never a count of rows. Such a count
is an estimate. Analytics Engine samples the rows of one index: it keeps some rows, each standing
for `_sample_interval` of them. It was measured doing so at small volumes, when one isolate wrote
a few points under one index within seconds (four in one invocation were stored as two rows),
and not when the same points came from several machines. The weights of the rows kept came to
the points written every time, so points that stand for different numbers of calls are what add
up to more or less than was written, by more the more their `calls` differ: 9% over for PDF reads
of 7 to 34 model calls each, read side by side in one isolate. That is why each kind of call has
an index of its own. The rare kinds (a PDF opened again, a document cut off) are written a call
or two to a point, so their counts are close to exact at any volume, while the calls of one PDF
read, which may be four or two thousand to a point, are right over many reads and not for one.
A tally
begins at most 48 sums. A call that would begin another is summed by source, service, event type
and outcome alone, under the operation `other` with no reason, detail, status or code, so what a
service answers cannot take a flush past the limit: a flush writes at most those 48 points and
one `other` point for each combination of source, service, event type and outcome its callers
name. A call added to a tally after its last flush is never written.

Four queries, in Analytics Engine SQL, against `gadgets_metrics_v1`. PDF conversions a day, by how
they ended:

```sql
SELECT
  toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
  blob7 AS outcome,
  blob11 AS reason,
  SUM(_sample_interval * double5) AS conversions
FROM gadgets_metrics_v1
WHERE blob1 = 'subservice/v1' AND blob9 = 'workers-ai' AND blob10 = 'to-markdown'
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, outcome, reason
ORDER BY day
```

Workers AI calls, with the share of them that was refused and the share that failed, by operation:

```sql
SELECT
  blob10 AS operation,
  SUM(_sample_interval * double5) AS calls,
  SUM(IF(blob7 = 'refused', _sample_interval * double5, 0.0))
    / SUM(_sample_interval * double5) AS refused_rate,
  SUM(IF(blob7 = 'error', _sample_interval * double5, 0.0))
    / SUM(_sample_interval * double5) AS error_rate
FROM gadgets_metrics_v1
WHERE blob1 = 'subservice/v1' AND blob9 = 'workers-ai'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY operation
```

How often a PDF was opened again in the renderer, by why the document before it was lost
(`blob12`) and how the reopen itself ended (`blob7`, `blob11`), and how often the renderer let a
document go because a call for it was cut off, which is the row whose `event` is `release`:

```sql
SELECT
  blob2 AS event,
  blob10 AS operation,
  blob12 AS cause,
  blob7 AS outcome,
  blob11 AS reason,
  SUM(_sample_interval * double5) AS times
FROM gadgets_metrics_v1
WHERE blob1 = 'subservice/v1' AND blob9 = 'pdf-renderer'
  AND (blob10 = 'reopen' OR (blob2 = 'release' AND blob11 = 'cut-off'))
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY event, operation, cause, outcome, reason
```

Google API requests and the share of them that failed, by service and operation:

```sql
SELECT
  blob9 AS service,
  blob10 AS operation,
  SUM(_sample_interval * double5) AS requests,
  SUM(IF(blob7 = 'error', _sample_interval * double5, 0.0))
    / SUM(_sample_interval * double5) AS error_rate
FROM gadgets_metrics_v1
WHERE blob1 = 'subservice/v1' AND blob8 = 'gatekeeper.google.api'
  AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY service, operation
ORDER BY requests DESC
```
