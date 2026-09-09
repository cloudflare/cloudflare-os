# Work Items Gatekeeper Shell

Provider-neutral, auto-provisioned Work Items management shell. The package owns only shell-local UI state: saved views and optional operational imports of saved views. It does not store Jira or Zendesk credentials, call provider HTTP APIs, or mint cross-gatekeeper server authority.

## Composition contract

The Workshop hosts this app as the visible shell with `composition: { kind: "work-items" }`. The iframe asks the Workshop host for `listCapabilities()` and `getCapability(id)`, then composes embedded-only source apps whose metadata is exactly:

- Jira: `{ kind: "work-items", role: "jira", embeddedOnly: true }`
- Zendesk: `{ kind: "work-items", role: "zendesk", embeddedOnly: true }`

Each source capability must implement `WorkItemsSourceManagementApi` from `src/types.d.ts`: `getCurrentUser`, `getSourceStatuses`, `search`, and `item`. Each per-item capability returned by `item()` must implement the full direct `WorkItemManagementApi` contract: `read`, `addComment`, `updateFields`, `transition`, `readAttachment`, `mediaCapabilities`, `createAttachment`, and `linkTo`. Missing source methods are isolated as disconnected contract errors so one healthy provider can continue. Missing per-item methods fail that item selection. Unavailable sources are tolerated only when the Workshop lists a source but `getCapability(id)` returns `null`, or when a method throws during a provider operation; those become source health or partial-search failures.

Source adapters must advertise provider options accurately. For example, a Zendesk adapter should return no transitions when transitions are unsupported, and unsupported operations must reject rather than returning placeholder success. The shell forwards direct management API results and does not unwrap queued action envelopes.

My work sends `assignedToMe: true` to each selected provider on every search page. Each source resolves its own authenticated assignee and applies the restriction before pagination; an unresolved identity must fail, never fall back to all items. The shell does not infer assignment from display names, email addresses, or requester fields. The manual Assignee/requester filter remains an explicit, exact filter over loaded results. Saved views and route state preserve assignment intent separately from that filter. Older built-in My work links discard their automatically inferred person token. The server intentionally exposes no `setCurrentUser` UI method, because the iframe is not an identity authority.

## Search completeness contract

`WorkItemSearchPage.completeness?: Partial<Record<WorkItemProviderKind, boolean>>` is the only signal that may be used to call a result set complete. The contract is deliberately minimal:

- `completeness[p] === true` — provider `p` exhausted its **entire matching source** for this query: no further pages, no ceiling truncation, no failure, no dropped items.
- `completeness[p] === false` — anything else: more pages remain, the provider stopped at a result ceiling, the provider failed, or malformed items were dropped.
- Key omitted — legal. Providers that do not report it (Jira today) are derived conservatively by the shell: complete only when `hasMore[p] !== true` **and** `truncated[p] !== true` **and** no `errors` entry names `p`.

Two rules follow from this and are enforced in `app/composition.ts`:

- **A missing cursor is never evidence of completeness.** A provider stopped at its ceiling also returns no cursor, so `truncated[p]` — not `cursors[p]` — distinguishes "done" from "gave up".
- **A provider is only trusted to say "incomplete".** A declared `true` is overridden whenever the shell itself observed a failure or dropped a malformed item for that source. Each source's page is also scoped to its own key, so one provider cannot seed another provider's cursor, `hasMore`, or `completeness`.

When the UI appends pages, `truncated` and `errors` are sticky: a provider that finishes paging later is still reported incomplete if an earlier page truncated, failed, or dropped items. The result list footer states either `Showing all N matching items.` or `Partial results: …` with the specific reason per provider; it never reports a complete set at a ceiling.

`WorkItemSearchRequest.exhaustive?: boolean` asks providers that have a large-query path to page their whole matching source instead of stopping at a ceiling. Providers without one ignore it. It must be set on the first page and kept unchanged while paging, because providers may serve it from a different endpoint with a different ordering, making cursors non-interchangeable. The shell offers it as **Load all matching results** after a provider reports `truncated` and a query or My work filter is present. It restarts the result set rather than appending, so offset and export pages are never mixed. Zendesk export requires a nonempty query and rejects `type:` terms; ticket scope is supplied by `filter[type]=ticket` instead.

## Agent and coding-session authority

This shell is UI-only. Provider gatekeepers own their own agent-facing sessions, approval queues, coding-session tool catalogs, and provider-specific credentials. The shell's singleton `WorkItemsSession` is only a lightweight readiness marker for discovery; it does not proxy provider operations server-side.

Agent type discovery returns only `src/agent-types.txt`, not the UI management contracts. `ping()` confirms shell installation, not provider connectivity.

## Setup and recovery

Each Workshop app open and provider retry freshly lists authorized management apps rather than relying on the navigation cache. Existing provider accounts are composed through their declared embedded UI and `getGatekeeperApp`; no provider singleton or ambient authority is added. Source frame failures remain visible as provider errors instead of disappearing from discovery.

Unavailable providers offer **Connect or manage Jira/Zendesk**, which opens the existing Workshop Connectors page for account selection, connection or reconnection. Return to Work Items after setup. **Retry Jira/Zendesk** reacquires the shell and source capabilities; search retries refresh provider status and results. A failed or unavailable search is not presented as a successful empty result.

## Saved-view migration

Saved views are bounded to 80 normalized entries. For operational migrations from another shell, the UI metadata capability exposes `importSavedViews(views)`, which replaces the shell's saved views after applying the same normalization, de-duplication by id, and bounds as ordinary saves. The operation is idempotent for already-normalized input. Orchestrators should call it once with user-approved exported view JSON; the shell does not read legacy provider storage by itself and does not infer saved views from provider accounts.

## Build notes

`src/types.txt` must remain a symlink to `types.d.ts`. `src/generated/app.txt` is generated from `app/` by `node build-app.mjs` and committed as package-local data for the Worker text module rule.
