# Cloudflare gatekeeper

Cloudflare OAuth, serving three unrelated purposes from one connected account — sign-in
(`AUTH_GATEKEEPERS`), AI Gateway billing, and **Workers Observability** read-only telemetry
resources. Two resource granularities (whole account, or one Worker) both map to the single
indivisible `workers-observability.read` scope, so the capability boundary is the *binding*, not the
grant.

- Layering: `observability-api.ts` is the only place that talks HTTP; `observability-parse.ts`
  validates every response (no blind casts); `observability-session.ts` is the agent-facing session,
  where every read funnels through one `#observe` so no path returns data unaudited;
  `observability-discovery.ts` derives field names/values from a sampled events query.
- Scopes fail closed to `BILLING_SCOPES`, and an omitted `resourceUrlPatterns` ("all resource types")
  is distinct from `[]` ("none"): a billing-only connection must not silently acquire telemetry
  access, and recording a wider grant than was made would make `ensureResources` short-circuit into a
  binding that 403s with no way to re-prompt.
- Three provider behaviours return wrong-but-plausible data with no error, so none is trusted (all
  verified against a live account):
  - `telemetry/keys`/`values` **ignore** the `filters` they accept, so a constrained discovery call is
    answered from a filtered `telemetry/query` sample or it would disclose the whole account;
  - an unknown filter key matches nothing, which bites because a log's own fields are returned nested
    under `source` but indexed under their *bare* name (`{event: "x"}` → `source.event`, queried as
    `event`, hence `observabilityFieldKey` accepting the `source.` alias wherever a caller names a
    field);
  - `/accounts` pages at 20 by default, so it must be walked to the end.
- Worker-scoped bindings prepend an immutable `$metadata.service` filter *and* re-filter the
  response, since a filter the provider silently ignored would leak another Worker's telemetry. A
  dropped event proves the filter was not applied, so the provider's own `count` is then withheld
  rather than reported (it would count the whole account) and the drop is logged at `error`;
  `statistics` is kept, since it describes what the query cost rather than how much matched.
  Pagination cursors come from the provider's raw events rather than the surviving ones, so a
  fully-foreign page can't stall pagination and hide the caller's own older data.
- Trace *summaries* are account-only (their shape describes the whole cross-service trace); a Worker
  binding can still fetch its own events for a known trace id.
- `calculate()` is the one read with no second line of defence — an aggregate can't be un-mixed — so
  it rests solely on the injected filter; that is accepted and documented on the method, with the
  group-by fix left as a follow-up.
- A provider error message can quote a caller-supplied filter value back, so only its numeric `codes`
  are logged — filter *values* stay out of the audit trail (`summarizeFilter`), and the message
  travels to the caller who caused it.

## Tests and configurators

- Tests are two vitest projects: `vitest.config.ts` (Node, pure logic) and `vitest.worker.config.ts`
  (workerd, for `RpcTarget`/`RpcStub`/Durable Objects). The workerd suite reaches the gatekeeper
  through a `TestHooks` Durable Object because a `DurableObjectClass` carrying `ctx.props` is only
  reachable via `ctx.facets` — the way the overseer instantiates it.
- `src/configurator/*.tsx` duplicate the resource-URL grammar from `resources.ts` and **must**:
  `build-gatekeeper-configurator.ts` transpiles each per-file, stripping only
  `@gadgets/configurator-ui` and type-only imports, so they cannot import runtime helpers.
  `__tests__/configurator-url.test.ts` keeps the copies in step, and `configurator-fields.test.ts`
  drives `render` against a mocked runtime — the runtime's `clearFields` only drops an
  autocomplete's typed query, so a dependent field must *also* be nulled through `setValues` or the
  stale value silently survives into the resource URL.
