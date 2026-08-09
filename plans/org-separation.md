# Org separation within a deployment — Analysis & Plan

One customer, one airgapped deployment, several internal orgs — Engineering, Legal, Finance —
sharing the GPU cluster the customer bought while keeping their workspaces apart.

Not cross-customer isolation: separate customers get separate airgapped networks, and there is no
route between them. See `fieldos.md`.

## Current state (one paragraph)

Nothing models orgs. Separation today comes from a per-workspace sharing graph (`sharing.ts`) that
grants access by reachability from a single owner and knows nothing of groups, plus a flat
deployment-wide `ADMINS` list and one `AdminConfig`. The Context gatekeeper has a `sharingDomain`
namespacing scheme whose own source says it "is not a boundary against malicious peer configs" —
the cautionary example lives in this repo.

## The constraint that shapes everything

`openGadget(id)` (`server.ts`) takes a **raw Durable Object id from the client** and resolves it
directly with `idFromString`, without looking it up through the caller's records. Authorization
happens *inside* `Overseer.open()`.

**Therefore an org boundary implemented as a listing filter is worthless** — anyone holding an id
bypasses it. The check must be an authorization decision at a real chokepoint. If we cannot name
the line where it runs, we have rebuilt `sharingDomain`.

The good news: there are only **two** such chokepoints.

## Core decisions

**1. Container, not grouping — the data model already chose.**
A workspace has exactly one `ownerId`, set at creation, and **ownership is immutable** (no
`transferOwner` exists anywhere). Sharing is reachability from that owner. That is structurally a
container, and "org" generalizes cleanly from "owner". A grouping model — resources shared *to*
groups — would fight the design: the sharing graph holds individual profile ids, so group-valued
edges would need a directory to resolve them.

**2. The org is stamped on the workspace, not resolved through its owner.**
This is the decision most likely to be got wrong, and it only shows up later.

Checking `orgOf(caller) === orgOf(owner)` seems natural and is a trap. Ownership is immutable and
there is no offboarding path, so when someone moves Engineering → Legal, **every workspace they own
silently moves with them**: an Engineering project becomes a Legal project and its Engineering
collaborators lose access, with no admin action and no warning. Deriving the org from an IdP claim
makes this worse, since the claim flips the moment HR moves the person.

So the Overseer stores its own `orgId`, snapshotted from the creator at creation. The check is
`orgOf(caller) === workspace.orgId`. A person changing teams does not drag their workspaces along,
an admin can reassign a workspace without touching ownership, and the non-owner path needs one
lookup rather than two.

Every mature product treats resource ownership as transferable and orphaned resources as a known
failure: GitHub documents repository transfer under "best practices for leaving your company";
Notion built a "Recently Left" lost-and-found with a 30-day window and a content transfer API. We
are not building offboarding, but the design must not foreclose it.

**3. Membership comes from an IdP claim, under a configurable name, failing closed.**
There is **no standard claim name** — GitLab exposes `groups_attribute`, Grafana requires a groups
mapper on the Keycloak client. So `OIDC_GROUPS_CLAIM` is configuration, not a constant.

**A missing claim means no org, never a default org.** This matters concretely: above **200 groups
(JWT) / 150 (SAML)** Microsoft Entra **omits the groups claim entirely** and substitutes a pointer
to Microsoft Graph — an internet endpoint, unreachable from an airgapped network. A user in 250
groups would otherwise silently land in whichever org we defaulted to. Entra deployments must be
configured to emit only groups assigned to the application; that is a **hard requirement to
document**, not a tip.

**4. Cross-org sharing: admin-configurable, default deny.**
One `AdminConfig` boolean checked in the same `open()` branch, following the repo's existing
default-enabled/admin-opts-out convention. Classified deployments leave it off; deployments that
need Legal to review an Engineering tool turn it on.

**5. Blueprints stay deployment-wide. Deferred, deliberately.**
A blueprint is a recipe — code and metadata — and the data boundary is the workspace. Scoping them
breaks the deliberately public `PublicApi.getBlueprint`, which the deploy wizard and screenshot
serving depend on, and needs a new field, admin UI and migration.

Recorded so the tradeoff is not lost: blueprints are fetchable **unauthenticated, by id**, and a
blueprint reveals schemas, API shapes and internal terminology. In a deployment where "what Legal
is working on" is itself sensitive, this is a real leak. Revisit on customer objection.

**6. Admins stay flat and global.**
Per-org admin would require an `orgId` scope on every `AdminConfig` field, re-keying the
`AdminSettings` DO away from its `getByName("")` singleton, changing every `updateAdminConfig` call
site, and a per-org KV mirror key. In an airgapped single-customer deployment one IT/security team
plausibly administers the whole box. Revisit on explicit demand, not speculatively.

## Enforcement: two chokepoints

**Chokepoint 1 — `Overseer.open()`, the non-owner branch.**
Today: `prohibitAllSharing` check → optional `redeemShareKey` → `getEffectiveRole` → deny if none.
The org check goes beside `getEffectiveRole`. The owner path — the overwhelming majority of opens —
is untouched.

No bypass exists: every path that mints an Overseer stub funnels here, including
`newGadgetFromBlueprint` (which calls `openGadget` internally) and share-link redemption.

**Share links need no org awareness.** A link is a bearer token; redemption only edits the
permission graph, and the access decision still happens in `open()`. A cross-org link is denied
there. `sharing.ts` never learns orgs exist — correct layering, so do not touch it.

**Chokepoint 2 — Context Library public collections.**
`#assertCanRead` (`context-api.ts`) grants on `isPublic` with no org dimension, and this path
**never passes through `open()`**. Under org separation a Legal-authored public collection would be
readable by Engineering. Public collections get an `orgId` tag; the registry listing and
`hasCollectionAccess` filter on it. Untagged means all-orgs, for back-compat.

Private collections need nothing — already per-account, never shared.

**Hooks and scheduled tasks are a non-issue.** They fire inside the same Overseer DO or
account-scoped `ScheduleDriver`, with no cross-identity RPC, and inherit the workspace's authority
— which the org check already constrains.

## Where membership is stored

`orgId` on `UserDurableObject`, written at sign-in from the claim, mirrored to KV exactly as
`AdminSettings` mirrors `.adminConfig`, so the hot path is one cheap KV get.

Rejected: a separate `OrgDurableObject` (a second DO round-trip on the hottest path, to answer a
question that is a property of the user alone), and carrying the org in the session (session tokens
are opaque bearer strings re-validated per call, not JWTs re-parsed per request — so this collapses
back to the same field).

## The failure mode to design against

The research is unambiguous: with IdP group claims, **the thing that actually goes wrong is
misconfiguration that looks like it worked**. GitLab and Grafana's open issues are the same shape —
the claim is present and correct, the mapping silently does not apply, and the user is created
without the expected access. Teams "forget to map default scopes".

Nobody stages membership changes for review; every product re-syncs silently on login, so building
an approval workflow would be inventing a mechanism the industry does not have.

The useful mitigation is different: **let an admin see what a sign-in resolves to before
enforcement is switched on.** A dry run beats an approval flow, and it addresses the failure that
actually happens.

Slack's Enterprise Grid migration reinforces this — its failures were identity-shaped:
email-alias mismatches creating duplicate accounts, and mandatory SSO locking users out where the
IdP had not been configured first. Get identity right *before* enforcement goes on, and do not make
the rollout a one-way door.

## Phases

**Phase 1 — membership, observable, not enforcing. — DONE.**
Shipped in four slices: `resolveOrg()` in `gatekeeper-oidc`; `orgId` on `UserDurableObject` written
on every sign-in; `orgId` stamped on the Overseer at creation; `getOrgForUser()` for the admin
read-out. Nothing denies anyone yet.

Two corrections made during implementation, both worth keeping:
- **The KV mirror was dropped.** It exists for `AdminConfig` because that is one document read by
  every connection. Org membership is per-user and `open()` already holds the user namespace, so a
  mirror would have added a second storage system and a staleness window to save a round-trip that
  may not exist.
- **Two paths create a workspace**, not one: `open()`'s first-open block and
  `receiveExternalMessage()`. Stamping only the first would leave every externally-created
  workspace permanently untagged — a hole from day one rather than a legacy-data question.

*Original scope, for reference:*
`OIDC_GROUPS_CLAIM` in `gatekeeper-oidc`; `orgId` on `UserDurableObject` written at sign-in and
KV-mirrored; `orgId` stamped on the Overseer at creation; an admin read-out showing the resolved
org for a user. **Nothing is denied yet.** Done when an admin can confirm every user resolves to
the org they expect.

**Phase 2 — enforcement.**
The check in `open()`'s non-owner branch, plus `allowCrossOrgSharing` in `AdminConfig`, behind an
`ENABLE_ORG_SEPARATION` flag so Phase 1 can be verified in production first and the rollout is not
one-way. Done when a cross-org open is denied and the flag can be turned off again cleanly.

**Phase 3 — the second chokepoint.**
`orgId` on public Context collections; registry listing and `hasCollectionAccess` filter on it.
Done when a Legal-authored public collection is invisible to Engineering.

**Not building:** per-org admin scoping, blueprint scoping, a user directory or "list users in
org X", an invite flow, and any approval workflow for membership changes.

## Risks

| Risk | Mitigation |
|---|---|
| **Entra group overage** silently produces no claim above 200 groups, and the Graph fallback is unreachable airgapped. | Fail closed on a missing claim. Document "emit only groups assigned to the application" as a hard requirement. Surface it in the admin read-out. |
| **Silent claim misconfiguration** — the failure that actually happens in comparable products. | Phase 1 ships observable-but-not-enforcing precisely for this; the admin read-out is the mitigation, not a nice-to-have. |
| **A user with no org** cannot reach anything org-scoped. Correct, but looks like an outage. | Distinct error, not a generic denial. The admin read-out must show "no org resolved" plainly. |
| **The mover problem** — the trap this design exists to avoid. | Org stamped on the workspace, never resolved through the owner. |
| **No offboarding path** means a departed user's workspaces are unreachable. Pre-existing, worsened by orgs. | Out of scope, recorded. Notion's "Recently Left" is the pattern if it becomes real. |
