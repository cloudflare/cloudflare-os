# Microsoft 365 gatekeeper: design record

`packages/gatekeeper-microsoft` is one OAuth connection to a user's work or school Microsoft 365 account,
offering three resource types: **SharePoint & OneDrive** (this document), **Outlook** mail
([microsoft-outlook.md](microsoft-outlook.md)) and **Outlook Calendar** ([microsoft-calendar.md](microsoft-calendar.md)).
The connection, tenant policy, HTTP layer and observer verifier are shared, and described here.

It covers SharePoint Online and OneDrive for Business. SharePoint Embedded, consumer OneDrive and personal
Microsoft accounts are out of scope: no SharePoint endpoint accepts a personal account's token.

## Principles

1. **Delegated auth only.** An agent acts with the connected user's delegated permissions, so it can never
   reach more than the user can. Delegated `Sites.Read.All` means "what this user can read", never the whole
   tenant. The **binding** narrows that further and is the capability boundary; the gatekeeper enforces it.
2. **Stable IDs in props.** At bind time `getGatekeeperClassFor` resolves the resource URL to IDs and bakes them
   into the facet's props. Renaming or moving the object afterwards can neither break nor widen the binding.
3. **No passthrough.** Agents never send a raw Graph path, `$batch`, KQL or OData. List filters are structured
   fields compiled against the list's schema (`sharepoint-lists.ts`).
4. **Pre-authenticated URLs are bearer capabilities.** `@microsoft.graph.downloadUrl`,
   `@microsoft.graph.downloadUrlNoAuth`, the `302` from `/content` and copy-monitor URLs never reach the agent.
   Bytes stream through the gatekeeper, and every Graph object is rebuilt from an allowlist of fields
   (`graph-parse.ts`) rather than passed through.
5. **Search results are hints.** Every search hit is re-read and re-checked against the binding before it is
   returned. The Copilot Retrieval API is not used: it runs unscoped when its KQL filter is invalid, so it can
   never be a scope boundary.
6. **Every read is an observation; every change waits for approval**, is simulated until decided, and is applied
   with a version fence so a stale approval cannot overwrite newer work.

## Connection

- **OAuth.** Authorization code with PKCE, as a confidential web client against Entra's v2.0 endpoints, using
  the kit's `oauth-client`, `credentials`, `connect-handshake`, `credential-stage`, `connect-pages` and
  `preview-oauth`. The authorize request always sends `prompt=select_account` (a silent sign-in would bind
  whichever account the browser is signed into); a reconnect adds `login_hint` with the pinned user.
- **Tokens.** Access tokens last 60–90 minutes; refresh tokens slide for 90 days. `invalid_grant` and
  `interaction_required` (Conditional Access or MFA demanding a fresh sign-in) end the grant. Entra's v2
  refresh needs the scopes named, so the grant keeps `requestedScopes` and repeats them on every refresh.
- **Pinning.** The connection is pinned to `(tid, oid)` from the `id_token`, never email or UPN, which are
  mutable. The token is received directly from Entra's token endpoint over TLS, so (per OpenID Connect Core
  §3.1.3.7) its signature is not checked; its `aud` is, and its `oid` is confirmed against `GET /me` before
  anything is stored. A reconnect as anyone else is refused. The identity is re-read daily; a re-read naming
  another user is ignored.
- **Reconnect.** A reconnect URL is a bearer capability, so its grant is staged until the Workshop calls
  `commitReconnect(stageId)`. A reconnect re-requests every resource type the connection already holds, so it
  renews rather than narrows; `ensureResources` unions the scopes.
- **Disconnect.** Entra has no per-app refresh-token revocation (only "sign out everywhere"), so disconnecting
  forgets the tokens; the user can remove consent at myapps.microsoft.com. A grant a callback refuses is never
  stored.
- **SharePoint host.** The account records its tenant's SharePoint name (`contoso` for `contoso.sharepoint.com`)
  from `GET /sites/root`. A user with no SharePoint license gets a 403 or 404 there and connects without one; a
  SharePoint binding then fails with an explanation. A SharePoint URL on any other tenant's host is refused.

### Admin consent

Microsoft's default user-consent policy excludes `Sites.*.All` and `Files.*.All`, so in practice a tenant
administrator grants consent once. The callback recognizes `consent_required` and `AADSTS65001`/`90094`/`90095`
and shows a page with the tenant's admin-consent link; `AADSTS50020`/`500200`/`50194` (an account from a tenant
this deployment doesn't accept) and `AADSTS53000`/`53001`/`53003` (Conditional Access) get their own
explanations. All scopes are listed statically on the app registration, because "Grant admin consent" only
grants listed scopes.

## Deployment settings

Identity and tenant wiring are env vars, deliberately outside the admin UI (see `deploy-inputs.json`):

| Var | Purpose |
|---|---|
| `CLIENT_ID` / `CLIENT_SECRET` | The deployment's Entra app registration. The secret is sent in the POST body: a secret may contain characters raw Basic encoding mangles. |
| `MICROSOFT_TENANT_ID` | The authority: a tenant GUID or verified domain, or `organizations` (the default). |
| `MICROSOFT_ALLOWED_TENANT_IDS` | Comma-separated tenant GUIDs, checked against the token's `tid`. Required with `organizations`. |
| `MICROSOFT_SHAREPOINT_ACCESS` | `write` (default) or `read`. |
| `MICROSOFT_SHAREPOINT_SITES` | `all` (default) or `selected`: whether connections ask for every site the user can open or only the sites a SharePoint admin grants the app (`Sites.Selected`). |
| `MICROSOFT_OUTLOOK_ACCESS`, `MICROSOFT_CALENDAR_ACCESS` | The Outlook and Calendar ceilings; see their plans. |
| `AI` binding | Workers AI, for reading PDFs and legacy Office formats. Optional. |

**Tenant policy** (`tenantPolicy` in `microsoft-env.ts`). `common` and `consumers` are refused (personal accounts
have no SharePoint), and `organizations` without an allowlist is refused (it would let any company's users
connect). An authority named by GUID is also compared with the token's `tid`; a guest passes, since their token
is issued by the resource tenant.

**Scopes.** Every connection requests `openid profile email offline_access User.Read`. SharePoint adds
`Sites.Read.All Files.Read.All` or the ReadWrite variants, by the ceiling. The **effective access** is the lower of
the ceiling and what the grant actually holds (`write` only with both ReadWrite scopes, since an admin may consent
to less than was asked). A connection made under `write` keeps only `read` once the ceiling is lowered. A file,
folder or library binding is also lowered to `read` when the user's own role on it is only `read`, as for something
shared with them to view. Graph reports that role as `shared.effectiveRoles`, which isn't documented, so it is only
ever used to lower access: where it's absent, the binding keeps `write` and SharePoint refuses what the user can't
do when the change is applied.

**Selected sites.** `MICROSOFT_SHAREPOINT_SITES=selected` asks for `Sites.Selected` and `Files.Read(Write)`
instead, for organizations that want Microsoft to limit the app to sites a SharePoint admin grants it (README,
"Only selected sites"). Step-by-step consent stays: we can't learn what an admin will allow before asking, and
asking for a permission they refused strands the user on Microsoft's "Need admin approval" page, so the setting
chooses what to ask for. What a connection *does* follows its grant (`grantedSharePoint`): both ReadWrite `.All`
permissions mean every site, whatever the setting; `Sites.Selected` alone means only granted sites, with the user's
own OneDrive only under `Files.Read(Write)`, and no Shared with you. Microsoft Search doesn't honor
`Sites.Selected`, and Graph answers any site's own metadata, so site listings and pasted site links keep only
sites whose library opens (`GET /sites/{id}/drive`); file hits, already read again as the user, drop out by
themselves. A site's grant role isn't readable with the user's token, so a
`read`-granted site still binds at the deployment's level and Microsoft refuses its changes at apply. A
read-only binding's session is a `SharePointReaderImpl`, a separate class with no write methods at all.

## The SharePoint resource

One resource, `https://*.sharepoint.com/*`, matches every SharePoint and OneDrive for Business URL, so a pasted
URL always pre-selects it. Which object it names, and so how much the binding covers, is decided asynchronously
with the user's token, by the configurator and by `getGatekeeperClassFor`. SharePoint paths are ambiguous
(`/sites/X/Foo` may be a library, a subsite or a folder), which a synchronous pattern match could not settle.

```ts
type SharePointScope =
  | { kind: "all" }                                       // everything the user can open
  | { kind: "site";    siteId: string }                   // host,siteCollectionId,webId
  | { kind: "library"; siteId: string; driveId: string }  // a document library, or a OneDrive
  | { kind: "folder";  siteId: string; driveId: string; itemId: string }
  | { kind: "file";    siteId: string; driveId: string; itemId: string }
  | { kind: "list";    siteId: string; listId: string }
  | { kind: "page";    siteId: string; pageId: string };
```

The resource URL is the object's `webUrl`. `describe()` returns a per-scope title and a `suggestedBindingName`
(`SHAREPOINT`, `SHAREPOINT_SITE`, `SHAREPOINT_LIBRARY`, `SHAREPOINT_FOLDER`, `SHAREPOINT_FILE`, `SHAREPOINT_LIST`,
`SHAREPOINT_PAGE`, or `ONEDRIVE` for a personal site). A site binding covers that site only: subsites have their
own permissions and are bound separately.

**URL resolution** (`sharepoint-resolve.ts`). `GET /shares/u!{base64url(url)}/{facet}` resolves almost every URL
the browser shows, not only sharing links, and redeems nothing (no `Prefer: redeemSharingLink` is sent). It has to
be asked for the right facet. The order: `/site` when the path is exactly a site path; `/listItem` for a
`SitePages/*.aspx` page; then `/driveItem`, then `/list`, then the longest site-path prefix that resolves.

### The session

One session class serves every scope, typed to the agent by what the scope reaches (`SharePointFileSession`,
`SharePointFolderSession`, `SharePointListScopeSession`, `SharePointPageReader`, and `SharePointSession` for a site or
everything, each with a `Reader` form in `types.d.ts`, built from shared fragments); `getScope()` says what it covers,
and anything outside it is refused with the same error whether or not it exists. The agent sees
opaque references that carry the container as well as the object (`ItemRef`, `ListRef`, `PageRef`), because a
Graph item ID is only addressable within its drive, and a list or page within its site. Paths are shown relative
to the binding's top, never above it.

Reads: sites (`listSites`, `getSite`), `resolveUrl`, folder listings, `getEntry`, `search`, `readFile` (text),
`readBytes`, `readWorkbook`, `readPresentation`, `listVersions`, lists (`openList`: columns, structured
`queryItems`, `getItem`) and pages (`listPages`, `readPage`).

### The scope guard

`ScopeGuard` (`sharepoint-scope.ts`) is the chokepoint. Every object an operation touches, and every row a listing
or search returns, is checked by ID before it is used:

| Scope | Covers |
|---|---|
| `all` | Everything the user can open |
| `site` | Drives and items whose site is the bound site, and its lists and pages |
| `library` | The bound drive |
| `folder` | The bound drive, where the item's ancestry, walked by `parentReference.id`, reaches the bound folder. A folder's proof is kept for a minute (`PROOF_TTL_MS` in `sharepoint-scope.ts`), and a listing's children inherit their parent's proof. |
| `file`, `list`, `page` | That exact object |

Cheap refusals (wrong drive, wrong item) come before any Graph call. A provisional `~N` ID, for something created
by an action still awaiting approval, is resolved through the overlay at every entry point; after approval it
resolves to the real ID.

**Search.** In a library or folder binding, `/drives/{id}/root/search` (which stays inside the drive but not
inside a folder); elsewhere Microsoft Search (`/search/query`) with a KQL `path:` filter for a site binding. Either
way each hit is re-read and passed through the guard. Agent words are sanitized so they cannot re-associate the
appended filter. A cursor reads at most three provider pages per call before answering "ask again".

**Lists.** `$filter` on a non-indexed column fails with 400 unless the request sends
`Prefer: HonorNonIndexedQueriesWarningMayFailRandomly`, which works only under the 5,000-item view threshold. The
header is sent only when the compiled query touches a non-indexed column; above the threshold the refusal is
explained, naming the column. `getColumns()` reports `indexed`.

## Content

Graph converts out of Office (`?format=pdf`) but has no document-to-text conversion and never converts into
Office. So (`sharepoint-content.ts`, `content/`):

- **Word and PowerPoint** are parsed in the Worker to Markdown.
- **Excel** is read through Graph's workbook API, which returns computed values and formulas and needs no session
  for reads.
- **PDF** goes through Workers AI's `toMarkdown` when the `AI` binding is present.
- **Legacy and OpenDocument formats** (`doc`, `ppt`, `xls`, `rtf`, `odt`, …) are rendered to PDF by Graph
  (`?format=pdf`, which redirects to the `*.svc.ms` media service), then through `toMarkdown`.
- **HTML and pages** go through a small HTML-to-Markdown converter. A page's canvas is flattened to reading order;
  only text web parts carry content Graph exposes, and the rest are named so the reader knows something is there.

Files over 25 MB are not read. Encrypted (sensitivity-labelled, MIP) files can't be converted.

### Writing native Office files

An agent's output should be a file people open, co-author and track as usual, so writes produce native formats:

| Intent | Method |
|---|---|
| A new report, memo or deck | `uploadFile("x.docx" \| "x.pptx", markdown)`: written in Word's built-in styles, or as a 16:9 deck, so the organization's theme and Word's navigation pane apply |
| …in the organization's look | `uploadFile(..., { template: fileId })`: the template's styles, theme, headers and footers, or masters and layouts |
| A new spreadsheet | `uploadFile("x.xlsx", rows \| csv)`: header bold and frozen; formulas allowed except those reaching outside the workbook (`WEBSERVICE`, `HYPERLINK`, `RTD`, external references) |
| Change part of a document | `editDocument`: find/replace and insert/delete paragraphs in place, keeping formatting, comments and images; recorded as tracked changes by default |
| Change part of a deck | `editPresentation`: text, slides and notes, in place; added slides are shown to the approver as the Markdown they are made from |
| Change cells | `updateCells` through the workbook API, which keeps every other cell, formula, format and chart |
| Start from an existing file | `copyFile`: Graph's own asynchronous copy, which keeps metadata and sensitivity label |
| Rewrite wholesale | `replaceFile`: allowed, but the approver is told what the old file had that the new one won't |

An in-place edit shows the approver only what it changes, so it is refused while a replace of the same file awaits
approval: approving it would also write the pending content, which it never shows. An Office file passed as bytes
gets the limits a written one has by construction (`content/package-check.ts`): no macros or ActiveX, nothing
fetched when it is opened (a remote template, linked picture or workbook link; links people click are allowed), no
DDE or content-fetching Word fields, and no formula the workbook writer refuses. `ifUnchanged` takes a version a read
returned; `*`, which Graph's If-Match would take as any version, is refused.

Generated files are checked by the contract suite: SharePoint renders them to PDF (proving Office Online opens
them) and the gatekeeper's own converters read them back.

## Changes

Actions (`sharepoint-actions.ts`, the kit's `defineActions`): create folder, upload, replace, edit document or
presentation, update cells, copy, rename, move (within one library), delete, and list item create, update and
delete. Upload bytes are captured with `action-files`, up to 25 MB each.

- **Simulation.** A read-time overlay (`sharepoint-overlay.ts`) applies pending actions: a pending upload appears
  in its folder with a provisional ID, a rename shows the new name, a delete drops out of listings, an item edit
  overlays its fields.
- **Fencing.** A replace or delete is applied only if the file's content is unchanged since it was proposed (Graph
  accepts the `cTag` in `If-Match`); a list item update is fenced on its eTag. The workbook API takes no
  `If-Match`, so `updateCells` compares the `cTag` just before writing. A rename or move is fenced only when the
  agent passes `ifUnchanged`. A stale tag answers `412` (`resourceModified` on a PATCH, `notAllowed` on a content
  PUT). Neither tag moves on a move, so every file apply also re-proves its target (and a destination or parent
  folder) through the binding's `ScopeGuard` before writing. A second change to a file's content is refused while
  one is pending: it could only be fenced on the first landing.
- **Claims.** Creates, uploads, copies, replaces and cell updates are `claimBeforeApply`: a replay after a crash
  would be refused as a duplicate name (indistinguishable from someone else's file, so never adopted) or, for a
  replace, fenced out by the tag its own write moved. A copy still running at the 45-second deadline is an
  `ActionOutcomeUnknownError`, since it lands later.
- **Revert.** A creation is deleted; a replace or cell update restores the previous version; a rename or move is
  put back; a list item's old values are written back. A delete cannot be reverted: Graph has no recycle-bin
  restore, so the approver is told the file goes to the site's recycle bin for 93 days.

Sharing actions (links, invitations, permission changes, sensitivity-label changes) are deliberately not offered:
they are the exfiltration path.

## Observers

A collaborator observes a binding only with a working Microsoft 365 connection of their own in the owner's
tenant, through their own `MicrosoftVerifier`; probes run with their token, never the owner's.

SharePoint breaks permission inheritance at any level, and listings are trimmed to what the reader can open, so
one container's ACL never vouches for its contents. Every read therefore names the objects it revealed as
**access units** (`sharepoint-observers.ts`, the kit's tracked-collection strategy, at most 2,000 per binding),
and an observer sees the read only if their account can open every unit. Units are probed by ID, twenty to a
`$batch`; a 403 or 404 means no access, and anything else (throttling, an outage) fails the check rather than
admitting.

Seeing an object is weaker than reading it, so a read names what it needed:

| Gap | Unit | Probe |
|---|---|---|
| Restricted View, block-download and unmanaged-device policies show a file but refuse its bytes | `content` on `readFile`, `readBytes`, `readWorkbook` | `GET items/{id}/content`: a 302 (never followed) means access |
| Version history is its own permission | `versions` on `listVersions` | `GET items/{id}/versions?$top=1` |
| A draft is shown only to editors; a reader opening the same ID gets the published version **with a 200** | `fileVersion` for a minor version, `listItemVersion` for a minor version or an item not approved, `pageVersion` for an unpublished page | The same read, passing only if the observer is shown the **same** version |

Only drafts are pinned, so a later publish doesn't lock observers out of old reads. A pinned unit fails closed: if
the draft is published or edited after the read, the observer is refused until a fresh read.

## Verified Graph behaviour

Verified against the live test tenant (see [Test tenant](#test-tenant)):

- **403 vs 404.** A user who can open the drive gets `404 itemNotFound` for an item hidden by broken inheritance and
  for an ID that doesn't exist; a user with no access to the drive or site gets `403 accessDenied` on everything.
  Neither reveals whether an item exists. `$batch` returns a status per request.
- **`parentReference` leaks across the boundary.** A user who can open only a shared subfolder still sees the
  parent's name and path, so paths are rebuilt relative to the binding. `parentReference.siteId` is a bare GUID,
  not the composite site ID; `sharepointIds` carry enough to build it.
- **Downloads.** `/content` redirects to the SharePoint host; `?format=pdf` redirects to `*.svc.ms`. `graph-api.ts`
  follows one redirect, only to those hosts, without the `Authorization` header.
- **`/sites?search=`** reads an index a new tenant leaves empty for days, so site search uses Microsoft Search
  plus `/me/followedSites` (which answers `200 []` when nothing is followed).
- **Search lags uploads by hours** on a new tenant, so nothing may depend on finding a fresh file.
- **`/sites/{id}/lists` omits Site Pages**, so whether a site has pages is asked of the pages endpoint.
- **Pages.** A communication site's template `Home.aspx` returns an empty `canvasLayout` through Graph; the agent is
  told such pages often have content Graph can't read. A page created through Graph reads back with exact `innerHtml`.
- **Delta works on a non-root folder** (`/items/{folderId}/delta`), including as a user who can open only that
  folder.
- **Visitors can read but not write:** `403` on PATCH, so a read probe never proves write access.

## Test tenant

The optional live suite (`__tests__/contract/`, `vitest.contract.config.ts`) runs against a test tenant with
three licensed users, signed in interactively so MFA and Conditional Access keep working. The package README's
"Live suite" section lists every fixture it needs (sites, OneDrive shares, calendars, mailbox permissions) and how
to set one up.

## Tests

- **Node** (`vitest.config.ts`): URL parsing and resolution, scope proofs, Graph parsing, list query compilation,
  content converters against fixture files, the overlay, observer units.
- **workerd** (`vitest.worker.config.ts`): the account Durable Object against a fake Entra and Graph (connect,
  pinning, every refusal, staged reconnects, refresh), and the gatekeeper through `TestHooks` facets.
- **Contract** (`vitest.contract.config.ts`): skipped unless `.dev.vars` and a tokens file are present. Covers
  every scope kind's reads and refusals, writes applied and reverted, Office files rendered by Microsoft 365,
  observers with real sharing, Outlook and Calendar.
