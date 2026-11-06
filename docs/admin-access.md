# Admin access: the admin audit log

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) change
its settings through the admin panel and the API. This document is the design record for the
deployment-wide log of those changes, which says afterwards who changed which setting, and when.
The API itself is documented on `AdminApi` in `packages/workshop-shared/src/api.ts`; the pieces
are:

| Concern | Location |
| --- | --- |
| Admin status | `packages/workshop-backend/src/auth/config.ts` |
| The environment's bound, validation, the audit's text bounds | `packages/workshop-backend/src/admin-access.ts` |
| The `AdminApi` capability (`AdminApiImpl`) and the settings audit (`AdminSettings`) | `packages/workshop-backend/src/admin-settings.ts` |
| Diffing a settings change (`diffAdminConfig`) | `packages/workshop-backend/src/admin-config.ts` |
| The deployment-wide audit log (`AdminAuditDurableObject`) | `packages/workshop-backend/src/admin-audit.ts` |
| The admin panel's Audit tab | `packages/workshop-frontend/src/features/admin-audit/` |

## Entry points

Everything goes through `AuthenticatedApi.getAdminApi()`, which returns null unless the
caller is an admin. The admin check runs once, when the capability is minted.

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminAuditRetentionDays()`. Every setter is audited.
- **The audit log**: `listAdminAudit()` and `getAdminAuditStats()`.

Each record's `via` (`AdminVia`) comes from the session's User-Agent: `"cli"` when the `/api`
upgrade names `cf-os api` (`cf-os-api/<version>`), `"api"` for any other client, the Workshop's
admin panel included. A client can send any User-Agent, so it labels records and grants nothing.
Each capability mints a random `sessionId`, so every record made through one `getAdminApi()` call
shares its `via` and `sessionId` and can be read as one session.

## Retention and its bound

### The environment's bound

A backend variable bounds what admins may choose. It is an environment variable for the reason
authentication config is (`auth/config.ts`): a compromised admin session must not be able to
shorten the log.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ADMIN_AUDIT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ADMIN_AUDIT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days the audit log keeps a record, whatever admins choose. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bound wherever it is enforced: the settings audit and the audit log's own floor.
`getSettings()` reports `chosen`, the bound (`min`), and `effective`, which is what is enforced. The
setter refuses a value below the bound, naming the variable; a choice stored before the bound rose
is kept but not enforced.

### Setting the bound

It is a variable of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set it in the shell or in the root `.dev.vars`;
  `scripts/run-dev-server.ts` passes it through to the backend.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries this variable its deployments run
  with the default. Any redeploy that writes its own variables must carry it.

### When a variable is dropped

The floor falls back to 90 days, and with it the retention actually kept wherever the admins chose
less, which prunes the older records. So set the retention you want in the admin panel too: the
admins' choice persists in the deployment's settings across deploys, while the floor only stops an
admin session from choosing less. The Audit tab says when the floor is what holds retention up; it saves only a value that is
typed, so type the number of days you want kept, even the minimum.

## The audit

### Records

An `AdminSettingRecord` (`kind: "setting"`) is one `AdminApi` setter's change. It holds `at`,
`admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
map or list setting, and its value `before` and `after`. `listAdminAudit()` filters by kind, admin,
method and time, the method read through an index on the record's `json_extract()`. A method no
record type names is refused (capnweb-validate checks it against the method union); one that no
logged record has gives an empty page. `getAdminAuditStats()` filters by kind.

### Setting records

Every setter is recorded before its change takes effect. `AdminSettings.#mutateAdminConfig()`, which
serializes every `AdminConfig` write, is the chokepoint: each admin-facing mutator takes a
trailing `AdminSettingActor` (who, which session, `via`, and the `AdminApi` method), and the
chokepoint records `diffAdminConfig(current, next)` before `storage.adminConfig.put(next)`.

- Strings are recorded as themselves, and other values as JSON with object keys sorted. Own
  properties only: model maps legitimately hold `__proto__` and `constructor` keys.
- Maps (`banner`, `disabledResources`, `ambientGatekeeperModes`, `modelModes`, `modelSettings`,
  `modelOrder`) are recorded per key. Formats (by blueprint id) and added models (by model id) are
  recorded per entry, and a change to their order as one more change, without `key`, holding both
  lists of ids. `providerOrder` is recorded as one change, holding both lists.
- A value is kept whole up to `MAX_ADMIN_AUDIT_VALUE_LENGTH` (10,000) characters, more than any
  bounded setting holds (the agent instructions are at most 8000). Only unbounded inputs pass it;
  then both values become excerpts starting a little before their first difference, with the offset
  and both whole lengths, so a change hidden behind a long prefix still shows. A cut from the end
  would hide exactly the edits an audit exists to show.
- Two writes the diff cannot see are recorded explicitly before they happen: the site logo, as
  `"default"` or a logo's size and SHA-256 (never its bytes), which R2 keeps beside the logo, so
  uploading the logo already stored records nothing; a logo stored without its digest, before
  logos were recorded, is `"custom"`; and featuring a blueprint, whose bit lives in its owner's
  user DO.
- A call that changes nothing records nothing (it is still written, since it may be a retry
  repairing the KV mirror). A record is kept if the change then fails, for example when the KV
  mirror write fails and the config is rolled back: it records the attempt.

Not recorded: reads (`getSettings`, `isBlueprintFeatured`, `getUpdateStatus` and the audit log
itself), the gateway tests, `checkForUpdates`, and the deployment's own promotion of its
bundled formats, which no admin made.

### Text bounds

Setting keys are cut to `MAX_ADMIN_AUDIT_ARG_LENGTH` (256) characters by `cutAdminAuditText()`, the
last character replaced with `…` and never splitting a surrogate pair: a record marks its cuts,
never passing a fragment off as the whole. Values are capped at 10,000 with excerpts, and a setter's
diff has a bounded number of changes, so every record, and every page of them, is bounded.

The store keeps each field once: kind, time and admin in columns, the rest as JSON.

### Retention and pruning

The log keeps a record for the effective retention (`adminAuditRetentionDays`, default 90 days,
never below the floor). It deletes up to 1000 expired rows at the start of each call and never lists
or counts one, and it holds the floor itself whatever retention a caller passes.

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), and the ten admins with the most
records. A window reaching past the retention counts nothing there.

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: the bound's parsing, the policy, validation, the cuts, and setting values
  and excerpts.
- `admin-config.test.ts` (`diffAdminConfig`) and `admin-settings-audit.test.ts`: what each setter
  records, before which write, and the retention's bound.
- `admin-audit.test.ts`: the log's listing, filters, cursors, schema, retention and stats.
- `admin-api-impl.test.ts`: who `AdminApiImpl` records as making a change, and its forwarding of
  listings and statistics.
- `cli-admins-only.test.ts`: the `via` a session's User-Agent gives its records.

Integration suites, in `packages/integration-tests/__tests__/`:

- `workshop-admin-audit.test.ts`: every setting change recorded before it takes effect, sessions,
  filters, stats across two admins, and a refused change when its record cannot be written.
- `workshop-admin-bounds.test.ts`: the bound's default, and a redeploy that raises it and demotes an
  admin, whose records stay.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the log with a trigger on `admin_audit`, and adds a workspace row for the kind filter to
leave out.
