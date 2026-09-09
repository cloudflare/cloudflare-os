# Jira Gatekeeper

Dedicated Jira Cloud gatekeeper for Work Items-compatible agents. It exposes capability-scoped
sessions for a Jira site, project, or issue; uses Atlassian OAuth 2.0 (3LO) through
`api.atlassian.com`; stores rotating refresh tokens in a `UserAccount` Durable Object; and routes
reads through observation authorization and writes through the approval queue.

No production OAuth client secret is committed. Set `CLIENT_ID`, `CLIENT_SECRET`, and `BASE_URL` in
the deployment environment.

## Site selection

A connection uses exactly one Jira site. The chosen `cloudId` is persisted as `selectedSite`, and
every site-scoped path resolves through it: resource binding, the configurators' live project and
issue search, Work Items search, the observer verifier, and the default project. Other sites the
same OAuth token can reach are never queried.

Atlassian's consent callback returns only `code` and `state`; it does not report the site the user
picked on the consent screen, and `accessible-resources` documents no ordering. The site is
therefore always resolved explicitly rather than inferred from the callback or from array position:

- One accessible site: selected automatically.
- Several accessible sites: the OAuth browser flow renders a chooser and completes only after the
  user picks. Until then the exchanged grant is held in `pendingSelection` and is unusable — no
  `grant`, no `complete()` callback. The chooser posts back a single-use nonce under
  `form-action 'self'`; replayed, expired, or malformed state is refused, and an abandoned chooser
  is dropped by the existing cleanup alarm.
- Connections made before selection existed migrate on first use only when exactly one site is
  accessible. With several, nothing is chosen for them: site-scoped calls fail with a message
  telling the user to reconnect and choose. A default project never implies a site.
- Reconnect keeps the site it already uses. If the new authorization no longer includes that site,
  the reconnect fails with that site named and the previous grant, sites, and selection are left
  untouched — it never moves existing bindings to a different site. When Atlassian resource
  discovery fails during reconnect, the new authorization is refused and the existing connection
  remains unchanged. Empty site lists cannot complete a connection either.

Enforcement is at token issuance, not only at listing: gatekeeper bindings persist their `cloudId`
and request tokens through `getAccessTokenForSite(cloudId)`, so a capability stored before
selection — or for a site the connection no longer uses — is refused rather than silently served.

## Search and identity

`JiraSite.searchIssues(options)` and `JiraProject.searchIssues(options)` still return an RPC
`Cursor` with `next()`. All issue searches (including configurators, coding tools and Work Items)
use `POST /rest/api/3/search/jql`, with opaque `nextPageToken` pagination rather than `startAt`
or `total`. Empty or sort-only queries gain `created >= "1970-01-01"` because enhanced search
requires a search restriction. Issues with imported creation dates before 1970 require explicit
bounded JQL. Search fields are explicit; attachments remain available via issue methods.

Call `next()` sequentially until it returns `null`, then dispose the cursor. A short or empty
batch does not imply exhaustion. Failed observations do not advance the cursor. Work Items keeps
the selected site's token in its existing `{ "<cloudId>": token | null }` cursor map, so an
unvisited start stays distinct from an exhausted one. Existing numeric Work Items offset cursors
cannot be translated; they fail with a restart-search message rather than silently duplicating
results. The Work Items consumer treats cursor strings as opaque and keeps them in page state, not
saved views. The Jira source reports `hasMore.jira` and omits the optional `completeness` field, so
Work Items composition derives Jira exhaustion from `hasMore`.

The `jira_search` coding-session tool paginates too, rather than stopping at the first page. It
returns `hasMore` and, while more pages exist, a `nextCursor` to pass back with the same query:

```jsonc
{ "items": [/* ... */], "hasMore": true, "nextCursor": "eyJqcWwiOi..." }
```

The cursor is a base64url envelope carrying Jira's opaque `nextPageToken` alongside the JQL it came
from. Every continuation re-derives the JQL from the binding's own scope and query and requires an
exact match, so a project-scoped cursor cannot be replayed against a site-scoped search or a
different query; malformed cursors are rejected before any request is sent. Shipped callers that
ignore the new fields keep reading `items` unchanged.

For "my issues", no email is needed:

```ts
using cursor = await JIRA_PROJECT.searchIssues({ assignedToMe: true, maxResults: 20 });
const batch = await cursor.next();
```

On a site grant, richer queries can use Jira's `currentUser()` function:

```ts
using cursor = await JIRA_SITE.searchIssues({
  jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
});
```

`getCurrentUser()` on site and project sessions reads `/myself` with the connected OAuth token
and authorizes a private-only observation before returning the normalized `JiraUser`. Its
`accountId` can be used for assignment; email may be hidden by Atlassian privacy settings and
should not be requested as a fallback. This method is intentionally absent from shareable
issue-only capabilities. No additional OAuth scopes are requested (`read:jira-user` already exists).

The Jira Work Items source `search` also accepts `assignedToMe?: boolean`, locally extending the
shared request type. It adds `assignee = currentUser()` to the provider query before pagination
on every site; it never treats reporting/requesting an issue as assignment.

## Issue workflows

- Discover creation types with `project.listIssueTypes()`.
- `project.listStatuses()` returns distinct workflow statuses, flattened from Jira's issue-type
  groups. Status IDs are not transition IDs.
- Open an issue and call `issue.listTransitions()` to discover currently allowed transitions,
  then `issue.transition(idOrName, { fields, commentMarkdown })` as needed. Jira enforces workflow
  permissions and required fields; custom transition-screen fields are not exposed by this API.
- `createIssue()` immediately returns an action-backed pending issue session. Submission does not
  wait for application: `awaitDecision` is only a harness hint. Each issue operation checks the
  stored creation outcome once, reports pending/rejected/failed state promptly, and resolves the
  eventual Jira key after application. Retry the same session when pending, not `createIssue()`;
  no polling or duplicate submission occurs. Creation stores Jira's minimal `{id, key}` result
  without assuming it contains full issue fields.
- Writes retain the existing approval queue and auto-approval policy. Search is eventually
  consistent; read a known issue directly rather than assuming an immediate search reflects a write.

## References

Verified against Atlassian's current documentation and OpenAPI on 2026-09-09 (Context7 was
attempted first but unavailable due to its monthly quota).

- [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) —
  the callback returns only `code` and `state`; the consent screen's site choice is not reported
  back, and `state` is required for CSRF protection.
- [Get the cloudid for your site](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#3-1-get-the-cloudid-for-your-site) —
  apps must always call `accessible-resources` to learn which sites a token can reach; no ordering
  of that array is documented, so position must not be treated as a selection.
- [Accessible resources](https://developer.atlassian.com/cloud/oauth/getting-started/making-calls-to-api/)
- [Enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post)
- [Current user](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/#api-rest-api-3-myself-get)
- [Project statuses](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/#api-rest-api-3-project-projectidorkey-statuses-get)
- [Create issue and transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [JQL functions](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/#currentUser--)
- [Official OpenAPI](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json)
