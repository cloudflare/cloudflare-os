# Cloudflare gatekeeper

Cloudflare OAuth, serving three unrelated purposes from one connected account — sign-in
(`AUTH_GATEKEEPERS`), AI Gateway billing, and **Workers Observability** read-only telemetry
resources. Two resource granularities (whole account, or one Worker) share the
`workers-observability.read` scope; a Worker binding also needs `workers-tail.read`, the narrowest
scope the Workers API accepts for reading a Worker's ID, name and versions. The capability
boundary is the *binding*, not the grant.

- Layering: `observability-api.ts` is the only place that talks HTTP (`requestAccountApi`, which
  `workers-api.ts` also uses for Worker lookups); `observability-parse.ts` validates every response
  (no blind casts); `observability-session.ts` is the agent-facing session, where every read
  funnels through one `#observe` so no path returns data unaudited or without its subresource;
  `observability-discovery.ts` derives field names/values from a sampled events query.
- Scopes fail closed to `BILLING_SCOPES`, and an omitted `resourceUrlPatterns` ("all resource types")
  is distinct from `[]` ("none"): a billing-only connection must not silently acquire telemetry
  access, and recording a wider grant than was made would make `ensureResources` short-circuit into a
  binding that 403s with no way to re-prompt. A connection granted only `workers-observability.read`
  reports only the account type as granted, so connecting a Worker asks for `workers-tail.read`.
- Three provider behaviours return wrong-but-plausible data with no error, so none is trusted (all
  verified against a live account):
  - `telemetry/keys`/`values` **ignore** the `filters` they accept, so a constrained discovery call is
    answered from a filtered `telemetry/query` sample or it would disclose the whole account;
  - an unknown filter key matches nothing, which bites because a log's own fields are returned nested
    under `source` but indexed under their *bare* name (`{event: "x"}` → `source.event`, queried as
    `event`, hence `observabilityFieldKey` accepting the `source.` alias wherever a caller names a
    field);
  - `/accounts` pages at 20 by default, so it must be walked to the end.
- A Worker binding is pinned to the Worker's immutable ID (the Workers API's `id`, the legacy Scripts
  API's `tag`), which `getGatekeeperClassFor` resolves from the URL's name into the props the
  overseer stores. Telemetry carries no Worker ID — `$metadata.service` is the name an event was
  recorded under, which a rename frees and another Worker can take — so each read resolves the ID to
  the Worker's current name and versions (`workers-api.ts`, reused for a minute per binding). Its
  queries require that name *and* `$workers.scriptVersion.id in <versions>`, and every returned event
  is re-checked by version, since a version belongs to one Worker for good; nothing else proves an
  event's Worker. The version list is walked by ID, and the ID is looked up again afterwards
  because the Workers API also resolves the path segment as a *name*. A deleted Worker leaves the
  binding reading nothing, whoever takes the name. A binding stored before Worker IDs (a
  `workerName` without `workerId`) refuses every session, since nothing records which Worker it
  was granted.
- A dropped event proves the provider did not apply the scope filter, so the provider's own `count`
  is then withheld rather than reported (it would count the whole account) and the drop is logged at
  `error`; `statistics` is kept, since it describes what the query cost rather than how much
  matched. Pagination cursors come from the provider's raw events rather than the surviving ones, so
  a fully-foreign page can't stall pagination and hide the caller's own older data.
- Trace *summaries* are account-only (their shape describes the whole cross-service trace); a Worker
  binding can still fetch its own events for a known trace id.
- `calculate()` is the one read with no second line of defence — an aggregate can't be un-mixed — so
  it rests solely on the injected conditions; the name condition (whose `query` filtering is
  verified live) backs up the version one (documented, not yet live-verified). That is accepted and
  documented on the method, with the group-by fix left as a follow-up.
- Observers: every read reports one subresource, `account/<accountId>` or
  `account/<accountId>/worker/<workerId>`. `verifyObserverAccess` asks each observer's own
  `UserAccount` (`checkSubresourceAccess`): an account needs a telemetry read to succeed there, a
  Worker that as well as the Worker, looked up by ID, being visible; 400/401/403/404 deny, anything
  else throws. Scope grants are checked on every call, uncached. Each Cloudflare request's answer is
  cached in the observer's `UserAccount` across every workspace — allowed for 15 minutes, denied
  for 15 seconds — partitioned by the credentials that learned it; a check a reconnect overtakes
  throws, so one principal's account answer is never paired with another's Worker answer.
  `addObserver` still requires the binding's own subresource, and the whole account for a binding
  stored before Worker IDs.
- A provider error message can quote a caller-supplied filter value back, so only its numeric `codes`
  are logged — filter *values* stay out of the audit trail (`summarizeFilter`), and the message
  travels to the caller who caused it.

## Tests and configurators

- Tests are two vitest projects: `vitest.config.ts` (Node, pure logic) and `vitest.worker.config.ts`
  (workerd, for `RpcTarget`/`RpcStub`/Durable Objects). The workerd suite reaches the gatekeeper
  through a `TestHooks` Durable Object because a `DurableObjectClass` carrying `ctx.props` is only
  reachable via `ctx.facets` — the way the overseer instantiates it.
  `__tests__/workerd/cloudflare-backend.ts` stands in for the Cloudflare API per access token, and
  answers every telemetry query with every event, whatever its filters say, so a test sees exactly
  what the gatekeeper let through.
- `src/configurator/*.tsx` duplicate the resource-URL grammar from `resources.ts` and **must**:
  `build-gatekeeper-configurator.ts` transpiles each per-file, stripping only
  `@gadgets/configurator-ui` and type-only imports, so they cannot import runtime helpers.
  `__tests__/configurator-url.test.ts` keeps the copies in step, and `configurator-fields.test.ts`
  drives `render` against a mocked runtime — the runtime's `clearFields` only drops an
  autocomplete's typed query, so a dependent field must *also* be nulled through `setValues` or the
  stale value silently survives into the resource URL.
