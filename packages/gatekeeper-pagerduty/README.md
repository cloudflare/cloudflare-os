# Gatekeeper PagerDuty

Connects PagerDuty users to Gadgets. A gadget can read incidents, services, teams, schedules and
who is on call, and act on incidents and schedules as the connected user: acknowledge, resolve,
add notes, reassign, open incidents, put people on call. Nothing reaches PagerDuty until a user
approves it, or an auto-approval rule the user enabled for its kind applies it. Most pending
changes are shown to the gadget as if they had already happened, so a gadget keeps working while it
waits. Everything a gadget sees is what the connected user can see in PagerDuty.

Five resource types, each its own grant, all picked from one connect card:

| Resource | Link | What it reaches |
|---|---|---|
| PagerDuty Account | `https://<subdomain>.pagerduty.com` | Every incident, service, team and schedule the user can see. |
| PagerDuty Team | `…/teams/<id>` | The team's services and their incidents, its schedules and members. |
| PagerDuty Service | `…/service-directory/<id>` | One service and its incidents, and opening new incidents on it. |
| PagerDuty Incident | `…/incidents/<id>` | One incident: read it and change it. |
| PagerDuty Schedule | `…/schedules/<id>` | One on-call schedule: its shifts and overrides. |

EU accounts use `https://<subdomain>.eu.pagerduty.com` in place of the US host. A link to another
account than the connection's is refused.

## What a gadget can do

The full API is `src/types.d.ts`, which is also what agents read. In brief:

- **Account**, **Team** and **Service** list and open incidents (by default, open ones from the
  last 30 days), list who is on call, look up users by name or email, and list priorities. Account
  and Team also list and open services and schedules; a Team lists its members; a Service opens
  new incidents. Opening something from a broader binding returns the same interface a narrower
  binding gets, and a narrower binding refuses IDs outside it, such as another team's incident. A
  change to an incident that has since moved off the team or service it was reached through (the
  binding, or one opened from it), or to a service or schedule that has since left that team, is
  refused when it would apply; so is a listing's page of such an incident.
- **Incident** reads its details, log, notes and alerts, looks up users and lists priorities, and
  acknowledges, snoozes, resolves, reassigns, escalates, requests responders, sets the title,
  priority or urgency, adds notes and posts status updates. A resolved incident isn't
  acknowledged, since PagerDuty would reopen it: `acknowledge()` refuses one, and an
  acknowledgement waiting for approval fails if the incident is resolved by then.
- **Schedule** reads its details, shifts and overrides, looks up users, and adds or removes
  overrides. Both kinds of PagerDuty schedule are read, by the same IDs: layer-based ones from
  `/schedules`, shift-based ones from `/v3/schedules`, which is asked first for a schedule not yet
  known, as PagerDuty recommends, and refuses a layer-based one with 400. Listings give
  layer-based schedules first, then shift-based ones, whose rows carry only a name.

Methods that take a user accept an email or a PagerDuty ID. `getMetadata().you` is the connected
user, so "my incidents" is `listIncidents({ assignedToMe: true })`.

Account, Team, Service and Incident bindings can also `subscribe()` a gadget's hook to incident
events; see [Event hooks](#event-hooks).

## Actions

Each kind is a rule a user can enable for auto-approval. Kinds that page or email people outside
the binding, or delete, are never auto-approved.

| Kind | Methods | Auto-approvable |
|---|---|---|
| Acknowledge and snooze incidents | `acknowledge`, `snooze` | Yes |
| Resolve incidents | `resolve` | Yes |
| Change incidents' title, priority and urgency | `setTitle`, `setPriority`, `setUrgency` | Yes, except `setUrgency("high")`: pages responders, and resumes an acknowledged incident's escalation |
| Add notes to incidents | `addNote` | Yes |
| Reassign and escalate incidents | `reassign`, `escalate` | No: notifies the new assignees |
| Ask more people to respond to incidents | `requestResponders` | No: pages each responder |
| Post incident status updates | `postStatusUpdate` | No: emails subscribers and stakeholders |
| Open incidents | `createIncident` | No: pages whoever is on call |
| Add schedule overrides | `createOverride` | Only when it puts the connected user on call |
| Remove schedule overrides | `deleteOverride` | No: removes an override |

Approved changes can't be reverted automatically: PagerDuty's API has no undo for them.

## Setting up a PagerDuty app

The gatekeeper uses a private Scoped OAuth app, registered on the deployment's own PagerDuty
account (for example `acme.pagerduty.com`). Only that account's users can connect, US or EU alike.

1. Sign in as a Manager, Global Admin or Account Owner, and open **Integrations > Developer Tools
   > App Registration**. Select **New App**.
2. Give it a **Name** and a **Description**. Under **Functionality**, tick **OAuth 2.0** only,
   leaving **Events Integration** unticked, and continue to **Configure OAuth 2.0**.
3. Set **Authorization** to **Scoped OAuth**. The form starts on **Classic User OAuth**, which
   grants read or write on everything rather than the scopes below, and which the gatekeeper
   can't use.
4. Under **Redirect URL**, add `$PUBLIC_BASE_URL/gatekeeper/pagerduty/oauth`. **Add Redirect URL**
   takes more, such as the local development one below.
5. Under **Permission Scope**, grant these scopes, exactly what the gatekeeper's endpoints need
   (`SCOPES` in `src/pagerduty-env.ts`): `incidents.read`, `incidents.write`, `services.read`,
   `teams.read`, `users.read`, `schedules.read`, `schedules.write`, `oncalls.read`,
   `priorities.read`, `escalation_policies.read`.
6. Select **Register App**, and copy the **Client ID** and **Client Secret** into the deployment's
   `CLIENT_ID` and `CLIENT_SECRET`.

PagerDuty grants a scope the app lacks by silently leaving it out, so a connection missing any of
them is refused, naming the ones missing.

A deployment behind Cloudflare Access needs nothing more: users sign in on PagerDuty's own page,
which sends them through the account's SSO if it has one.

### Local development

Export `PAGERDUTY_CLIENT_ID` and `PAGERDUTY_CLIENT_SECRET` in your shell or the root `.dev.vars`;
`pnpm dev-server` maps them into the worker's `CLIENT_ID` and `CLIENT_SECRET`. Register
`http://localhost:8787/gatekeeper/pagerduty/oauth` as a redirect URL.

## Event hooks

A gadget subscribes through an account, team, service or incident binding (or one opened from
it), for some or all of these events: triggered, acknowledged, unacknowledged, resolved, reopened,
reassigned, escalated, delegated, priority updated, note added, responder added and status update
published. PagerDuty delivers them through one account-wide webhook that an admin sets up by hand.
Until the deployment has its signing secret, `subscribe()` throws "PagerDuty hooks are not
configured on this deployment." and everything else works as before.

1. Sign in as a Manager, Admin, Global Admin or Account Owner, and open **Integrations > Generic
   Webhooks (v3)**. Select **New Webhook**.
2. Set **Webhook URL** to `$PUBLIC_BASE_URL/gatekeeper/pagerduty/webhook`, **Scope Type** to
   **Account**, and give it a description, e.g. "Gadgets".
3. Under **Event Subscription**, tick exactly these: `incident.acknowledged`,
   `incident.annotated`, `incident.delegated`, `incident.escalated`, `incident.priority_updated`,
   `incident.reassigned`, `incident.reopened`, `incident.resolved`, `incident.responder.added`,
   `incident.status_update_published`, `incident.triggered` and `incident.unacknowledged`. Others
   are accepted and ignored.
4. Select **Add Webhook**, and copy the signing secret PagerDuty then shows. It is shown only once.
5. Set it as this worker's `PAGERDUTY_WEBHOOK_SECRET` secret, e.g. `wrangler secret put
   PAGERDUTY_WEBHOOK_SECRET` in this package, or in the worker's settings in the Cloudflare
   dashboard. It is not a deploy-wizard input, so a deployment without hooks installs as before.
6. If the deployment sits behind Cloudflare Access, add a bypass for
   `/gatekeeper/pagerduty/webhook`; the worker accepts only deliveries signed with the secret.

The worker checks each delivery's `X-PagerDuty-Signature` (any of several, so the secret can be
rotated), ignores an event it has already received or one more than a day old, and answers at
once. Each enabled hook whose binding could hold the incident is then called in the background: the
incident is read again as the hook's owner, and the event is dropped if they can't see it or it lies
outside the binding (another team's or service's incident). A hook's event carries the incident's
summary as it is at delivery and a capability to read and change it; its observation reports the
binding's resources plus the incident and its service. A note too long for PagerDuty to send whole
is read in full; a status update too long arrives without its message, which PagerDuty offers no
way to read.

Limits:

- **Events can be missed.** A hook that is disabled, or that fails eight attempts, misses them;
  so does everything PagerDuty sent while the webhook was misconfigured. A gadget that must see
  every incident should also list them now and then.
- **PagerDuty disables the webhook for 24 hours after three refused deliveries in a row**, as
  when the secret is wrong (each is refused with 401) or Cloudflare Access turns PagerDuty away,
  and drops what it had queued. It shows as **Needs Attention** in PagerDuty; fix the cause and
  enable it there again.
- **An outage of more than a day loses events.** PagerDuty retries a failed delivery for up to 48
  hours, but the worker ignores events more than a day old, as it remembers what it has received
  only that long.
- **Order is not kept**, and an event may arrive more than once; hooks key their work on the
  event's `id`.
- **Only the webhook's own account is served.** An event goes only to hooks on the account its
  incident link names (subdomain and region); hooks on any other account never see it.
- **Every delivery costs a REST read** as the hook's owner, against their rate limit.
- **Disconnecting drops the connection's hooks**, and enabling one afterwards fails with "This
  PagerDuty account has been disconnected." Reconnecting keeps them.

For local development, PagerDuty can't reach `localhost`: run a tunnel to the dev server (e.g.
`cloudflared tunnel --url http://localhost:8787`), point a webhook at
`https://<tunnel host>/gatekeeper/pagerduty/webhook`, and set `PAGERDUTY_WEBHOOK_SECRET` to its
secret in your shell or the root `.dev.vars`; `pnpm dev-server` passes it to the worker.

## Sharing a workspace

Every read reports what it disclosed as subresource IDs, qualified by region and account, such as
`region/us/account/PABC123/service/PXYZ789`: the account, plus the bound team, service, incident or
schedule, plus every team, service, schedule or escalation policy a filter named or a page
contained, a team's own listings included. An incident read, and a hook's event, also reports the
incident and its service, or only its service for an incident still waiting to be opened, which has
no ID yet. Empty pages and cached reads report the same.

A collaborator may observe a read only if their own PagerDuty connection can see every one of
those, checked with their login: the account by being the same account in the same region, with a
base role known to see the account's objects (not Limited Stakeholder or Restricted Access, nor a
role PagerDuty adds later); each object by PagerDuty opening it for them. A refusal (403 or 404) is
a no; any other failure fails the check. An answer is reused for 15 minutes if it allowed and 15
seconds if it denied, so a lost role or team membership goes unnoticed for up to 15 minutes. See
`docs/observers.md`.

## Limitations

- **Reconnect once a year.** PagerDuty caps a Scoped OAuth grant at one year.
- **A connection unused for 30 days dies.** Its refresh token expires, and the user must reconnect.
- **Disconnecting doesn't revoke at PagerDuty**, which documents no revocation endpoint. The grant
  lapses there (the access token within a day); a user can revoke it sooner from their PagerDuty
  profile.
- **Not covered:** merging incidents, incident workflows, the Events API, maintenance windows,
  editing escalation policies, status pages, custom fields and analytics.
- **No overrides on shift-based schedules yet.** A shift-based schedule's override replaces one
  rotation's member rather than whoever the schedule has, so `createOverride()` and
  `deleteOverride()` refuse one; its shifts and overrides can still be read.
- **Some pending changes don't show in reads.** A reassignment to an escalation policy leaves the
  incident's policy and assignees as they were, since PagerDuty picks the new assignees; removing
  an override PagerDuty already has leaves its user on call in shifts and on-call listings (its
  overrides show it removed), since PagerDuty doesn't say whom it displaced; an override for a
  time nobody is on call shows in shifts but not in on-call listings, which take each entry's
  escalation policy and level from PagerDuty; an on-call listing filtered by `users` doesn't show
  an override staged after it was opened that puts one of them on call, since PagerDuty was asked
  only for their entries, so list again; and an incident's log shows no pending change at all.

## Troubleshooting

### "The PagerDuty connection has expired or was revoked. Reconnect the PagerDuty account."

PagerDuty refused the refresh token: the connection went 30 days unused, reached its one-year cap,
or was revoked. Reconnect from the Workshop's Connections page.

### "The PagerDuty app is missing permissions"

The app isn't granted every scope above. Add the ones the message names to the app, then connect
again.

### "That's a different PagerDuty user"

A reconnect was authorized by another user than the one the connection was made for. Sign in to
PagerDuty as that user and reconnect, or connect the other user separately.
